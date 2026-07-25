'use strict';

// Recurring daily series as a Platform work provider.
//
// A series is not a batch: its occurrences are ordinary Release Queue jobs that
// share a seriesId, and they are reviewed and approved in the Release Queue.
// That surface belongs to the `publishing-queue` module, so the series is
// registered under THAT module rather than AutoPoster — the work registry then
// stamps the ownership and allows only links inside the route that module
// already declares.
//
// This adds no authority and no new storage: it groups posts that already carry
// their own durable series metadata (src/batchService.js listSeries) and
// projects them through the one canonical work-state vocabulary.

const batchService = require('./batchService');
const platformStatus = require('./platformStatus');

const MODULE_ID = 'publishing-queue';

// listSeries is resolved per call rather than captured at require time so the
// provider always uses the live service binding.
function createRecurringSeriesWorkProvider(options = {}) {
  return {
    moduleId: MODULE_ID,
    listWork: async (context) => {
      const listSeries = options.listSeries || batchService.listSeries;
      const result = await listSeries(context);
      const series = (result && result.series) || [];
      return series.map(platformStatus.projectRecurringSeries);
    }
  };
}

module.exports = { MODULE_ID, createRecurringSeriesWorkProvider };
