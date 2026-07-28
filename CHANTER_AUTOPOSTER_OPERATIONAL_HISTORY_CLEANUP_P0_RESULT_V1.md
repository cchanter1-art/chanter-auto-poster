# CHANTER AutoPoster Operational History Cleanup P0 Result V1

Date: 2026-07-28

Repository: `apps/chanter-auto-poster`

Branch: `main`

Baseline HEAD: `30f9e0740657e9230a109f0c5379dddcae63fd52`

Execution mode: read-only dry run

## 1. Actual data model

Repository inspection established the following authority boundaries:

- Firestore `posts` is the canonical AutoPoster operational-record collection.
- Firestore `postBatches` stores batch-level summary records; batch children are still `posts`.
- Campaigns and recurring series are represented by `campaignId`, `seriesId`, and `batchId` fields on posts rather than separate campaign or series collections.
- Operational evidence can be attached to a post through `history`, `publishId`, `providerVerification`, `providerOperation`, `lastResult`, `approvalId`, `evidenceBundleId`, `runtimeGraphId`, and `runtimeMissionId`.
- Canonical AutoPoster command and mission-graph records are owned by the external Operator read model. They are not local Firestore collections in this repository.
- Connected accounts, workspaces, memberships, subscriptions, usage ledgers/counters, OAuth transactions, and configuration collections are adjacent authorities and are excluded from cleanup.
- No dedicated archive/tombstone collection or operational-history cleanup service existed at baseline.
- The classic `index.ejs` surface currently treats every non-`posted` row as active and only `posted` rows as history. That is not the complete canonical classification required by this task.
- The existing generic `storage.deletePost` path can physically delete a `posted` Firestore row after its current usage checks. It is not suitable for this cleanup policy, which must preserve published history.

The added dry-run classifier accepts either a post array or an explicit export object containing:

```text
posts
postBatches / batches
canonicalCommands / commands
missionGraphs / graphs
evidenceRecords / evidence
```

It records coverage separately for every authority. Missing authority exports do not silently count as empty authority state.

## 2. Total before counts

The only safe local source available was the ignored local file:

```text
data/posts.json
bytes: 648
SHA-256: d133787c9acddbfd1b7460bd41df4a331b1d0fbc84b195429728dbf55ffd8718
```

Coverage:

```text
posts: true
postBatches: false
canonicalCommands: false
missionGraphs: false
evidenceRecords: false
```

Total records before: `1`

This is a local snapshot count, not a claim about production Firestore.

## 3. Classification counts

Dry-run timestamp: `2026-07-28T12:00:00.000Z`

```text
total: 1
active: 0
scheduled: 0
waiting_approval: 0
published: 1
failed: 0
cancelled: 0
test_demo: 0
legacy: 0
duplicate: 0
orphaned: 0
unknown: 0
```

Exact classified record:

```text
record ID: 8f5e3002-30f5-443a-be74-3700b6a7e656
classification: published
reason: recorded publication status is posted
provider artifact ID: absent in the local snapshot
recommended action: archive_history_after_approval
removal eligible: false
```

## 4. Exact archive and removal criteria

Archive proposal criteria:

- classification is `published`, `cancelled`, or `legacy`;
- the proposal is informational only;
- an archive operation still requires a separately approved mutation implementation.

Exact archive proposal IDs:

```text
8f5e3002-30f5-443a-be74-3700b6a7e656
```

Removal proposal criteria:

- classification is exactly `test_demo`, `duplicate`, or `orphaned`;
- no provider publication artifact or verification evidence;
- no canonical command, graph, mission, approval, evidence-bundle, replay/duplicate, history, or provider-operation linkage;
- no active approval;
- no scheduled future execution;
- no active/uncertain provider execution;
- explicit non-production/customer-safe ownership evidence;
- for batches, child-post authority coverage is present and no child records remain;
- duplicate detection retains one stronger canonical record;
- orphan detection only runs when the corresponding authority export was supplied.

Exact removal proposal IDs:

```text
none
```

Physical deletion was not implemented or executed.

## 5. Skipped and unknown records

```text
skipped removal IDs: none
unknown IDs: none
```

These empty lists apply only to the one-record local snapshot. Missing batch, command, graph, and evidence exports remain explicitly uncovered, not implicitly clean.

Failed records are conservatively retained as needs-attention work. The dry run does not infer that a failure is resolved without an authoritative resolution marker.

## 6. Mutation evidence

```text
operation ID: null
performed: false
writes: 0
archives: 0
deletes: 0
provider calls: 0
Firestore reads: 0
Firestore writes: 0
```

The classifier and CLI have no storage, Firestore, provider, or mutation dependency. The CLI requires an explicit local JSON input and exits with code `2` when no input is supplied.

No Firestore emulator was configured in the process or `.env`, so no Firestore connection was attempted. This avoided any possibility of an accidental real-project read.

## 7. Before and after counts

Before and after classification counts are identical.

The local input SHA-256 before and after the dry run was:

```text
D133787C9ACDDBFD1B7460BD41DF4A331B1D0FBC84B195429728DBF55FFD8718
```

Second execution with the same input and timestamp is deterministic and produces the same report. No state exists for the command to mutate.

## 8. Tests and build

Focused:

```text
node --test test/operational-history-audit.test.js
18 tests
18 pass
0 fail
```

Local dry run:

```text
node scripts/operational-history-audit.js --input data/posts.json --now 2026-07-28T12:00:00.000Z
exit 0
1 published
0 removal candidates
0 mutations
input hash unchanged
```

Fail-closed input check:

```text
node scripts/operational-history-audit.js
exit 2
explicit local JSON input required
```

Full suite:

```text
npm test
686 tests
686 pass
0 fail
```

Production build:

```text
npm run build
PASS
Vite 8.0.16
24 modules transformed
```

Diff hygiene:

```text
git diff --check
PASS
```

Browser screenshots and mutation-flow proof were not produced because founder cleanup controls, archive mutation, and removal mutation were deliberately not implemented in this dry-run-only phase.

## 9. Files changed

```text
package.json
scripts/operational-history-audit.js
src/operationalHistoryAudit.js
test/operational-history-audit.test.js
CHANTER_AUTOPOSTER_OPERATIONAL_HISTORY_CLEANUP_P0_RESULT_V1.md
```

Pre-existing untracked `firestore-debug.log` was not read as task data, modified, staged, or removed.

## 10. Remaining risks

1. The inspected local snapshot contains only one post and is not evidence of complete production or emulator history.
2. Batch, Operator command, mission-graph, and evidence exports were unavailable, so cross-authority orphan and linkage truth was not audited against real records.
3. No founder-only Preview/Archive/Remove controls, operation evidence log, bounded mutation batch, archive store, or tombstone mechanism exists yet.
4. Default runtime/customer projections were not changed in this dry-run-only phase. The classic surface still uses the coarse `posted` versus non-`posted` split.
5. The pre-existing generic delete path can physically delete reconciled `posted` rows. Cleanup mutations must not reuse that behavior for published history.
6. No browser or emulator operational proof was possible without the bounded controls and a configured emulator dataset.

## 11. Final verdict

```text
DRY-RUN PHASE: PASS
FULL P0 ACCEPTANCE: PARTIAL
```

The repository now has deterministic, read-only, fail-closed classification and preview tooling with exact candidate IDs and strong focused/full/build evidence. The available local record was preserved as published history and no removal was proposed.

Full P0 acceptance is not claimed because the available dataset is incomplete and the separately approval-gated archive/remove controls, default projection cleanup, mutation evidence, and browser proof have not been implemented or executed.

No commit, merge, push, deployment, Firestore mutation, provider mutation, archive, or physical deletion occurred.
