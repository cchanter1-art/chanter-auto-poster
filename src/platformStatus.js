'use strict';

// Canonical CHANTER Platform work states. One vocabulary for every module, so
// the Overview / Work / Approvals surfaces read identically no matter which
// module produced the work. Modules keep their own internal status vocabulary;
// this file is the only translation point, and it is pure — no I/O, no clock,
// no provider calls — so the projection is deterministic and unit-testable.
//
// The state VALUES below are the canonical identifiers and must not change;
// `label` is display copy and is English-only, like the rest of the shell.

const WORK_STATE = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting_approval',
  COMPLETED: 'completed',
  FAILED: 'failed',
  PAUSED: 'paused'
});

const WORK_STATE_ORDER = Object.freeze([
  WORK_STATE.WAITING_APPROVAL,
  WORK_STATE.RUNNING,
  WORK_STATE.FAILED,
  WORK_STATE.PAUSED,
  WORK_STATE.COMPLETED,
  WORK_STATE.IDLE
]);

const WORK_STATE_PRESENTATION = Object.freeze({
  [WORK_STATE.IDLE]: { label: 'Idle', chip: 'chip-neutral' },
  [WORK_STATE.RUNNING]: { label: 'Running', chip: 'chip-preparing' },
  [WORK_STATE.WAITING_APPROVAL]: { label: 'Waiting for approval', chip: 'chip-attention' },
  [WORK_STATE.COMPLETED]: { label: 'Completed', chip: 'chip-completed' },
  [WORK_STATE.FAILED]: { label: 'Failed', chip: 'chip-failed' },
  [WORK_STATE.PAUSED]: { label: 'Paused', chip: 'chip-neutral' }
});

function presentation(state) {
  return WORK_STATE_PRESENTATION[state] || WORK_STATE_PRESENTATION[WORK_STATE.IDLE];
}

// AutoPoster's durable batch vocabulary (batchService.deriveBatchStatus, mirrored
// onto the batch record by refreshBatchRecord) is:
//   empty | preparing | ready | attention_required | completed
//
// attention_required is the one status that splits: a batch whose preparation
// actually failed is a Platform failure, while a batch that merely needs a human
// to fix a caption or a title is still waiting on that human — not broken. The
// failed-preparation tally is the discriminator, so the Platform never reports
// "Failed" for work that only needs a person to finish it.
function autoPosterStateOf(record) {
  const status = String(record.status || '').trim();
  const failed = Number(record.failedCount || 0);
  if (status === 'empty') return { state: WORK_STATE.IDLE, reason: 'No items.' };
  if (status === 'preparing') return { state: WORK_STATE.RUNNING, reason: 'AI preparation in progress.' };
  if (status === 'completed') return { state: WORK_STATE.COMPLETED, reason: 'All items approved.' };
  if (status === 'ready') return { state: WORK_STATE.WAITING_APPROVAL, reason: 'Waiting for human review.' };
  if (status === 'attention_required') {
    return failed > 0
      ? { state: WORK_STATE.FAILED, reason: 'Preparation failed for one or more items.' }
      : { state: WORK_STATE.WAITING_APPROVAL, reason: 'Needs a fix before approval.' };
  }
  // Unknown module status: report idle but surface the raw value rather than
  // guessing that work is running. Nothing is hidden, nothing is invented.
  return { state: WORK_STATE.IDLE, reason: status ? `Module status: ${status}` : 'Unknown status.' };
}

// Projects one durable AutoPoster batch record into a Platform work item.
// Reads only fields the record already carries, so the Work surface costs no
// extra storage reads beyond the batch list itself.
function projectAutoPosterBatch(record = {}) {
  const { state, reason } = autoPosterStateOf(record);
  const total = Number(record.itemCount || 0);
  const accepted = Number(record.acceptedCount || 0);
  const failed = Number(record.failedCount || 0);
  const prepared = Number(record.preparedCount || 0);
  const awaiting = Math.max(0, total - accepted);
  const batchId = String(record.batchId || '');
  return {
    moduleId: 'autoposter',
    workId: batchId,
    title: `Batch ${batchId.slice(0, 8) || '—'}`,
    state,
    stateReason: reason,
    counts: { total, prepared, failed, accepted, awaiting },
    // The Approvals surface keys off this alone, so approval never appears for
    // work that has nothing left for a human to accept.
    needsApproval: state === WORK_STATE.WAITING_APPROVAL && awaiting > 0,
    href: batchId ? `/platform/compose/${encodeURIComponent(batchId)}` : '',
    createdAt: String(record.createdAt || ''),
    updatedAt: String(record.updatedAt || record.createdAt || ''),
    // Every batch carries a durable record, so every batch is indexable on the
    // Evidence surface — including an empty one, whose evidence is that nothing
    // was ever added to it.
    evidenceAvailable: true,
    videoCount: Number(record.videoCount || 0),
    destinationCount: Number(record.destinationCount || 0)
  };
}

// Projects one recurring daily series into a Platform work item. A series has
// no record of its own: it IS the group of queue jobs that share a seriesId,
// so every number here is counted from durable posts rather than from a
// summary that could drift away from them.
//
// The state vocabulary is the same canonical one every other producer uses —
// no series-specific status is invented.
function projectRecurringSeries(series = {}) {
  const seriesId = String(series.seriesId || '');
  const total = Number(series.jobCount || 0);
  const failed = Number(series.failedCount || 0);
  const posted = Number(series.postedCount || 0);
  const awaiting = Number(series.pendingApprovalCount || 0);
  const occurrences = Number(series.occurrenceCount || 0);

  let state;
  let reason;
  if (total === 0) {
    state = WORK_STATE.IDLE;
    reason = 'No releases.';
  } else if (failed > 0) {
    state = WORK_STATE.FAILED;
    reason = `${failed} of ${total} releases failed.`;
  } else if (awaiting > 0) {
    state = WORK_STATE.WAITING_APPROVAL;
    reason = `${awaiting} of ${total} releases waiting for human approval.`;
  } else if (posted === total) {
    state = WORK_STATE.COMPLETED;
    reason = 'Every release published.';
  } else {
    state = WORK_STATE.RUNNING;
    reason = `Approved; ${total - posted} of ${total} releases still scheduled.`;
  }

  return {
    moduleId: 'publishing-queue',
    workId: seriesId,
    title: `Daily series ${seriesId.slice(0, 8) || '—'}`,
    state,
    stateReason: reason,
    counts: { total, prepared: total, failed, accepted: total - awaiting, awaiting },
    needsApproval: state === WORK_STATE.WAITING_APPROVAL && awaiting > 0,
    // Occurrences are ordinary queue jobs, reviewed and approved in the Release
    // Queue — the surface the publishing-queue module already owns.
    href: '/private/autoposter',
    createdAt: String(series.createdAt || ''),
    updatedAt: String(series.updatedAt || series.createdAt || ''),
    evidenceAvailable: true,
    // Recurrence parameters travel with the work item so Evidence retains what
    // the series was actually asked to do.
    recurrence: {
      frequency: String(series.frequency || 'daily'),
      startDate: String(series.startDate || ''),
      endDate: String(series.endDate || ''),
      timezone: String(series.timezone || ''),
      occurrenceCount: occurrences,
      firstReleaseAt: String(series.firstReleaseAt || ''),
      lastReleaseAt: String(series.lastReleaseAt || '')
    },
    videoCount: Number(series.sourceCount || 0),
    destinationCount: Number(series.destinationCount || 0)
  };
}

// Operator's durable mission-graph vocabulary (chanter.mission.graph.v1,
// MissionGraphState in the Operator repository) is:
//   approval_required | approved | running | completed
//   | failed_recoverable | failed_terminal | cancelled
//
// approved is transient by construction: approveGraph transitions to it and
// immediately runs the scheduler, so reporting it as running is the honest
// reading rather than an optimistic one. Both failure states are failures —
// recoverable says how it can be recovered, not that it is fine — and recovery
// is an internal control action that this surface never offers.
function operatorGraphStateOf(record) {
  const status = String(record.status || '').trim();
  if (status === 'approval_required') return { state: WORK_STATE.WAITING_APPROVAL, reason: 'Waiting for an internal approver.' };
  if (status === 'approved') return { state: WORK_STATE.RUNNING, reason: 'Approved; execution scheduled.' };
  if (status === 'running') return { state: WORK_STATE.RUNNING, reason: 'Mission execution in progress.' };
  if (status === 'completed') return { state: WORK_STATE.COMPLETED, reason: 'All mission steps completed.' };
  if (status === 'failed_recoverable') return { state: WORK_STATE.FAILED, reason: 'Recoverable failure; recovery is an internal control action.' };
  if (status === 'failed_terminal') return { state: WORK_STATE.FAILED, reason: 'Terminal failure.' };
  if (status === 'cancelled') return { state: WORK_STATE.PAUSED, reason: 'Cancelled by an internal operator.' };
  // Same doctrine as AutoPoster: an unrecognised module status is reported as
  // idle with the raw value shown, never guessed into looking like progress.
  return { state: WORK_STATE.IDLE, reason: status ? `Module status: ${status}` : 'Unknown status.' };
}

const OPERATOR_NODE_FAILURE_STATES = new Set(['failed_recoverable', 'failed_terminal']);

// Projects one Operator mission graph into a Platform work item. Node tallies
// stand in for the item tallies AutoPoster reports, so the shared counts column
// means the same thing on both: how much of this unit of work is done, how much
// broke, how much a person has cleared.
//
// Operator is an internal module. This projection therefore proposes no link at
// all — and platformWorkProviders would strip one anyway, since the registry
// gives internal modules no route.
function projectOperatorMissionGraph(record = {}) {
  const { state, reason } = operatorGraphStateOf(record);
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  const total = Number(record.nodeCount || nodes.length || 0);
  const prepared = nodes.filter((node) => String(node && node.status) === 'completed').length;
  const failed = nodes.filter((node) => OPERATOR_NODE_FAILURE_STATES.has(String(node && node.status))).length;
  // Approval on a graph is granted once, for the whole compiled graph, so it
  // clears every step at once rather than item by item.
  const approved = record.approvedBy ? total : 0;
  const awaiting = Math.max(0, total - approved);
  const graphId = String(record.graphId || '');
  return {
    moduleId: 'operator',
    workId: graphId,
    title: String(record.objective || '').trim() || `Mission ${graphId.slice(0, 8) || '—'}`,
    state,
    stateReason: reason,
    counts: { total, prepared, failed, accepted: approved, awaiting },
    needsApproval: state === WORK_STATE.WAITING_APPROVAL && awaiting > 0,
    href: '',
    createdAt: String(record.createdAt || ''),
    updatedAt: String(record.updatedAt || record.createdAt || ''),
    // A compiled graph carries a durable node set and event journal, so it can
    // be indexed here. The journal itself stays behind the Operator boundary.
    evidenceAvailable: total > 0
  };
}

function summarizeWork(items = []) {
  const byState = {};
  for (const state of WORK_STATE_ORDER) byState[state] = 0;
  for (const item of items) {
    if (Object.prototype.hasOwnProperty.call(byState, item.state)) byState[item.state] += 1;
  }
  return {
    total: items.length,
    byState,
    running: byState[WORK_STATE.RUNNING],
    awaitingApproval: items.filter((item) => item.needsApproval).length,
    failed: byState[WORK_STATE.FAILED]
  };
}

// Newest first, but anything a human is blocking on is lifted to the top: the
// Work surface should open on what needs a person, not on finished history.
function sortWork(items = []) {
  const rank = (item) => WORK_STATE_ORDER.indexOf(item.state);
  return items.slice().sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

module.exports = {
  WORK_STATE,
  WORK_STATE_ORDER,
  WORK_STATE_PRESENTATION,
  presentation,
  projectAutoPosterBatch,
  projectRecurringSeries,
  projectOperatorMissionGraph,
  summarizeWork,
  sortWork
};
