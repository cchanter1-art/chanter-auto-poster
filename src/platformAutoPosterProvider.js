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
const platformStatus = require('./platformStatus');

const MODULE_ID = 'autoposter';

// listBatches is resolved per call rather than captured at require time so the
// provider always uses the live service binding.
function createAutoPosterWorkProvider(options = {}) {
  return {
    moduleId: MODULE_ID,
    listWork: async (context) => {
      const listBatches = options.listBatches || batchService.listBatches;
      const result = await listBatches(context);
      const batches = (result && result.batches) || [];
      return batches.map(platformStatus.projectAutoPosterBatch);
    }
  };
}

module.exports = { MODULE_ID, createAutoPosterWorkProvider };
