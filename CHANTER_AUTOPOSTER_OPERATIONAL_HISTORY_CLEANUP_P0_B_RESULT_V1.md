# CHANTER AutoPoster — Operational History Cleanup P0-B Result V1

## Final verdict

**PASS — LOCAL ARCHIVE FOUNDATION**

The repository now has a founder-controlled, fail-closed logical archive foundation for eligible completed operational records. The implementation was validated against an explicit local fixture only. It does not constitute production or live Firestore proof.

No physical deletion, deployment, push, commit, real provider operation, or production mutation was performed.

## Outcome

- Eligible `published`, `cancelled`, and `legacy` records can be previewed as a frozen, bounded candidate set.
- Execution requires a matching owner, complete local authority coverage, an explicit signed founder approval, and the same stable operation ID and candidate-set hash produced by preview.
- A successful archive adds a canonical `operationalArchive` envelope to the original record. The original operational record, provider identifiers, evidence identifiers, and history remain present and recoverable.
- Reusing an operation ID returns the stored operation evidence and performs zero duplicate mutations.
- Partial failures are reported as `partial`, with exact archived IDs, skipped IDs, and failure reasons.
- Default and Queue projections exclude successfully archived records. History and Activity projections retain them.
- Published and archived records are rejected by the generic physical-delete path.

## Canonical archive contract

Archive envelope schema:

`chanter.autoposter.operational-archive.v1`

Operation evidence schema:

`chanter.autoposter.operational-archive-operation.v1`

Founder approval schema:

`chanter.autoposter.operational-archive-approval.v1`

Authority manifest schema:

`chanter.autoposter.archive-authority-manifest.v1`

The archive service accepts only:

- `explicit_local_fixture`
- `firestore_emulator`

It fails closed when canonical authority collections, scoped ownership, approval evidence, candidate-set integrity, or authority coverage are missing or malformed.

The archive batch limit is 100 records. The repository CLI uses an explicit local JSON file and never imports the Firestore client, provider clients, or the generic delete operation.

## Files changed

P0-B implementation and evidence:

- `package.json`
- `scripts/operational-history-archive.js`
- `src/operationalHistoryArchive.js`
- `src/operationalHistoryAudit.js`
- `src/platformRoutes.js`
- `src/platformStatus.js`
- `src/postsMapper.js`
- `src/storage.js`
- `src/views/index.ejs`
- `test/fixtures/operational-history-archive-state.json`
- `test/operational-history-archive.test.js`
- `test/queue-delete-storage.test.js`
- `CHANTER_AUTOPOSTER_OPERATIONAL_HISTORY_CLEANUP_P0_B_RESULT_V1.md`

The existing uncommitted P0 classifier, dry-run CLI, tests, and P0 result remain in the working tree as the required foundation for this P0-B change.

`firestore-debug.log` was pre-existing and was not modified or staged.

## Deterministic local operation evidence

Evidence source:

`test/fixtures/operational-history-archive-state.json`

Execution mode:

`explicit_local_fixture`

Operation ID:

`autoposter-archive-v1-0337dfe05493641ae7a975d91bd5771b2334b734c6acb2f95416c14ce3349d82`

Candidate-set hash:

`dceb46a4f64d877dee4c0965eecfd7b00ac0bea0700acfd729756d17ccea23eb`

Candidate IDs:

- `archive-cancelled`
- `archive-legacy`
- `archive-published`

Archived IDs:

- `archive-cancelled`
- `archive-legacy`
- `archive-published`

Skipped IDs:

- none

Failure reasons:

- none

Before counts:

```text
total: 5
defaultVisible: 5
operational: 2
history: 3
cleanupReview: 0
archived: 0
```

After counts:

```text
total: 5
defaultVisible: 2
operational: 2
history: 3
cleanupReview: 0
archived: 3
```

Other observed evidence:

- preview ready: `true`
- preview mutations: `0`
- execution state: `completed`
- physical deletes: `0`
- repeated operation replayed: `true`
- repeated operation mutation count: `0`
- archived-state and replay-state hashes: equal
- published provider artifact preserved: `true`
- published history entry count preserved: `1`
- input fixture unchanged by preview: `true`

The approver and approval timestamp are present in the signed local operation evidence. The approval signature and process-scoped fixture secret are intentionally not reproduced in this report.

## Required scenario evidence

### Preview-only execution

The CLI preview produced the stable operation ID, candidate-set hash, and exact three-record candidate set with zero writes and zero physical deletes.

### Rejected execution without approval

The CLI execution attempt without an approval file exited with code `2` and error code `archive_input_required`.

The focused service test separately verifies that a complete execution request without founder approval is rejected with `founder_approval_required`.

### Successful bounded archive

The approved local operation archived exactly three of five fixture records and reduced `defaultVisible` from 5 to 2 while retaining all five source records.

### Idempotent repeated operation

Reusing the same operation ID returned the stored evidence with:

```text
replayed: true
replayMutationCount: 0
```

The persisted state hash was unchanged.

### Partial failure reporting

The focused test injects a mutation failure for `archive-legacy`. The operation state is `partial`; the two successful IDs remain in `archivedIds`, the failed ID is reported in `skippedIds`, and its failure reason is retained. The operation is not counted as complete.

### Projection behavior

- Archived rows disappear from the default and Queue projections.
- Archived rows remain visible in History and Activity projections.
- The local successful operation changed `defaultVisible` from 5 to 2 while `history` remained 3.

### Published evidence preservation

The published fixture retains provider artifact ID:

`provider-artifact-local-001`

Its provider evidence and history are byte-for-byte unchanged outside the additive archive envelope.

### Zero physical deletes

- Archive service physical-delete count: `0`
- Archive CLI contains no Firestore, provider, or generic delete dependency.
- Storage regression tests prove both published and archived records are rejected before `transaction.delete`.
- The generic delete path returns `published_history_protected` for both protected cases.

## Authority fail-closed evidence

A preview against the repository's ignored `data/posts.json` returned:

```text
executionReady: false
candidateIds: []
writes: 0
physicalDeletes: 0
```

Observed blockers included:

- missing `postBatches`
- missing `canonicalCommands`
- missing `missionGraphs`
- missing `evidenceRecords`
- invalid canonical collection shapes
- missing archive authority manifest

No mutation was attempted against this incomplete local snapshot.

## Commands executed

Focused tests:

```powershell
node --test test/operational-history-audit.test.js test/operational-history-archive.test.js test/queue-delete-storage.test.js
```

Result:

```text
tests 43
pass 43
fail 0
```

Full suite:

```powershell
npm test
```

Result:

```text
tests 705
pass 705
fail 0
```

Production build:

```powershell
npm run build
```

Result:

```text
Vite 8.0.16
24 modules transformed
built successfully in 109 ms
```

Diff hygiene:

```powershell
git diff --check
```

Result:

```text
PASS
```

PowerShell reported advisory CRLF conversion warnings for existing Windows working-tree files; no whitespace errors were reported.

The local CLI evidence sequence used:

```powershell
npm run archive:history -- preview --input <explicit-fixture> --owner owner-local --output <preview.json>
npm run archive:history -- execute --input <explicit-fixture> --owner owner-local --preview <preview.json>
npm run archive:history -- approve --preview <preview.json> --owner owner-local --approver founder-local --output <approval.json>
npm run archive:history -- execute --input <explicit-fixture> --owner owner-local --preview <preview.json> --approval <approval.json> --output <archived.json>
npm run archive:history -- execute --input <archived.json> --owner owner-local --preview <preview.json> --approval <approval.json> --output <replay.json>
```

`AUTOPOSTER_ARCHIVE_APPROVAL_SECRET` was a process-scoped synthetic fixture secret and was removed from the process after the evidence run.

## Scope control

Deliberately not changed:

- connected accounts
- workspaces
- memberships
- subscriptions
- usage ledgers
- OAuth records
- configuration
- Operator commands
- mission graphs
- external evidence authorities
- provider publishing behavior
- production Firestore

No physical-delete archive implementation, real Firestore connection, deployment, remote mutation, commit, or push occurred.

## Remaining risks and limits

- Proof is local-fixture proof only. No production readiness or production data coverage is claimed.
- The implementation is a repository-local service and explicit local CLI foundation. Wiring a founder archive action to a server endpoint or real emulator-backed repository adapter is outside this task and would require a separately authorized change.
- A synthetic evidence directory may remain under the Windows temporary directory because the environment blocked the attempted cleanup command. It is outside the repository and contains fixture data only.
- P0 and P0-B changes are intentionally uncommitted and coexist in the working tree for review.

## Git status

- Branch: `main`
- Starting HEAD: `30f9e0740657e9230a109f0c5379dddcae63fd52`
- Commit created: no
- Push performed: no
- Deployment performed: no
- Production mutation performed: no
- Working tree: intentionally dirty with the P0/P0-B implementation and result artifacts, plus the pre-existing untracked `firestore-debug.log`
