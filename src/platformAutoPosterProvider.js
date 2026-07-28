'use strict';

// AutoPoster as a Platform work provider. Before this file the shell reached
// into batchService.listBatches directly; now AutoPoster is one registered
// producer behind the same contract every other module uses, and the shell no
// longer knows it exists by name.
//
// The read is exactly the one the shell already performed — the same durable
// batch list, the same projection, the same execution context — so AutoPoster
// work on every surface is unchanged. This is a re-seating, not a rewrite.

const batchService = require('./batchService');
const applicationService = require('./autoposterApplicationService');
const platformStatus = require('./platformStatus');

const MODULE_ID = 'autoposter';

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
      const standaloneRuntimeJobs = ((queueResult && queueResult.items) || [])
        .filter((post) => String(post.runtimeGraphId || '').trim() && !String(post.batchId || '').trim());
      return [
        ...batches.map(platformStatus.projectAutoPosterBatch),
        ...standaloneRuntimeJobs.map(platformStatus.projectAutoPosterRuntimeJob)
      ];
    }
  };
}

module.exports = { MODULE_ID, createAutoPosterWorkProvider };
