# CHANTER AutoPoster - Operational History Cleanup P0-E Result V1

## Final verdict

**PASS - ARCHIVE EMULATOR PROJECT IDENTITY ALIGNED**

The complete operational-history archive emulator lane now uses one canonical
test-only Firebase project identity:

```text
demo-chanter-autoposter-archive
```

Fresh canonical and expanded emulator runs contain no multi-project warning and
no request for `chanter-site`. All P0-D archive behavior remains unchanged.

This is local emulator evidence only. It is not production readiness or
production-data proof.

## Root cause

The Firebase emulator command already selected
`demo-chanter-autoposter-archive`, and the archive-specific Admin app used the
Firebase CLI-provided `GCLOUD_PROJECT`.

The expanded P0-D gate also runs normal private-route and queue-delete tests.
Those workers load the repository's normal Firebase configuration, which
resolved `FIREBASE_PROJECT_ID` to `chanter-site`. As a result, the same
single-project emulator received requests for two project IDs.

Pre-change `firestore-debug.log` contained four occurrences of:

```text
Multiple projectIds are not recommended in single project mode.
Requested project ID chanter-site, but the emulator is configured for
demo-chanter-autoposter-archive.
```

This was a test-process identity mismatch, not an archive candidate,
repository, approval, or persistence defect.

## Before and after identity resolution

### Before

- Firebase CLI project: `demo-chanter-autoposter-archive`
- Archive Admin app project: `demo-chanter-autoposter-archive`
- Normal Firebase config in focused test workers: `chanter-site`
- Emulator single-project warning count: `4`
- `chanter-site` request count in the fresh focused log: `4`

### After

- Firebase CLI project: `demo-chanter-autoposter-archive`
- Archive Admin app project: `demo-chanter-autoposter-archive`
- `GCLOUD_PROJECT`: `demo-chanter-autoposter-archive`
- `GOOGLE_CLOUD_PROJECT`: `demo-chanter-autoposter-archive`
- `FIREBASE_PROJECT_ID`: `demo-chanter-autoposter-archive`
- `VITE_FIREBASE_PROJECT_ID`: `demo-chanter-autoposter-archive`
- Emulator host: `127.0.0.1:8080`
- Emulator single-project warning count: `0`
- `chanter-site` request count in both fresh logs: `0`

The four environment values are set only in the child environment created by
the archive emulator test runner. Production defaults, `.env`, `.firebaserc`,
and deployment configuration were not changed.

## Implementation

The archive emulator safety guard now accepts only the canonical project
`demo-chanter-autoposter-archive`. It no longer accepts arbitrary project IDs
merely because they begin with `demo-`.

The new test runner:

1. requires a loopback `FIRESTORE_EMULATOR_HOST`;
2. validates the canonical project through the archive safety guard;
3. injects the canonical project into all four project-resolution variables;
4. starts Node's test runner without a shell;
5. preserves the child test exit code;
6. offers fixed `canonical` and `focused` suites.

The established test counts do not change. Existing emulator tests now assert
that every project-resolution variable and the Firebase Admin app use the
canonical identity. They also prove that both `chanter-site` and a different
`demo-` project fail closed.

## Exact files changed

- `package.json`
- `src/operationalHistoryArchiveFirestore.js`
- `scripts/operational-history-archive-emulator-tests.js`
- `test/operational-history-archive-firestore-emulator.test.js`
- `test/operational-history-archive-controls-emulator.test.js`
- `CHANTER_AUTOPOSTER_OPERATIONAL_HISTORY_CLEANUP_P0_E_RESULT_V1.md`

No archive classifier, candidate selection, approval, replay, persistence,
projection, route, UI, provider, or generic delete implementation changed.

## Fresh warning-free emulator evidence

Both fresh runs printed the canonical identity before starting test workers:

```text
[ARCHIVE_EMULATOR_IDENTITY] suite=canonical projectId=demo-chanter-autoposter-archive host=127.0.0.1:8080
[ARCHIVE_EMULATOR_IDENTITY] suite=focused projectId=demo-chanter-autoposter-archive host=127.0.0.1:8080
```

After each emulator shutdown, the newly generated `firestore-debug.log` was
searched for both the warning text and `chanter-site`.

Canonical result:

```text
[ARCHIVE_EMULATOR_WARNING_CHECK] PASS count=0
[ARCHIVE_EMULATOR_CHANTER_SITE_CHECK] PASS count=0
```

Focused result:

```text
[ARCHIVE_FOCUSED_WARNING_CHECK] PASS count=0
[ARCHIVE_FOCUSED_CHANTER_SITE_CHECK] PASS count=0
```

`singleProjectMode: false` was not added.

## Validation

### Canonical archive emulator gate

```powershell
$env:JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot'
$env:PATH="$env:JAVA_HOME\bin;$env:PATH"
npm run test:archive:emulator
```

Result:

- tests: `27`
- pass: `27`
- fail: `0`
- skipped: `0`
- mismatch warnings: `0`
- `chanter-site` requests: `0`

The deterministic operation evidence remained unchanged:

- operation ID:
  `autoposter-archive-v1-2ae268b008137ecc3977cb3feca378f9ec0ffc20a40e777057ae59480d618f58`
- archived IDs:
  - `control-archive-cancelled`
  - `control-archive-legacy`
  - `control-archive-published`
- skipped IDs: none
- failures: none
- physical deletes: `0`

### Expanded focused emulator gate

```powershell
npm run test:archive:focused:emulator
```

Result:

- tests: `75`
- pass: `75`
- fail: `0`
- skipped: `0`
- mismatch warnings: `0`
- `chanter-site` requests: `0`

### Full suite

```powershell
npm test
```

Result:

- tests: `707`
- pass: `707`
- fail: `0`
- skipped: `0`

### Production build

```powershell
npm run build
```

Result: **PASS**

- P0-E runner syntax check: pass
- archive source and test syntax checks: pass
- EJS compilation: pass
- Vite production build: pass
- transformed modules: `24`

### Diff hygiene

```powershell
git diff --check
git diff --cached --check
```

Result: **PASS**

## Safety proof

- Host accepted by the tested flow: loopback `127.0.0.1:8080`
- Project accepted by the tested flow:
  `demo-chanter-autoposter-archive`
- `chanter-site`: explicitly rejected by the safety guard
- another `demo-` ID: explicitly rejected by the safety guard
- missing emulator host: explicitly rejected
- non-loopback emulator host: explicitly rejected
- production credential or production project used: no
- physical deletes: `0`
- provider calls: none
- production Firestore connections: none

The Firebase CLI also reports that non-emulated services for the selected
`demo-` project fail closed.

## Scope control

Deliberately unchanged:

- `.firebaserc` and normal production project selection;
- Firebase production credentials;
- Firestore rules and indexes;
- archive classification and eligibility;
- candidate freezing and hashing;
- founder approval signing;
- operation evidence and replay;
- archive persistence and projections;
- connected accounts, OAuth, billing, subscriptions, workspaces, and missions;
- provider clients and publishing;
- generic storage/delete behavior;
- deployment state.

No dependency was added.

## Remaining risks

- This is deterministic local emulator proof only.
- The archive lane remains intentionally unavailable outside a loopback
  emulator using the exact canonical demo project.
- `firestore-debug.log` remains an untracked local emulator artifact and is
  excluded from the checkpoint.

## Git checkpoint and final status

- Parent P0-D checkpoint: `0c2a3b8`
- P0-E checkpoint message:
  `test(autoposter): align archive emulator project identity`
- P0-E checkpoint scope: only the six files listed above
- Excluded: `firestore-debug.log`

The exact P0-E commit hash is reported in the final handoff. A Git commit cannot
embed its own content-derived hash inside a file committed by that same commit.

After the checkpoint, `git status --short` contains only:

```text
?? firestore-debug.log
```

No push, deployment, production connection, provider call, publish, production
mutation, or physical deletion occurred.

## Lane closeout

Operational History Cleanup P0 through P0-E is closed at the local,
emulator-proven boundary.

No production archive deployment work was opened. Control returns to the next
visible CHANTER Platform or commercial execution priority.
