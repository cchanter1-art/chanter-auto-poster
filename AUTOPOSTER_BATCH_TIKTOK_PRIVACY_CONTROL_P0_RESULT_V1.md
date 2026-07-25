# AUTOPOSTER — BATCH TIKTOK PRIVACY CONTROL P0 — RESULT V1

## 1. Repository path, branch, parent HEAD, final git status

- **Path**: `C:\Users\IT\OneDrive\Desktop\CHANTER\apps\chanter-auto-poster`
- **Branch**: `main`
- **Parent HEAD**: `f5a8e5edb503ecf6ec932a16d972d49e1ca81cbc` (`docs(autoposter): close image batch intake P0`) — the committed image-batch baseline this task builds on.
- **Final git status --short** (before any commit):
  ```
   M package.json
   M src/batchService.js
   M src/platformRoutes.js
   M src/postsMapper.js
   M src/tiktok.js
   M src/views/platform-batch.ejs
  ?? firestore-debug.log            (pre-existing untracked, not mine)
  ?? src/tiktokPrivacy.js
  ?? test/platform-batch-privacy-control.test.js
  ```
  `git diff --stat HEAD`: 6 tracked files changed, **+102 / −3**, plus 2 new files. `npm run build` produced no `public/autoposter-dashboard/*` churn.

## 2. Exact files changed and why

| File | Change | Why |
|---|---|---|
| `src/tiktokPrivacy.js` (new) | The canonical TikTok privacy vocabulary: `TIKTOK_PRIVACY_LEVELS`, `DEFAULT_TIKTOK_PRIVACY_LEVEL` (`SELF_ONLY`), `isTikTokPrivacyLevel`, `normalizeTikTokPrivacyLevel`. Pure, no I/O. | ONE privacy model (not a second one) shared by the edit surface, the write chokepoint, and the provider — mirrors the `tiktokSoundMode.js` precedent so layers can't disagree. |
| `src/postsMapper.js` | `mapPatchToFirestore` normalizes `privacyLevel` (fail-safe to `SELF_ONLY`), mirroring the existing `soundMode` guard. Read default `privacyLevel: data.privacyLevel \|\| 'SELF_ONLY'` left unchanged. | Last-resort write-time safety net: garbage can never reach storage and never resolves to a public level. |
| `src/batchService.js` | `updateItem` accepts `privacyLevel`: TikTok-only (else `provider_mismatch`), rejects an unknown value with a typed `invalid_privacy_level` error, and stores the normalized value in the patch. | Operator-visible edit-time validation; reuses the existing item-edit path and the canonical field. |
| `src/platformRoutes.js` | PATCH `…/items/:postId` forwards `req.body.privacyLevel` to `updateItem`. | Wire the existing save path; no new endpoint. |
| `src/tiktok.js` | `publishPhotoPost` (the unified publish entry) gains two fail-closed checks: (#1) reject an unknown `privacyLevel` **before any external call**; (#2) after `creator_info`, reject a value not in the account's `privacy_level_options` **before init**. New terminal codes `PRIVACY_LEVEL_INVALID` / `PRIVACY_LEVEL_UNSUPPORTED`. | Enforce capability and never silently substitute (esp. never `SELF_ONLY → PUBLIC_TO_EVERYONE`). PHOTO/VIDEO payloads already read the persisted value via `resolvePrivacyLevel`. |
| `src/views/platform-batch.ejs` | Per-item **TikTok-only** privacy `<select class="field-privacy">` inside a `tiktok-privacy-wrap` (hidden unless the destination is TikTok, toggled on destination change like the YouTube title). Shows the persisted value; saves through the existing PATCH; wired into dirty-tracking. | The missing review-page control, minimal, no redesign, no new page, not shown for non-TikTok destinations. |
| `package.json` | Added `node --check` for the new module + test. | Build parity with sibling files. |
| `test/platform-batch-privacy-control.test.js` (new) | 13 deterministic tests. | Proves the acceptance criteria offline. |

## 3. Canonical privacy field and full propagation path

**Canonical field: `privacyLevel`** (TikTok's own `privacy_level` enum: `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`, `SELF_ONLY`). Already used by classic uploads, storage (`storage.js` create), the mapper, and both provider payloads. No second field or model was introduced.

```
batch-review edit (.field-privacy, TikTok only)
  → PATCH /api/platform/batches/:batchId/items/:postId  { privacyLevel }
  → batchService.updateItem   (TikTok-only + reject unknown + normalize → patch.privacyLevel)
  → applicationService.updatePost   (patch passthrough, edit-state gate)
  → storage.updatePost → postsMapper.mapPatchToFirestore   (normalize, fail-safe SELF_ONLY)
  → Firestore (persisted on that exact draft)
  → postFromDoc on read/reload/acceptance   (privacyLevel || SELF_ONLY)
  → acceptItems approves + safe-schedules WITHOUT touching privacy
  → scheduler → tiktok.publishPhotoPost
        fail-closed #1 (unknown → no external call)
        → creator_info query
        fail-closed #2 (value ∉ account options → no init call)
        → buildPhotoPayload / buildVideoPayload → resolvePrivacyLevel
        → post_info.privacy_level = persisted value
```

## 4. Account-capability / allowed-option handling

- **Source of truth**: TikTok `creator_info.privacy_level_options`, queried at publish (`queryCreatorInfoForPublish`).
- **At publish**: `publishPhotoPost` requires the persisted value to be one of those options (fail-closed #2) before any init/publish call. When the account reports **no** options, the requested value is trusted as-is (it is already normalized, defaulting to `SELF_ONLY` — never public).
- **At review time**: allowed-option data is not fetched (no external call is made while editing). The selector offers the canonical TikTok set with `SELF_ONLY` as the proof-safe default; the account-capability check is enforced fail-closed at publish. `SELF_ONLY` is always selectable, which is exactly what a controlled proof needs.

## 5. Fail-closed behavior

| Point | Trigger | Result |
|---|---|---|
| Edit (batchService.updateItem) | unknown privacy value | typed `BatchServiceError` code `invalid_privacy_level`; draft unchanged |
| Edit | privacy on a non-TikTok item | typed `provider_mismatch` |
| Write (mapPatchToFirestore) | garbage value reaching storage | normalized to `SELF_ONLY` (never public) |
| Publish #1 (tiktok.publishPhotoPost) | explicitly-set unknown value | `PRIVACY_LEVEL_INVALID`, **no external TikTok request** |
| Publish #2 (after creator_info) | value ∉ account `privacy_level_options` | `PRIVACY_LEVEL_UNSUPPORTED`, **init/publish never reached** |

No path converts `SELF_ONLY` to `PUBLIC_TO_EVERYONE`: an account whose options excluded `SELF_ONLY` fails closed (proven by test), it is never silently swapped. Existing approval and destination-readiness checks in `acceptItems` are untouched.

## 6. Exact legacy compatibility rule

**Rule**: a stored draft without `privacyLevel` reads as `SELF_ONLY` — the existing `postsMapper.postFromDoc` default (`data.privacyLevel || 'SELF_ONLY'`), left unchanged.

- No migration / backfill / document rewrite → **deterministic IDs preserved**, no data corruption.
- Any stored non-canonical value normalizes to `SELF_ONLY` at the next write and fails closed at publish.
- Classic-upload / non-batch behavior is unchanged (the field, storage default, and `resolvePrivacyLevel` are all untouched there).
- A proof-intended item is **never silently made public**: the default and every fallback resolve to `SELF_ONLY`, and unsupported values fail rather than escalate.

## 7. PHOTO and VIDEO payload proof

- **PHOTO** `buildPhotoPayload({ privacyLevel:'SELF_ONLY', soundMode:'tiktok_recommended' })` → `media_type:'PHOTO'`, `post_info.privacy_level:'SELF_ONLY'`, `post_info.auto_add_music:true` (auto-music behavior unchanged). With `soundMode:'keep_original'` → `auto_add_music:false`, privacy still `SELF_ONLY`.
- **VIDEO** `buildVideoPayload({ privacyLevel:'SELF_ONLY' }, …)` → `post_info.privacy_level:'SELF_ONLY'`, `post_mode:'DIRECT_POST'`; a different selected value (`PUBLIC_TO_EVERYONE`, options permitting) flows through verbatim — proving the payload uses the persisted selection, not an inferred default.

## 8. Commands and exact results

| Command | Result |
|---|---|
| `node --test test/platform-batch-privacy-control.test.js` (focused) | **13 pass / 0 fail** |
| `node --test test/tiktok-sound-mode.test.js test/tiktok-video-upload.test.js test/tiktok-multi-account.test.js test/platform-batch-image-intake.test.js test/platform-batch.test.js test/platform-destination.test.js test/posts-mapper.test.js` | **61 pass / 0 fail** |
| `node --test test/*.test.js` (full suite) | **519 pass / 0 fail** (0 cancelled/skipped/todo) |
| `npm run build` | **passed** — all `node --check`, EJS compile of all views, `vite build ✓ (built in ~101ms)` |

Focused tests map to the criteria: (1) UI ships a TikTok privacy control; (2) two drafts persist different privacy; (3) save+reload preserves each; (4) acceptance preserves privacy; (5) PHOTO `SELF_ONLY` + auto-music unchanged; (6) VIDEO uses selected privacy; (7) invalid rejected before any call; (8) account-unsupported rejected before init; (9) `SELF_ONLY` never converted to public; (10) legacy default `SELF_ONLY`. Criteria 11–12 (classic upload unchanged; existing image-batch/sound-mode/fan-out/approval/scheduling/storage/payload suites green) are covered by the full-suite run.

## 9. Deterministic vs credential-dependent test separation

- **Deterministic / offline**: the new privacy suite and the sound-mode/fan-out/mapper suites run over in-memory fakes (Firestore, Cloudinary, AI, and the TikTok HTTP endpoints via a `fetch` mock). No network, no credentials. No new credential-dependent test was added.
- **Credential-dependent (live Firestore)**: parts of the broader suite exercise the real `storage.js` against the Firebase project in `.env`. They ran green here but depend on live credentials.

## 10. No provider mutation

**No TikTok or YouTube provider mutation occurred.** The provider tests use a `fetch` mock and injected fake storage; every fail-closed test asserts the publish/init call was never reached. No live publish, no token reconnect, no URL/domain change, no token-custody change.

## 11. Current external blockers still remaining (unchanged, out of scope)

- **Fresh production TikTok token**: stale/pre-approval tokens still require a manual reconnect.
- **URL ownership / media-transfer configuration**: `PULL_FROM_URL` still requires TikTok-approved URL ownership / domain configuration.

These were deliberately not addressed (per the no-go list).

## 12. Diff summary

```
 package.json                 |  2 +-
 src/batchService.js          | 20 +++++++++++++++++++-
 src/platformRoutes.js        |  1 +
 src/postsMapper.js           |  8 ++++++++
 src/tiktok.js                | 37 +++++++++++++++++++++++++++++++++++++
 src/views/platform-batch.ejs | 37 ++++++++++++++++++++++++++++++++++++-
 6 files changed, 102 insertions(+), 3 deletions(-)
 + src/tiktokPrivacy.js                          (new, canonical vocabulary)
 + test/platform-batch-privacy-control.test.js   (new, 13 tests)
```

## 13. Limitations

- **Review-time options are the canonical TikTok set**, not per-account allowed options (no creator_info call is made while editing). Account capability is enforced fail-closed at publish. If desired later, `/api/platform/destinations` could surface per-account `privacy_level_options`; that is out of scope here.
- **UI verification** was done by asserting the shipped `platform-batch.ejs` control/wiring (deterministic) rather than a live authenticated DOM render; the safety-critical persistence/validation/payload behavior is fully covered by server-side tests.
- **`resolvePrivacyLevel` fallback chain** in `tiktok.js` is retained unchanged; with fail-closed #2 upstream, its escalation branch is unreachable for a set value that is not in the account options.
- Unaudited-app reality: only `SELF_ONLY` is actually permitted by TikTok today, so non-`SELF_ONLY` selections will fail closed at publish until the app is approved — which is the intended, honest behavior.

## 14. Commit / push status

**Committed and pushed.** — held for review per the task. Working tree carries the 6 tracked edits + `src/tiktokPrivacy.js` + `test/platform-batch-privacy-control.test.js` on top of parent HEAD `f5a8e5e`. `firestore-debug.log` remains pre-existing untracked and unrelated.

## 15. Closeout

- **Implementation commit:** e55158d25c434cd9bc757ddc0da67f1a95680a48
- **Push:** confirmed to `origin/main`
- **Committed files:**

- AUTOPOSTER_BATCH_TIKTOK_PRIVACY_CONTROL_P0_RESULT_V1.md
- package.json
- src/batchService.js
- src/platformRoutes.js
- src/postsMapper.js
- src/tiktok.js
- src/tiktokPrivacy.js
- src/views/platform-batch.ejs
- test/platform-batch-privacy-control.test.js

- **Live TikTok/YouTube publish:** not executed
- **Token reconnect:** not executed
- **URL ownership configuration:** not changed
- **firestore-debug.log:** excluded and remains untracked