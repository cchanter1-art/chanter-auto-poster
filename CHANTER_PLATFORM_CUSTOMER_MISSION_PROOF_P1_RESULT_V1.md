# CHANTER Platform — Customer Mission Proof P1 Result V1

## Final verdict

PASS

The exact existing AutoPoster customer mission completed in a real system
Chrome browser against a loopback-only application boundary. Canonical
navigation, persisted review, preparation, `Accept All`, refresh, idempotent
replay, Queue, Activity, exact-batch reopen, and disconnected-destination
recovery all passed.

The evidence shows zero provider publish calls, zero duplicate work or
approvals, no persisted `postedAt` values, no false publish claim, and no
external request. This is deterministic local browser proof, not production
persistence or provider proof.

## Preflight

- Repository: `apps/chanter-auto-poster`
- Branch: `main`
- Exact P0 commit: `c999eda6aba218a10a3d677b724f851fa4c205c9`
- Exact P1 starting HEAD: `c999eda6aba218a10a3d677b724f851fa4c205c9`
- P0 subject: `feat(platform): prove customer autoposter scheduling mission`
- Starting unrelated state: only untracked `firestore-debug.log`

## Browser harness

- Driver: repository-local `playwright-core` 1.62.0
- Browser: installed system Google Chrome at
  `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Mode: headless, loopback HTTP, UTC browser timezone
- Authentication: a real signed admin session cookie consumed by the canonical
  authentication middleware
- Persistence boundary: P0's established deterministic in-memory test world
- Preparation boundary: deterministic fake preparation provider
- Media boundary: two bounded temporary pseudo-MP4 fixtures, deleted after use
- External network: blocked; the synthetic media URL was fulfilled locally
- Firestore, OAuth, production credentials, real accounts, and provider APIs:
  unused

## Exact visible workflow

```text
GET /platform/autoposter/compose
-> upload browser-mission-a.mp4 + browser-mission-b.mp4
-> select account-a
-> set 2026-08-01 09:00 UTC
-> enter Customer browser mission caption
-> submit through the real browser page handler
-> navigate to the canonical batch URL
-> load the exact two-item persisted review
-> prepare both items
-> Accept All
-> completed review lifecycle + scheduled/approved items
-> refresh
-> replay the same deterministic intake
-> Queue
-> Activity
-> reopen the exact batch
-> exercise disconnected-destination recovery
```

## Deterministic mission evidence

- Canonical batch ID:
  `batch-e428a81c0cd6420e65fd31866f56c9b3d86c473d`
- Final canonical path:
  `/platform/autoposter/compose/batch-e428a81c0cd6420e65fd31866f56c9b3d86c473d`
- Item IDs: `post-1`, `post-2`
- Server owner: `owner`
- Server workspace: `workspace-legacy-4c1029697ee358715d3a14a2`
- Destination ID: `account-a`
- Caption: `Customer browser mission caption`
- Scheduled times:
  - `2026-08-01T09:00:00.000Z`
  - `2026-08-01T09:30:00.000Z`
- State transition:
  `preparing -> ready -> scheduled`, with batch review lifecycle `completed`
- Final item states: `scheduled`, `scheduled`
- Approved count: `2`
- Duplicate item count after identical UI replay: `0`
- Duplicate approval count after repeated `Accept All`: `0`
- Provider publish calls: `0`
- Persisted `postedAt` values: `null`, `null`

Browser-supplied hidden `userId`, `workspaceId`, `status`, and `approved`
values did not override server-resolved authority or scheduled/unapproved
intake truth.

## Navigation, refresh, and projection evidence

- Composer submission caused a real browser navigation to the exact canonical
  batch path.
- The review rendered exactly `post-1` and `post-2`.
- Refresh retained the same batch ID, item IDs, destination, caption, schedule,
  approvals, and scheduled states.
- Replaying the same intake key returned the same batch and created no item.
- Repeating `Accept All` created no additional approval.
- Reopening the exact batch created no scheduled work.
- Queue showed the same batch as `Scheduled`.
- Activity showed the same batch review lifecycle as `Completed`.
- Neither surface claimed posted, published, provider accepted, or provider
  completed.

## Disconnected-destination recovery

The browser changed the captured destination control to
`account-not-connected` and submitted the normal composer:

- response: HTTP 409;
- code: `destination_unavailable`;
- concrete reason: destination is not connected and publishing-ready;
- partial batches/items created: `0`;
- scheduled work created: `0`;
- false-success state: none;
- composer remained visible and recoverable;
- screenshot captured.

Chrome reports a failed resource for the intentional 409. It was captured as
the one expected recovery console entry, not suppressed:

```text
Failed to load resource: the server responded with a status of 409 (Conflict)
```

- Unexpected console errors: `0`
- Browser request failures: `0`
- Unexpected HTTP failures: `0`
- External requests: `0`

## Browser-visible defect fixed

The real browser proved that a completed review batch disappeared from Queue
even while its approved items remained scheduled. The root cause was a
projection filter that treated batch review lifecycle `completed` as provider
execution completion.

The bounded correction preserves the explicit archive boundary, keeps ordinary
non-completed work unchanged, and reopens only the exact completed-review batch
to determine whether approved items remain in active
`pending`/`scheduled`/`ready`/`processing` states. Scheduled work renders as
`Scheduled`; terminal posted history remains Activity-only; an unreadable
batch fails closed instead of guessing.

## Screenshot evidence

Committed test-only evidence directory:

`test/evidence/platform-customer-mission-p1/`

- `01-composer-before-submit.png`
- `02-exact-batch-review-ready.png`
- `03-after-accept-all.png`
- `04-after-refresh.png`
- `05-queue.png`
- `06-activity.png`
- `07-disconnected-destination-error.png`

The images contain no cookies, tokens, approval signatures, production account
data, or personal data.

## Files changed

- `package.json`
- `package-lock.json`
- `src/platformRoutes.js`
- `src/views/platform-autoposter-list.ejs`
- `test/platform-batch.test.js`
- `test/platform-shell.test.js`
- `test/evidence/platform-customer-mission-p1/01-composer-before-submit.png`
- `test/evidence/platform-customer-mission-p1/02-exact-batch-review-ready.png`
- `test/evidence/platform-customer-mission-p1/03-after-accept-all.png`
- `test/evidence/platform-customer-mission-p1/04-after-refresh.png`
- `test/evidence/platform-customer-mission-p1/05-queue.png`
- `test/evidence/platform-customer-mission-p1/06-activity.png`
- `test/evidence/platform-customer-mission-p1/07-disconnected-destination-error.png`
- `CHANTER_PLATFORM_CUSTOMER_MISSION_PROOF_P1_RESULT_V1.md`

No browser cache, trace, video, temporary upload, or generated build artifact
is included.

## Commands executed and exact results

Preflight and discovery:

```powershell
git status --short --branch
git log -3 --oneline
Get-Content package.json
Get-ChildItem -Recurse -File | Where-Object {
  $_.Name -match 'playwright|cypress|puppeteer|browser|e2e'
}
```

Result: P0 found at the exact hash above; no existing repository browser
harness; only `firestore-debug.log` was unrelated and untracked.

Bounded dependency and browser probe:

```powershell
npm install --save-dev --ignore-scripts playwright-core@1.62.0
node -e "<launch installed Chrome with playwright-core>"
```

Result: dependency installed; Chrome launched successfully without downloading
a browser binary. NPM reported 12 audit findings (1 low, 9 moderate, 2 high);
no audit mutation was run because dependency remediation is outside P1.

Browser mission gate:

```powershell
npm run test:platform:browser
```

Result: 1 test, 1 passed, 0 failed, 0 skipped.

Archive regression invariant:

```powershell
node --test --test-name-pattern="live Queue filters archived work" test/operational-history-archive.test.js
```

Result: 1 test, 1 passed, 0 failed.

Existing focused Platform gate:

```powershell
node --test test/platform-batch.test.js test/platform-customer-surface.test.js test/platform-destination-chips.test.js test/platform-work-providers.test.js test/platform-shell.test.js test/unified-composer.test.js
```

Result: 135 tests, 135 passed, 0 failed, 0 skipped.

Full suite:

```powershell
npm test
```

Result: 710 tests, 710 passed, 0 failed, 0 skipped.

Production build:

```powershell
npm run build
```

Result: PASS; all configured Node syntax checks, EJS compilation, and Vite
production build completed successfully.

Diff hygiene:

```powershell
git diff --check
git diff --cached --check
```

Result: PASS. Git emitted only expected Windows LF-to-CRLF working-copy
warnings; no whitespace errors were found.

## Bounded correction history

1. The first browser attempt exposed interaction with a control hidden behind
   the existing Options disclosure. The test opened that disclosure before
   filling the field.
2. The next attempt exposed the real Queue projection defect described above.
   The production correction was limited to execution-aware Queue projection
   and one focused route test.
3. The initial disconnected test injected a new checkbox after the composer's
   script had captured its controls, so no request was sent. The original task
   stopped PARTIAL after its bounded correction limit.
4. When the same P1 task was explicitly resumed, the test reused the captured
   destination checkbox with a disconnected ID. The required 409 recovery
   passed without changing production validation.
5. The first full-suite run exposed an archive test's source invariant after
   the Queue filter moved into a helper. The helper was made explicitly
   archive-safe; the archive invariant, focused gate, and full suite then
   passed. No test was weakened.

## Scope control

- No UI redesign or parallel mission path.
- No Firestore or Firestore emulator connection.
- No provider, OAuth, external network, or production call.
- No production account, credential, or customer data.
- No deployment or push.
- No Operator or adjacent repository change.
- `firestore-debug.log` remains excluded and untouched.

## Remaining risks

- This proves the local deterministic browser boundary only; it does not prove
  production Firestore persistence, OAuth connectivity, provider acceptance,
  or publication.
- The installed dependency report contains 12 existing/transitive audit
  findings; remediation was not expanded into this mission.
- The browser harness uses an installed Chrome binary and therefore requires
  Chrome to exist on the validating host.

## Git status and checkpoint

Before the required checkpoint, the P1 diff was confined to the files listed
above on `main`, with only unrelated `firestore-debug.log` left untracked.

Required local commit subject:

```text
test(platform): prove customer mission in browser
```

The final handoff records the resulting commit hash. No push, deployment,
production connection, Firestore connection, OAuth operation, provider call,
publish, or production mutation occurred.
