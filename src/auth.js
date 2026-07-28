'use strict';

const { createHash, createHmac, randomBytes, timingSafeEqual, scryptSync } = require('crypto');
const config = require('./config');

const ADMIN_SESSION_COOKIE = 'chanter_admin_session';
const SESSION_VERSION = 1;

function validateAdminConfig() {
  if (!config.adminPassword) {
    throw new Error('ADMIN_PASSWORD is required; refusing to start an unprotected AutoPoster');
  }
  if (config.adminPassword.length < 12) {
    throw new Error('ADMIN_PASSWORD must contain at least 12 characters');
  }
  return true;
}

function parseCookies(header) {
  return String(header || '').split(';').map((part) => part.trim()).filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf('=');
      if (separator === -1) return cookies;
      try {
        cookies[decodeURIComponent(part.slice(0, separator))] = decodeURIComponent(part.slice(separator + 1));
      } catch (error) {
        // Ignore malformed cookies instead of failing the entire request.
      }
      return cookies;
    }, {});
}

function signingKey() {
  return createHash('sha256')
    .update(`chanter-admin-session:${config.adminSessionSecret || config.adminPassword}`)
    .digest();
}

function sign(value) {
  return createHmac('sha256', signingKey()).update(value).digest('base64url');
}

function createAdminSessionToken(now = Date.now()) {
  validateAdminConfig();
  const payload = Buffer.from(JSON.stringify({
    v: SESSION_VERSION,
    role: 'admin',
    sub: config.defaultUserId,
    iat: now,
    exp: now + config.adminSessionHours * 60 * 60 * 1000,
    nonce: randomBytes(16).toString('base64url')
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyAdminSessionToken(token, now = Date.now()) {
  if (!token || !config.adminPassword) return null;
  const [payload, signature, extra] = String(token).split('.');
  if (!payload || !signature || extra) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      session.v !== SESSION_VERSION ||
      session.role !== 'admin' ||
      session.sub !== config.defaultUserId ||
      !Number.isFinite(session.exp) ||
      session.exp <= now
    ) return null;
    return session;
  } catch (error) {
    return null;
  }
}

// Cache the scrypt-derived key so we only run the KDF once per process
// lifetime. The salt is derived deterministically from the password so
// no separate salt env var is needed.
let cachedPasswordKey = null;
let cachedPasswordSource = null;

function derivePasswordKey(password) {
  if (cachedPasswordSource === password && cachedPasswordKey) {
    return cachedPasswordKey;
  }
  const salt = createHash('sha256').update(`chanter-admin-salt:${password}`).digest();
  cachedPasswordKey = scryptSync(password, salt, 64);
  cachedPasswordSource = password;
  return cachedPasswordKey;
}

function verifyAdminPassword(candidate) {
  if (!config.adminPassword) return false;
  const expected = derivePasswordKey(config.adminPassword);
  const salt = createHash('sha256').update(`chanter-admin-salt:${config.adminPassword}`).digest();
  const actual = scryptSync(String(candidate || ''), salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isSecureRequest(req) {
  return Boolean(req.secure || String(req.get('x-forwarded-proto') || '').toLowerCase() === 'https');
}

function setAdminSessionCookie(req, res) {
  const token = createAdminSessionToken();
  res.cookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'lax',
    maxAge: config.adminSessionHours * 60 * 60 * 1000,
    path: '/'
  });
}

function clearAdminSessionCookie(req, res) {
  res.clearCookie(ADMIN_SESSION_COOKIE, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'lax',
    path: '/'
  });
}

function attachUser(req, res, next) {
  const token = parseCookies(req.headers.cookie)[ADMIN_SESSION_COOKIE];
  const session = verifyAdminSessionToken(token);
  req.adminSession = session;
  req.isAdmin = Boolean(session);
  if (session) req.userId = session.sub;
  next();
}

function resolveUserId(req) {
  return req && req.adminSession ? req.adminSession.sub : null;
}

function safeReturnTo(value) {
  const candidate = String(value || '').trim();
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/platform';
  try {
    const parsed = new URL(candidate, 'http://autoposter.local');
    const allowedPath = parsed.pathname === '/platform'
      || parsed.pathname.startsWith('/platform/')
      || parsed.pathname === '/private/autoposter/legacy'
      || parsed.pathname === '/private/autoposter/dashboard'
      || parsed.pathname === '/internal/operational-history/archive'
      || parsed.pathname === '/connect/tiktok';
    return allowedPath ? `${parsed.pathname}${parsed.search}` : '/platform';
  } catch (error) {
    return '/platform';
  }
}

function requireAdminPage(req, res, next) {
  if (req.isAdmin) {
    next();
    return;
  }
  const returnTo = safeReturnTo(req.originalUrl);
  res.redirect(`/admin-login?returnTo=${encodeURIComponent(returnTo)}`);
}

function requireAdminOAuth(req, res, next) {
  if (req.isAdmin) {
    next();
    return;
  }
  res.redirect('/admin-login?notice=Your+admin+session+expired.+Log+in+and+connect+TikTok+again.');
}

function requireAdminApi(req, res, next) {
  if (req.isAdmin) {
    next();
    return;
  }
  res.status(401).json({ ok: false, reason: 'Admin authentication required' });
}

function requireUser(req, res, next) {
  if (String(req.path || '').startsWith('/api/')) {
    requireAdminApi(req, res, next);
    return;
  }
  requireAdminPage(req, res, next);
}

/**
 * CSRF protection via Origin/Referer header check.
 *
 * SameSite=Lax on the session cookie already blocks cross-site POST
 * requests in modern browsers, but older browsers and edge cases can
 * still leak the cookie. This middleware provides defense-in-depth by
 * verifying that every state-changing request originates from the same
 * host. No form modifications are needed — the browser automatically
 * sends Origin (or Referer as fallback) on all non-GET requests.
 */
function csrfOriginCheck(req, res, next) {
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  const host = req.headers['host'];
  if (!host) {
    return res.status(403).send('CSRF check failed: missing Host header');
  }

  const origin = req.headers['origin'];
  const referer = req.headers['referer'];

  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host === host) {
        return next();
      }
    } catch {
      // Invalid Origin URL — fall through to rejection
    }
    return res.status(403).send('CSRF check failed: Origin mismatch');
  }

  if (referer) {
    try {
      const refererUrl = new URL(referer);
      if (refererUrl.host === host) {
        return next();
      }
    } catch {
      // Invalid Referer URL — fall through to rejection
    }
    return res.status(403).send('CSRF check failed: Referer mismatch');
  }

  return res.status(403).send('CSRF check failed: missing Origin header');
}

module.exports = {
  ADMIN_SESSION_COOKIE,
  DEFAULT_USER_ID: config.defaultUserId,
  attachUser,
  clearAdminSessionCookie,
  csrfOriginCheck,
  createAdminSessionToken,
  requireAdminApi,
  requireAdminOAuth,
  requireAdminPage,
  requireUser,
  resolveUserId,
  safeReturnTo,
  setAdminSessionCookie,
  validateAdminConfig,
  verifyAdminPassword,
  verifyAdminSessionToken
};
