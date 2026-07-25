'use strict';

// One canonical composer capability seam.
//
// The unified Post Composer renders identically for every package; what a
// package changes is which capabilities inside it are usable. This module is
// the ONLY place that turns plan entitlements into composer capabilities, so
// package rules never leak into templates, routes, or services as scattered
// plan-name checks.
//
// Every capability here is DERIVED from an entitlement that already exists in
// src/planCatalog.js. Nothing invents a plan, a price, a billing state, or a
// new package tier. A `null` numeric entitlement means unmetered (the legacy
// full-access plan only) and collapses to the structural ceiling below.
//
// Compatibility rule: no capability may be narrower than what the surface
// already granted. Every real plan today can select more than one destination
// (Starter's connectedAccountLimit is 2) and can batch more than one item
// (Starter's batchSizeLimit is 5), so this seam removes access from nobody. A
// single-destination package is reachable only through an explicit
// entitlementOverride, and is the state the locked presentation exists for.

// Structural fan-out bound, independent of any package: it guards against an
// unbounded N x M explosion of source items by destination accounts. A plan
// may lower the usable number; nothing may raise it above this.
const MAX_DESTINATIONS = 10;

// Used when plan truth cannot be resolved (unconfigured Firestore, an
// unverifiable subscription). The composer still renders with the behavior the
// surface had before this seam existed; the canonical write path stays
// authoritative and refuses the submission on its own if truth is missing.
const COMPATIBILITY_REASON = 'Plan capabilities could not be verified; showing the standard composer.';

function finiteLimit(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// A plan limit narrows a structural ceiling; it can never widen it.
function boundedBy(limit, ceiling) {
  const finite = finiteLimit(limit);
  if (finite === null) return ceiling;
  return Math.max(1, Math.min(finite, ceiling));
}

function capabilities({
  resolved,
  reason = '',
  planId = null,
  maxDestinationsPerPost,
  maxItemsPerDraft,
  advancedScheduling,
  schedulingHorizonDays = null
}) {
  const destinations = Math.max(1, maxDestinationsPerPost);
  return Object.freeze({
    resolved: Boolean(resolved),
    reason,
    planId,
    // How many accounts one composed post may fan out to.
    maxDestinationsPerPost: destinations,
    // Whether the Accounts step may hold more than one selection at all. This
    // is the single capability that used to be an entire second product mode.
    multiAccountPosting: destinations > 1,
    // Per-account caption/hashtag/sound variation. Meaningful only past one
    // destination, so it is DERIVED from multi-account posting rather than
    // given a package rule of its own: gating it any harder would take away
    // variation that every real plan can use today. It is named separately
    // because the composer presents it separately, and because this is the one
    // line a future billing milestone would change to make it diverge — until
    // then the two are deliberately the same fact, and there is no second
    // server rule to enforce (see checkComposerSubmission).
    perAccountOverrides: destinations > 1,
    maxItemsPerDraft: Math.max(1, maxItemsPerDraft),
    // Collapsed multi-day scheduling. Only meaningful when a draft may carry
    // more than one item; a one-item package has exactly one slot to fill.
    advancedScheduling: Boolean(advancedScheduling),
    schedulingHorizonDays
  });
}

// The compatibility default: exactly the behavior this surface had before
// package capabilities existed. Never stricter than the previous ceilings.
function compatibilityCapabilities(maxItems, reason = COMPATIBILITY_REASON) {
  return capabilities({
    resolved: false,
    reason,
    maxDestinationsPerPost: MAX_DESTINATIONS,
    maxItemsPerDraft: Math.max(1, maxItems),
    advancedScheduling: true
  });
}

// Resolve composer capabilities from a commercial context (the object
// src/commercialService.js resolves). `maxItems` is the structural intake
// bound from config.batchIntake — the plan may lower it, never raise it.
function resolveComposerCapabilities(commercialContext, { maxItems } = {}) {
  const ceilingItems = Math.max(1, Number(maxItems) || 1);
  const entitlements = commercialContext && commercialContext.entitlements;
  if (!entitlements) return compatibilityCapabilities(ceilingItems);

  const batchSizeLimit = finiteLimit(entitlements.batchSizeLimit);
  return capabilities({
    resolved: true,
    planId: (commercialContext.plan && commercialContext.plan.id) || null,
    maxDestinationsPerPost: boundedBy(entitlements.connectedAccountLimit, MAX_DESTINATIONS),
    maxItemsPerDraft: boundedBy(entitlements.batchSizeLimit, ceilingItems),
    advancedScheduling: batchSizeLimit === null || batchSizeLimit > 1,
    schedulingHorizonDays: finiteLimit(entitlements.schedulingHorizonDays)
  });
}

// Server-side capability check for one composer submission. The UI mirrors
// these rules, but this is the enforcement boundary: a hidden or disabled
// control is never the security boundary, so every locked capability must also
// be unusable through the API.
// Note on per-account variation: it is not checked here, because it cannot be
// violated independently. `perAccountOverrides` is derived from
// `multiAccountPosting`, so a package that lacks it also caps destinations at
// one — and any varied submission is refused by the destination rule below
// before variation could matter. A separate branch here would be unreachable.
function checkComposerSubmission(capability, { destinationCount, itemCount }) {
  if (destinationCount > capability.maxDestinationsPerPost) {
    return {
      allowed: false,
      code: capability.multiAccountPosting ? 'destination_limit_reached' : 'multi_account_locked',
      reason: capability.multiAccountPosting
        ? `Your package allows up to ${capability.maxDestinationsPerPost} destination accounts per post.`
        : 'Multiple accounts per post are locked by your package.',
      limit: capability.maxDestinationsPerPost,
      current: destinationCount
    };
  }

  if (itemCount > capability.maxItemsPerDraft) {
    return {
      allowed: false,
      code: 'draft_size_limit_reached',
      reason: `Your package allows up to ${capability.maxItemsPerDraft} items per post.`,
      limit: capability.maxItemsPerDraft,
      current: itemCount
    };
  }

  return { allowed: true, code: 'allowed', reason: '' };
}

module.exports = {
  MAX_DESTINATIONS,
  COMPATIBILITY_REASON,
  compatibilityCapabilities,
  resolveComposerCapabilities,
  checkComposerSubmission
};
