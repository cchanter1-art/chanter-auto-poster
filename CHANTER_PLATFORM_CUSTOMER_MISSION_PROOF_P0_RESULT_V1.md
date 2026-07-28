# CHANTER Platform — Customer Mission Proof P0 Result V1

## Final verdict

PASS

One existing CHANTER Platform AutoPoster mission now operates as a coherent,
authenticated, persisted, refresh-safe, and duplicate-safe customer flow at the
local HTTP integration boundary.

The proof used two bounded video fixtures, one connected test destination, an
explicit UTC schedule, a manual caption, the existing batch review and
`Accept All` controls, the existing scheduled-work persistence contract, and
the existing Queue and Activity projections. No immediate publish path ran.

## Preflight

- Repository: `apps/chanter-auto-poster`
- Branch: `main`
- Preflight commit: `a554c3b810953d9a6148a47644d6231ed7e42e72`
- P0-E commit: `a554c3b810953d9a6148a47644d6231ed7e42e72`
- P0-E subject: `test(autoposter): align archive emulator project identity`
- Pre-existing unrelated working-tree file: `firestore-debug.log` (untracked,
  not read as authority, not modified, and excluded from the commit)

## Root cause

The existing domain path already created, prepared, reviewed, approved, and
projected a batch correctly. The missing seam was in the customer composer:
after `POST /api/platform/batches` returned the canonical `batchId`, the page
discarded that identifier, hid the form, and showed a generic scheduled
success. The customer therefore could not continue directly into the already
implemented exact-batch review and `Accept All` surface.

The same error branch also discarded the server's concrete rejection reason,
so bounded validation failures lacked an actionable recovery explanation.

## Exact visible workflow

1. Authenticated customer opens `GET /platform/autoposter/compose`.
2. Customer supplies 1–3 media items, date/time, caption, and connected
   destination selection.
3. Composer submits the existing `POST /api/platform/batches` contract.
4. Server-resolved owner/workspace authority creates the existing canonical
   batch and scheduled, unapproved item records.
5. The returned `batch.batchId` now sends the customer to
   `GET /platform/autoposter/compose/:batchId`.
6. The existing review surface invokes
   `POST /api/platform/batches/:batchId/prepare` and reads
   `GET /api/platform/batches/:batchId`.
7. Customer reviews the exact persisted items and invokes
   `POST /api/platform/batches/:batchId/accept-all`.
8. The existing approval service approves each ready item while its execution
   status remains `scheduled`.
9. Reopening the same batch resolves the same persisted `batchId`; Queue and
   Activity project the same work truthfully.

Other accepted composer operations (canonical command and recurring series)
retain their existing compact success treatment.

## Architecture path reused

```text
platform-compose.ejs
  -> platformRoutes.js POST /api/platform/batches
  -> authenticated request context + server commercial/workspace resolution
  -> existing batchService.createBatch
  -> existing application/storage scheduling boundary
  -> returned canonical batchId
  -> existing platform-batch.ejs review
  -> existing prepare/get/accept-all routes
  -> existing approval persistence
  -> existing Queue and Activity work projections
```

No parallel orchestration layer, schema, review model, approval model,
workspace authority, evidence authority, or persistence service was added.

## Persisted identifiers and state transitions

Deterministic local mission evidence:

- Batch ID: `batch-0faa3f9f3bccc586ace6b95cc75de14cedf7292d`
- Item IDs: `post-1`, `post-2`
- Server owner ID: `owner`
- Server workspace ID:
  `workspace-legacy-4c1029697ee358715d3a14a2`
- Destination account ID: `account-a`
- Caption: `Customer mission caption`
- Scheduled times:
  - `2026-07-11T09:00:00.000Z`
  - `2026-07-11T09:30:00.000Z`

Observed state path:

```text
batch preparing + items scheduled/unapproved
  -> batch ready + items readyToAccept
  -> Accept All
  -> batch completed + items scheduled/approved
```

`completed` is the batch review lifecycle state. Each item remains truthfully
`scheduled`; neither the API nor the customer projection claims it was posted.

## Authority, retry, refresh, and failure evidence

- Unauthenticated Platform access redirected to the admin login boundary.
- Browser-supplied `userId`, `workspaceId`, `status`, and `approved` fields did
  not control persisted authority or state.
- The exact intake-key replay returned HTTP 200, the same batch ID, and the same
  two items; duplicate item count remained `0`.
- Repeating `Accept All` accepted `0` new items and did not duplicate approval
  mutations.
- Reopening the batch API returned the same completed batch, both approved
  scheduled items, and the persisted caption.
- Queue exposed the same batch before approval; Activity exposed the same batch
  as `Completed` after approval.
- A disconnected destination returned HTTP 409 with
  `destination_unavailable` and the concrete recovery reason. It created no
  partial scheduled work.
- Provider publish calls: `0`.
- Persisted `postedAt` values: none.

## Files changed

- `src/views/platform-compose.ejs`
  - Propagates the accepted canonical batch ID into the existing review route.
  - Preserves compact success for command/series flows.
  - Displays the server's bounded rejection reason or a concrete fallback
    recovery action.
- `test/platform-customer-surface.test.js`
  - Locks the review handoff, preserved compact paths, and actionable fallback.
- `test/platform-batch.test.js`
  - Adds an authenticated local HTTP mission across the real routes, auth
    middleware, view rendering, and batch service with the established
    in-memory persistence/provider fixtures.
- `CHANTER_PLATFORM_CUSTOMER_MISSION_PROOF_P0_RESULT_V1.md`
  - Records this result and evidence.

## Validation evidence

Focused syntax, template, and mission gate:

```powershell
node --check test/platform-batch.test.js
node -e "const ejs=require('ejs'); const fs=require('fs'); ejs.compile(fs.readFileSync('src/views/platform-compose.ejs','utf8'),{filename:'src/views/platform-compose.ejs'}); console.log('EJS compile PASS')"
node --test test/platform-customer-surface.test.js test/platform-batch.test.js
```

Result: PASS — EJS compile passed; tests `18`, pass `18`, fail `0`,
cancelled `0`, skipped `0`, todo `0`.

Two earlier diagnostic runs failed only on test-harness/rendered-markup
expectations while the HTTP test was being established: first `16/18`, then
`17/18`. The final focused command above passed without changing domain
behavior to obtain the result.

Expanded Platform gate:

```powershell
node --test test/platform-batch.test.js test/platform-customer-surface.test.js test/platform-destination-chips.test.js test/platform-work-providers.test.js test/platform-shell.test.js test/unified-composer.test.js
```

Result: PASS — tests `133`, pass `133`, fail `0`, cancelled `0`, skipped `0`,
todo `0`.

Full suite:

```powershell
npm test
```

Result: PASS — tests `708`, pass `708`, fail `0`, cancelled `0`, skipped `0`,
todo `0`.

Production build:

```powershell
npm run build
```

Result: PASS — configured prebuild/build syntax and EJS checks passed; Vite
8.0.16 transformed 24 modules and completed the production bundle.

Diff hygiene:

```powershell
git diff --check
git diff --cached --check
```

Result: PASS — both commands exited `0`.

## Remaining risks and intentionally untested boundaries

- This is local HTTP integration proof on `127.0.0.1` using the repository's
  real routes, authentication middleware, EJS views, and batch service over its
  established in-memory test storage/provider fixtures.
- No browser automation ran; this result does not claim browser proof.
- No Firestore emulator or real Firestore project was used for this mission, so
  this result does not claim Firestore integration or production persistence
  proof.
- No real media processor, AI caption provider, connected provider API, or
  production account was exercised.
- The customer-visible handoff uses `window.location.assign`; its rendered
  contract and complete destination HTTP route are covered, while actual
  browser navigation remains an external UI boundary.

## Commit and final repository state

- Required bounded commit subject:
  `feat(platform): prove customer autoposter scheduling mission`
- This result file is part of that commit. A Git commit cannot contain its own
  final object hash; the exact resulting hash is therefore recorded in the
  final handoff alongside the post-commit `git status --short`.
- `firestore-debug.log` remains the sole intended unrelated untracked file.

No push, deployment, production connection, provider call, publish, or
production mutation occurred.
