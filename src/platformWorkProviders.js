'use strict';

// CHANTER Platform work ingestion. This is the seam between the Platform shell
// and whatever produces work: the shell iterates registered providers and never
// knows which modules exist. Adding a module means registering a provider, not
// editing Overview / Work / Approvals / Evidence / System health.
//
// This file deliberately imports NO module service. It knows the registry
// (for ownership) and the canonical state vocabulary (for summarising), and
// nothing else — so it can never grow a direct dependency on any one module's
// storage the way the shell's original work loader did.
// test/platform-work-providers.test.js asserts that by reading this source.
//
// A provider is:
//
//   { moduleId: 'autoposter', listWork: async (context) => [ ...work items ] }
//
// and must return canonical Platform work items (platformStatus projections).
// Providers propose; this layer disposes. Ownership fields — module name,
// owner, surface, whether a row is actionable, and above all the link — are
// stamped here from the module registry, so a provider cannot label itself as
// another module or link anywhere its module does not own.

const platformModules = require('./platformModules');
const platformStatus = require('./platformStatus');

// A provider failure is reported, never swallowed and never rendered as "no
// work". These are the two honest outcomes:
//
//   error    — every registered provider failed. The shell knows nothing.
//   degraded — some providers failed. The shell reports what it did read AND
//              names what it could not, so a partial read never reads as whole.
const DEGRADED_SEPARATOR = ' · ';

function errorReason(error, fallback) {
  const message = error && error.message ? String(error.message) : '';
  return message.trim() || fallback;
}

function createWorkRegistry() {
  const providers = [];
  const seen = new Set();

  // One provider per module, checked at registration rather than at read time:
  // a duplicate registration is a wiring bug, and double-counted work would be
  // silent and wrong on every surface at once.
  function register(provider) {
    if (!provider || typeof provider !== 'object') {
      throw new TypeError('A work provider must be an object.');
    }
    const moduleId = String(provider.moduleId || '').trim();
    if (!moduleId) {
      throw new TypeError('A work provider must declare a moduleId.');
    }
    if (typeof provider.listWork !== 'function') {
      throw new TypeError(`Work provider "${moduleId}" must implement listWork().`);
    }
    if (!platformModules.getModule(moduleId)) {
      throw new TypeError(`Work provider "${moduleId}" is not a declared platform module.`);
    }
    if (seen.has(moduleId)) {
      throw new Error(`Work provider "${moduleId}" is already registered.`);
    }
    seen.add(moduleId);
    providers.push({ moduleId, listWork: provider.listWork });
    return provider;
  }

  function list() {
    return providers.map((provider) => provider.moduleId);
  }

  // Ownership stamp. Everything a surface renders about *who* owns a row is
  // decided here from the registry, never taken from the provider.
  //
  // The link rule is the security-relevant one: an internal module's work is
  // visible (the Platform tells the truth about what CHANTER runs) but carries
  // no link and no control, and a customer module may only link inside the
  // route it already declares. So the AutoPoster provider can reach
  // /platform/autoposter/batches/<id> and nothing else, and no provider can
  // point the Work surface at an internal console.
  function ownershipOf(moduleId) {
    const module = platformModules.getModule(moduleId);
    // Unknown module: fail closed. Treat it as internal — visible, never linked.
    if (!module) {
      return {
        moduleName: platformModules.moduleLabel(moduleId),
        owner: 'Unknown owner',
        surface: platformModules.SURFACE_INTERNAL,
        actionable: false,
        routePrefix: ''
      };
    }
    const customer = module.surface === platformModules.SURFACE_CUSTOMER;
    return {
      moduleName: module.name,
      owner: module.owner,
      surface: module.surface,
      actionable: customer,
      routePrefix: customer && module.href ? module.href : ''
    };
  }

  function safeHref(href, ownership) {
    if (!ownership.actionable || !ownership.routePrefix) return '';
    const candidate = String(href || '');
    if (!candidate) return '';
    return candidate.startsWith(ownership.routePrefix) ? candidate : '';
  }

  function adopt(item, moduleId, ownership) {
    return {
      ...item,
      // A provider does not get to claim another module's identity.
      moduleId,
      moduleName: ownership.moduleName,
      owner: ownership.owner,
      surface: ownership.surface,
      actionable: ownership.actionable,
      href: safeHref(item.href, ownership),
      // Whether work waits on a person is a fact about that work, and the module
      // that owns it is the authority on it. It stays true for internal work
      // too: suppressing it would make the Approvals count understate what
      // CHANTER is actually waiting on, which is the quiet kind of lie this
      // surface exists to avoid. What internal work does not get is a control —
      // no link, and a label that says whose approval it is (see
      // _platform-work-row.ejs and platform-approvals.ejs).
      needsApproval: Boolean(item.needsApproval),
      evidenceAvailable: item.evidenceAvailable !== false
    };
  }

  function isUsableItem(item) {
    return Boolean(item) && typeof item === 'object' && String(item.workId || '').trim() !== '';
  }

  async function readProvider(provider, context) {
    const ownership = ownershipOf(provider.moduleId);
    const produced = await provider.listWork(context);
    if (!Array.isArray(produced)) {
      throw new TypeError('listWork() must resolve to an array of work items.');
    }
    const usable = produced.filter(isUsableItem);
    const dropped = produced.length - usable.length;
    return {
      items: usable.map((item) => adopt(item, provider.moduleId, ownership)),
      // A provider that returns unreadable rows is degraded, not empty: the
      // count of what was dropped is surfaced rather than quietly lost.
      dropped,
      moduleName: ownership.moduleName
    };
  }

  // Providers are read concurrently and independently. One slow or broken
  // module cannot delay or break the others, which is the whole point of the
  // seam: the Platform survives its modules.
  async function collect(context) {
    const settled = await Promise.allSettled(
      providers.map((provider) => readProvider(provider, context))
    );

    const items = [];
    const degraded = [];
    settled.forEach((outcome, index) => {
      const provider = providers[index];
      if (outcome.status === 'rejected') {
        degraded.push({
          moduleId: provider.moduleId,
          moduleName: ownershipOf(provider.moduleId).moduleName,
          reason: errorReason(outcome.reason, 'Work could not be read from this module.')
        });
        return;
      }
      items.push(...outcome.value.items);
      if (outcome.value.dropped > 0) {
        degraded.push({
          moduleId: provider.moduleId,
          moduleName: outcome.value.moduleName,
          reason: `${outcome.value.dropped} unreadable work record(s) were skipped.`
        });
      }
    });

    const failedProviders = settled.filter((outcome) => outcome.status === 'rejected');
    // Only a total blackout is an error. Anything less is a partial read, and
    // saying "unavailable" about a partial read would be its own kind of lie.
    const error = providers.length > 0 && failedProviders.length === providers.length
      ? degraded.map((entry) => entry.reason).join(DEGRADED_SEPARATOR)
      : '';

    const sorted = platformStatus.sortWork(items);
    return {
      items: sorted,
      summary: platformStatus.summarizeWork(sorted),
      degraded,
      error
    };
  }

  return { register, list, collect };
}

module.exports = { createWorkRegistry };
