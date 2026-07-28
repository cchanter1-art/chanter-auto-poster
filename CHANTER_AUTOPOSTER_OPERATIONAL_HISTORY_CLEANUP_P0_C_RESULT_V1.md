# CHANTER AutoPoster — Operational History Cleanup P0-C Result V1

## Final verdict

**PASS — FIRESTORE EMULATOR ARCHIVE FOUNDATION**

The founder-controlled operational archive now executes through the real Firebase Firestore emulator repository boundary. The approved candidate set is archived automatically and transactionally per record, operation evidence is persisted, projections update, and replay performs zero duplicate mutations.

This is emulator proof only. It is not production readiness or production-data proof.

No production Firestore project, provider API, deployment, push, or production mutation was used.

## Exact visible outcome

```text
Founder requests preview
→ service reads owner-scoped canonical records from Firestore emulator
→ service freezes the bounded candidate set and operation hash
→ founder supplies owner-bound signed approval
→ service archives exactly the approved records
→ Default and Queue projections exclude archived records
→ History and Activity retain recoverable evidence
→ operation evidence is persisted in Firestore emulator
→ replay returns the stored result with zero duplicate mutations
```

The canonical `archive:history` command now uses the emulator-backed service. The P0-B JSON implementation remains available only as the explicitly named `archive:history:fixture` command.

## Contracts reused

No second archive domain model or new archive schema was introduced.

- Archive envelope: `chanter.autoposter.operational-archive.v1`
- Operation evidence: `chanter.autoposter.operational-archive-operation.v1`
- Founder approval: `chanter.autoposter.operational-archive-approval.v1`
- Authority manifest: `chanter.autoposter.archive-authority-manifest.v1`
- Maximum candidate batch: `100`
- Eligible classifications: `published`, `cancelled`, `legacy`
- Archive representation: additive `operationalArchive` envelope
- Physical deletion allowed: `false`

P0-C strengthens the existing approval binding by including the explicit `ownerId` in the signed HMAC payload and replay verification.

## Firestore emulator repository boundary

The adapter reads these owner-scoped canonical collections:

- `posts` by `userId`
- `postBatches` by `userId`
- `canonicalCommands` by `ownerId`
- `missionGraphs` by `ownerId`
- `evidenceRecords` by `ownerId`

It reads the P0-B authority manifest from:

- `operationalArchiveAuthority/{owner-hash}`

It persists immutable operation evidence to:

- `operationalArchiveOperations/{operationId}`

Each record archive update runs through a Firestore transaction that:

1. rereads the exact document;
2. verifies ownership;
3. rejects an existing archive owned by another operation;
4. compares the frozen record fingerprint;
5. updates only `operationalArchive`.

Operation evidence is create-only inside a Firestore transaction. Existing evidence is returned rather than overwritten.

## Emulator safety configuration

- Firebase CLI: `15.22.0`
- Java: OpenJDK `21.0.11`
- Node: `22.22.0`
- Demo project: `demo-chanter-autoposter-archive`
- Authority mode: `firestore_emulator`
- Emulator host: required and restricted to loopback
- Production project IDs: rejected
- Missing emulator host: rejected
- Non-loopback emulator host: rejected
- Production Firebase credential fields: not imported or read by the archive execution path
- Provider clients: not imported
- Generic storage/delete service: not imported

Firebase reported:

```text
Detected demo project ID "demo-chanter-autoposter-archive",
emulated services will use a demo configuration and attempts to access
non-emulated services for this project will fail.
```

## Successful operation evidence

Operation ID:

`autoposter-archive-v1-565e77bdabed425fba8fe7271ee30eeaf1788bd185c012ae3fd1f0876a89979a`

Candidate-set hash:

`b18ad9b5444cf3c0477527c77500e1ee94fdbc2f62a8917aa409e06a109ca819`

Candidate IDs:

- `emulator-archive-cancelled`
- `emulator-archive-legacy`
- `emulator-archive-published`

Archived IDs:

- `emulator-archive-cancelled`
- `emulator-archive-legacy`
- `emulator-archive-published`

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

Physical deletes:

`0`

## Founder approval rejection evidence

The emulator integration proves:

- execution without founder approval returns `founder_approval_required`;
- a signed approval with a mismatched owner returns `founder_approval_invalid`;
- a mismatched operation ID returns `founder_approval_invalid`;
- a mismatched candidate-set hash returns `founder_approval_invalid`;
- each rejected execution leaves the candidate documents unchanged.

## Replay evidence

The repeated approved operation returned:

```text
replayed: true
replayMutationCount: 0
persisted operation documents for owner: 1
```

The owner-scoped dataset was identical before and after replay.

## Partial-failure evidence

Forced failing record:

`partial-archive-legacy`

Partial archived IDs:

- `partial-archive-cancelled`
- `partial-archive-published`

Partial skipped IDs:

- none

Failure evidence:

```text
recordId: partial-archive-legacy
reason: Emulator-injected archive failure for partial-archive-legacy.
```

Partial state:

`partial`

Partial before/after:

```text
before defaultVisible: 5
after defaultVisible: 3
before archived: 0
after archived: 2
physicalDeletes: 0
```

The partial evidence was persisted and returned by operation-result retrieval. It was never reported as complete.

## Projection proof

- Default projection changed from 5 visible rows to 2.
- Queue excluded all three successfully archived candidate IDs.
- History retained all three archived candidate IDs.
- Activity retained the archived published item because its durable evidence remained present.
- Operational count remained 2.
- History count remained 3.

## Provider and evidence preservation

The emulator-stored published record preserved:

- `publishId`: `provider-artifact-local-001`
- `providerOperation.externalVideoId`: `provider-artifact-local-001`
- original history entry count: `1`

The complete stored record was byte-for-byte identical to its seeded source after removing only the additive `operationalArchive` envelope.

No provider client was imported or called.

## Zero-physical-delete proof

- Successful operation evidence: `physicalDeletes: 0`
- Partial operation evidence: `physicalDeletes: 0`
- Replay mutation count: `0`
- Adapter source contains no `.delete(` call.
- Archive command source contains no `deletePost(` call.
- Real-emulator calls through the existing generic delete path rejected both published and archived records with `published_history_protected`.
- Both rejected documents remained present.
- No media-destruction call occurred.

Test-fixture teardown is achieved by emulator shutdown, not by the archive implementation.

## Files changed

The review checkpoint contains only the cumulative P0, P0-B, and P0-C implementation:

- `package.json`
- `CHANTER_AUTOPOSTER_OPERATIONAL_HISTORY_CLEANUP_P0_RESULT_V1.md`
- `CHANTER_AUTOPOSTER_OPERATIONAL_HISTORY_CLEANUP_P0_B_RESULT_V1.md`
- `CHANTER_AUTOPOSTER_OPERATIONAL_HISTORY_CLEANUP_P0_C_RESULT_V1.md`
- `scripts/operational-history-audit.js`
- `scripts/operational-history-archive.js`
- `scripts/operational-history-archive-emulator.js`
- `src/operationalHistoryAudit.js`
- `src/operationalHistoryArchive.js`
- `src/operationalHistoryArchiveFirestore.js`
- `src/platformRoutes.js`
- `src/platformStatus.js`
- `src/postsMapper.js`
- `src/storage.js`
- `src/views/index.ejs`
- `test/fixtures/operational-history-archive-state.json`
- `test/operational-history-audit.test.js`
- `test/operational-history-archive.test.js`
- `test/operational-history-archive-firestore-emulator.test.js`
- `test/queue-delete-storage.test.js`

The pre-existing untracked `firestore-debug.log` is explicitly excluded from the checkpoint.

## Commands executed

Environment and emulator availability:

```powershell
firebase --version
& 'C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot\bin\java.exe' -version
firebase emulators:exec --only firestore --project demo-chanter-autoposter-archive "node --version"
```

Dedicated real-emulator integration:

```powershell
npm run test:archive:emulator
```

Final dedicated result:

```text
tests 14
pass 14
fail 0
skipped 0
```

Combined focused validation:

```powershell
firebase emulators:exec --only firestore --project demo-chanter-autoposter-archive "node --test test/operational-history-audit.test.js test/operational-history-archive.test.js test/operational-history-archive-firestore-emulator.test.js test/queue-delete-storage.test.js"
```

Result:

```text
tests 57
pass 57
fail 0
skipped 0
```

Full suite:

```powershell
npm test
```

Result:

```text
tests 706
pass 706
fail 0
skipped 0
```

Production build:

```powershell
npm run build
```

Result:

```text
Vite 8.0.16
24 modules transformed
built successfully in 107 ms
```

Diff hygiene:

```powershell
git diff --check
```

Result:

```text
PASS
```

PowerShell/Git emitted advisory LF-to-CRLF working-copy warnings. No whitespace errors were reported.

## Bounded correction history

The first emulator integration run exposed:

- one real approval-contract gap: owner identity was implicit in the operation ID but absent from the signed approval payload;
- four test-shape mismatches involving Firebase Admin app options, Platform `workId`, operation document IDs, and state changed by the owner-binding gap.

One bounded correction added explicit owner binding and corrected the test expectations. The second emulator run passed all scenarios. No speculative rewrite was used.

## Scope control

Deliberately not implemented or changed:

- production Firestore execution
- customer-facing UI
- deployment
- scheduled cleanup
- autonomous approval
- physical deletion
- retention policy
- Operator integration
- provider publishing behavior
- connected accounts
- workspaces or memberships
- subscriptions or billing
- OAuth records
- usage ledgers
- mission graphs
- external evidence authorities

## Remaining risks and limitations

- This is deterministic Firestore emulator proof only.
- No production data authority coverage has been inspected or claimed.
- The internal service/command is not a customer-facing route.
- The authority manifest remains an explicit founder-controlled completeness assertion; P0-C validates it but does not create an autonomous authority-discovery system.
- Per-record transactions deliberately permit evidence-backed partial outcomes. Cross-record all-or-nothing archiving is not claimed.
- `firestore-debug.log` remains outside the checkpoint as a pre-existing untracked emulator log.

## Git checkpoint

- Branch: `main`
- Starting HEAD: `30f9e0740657e9230a109f0c5379dddcae63fd52`
- Checkpoint message: `feat(autoposter): add emulator-backed operational history archive`
- Scope: cumulative P0, P0-B, and P0-C only
- Excluded: `firestore-debug.log`
- Push: not performed
- Deployment: not performed
- Production mutation: not performed

The checkpoint commit is created only after this artifact and the final validation state are complete.
