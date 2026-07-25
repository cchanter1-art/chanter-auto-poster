'use strict';

// CHANTER Platform module registry: the one declarative list of what the
// Platform is made of. This file is data, not behaviour — listing a module
// here makes it *visible* in the shell; it never grants that module a route,
// an authority, or a capability it does not already own elsewhere.
//
// `surface` is the ownership boundary and the only security-relevant field:
//
//   'customer' — reachable from this Platform UI by the signed-in account.
//                Must have an href that already exists in this repository.
//   'internal' — owned and operated behind the Operator boundary. Declared
//                here so the Platform tells the truth about what CHANTER runs,
//                but rendered with no link and no control. Repository control,
//                commit preparation, push, deployment and worker administration
//                stay internal and are never reachable from this surface, so
//                every internal module carries href: null.

const SURFACE_CUSTOMER = 'customer';
const SURFACE_INTERNAL = 'internal';

const STATE_ACTIVE = 'active';
const STATE_INTERNAL = 'internal';

// Ordered: the customer-reachable modules come first, AutoPoster first of all,
// because the Overview and Modules pages render this order verbatim.
const MODULES = Object.freeze([
  {
    id: 'autoposter',
    name: 'AutoPoster',
    surface: SURFACE_CUSTOMER,
    state: STATE_ACTIVE,
    owner: 'CHANTER Platform',
    href: '/platform/autoposter',
    summary: 'Μαζική μεταφόρτωση βίντεο και εικόνων, προετοιμασία με AI, ανθρώπινη έγκριση και κλιμακωτός προγραμματισμός δημοσιεύσεων.',
    summaryEn: 'Batch video and image upload, AI preparation, human review, staggered scheduling.'
  },
  {
    id: 'publishing-queue',
    name: 'Ουρά δημοσιεύσεων',
    surface: SURFACE_CUSTOMER,
    state: STATE_ACTIVE,
    owner: 'CHANTER Platform',
    href: '/private/autoposter',
    summary: 'Η πλήρης κονσόλα διαχείρισης: συνδεδεμένα κανάλια, ουρά δημοσιεύσεων, ιστορικό.',
    summaryEn: 'Full operations console: connected channels, release queue, publish history.'
  },
  {
    id: 'operator',
    name: 'Operator',
    surface: SURFACE_INTERNAL,
    state: STATE_INTERNAL,
    owner: 'CHANTER Internal',
    href: null,
    summary: 'Εσωτερικό cockpit: αποστολές, εγκρίσεις, ledger εκτελέσεων, ετοιμότητα πλατφόρμας.',
    summaryEn: 'Internal cockpit: missions, approvals, agent run ledger, platform readiness.'
  },
  {
    id: 'agent-runtime',
    name: 'Agent Runtime',
    surface: SURFACE_INTERNAL,
    state: STATE_INTERNAL,
    owner: 'CHANTER Internal',
    href: null,
    summary: 'Κοινός πυρήνας κύκλου ζωής αποστολών και εργασιών.',
    summaryEn: 'Shared mission and task lifecycle kernel.'
  },
  {
    id: 'mcp-server',
    name: 'MCP Server',
    surface: SURFACE_INTERNAL,
    state: STATE_INTERNAL,
    owner: 'CHANTER Internal',
    href: null,
    summary: 'Επιφάνεια επιθεώρησης και προτάσεων· ποτέ δεν κατέχει εγκρίσεις.',
    summaryEn: 'Inspection and proposal surface; never owns approval authority.'
  },
  {
    id: 'loop-governor',
    name: 'Loop Governor',
    surface: SURFACE_INTERNAL,
    state: STATE_INTERNAL,
    owner: 'CHANTER Internal',
    href: null,
    summary: 'Ανθρώπινα εποπτευόμενος έλεγχος βρόχων εργασίας.',
    summaryEn: 'Human-supervised coding-loop tracker.'
  },
  {
    id: 'memory-vault',
    name: 'Memory Vault',
    surface: SURFACE_INTERNAL,
    state: STATE_INTERNAL,
    owner: 'CHANTER Internal',
    href: null,
    summary: 'Τοπική, ανθρώπινα ελεγχόμενη διαρκής μνήμη.',
    summaryEn: 'Local-first, human-gated durable memory.'
  },
  {
    id: 'safecommit',
    name: 'SafeCommit',
    surface: SURFACE_INTERNAL,
    state: STATE_INTERNAL,
    owner: 'CHANTER Internal',
    href: null,
    summary: 'Συμβουλευτικός έλεγχος αλλαγών κώδικα πριν από κάθε commit.',
    summaryEn: 'Advisory-only commit review.'
  },
  {
    id: 'sdk-forge',
    name: 'SDK Forge',
    surface: SURFACE_INTERNAL,
    state: STATE_INTERNAL,
    owner: 'CHANTER Internal',
    href: null,
    summary: 'Μητρώο δυνατοτήτων και παραγόμενα SDK για εσωτερικούς πελάτες.',
    summaryEn: 'Capability registry and generated SDKs for internal clients.'
  },
  {
    id: 'evolution-worker',
    name: 'Evolution Worker',
    surface: SURFACE_INTERNAL,
    state: STATE_INTERNAL,
    owner: 'CHANTER Internal',
    href: null,
    summary: 'Διαρκής, ελεγχόμενος βρόχος αυτοβελτίωσης υπό ανθρώπινη έγκριση.',
    summaryEn: 'Governed self-improvement loop under human approval.'
  }
]);

function listModules() {
  return MODULES.slice();
}

function listCustomerModules() {
  return MODULES.filter((module) => module.surface === SURFACE_CUSTOMER);
}

function listInternalModules() {
  return MODULES.filter((module) => module.surface === SURFACE_INTERNAL);
}

function getModule(id) {
  return MODULES.find((module) => module.id === String(id || '')) || null;
}

// The module that owns a unit of work, resolved for display. Unknown ids fall
// back to a neutral label rather than throwing: a stale work record must never
// take down the Work surface.
function moduleLabel(id) {
  const module = getModule(id);
  return module ? module.name : String(id || 'Άγνωστη ενότητα');
}

module.exports = {
  SURFACE_CUSTOMER,
  SURFACE_INTERNAL,
  STATE_ACTIVE,
  STATE_INTERNAL,
  MODULES,
  listModules,
  listCustomerModules,
  listInternalModules,
  getModule,
  moduleLabel
};
