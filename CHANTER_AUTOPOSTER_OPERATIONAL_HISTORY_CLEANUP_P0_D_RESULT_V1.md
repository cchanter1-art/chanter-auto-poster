# CHANTER AutoPoster - Operational History Cleanup P0-D Result V1

## Final verdict

**PASS - FOUNDER CONTROL SURFACE PROVEN IN THE FIRESTORE EMULATOR**

The founder can now open an authenticated internal AutoPoster page, request an
exact bounded archive preview, explicitly confirm that preview, execute the
canonical P0-C archive service automatically, and inspect sanitized persisted
operation evidence.

This is local Firestore emulator proof only. It is not production readiness or
production-data proof.

No production Firestore project, provider API, physical delete, deployment,
push, or production mutation was used.

## Preflight

- Repository: `apps/chanter-auto-poster`
- Branch: `main`
- Required P0-C checkpoint: `179bf2f`
- Checkpoint subject:
  `feat(autoposter): add emulator-backed operational history archive`
- Starting working tree: only untracked `firestore-debug.log`
- The emulator log remained excluded from the P0-D checkpoint.

## Exact visible founder workflow

```text
Founder signs in through the existing internal admin session
-> opens /internal/operational-history/archive
-> selects Preview archive candidates
-> reviews classification counts, exact IDs, operation ID, and candidate hash
-> sees the additive-archive / zero-delete warning
-> explicitly confirms Approve & archive
-> server revalidates the frozen preview
-> server creates the signed owner-bound approval
-> canonical P0-C emulator service archives the exact approved set
-> page shows completed or partial evidence truthfully
-> retry returns persisted replay evidence with zero duplicate mutation
```

The UI exposes idle, preview-ready/blocked, executing, completed, partial, and
rejected/blocked states. Duplicate submission controls are disabled while a
request is in flight.

## Routes

- `GET /internal/operational-history/archive`
- `POST /internal/operational-history/archive/preview`
- `POST /internal/operational-history/archive/execute`
- `GET /internal/operational-history/archive/operations/:operationId`

The main AutoPoster internal console links to the new control page.

## Authentication and founder boundary

The repository currently has one signed internal admin session rather than a
separate multi-founder role system. P0-D treats that existing single-admin
boundary as the founder boundary:

- `req.isAdmin` must be true;
- the signed session role must be `admin`;
- the signed session subject must be present;
- owner scope is derived from that subject;
- browser-supplied `ownerId` is ignored;
- unauthenticated page access redirects to the admin login;
- unauthenticated API access returns `founder_auth_required`;
- the return-to allowlist admits only the exact founder control page.

No customer or client session can satisfy this boundary.

## Approval-signing boundary

- The browser sends only the operation ID, candidate-set hash, and exact
  confirmation token.
- The server accepts only a server-issued, unexpired preview.
- Before first execution, the server regenerates the preview and compares the
  operation ID, candidate-set hash, and exact ordered candidate IDs.
- The server creates the signed approval with the authenticated owner, exact
  operation ID, exact candidate hash, and server timestamp.
- The process-scoped approval secret stays behind the route's server-side
  command factory.
- Browser HTML and JSON use closed allowlists and contain neither the approval
  secret nor a raw/derived approval signature.

The server-issued preview registry is intentionally process-local and expires
after ten minutes. A restart or expiry requires a new preview and fails closed.

## Successful emulator operation evidence

- Evidence ID / operation ID:
  `autoposter-archive-v1-2ae268b008137ecc3977cb3feca378f9ec0ffc20a40e777057ae59480d618f58`
- Candidate-set hash:
  `fa595724f6ee107670077fa964263cf1fb2e95c11d55ca48a7d43b8d7ae59c6e`
- Candidate IDs:
  - `control-archive-cancelled`
  - `control-archive-legacy`
  - `control-archive-published`
- Archived IDs:
  - `control-archive-cancelled`
  - `control-archive-legacy`
  - `control-archive-published`
- Skipped IDs: none
- Failures: none
- State: `completed`
- Physical deletes: `0`

### Before counts

- total: `5`
- default visible: `5`
- operational: `2`
- history: `3`
- cleanup review: `0`
- archived: `0`

### After counts

- total: `5`
- default visible: `2`
- operational: `2`
- history: `3`
- cleanup review: `0`
- archived: `3`

Default and Queue omit all three archived records. History retains all three,
and Activity retains the published record's evidence. The published provider
and evidence identifiers remain unchanged outside the additive archive
envelope.

## Replay evidence

The same operation ID and candidate-set hash were submitted again through the
execute route:

- persisted evidence was returned;
- `replayed`: `true`;
- `replayMutationCount`: `0`;
- the complete emulator dataset was identical before and after replay.

## Partial-failure evidence

A second bounded operation injected one deterministic per-record repository
failure:

- Candidates:
  - `partial-control-archive-cancelled`
  - `partial-control-archive-legacy`
  - `partial-control-archive-published`
- Archived:
  - `partial-control-archive-cancelled`
  - `partial-control-archive-published`
- Failed:
  - `partial-control-archive-legacy`
- Exact reason:
  `Control-injected archive failure for partial-control-archive-legacy.`
- Returned state: `partial`
- Physical deletes: `0`

The partial result and reason were persisted and returned; it was never
reported as complete.

## Fail-closed and security evidence

The deterministic route/control test covers all fourteen required scenarios
within twelve grouped subtests:

1. exact P0-C candidate preview;
2. preview zero mutation;
3. unauthenticated/non-founder rejection;
4. ignored browser owner spoofing;
5. execute-without-preview rejection;
6. changed-hash and changed-record rejection;
7. explicit approval of the exact frozen set;
8. replay with zero duplicate mutation;
9. exact persisted partial failure;
10. Default/Queue exclusion and History/Activity retention;
11. secret/signature absence from markup and every tested response;
12. non-emulator fail-closed response;
13. physical deletes equal zero;
14. no provider, production Firebase, credential, storage-delete, or generic
    delete client imported by the route.

The inherited P0-C safety tests additionally prove that:

- the emulator host must be loopback;
- the Firebase project must be a `demo-` project;
- incomplete owner authority coverage is rejected;
- generic deletion rejects published and logically archived history.

## Files changed

- `package.json`
- `src/auth.js`
- `src/server.js`
- `src/operationalHistoryArchiveRoutes.js`
- `src/views/index.ejs`
- `src/views/operational-history-archive.ejs`
- `test/operational-history-archive-controls-emulator.test.js`
- `CHANTER_AUTOPOSTER_OPERATIONAL_HISTORY_CLEANUP_P0_D_RESULT_V1.md`

No P0-C archive domain schema or repository adapter was duplicated or changed.

## Validation

### Canonical emulator gate

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

This contains 12 grouped P0-D control-surface subtests and 13 P0-C emulator
service subtests, plus their two parent tests.

### Expanded focused gate

```powershell
firebase emulators:exec --only firestore --project demo-chanter-autoposter-archive "node --test test/operational-history-audit.test.js test/operational-history-archive.test.js test/operational-history-archive-firestore-emulator.test.js test/operational-history-archive-controls-emulator.test.js test/admin-auth.test.js test/private-routes.test.js test/queue-delete-storage.test.js test/queue-delete-routes.test.js"
```

Result:

- tests: `75`
- pass: `75`
- fail: `0`
- skipped: `0`

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

- new route syntax check: pass
- new emulator test syntax check: pass
- new EJS template compilation: pass
- Vite production build: pass
- transformed modules: `24`

### Diff hygiene

```powershell
git diff --check
```

Result: **PASS**

## Scope control

Deliberately unchanged:

- generic archive schema and classification rules;
- connected accounts and provider clients;
- OAuth and token custody;
- workspaces, memberships, subscriptions, billing, and usage ledgers;
- Operator commands and mission graphs;
- scheduling/background behavior;
- customer-facing routes;
- physical deletion behavior except its already-existing archive protection;
- production Firebase configuration.

No dependency was installed. No separate archive implementation was added.

## Remaining risks

- This proves only deterministic local emulator behavior; it is not production
  authorization, production data, scale, or deployment evidence.
- Founder authorization inherits the repository's current single-admin model.
  A future multi-admin system would require an explicit founder claim before
  this route could remain founder-only.
- Server-issued preview state is in memory. Process restart intentionally
  invalidates approval readiness and requires a fresh preview.
- The internal page requires explicit emulator environment configuration and
  a process-scoped archive approval secret; missing or non-demo configuration
  fails closed.

## Git status and external actions

The P0-D checkpoint message is:

```text
feat(autoposter): add founder operational archive controls
```

The checkpoint contains only the eight P0-D files listed above. The exact commit
hash is reported in the final handoff because a commit cannot embed its own
content-derived hash.

`firestore-debug.log` remains untracked and excluded.

No push, deployment, provider call, real social-media post, production
Firestore connection, production mutation, or physical deletion occurred.
