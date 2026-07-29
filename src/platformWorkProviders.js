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
const missionValue = require('./missionValue');

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
    const validatedValueContract = missionValue.validateMissionValueContract(
      Object.prototype.hasOwnProperty.call(item, 'missionValueContract')
        ? item.missionValueContract
        : null
    );
    return {
      ...item,
      // The contract stays on its owning work item. Validation happens at this
      // projection boundary so malformed declarations degrade the provider
      // instead of becoming partially trusted UI state.
      missionValueContract: validatedValueContract,
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

  function mergedLinkedState(group) {
    const states = new Set(group.map((item) => item.state));
    if (states.has(platformStatus.WORK_STATE.FAILED)) return platformStatus.WORK_STATE.FAILED;
    if (states.has(platformStatus.WORK_STATE.WAITING_APPROVAL)) {
      return platformStatus.WORK_STATE.WAITING_APPROVAL;
    }
    if (states.has(platformStatus.WORK_STATE.RUNNING)) return platformStatus.WORK_STATE.RUNNING;
    if (states.has(platformStatus.WORK_STATE.PAUSED)) return platformStatus.WORK_STATE.PAUSED;
    if (states.has(platformStatus.WORK_STATE.COMPLETED)) return platformStatus.WORK_STATE.COMPLETED;
    return platformStatus.WORK_STATE.IDLE;
  }

  // One canonical AutoPoster command can be visible from three truthful read
  // models: Operator command, Operator graph, and the product-native Runtime
  // job. Graph identity is their shared join key. Collapse only exact linked
  // groups; unrelated work remains untouched. Provider failures were already
  // recorded above and remain in `degraded`, so dedup never turns an unreadable
  // side into a false empty one.
  function deduplicateLinkedWork(items) {
    const unlinked = [];
    const linked = new Map();
    for (const item of items) {
      const graphId = String(item.runtimeGraphId || '').trim();
      if (!graphId) {
        if (item.workKind === 'autoposter_command') {
          const commandId = String(item.canonicalWorkId || item.workId || '');
          unlinked.push(adopt({
            ...item,
            workId: commandId,
            href: commandId
              ? `/platform/autoposter/compose/commands/${encodeURIComponent(commandId)}`
              : ''
          }, 'autoposter', ownershipOf('autoposter')));
        } else {
          unlinked.push(item);
        }
        continue;
      }
      if (!linked.has(graphId)) linked.set(graphId, []);
      linked.get(graphId).push(item);
    }

    const merged = [...unlinked];
    for (const [graphId, group] of linked.entries()) {
      const commandRecords = group.filter((item) => item.workKind === 'autoposter_command');
      const productRecords = group.filter((item) => item.workKind === 'autoposter_runtime_job');
      const command = commandRecords[0];
      const product = productRecords[0];
      if (group.length === 1 || (!command && !product)) {
        merged.push(...group);
        continue;
      }
      const base = product || command;
      const canonicalWorkId = String(
        (command && command.canonicalWorkId)
        || (product && product.canonicalWorkId)
        || base.workId
      );
      const updatedAt = group
        .map((item) => String(item.updatedAt || item.createdAt || ''))
        .sort()
        .at(-1) || '';
      const createdAt = group
        .map((item) => String(item.createdAt || ''))
        .filter(Boolean)
        .sort()
        .at(0) || '';
      const evidenceUnavailable = group.some((item) => item.evidenceUnavailable === true);
      if (productRecords.length > 1) {
        const conflictWorkId = canonicalWorkId || productRecords
          .map((item) => String(item.productJobId || item.workId || ''))
          .filter(Boolean)
          .sort()[0];
        const conflict = adopt({
          ...base,
          workId: conflictWorkId,
          title: 'AutoPoster linkage conflict',
          state: platformStatus.WORK_STATE.FAILED,
          stateReason: 'Multiple AutoPoster product jobs share one canonical execution link.',
          counts: {
            total: productRecords.length,
            prepared: productRecords.reduce(
              (sum, item) => sum + Number((item.counts && item.counts.prepared) || 0),
              0
            ),
            failed: 1,
            accepted: productRecords.reduce(
              (sum, item) => sum + Number((item.counts && item.counts.accepted) || 0),
              0
            ),
            awaiting: productRecords.reduce(
              (sum, item) => sum + Number((item.counts && item.counts.awaiting) || 0),
              0
            )
          },
          needsApproval: false,
          href: '',
          createdAt,
          updatedAt,
          evidenceAvailable: !evidenceUnavailable
            && group.some((item) => item.evidenceAvailable),
          evidenceUnavailable,
          runtimeGraphId: graphId,
          runtimeMissionId: '',
          canonicalWorkId,
          productJobId: '',
          campaignId: '',
          approvalId: '',
          evidenceBundleId: '',
          linkage: {
            commandAvailable: Boolean(command),
            operatorGraphAvailable: group.some((item) => item.workKind === 'operator_mission_graph'),
            productAvailable: true,
            productConflict: true
          }
        }, 'autoposter', ownershipOf('autoposter'));
        merged.push({ ...conflict, actionable: false, href: '' });
        continue;
      }
      const graph = group.find((item) => item.workKind === 'operator_mission_graph');
      const stateReason = String(
        (product && product.stateReason)
        || (command && command.stateReason)
        || (graph && graph.stateReason)
        || base.stateReason
        || ''
      );
      const canonical = {
        ...base,
        workId: canonicalWorkId,
        title: product ? product.title : command.title,
        state: mergedLinkedState(group),
        stateReason,
        needsApproval: group.some((item) => item.needsApproval),
        href: command && canonicalWorkId
          ? `/platform/autoposter/compose/commands/${encodeURIComponent(canonicalWorkId)}`
          : '',
        createdAt,
        updatedAt,
        evidenceAvailable: !evidenceUnavailable
          && group.some((item) => item.evidenceAvailable),
        evidenceUnavailable,
        runtimeGraphId: graphId,
        runtimeMissionId: String(
          group.map((item) => item.runtimeMissionId).find((value) => String(value || '')) || ''
        ),
        canonicalWorkId,
        productJobId: String(
          group.map((item) => item.productJobId).find((value) => String(value || '')) || ''
        ),
        campaignId: String(
          group.map((item) => item.campaignId).find((value) => String(value || '')) || ''
        ),
        approvalId: String(
          group.map((item) => item.approvalId).find((value) => String(value || '')) || ''
        ),
        evidenceBundleId: String(
          group.map((item) => item.evidenceBundleId).find((value) => String(value || '')) || ''
        ),
        linkage: {
          commandAvailable: Boolean(command),
          operatorGraphAvailable: group.some((item) => item.workKind === 'operator_mission_graph'),
          productAvailable: Boolean(product)
        }
      };
      merged.push(adopt(canonical, 'autoposter', ownershipOf('autoposter')));
    }
    return merged;
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

    const sorted = platformStatus.sortWork(deduplicateLinkedWork(items));
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
