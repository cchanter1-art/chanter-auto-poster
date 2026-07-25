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
    href: batchId ? `/platform/autoposter/batches/${encodeURIComponent(batchId)}` : '',
    createdAt: String(record.createdAt || ''),
    videoCount: Number(record.videoCount || 0),
    destinationCount: Number(record.destinationCount || 0)
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
  summarizeWork,
  sortWork
};
