'use strict';

// AutoPoster as a Platform work provider. Before this file the shell reached
// into batchService.listBatches directly; now AutoPoster is one registered
// producer behind the same contract every other module uses, and the shell no
// longer knows it exists by name.
//
// The work list stays the same durable batch list. Eligible batches receive an
// additive, read-only child-post reconciliation through batchService's existing
// view seam; that read explicitly disables preparation auto-resume.

const batchService = require('./batchService');
const applicationService = require('./autoposterApplicationService');
const { projectAutoPosterMissionValue } = require('./platformAutoPosterMissionValue');
const platformStatus = require('./platformStatus');

const MODULE_ID = 'autoposter';
const MISSION_VALUE_KEYS = Object.freeze([
  'missionValueContract',
  'missionValueEvidence',
  'startedAt',
  'completedAt',
  'retainedLessons'
]);

function withoutMissionValueMetadata(batch) {
  const clean = { ...(batch || {}) };
  for (const key of MISSION_VALUE_KEYS) delete clean[key];
  return clean;
}

// listBatches is resolved per call rather than captured at require time so the
// provider always uses the live service binding.
function createAutoPosterWorkProvider(options = {}) {
  const includeCanonicalRuntimeJobs = options.includeCanonicalRuntimeJobs === true;
  return {
    moduleId: MODULE_ID,
    listWork: async (context) => {
      const listBatches = options.listBatches || batchService.listBatches;
      // Runtime-created canonical work exists only behind the canonical
      // execution flag. Keeping its queue read behind the same gate preserves
      // the exact legacy read path while the feature is off.
      const listQueue = includeCanonicalRuntimeJobs
        ? (options.listQueue || applicationService.listQueue)
        : null;
      const [batchResult, queueResult] = await Promise.all([
        listBatches(context),
        listQueue ? listQueue(context, { limit: applicationService.MAX_QUEUE_LIMIT || 100 }) : null
      ]);
      const batches = (batchResult && batchResult.batches) || [];
      const getBatchView = options.getBatchView || batchService.getBatchView;
      const projectedBatches = await Promise.all(batches.map(async (sourceBatch) => {
        const batch = withoutMissionValueMetadata(sourceBatch);
        const batchId = String(batch.batchId || '').trim();
        if (!batchId || typeof getBatchView !== 'function') {
          return platformStatus.projectAutoPosterBatch(sourceBatch);
        }
        try {
          const view = await getBatchView(context, batchId, { autoResume: false });
          const metadata = projectAutoPosterMissionValue(
            view && view.batch ? view.batch : batch,
            view && view.items
          );
          return platformStatus.projectAutoPosterBatch(metadata ? { ...batch, ...metadata } : batch);
        } catch {
          // Mission value is optional. If the evidence view is unavailable,
          // keep the existing work row rather than degrading the work source.
          // Pre-existing provider-owned metadata remains compatible when no
          // evidence view can be read at all.
          return platformStatus.projectAutoPosterBatch(sourceBatch);
        }
      }));
      const standaloneRuntimeJobs = ((queueResult && queueResult.items) || [])
        .filter((post) => String(post.runtimeGraphId || '').trim() && !String(post.batchId || '').trim());
      return [
        ...projectedBatches,
        ...standaloneRuntimeJobs.map(platformStatus.projectAutoPosterRuntimeJob)
      ];
    }
  };
}

module.exports = { MODULE_ID, createAutoPosterWorkProvider };
