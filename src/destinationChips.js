'use strict';

// Presentation-only grouping for the batch-intake destination chips.
//
// This consumes the EXISTING batchService.listDestinations() destination shape
// unchanged — { provider, providerDisplayName, accountId, label,
// publishingReady } — and returns provider-grouped view rows for the intake
// template. It introduces NO new destination model and performs NO
// connection/readiness filtering of its own: the caller decides which
// destinations to pass in. The only judgement it encodes is a per-provider
// `selectable` flag, driven by a caller-supplied predicate, so a provider that
// is connected but not choosable at bulk intake (YouTube, which needs a
// human-entered per-video title that cannot exist yet) can still be shown —
// grouped and clearly disabled — rather than silently disappearing.

// Stable display order for the known providers; anything unknown sorts after
// these, then alphabetically, so a future provider groups deterministically.
const PROVIDER_ORDER = ['tiktok', 'instagram', 'youtube'];

function providerRank(provider) {
  const index = PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? PROVIDER_ORDER.length : index;
}

// destinations: array of { provider, providerDisplayName, accountId, label,
//   publishingReady } (extra fields are ignored).
// options.isSelectable(provider) -> boolean (default: everything selectable).
// options.unavailableReason(provider) -> string shown on a non-selectable chip.
//
// Returns: [{ provider, providerDisplayName, selectable, accounts: [
//   { provider, providerDisplayName, accountId, key, label, publishingReady,
//     selectable, unavailableReason } ] }] — groups in stable provider order,
// accounts within a group in stable label order, duplicates collapsed by
// provider|accountId.
function groupDestinationsByProvider(destinations, options = {}) {
  const isSelectable = typeof options.isSelectable === 'function' ? options.isSelectable : () => true;
  const reasonFor = typeof options.unavailableReason === 'function' ? options.unavailableReason : () => '';

  const groups = new Map();
  const seen = new Set();
  for (const dest of Array.isArray(destinations) ? destinations : []) {
    if (!dest || typeof dest !== 'object') continue;
    const provider = String(dest.provider || '').trim().toLowerCase();
    const accountId = String(dest.accountId || '').trim();
    if (!provider || !accountId) continue;
    const key = `${provider}|${accountId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const providerDisplayName = String(dest.providerDisplayName || '').trim() || provider;
    const selectable = isSelectable(provider) === true;
    if (!groups.has(provider)) {
      groups.set(provider, { provider, providerDisplayName, selectable, accounts: [] });
    }
    const group = groups.get(provider);
    group.accounts.push({
      provider,
      providerDisplayName: group.providerDisplayName,
      accountId,
      key,
      label: String(dest.label || accountId),
      publishingReady: dest.publishingReady === true,
      selectable,
      unavailableReason: selectable ? '' : String(reasonFor(provider) || '')
    });
  }

  const ordered = [...groups.values()].sort((a, b) => {
    const rankDiff = providerRank(a.provider) - providerRank(b.provider);
    return rankDiff !== 0 ? rankDiff : a.provider.localeCompare(b.provider);
  });
  for (const group of ordered) {
    group.accounts.sort((a, b) => a.label.localeCompare(b.label) || a.accountId.localeCompare(b.accountId));
  }
  return ordered;
}

// Count of accounts the operator can actually select — the intake form gates
// its empty state on this, not on the raw connected count (a workspace with
// only a non-selectable provider still has nothing to fan out at intake).
function countSelectableAccounts(groups) {
  return (Array.isArray(groups) ? groups : []).reduce(
    (total, group) => total + group.accounts.filter((account) => account.selectable).length,
    0
  );
}

module.exports = { groupDestinationsByProvider, countSelectableAccounts, PROVIDER_ORDER };
