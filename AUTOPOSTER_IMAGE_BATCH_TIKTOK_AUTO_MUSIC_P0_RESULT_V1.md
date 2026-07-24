# AUTOPOSTER — IMAGE BATCH INTAKE + TIKTOK AUTO MUSIC P0 — RESULT V1

## 1. Repository path, branch, parent HEAD, git status

- **Path**: `C:\Users\IT\OneDrive\Desktop\CHANTER\apps\chanter-auto-poster`
- **Repo root**: same (single repository; nothing outside this root touched)
- **Branch**: `main`
- **Parent HEAD**: `9fbecad82c19182cf378fe1063398556919b80d0`
- **HEAD vs origin/main at start**: `0 0` (in sync)
- **git status --short (after changes, before any commit)**:
  ```
   M package.json
   M src/autoposterApplicationService.js
   M src/batchService.js
   M src/mediaPolicy.js
   M src/platformRoutes.js
   M src/storage.js
   M src/views/platform-autoposter.ejs
  ?? firestore-debug.log            (pre-existing untracked, not mine)
  ?? test/platform-batch-image-intake.test.js
  ```
  `npm run build` produced **no** `public/autoposter-dashboard/*` churn this run.

## 2. Objective and final verdict

**Objective**: admit images into the existing batch fan-out path so one canonical
image → batch intake → multiple TikTok destinations → independent
caption/schedule/soundMode → PHOTO Direct Post → `tiktok_recommended ⇒
auto_add_music:true` → persisted publish evidence — without weakening any
existing gate or the video path.

**Verdict**: **COMPLETE (deterministic).** Image batch intake works end-to-end
through the existing fan-out, the legacy video path is byte-for-bit unchanged,
the photo auto-music payload is proven, one canonical image fans out to multiple
destinations with independent sound modes, and the full suite + build are green.
Live proof is **prepared but not performed** (no authorization to publish).

## 3. Exact files changed and why

Image acceptance is a single **opt-in flag (`allowImageMedia`) set only by the
batch fan-out**. Every other intake path (classic `/upload`, client portal,
runtime control, public-URL intake) omits the flag and stays strictly
video-only. The three shared guards resolve the same widened predicate so they
can never drift apart.

| File | Change | Why |
|---|---|---|
| `src/mediaPolicy.js` | Added `IMAGE_EXTENSIONS`, `isImageUploadFile`, `isSupportedBatchUploadFile`, `BATCH_MEDIA_UPLOAD_MESSAGE`; exported them. `isVideoUploadFile`/`isVideoMediaUrl`/messages unchanged. | One authority for the widened batch predicate, with the SAME strictness as the video predicate (MIME+extension must agree; cross-mismatches rejected by both). |
| `src/platformRoutes.js` | Batch multer `fileFilter` now uses `isSupportedBatchUploadFile` + `BATCH_MEDIA_UPLOAD_MESSAGE`. Added `batchUploadExtension()` so a stored image never gets a fabricated `.mp4` name. | Admit images at the batch upload boundary; prevent the provider's filename fallback (`tiktok.isVideoPost`) from misclassifying an image as a video. |
| `src/autoposterApplicationService.js` | `validateMedia` accepts `input.allowImageMedia` (widened file predicate + batch message; URL branch stays video-only). `schedulePost` derives `allowImageMedia` once and forwards it to `validateMedia` and `creationDefaults`. | Service-layer media gate accepts images only for the batch path; threads the flag to the storage write. |
| `src/storage.js` | `addUploadedPosts` chokepoint: `defaults.allowImageMedia` selects `isSupportedBatchUploadFile` vs `isVideoUploadFile` (+ matching message). Persistence (mediaType/imagePath/publicImageUrl) already photo-aware. | Defense-in-depth write gate honors the opt-in; every non-batch caller still fails closed on images. |
| `src/batchService.js` | `createBatch` passes `allowImageMedia: true` to `schedulePost`; `generateItemCopy` diverts photo items (via `isPhotoItem`) to a truthful deterministic path (no download, no video analysis, no invented caption); intake copy made media-neutral. | Fan-out admits images; image preparation never runs video-only ffprobe/frame/audio logic; batch progresses even with no auto caption. |
| `src/views/platform-autoposter.ejs` | Dropzone `accept` widened to image MIME/extensions; primary/secondary hint indicate video **and** image. Per-destination Sound control untouched. | Clear accepted-media indication; no redesign, no new review page. |
| `package.json` | Added `node --check test/platform-batch-image-intake.test.js` to the build. | Parity with sibling batch tests in the build's syntax-check list. |
| `test/platform-batch-image-intake.test.js` (new) | Focused deterministic suite (10 tests). | Proves the acceptance criteria offline. |

## 4. Before/after media flow

**Before** — every intake path was video-only end to end:

```
upload → mediaPolicy.isVideoUploadFile → storage(mediaType) → post → mapper → provider
                 REJECTS images at multer, validateMedia, and storage chokepoint
```

**After** — the batch path (only) opts into images; the type is carried, never inferred from a misleading name:

```
image upload (batch multer: isSupportedBatchUploadFile, type-correct extension)
  → batchService.createBatch(allowImageMedia:true)
  → schedulePost → validateMedia(allowImageMedia) → storage.addUploadedPosts(allowImageMedia)
       getUploadMediaType(file)=='photo' ⇒ mediaType:'photo', imagePath/publicImageUrl set
  → fan-out: one canonical source (sourceIndex + originalName) → N destination drafts,
       each with its own account, caption, schedule, privacy, soundMode
  → preparation: photo item → deterministic success (no ffprobe/frame/audio, no download)
  → postsMapper preserves mediaType 'photo'
  → tiktok.publishPhotoPost → isVideoPost()==false → buildPhotoPayload → PHOTO DIRECT_POST
```

Classic `/upload`, client portal, runtime, and public-URL intake are unchanged
(no `allowImageMedia` ⇒ video-only).

## 5. Image preparation decision

`autoCaption.js` exposes only `analyzeVideoForCaption` (video ffprobe/frame/audio);
**no image caption model exists** and this task adds none. Photo items therefore
take a **truthful deterministic path**: `generateItemCopy` returns
`{ ok:true, caption:'', hashtags:'', provider:'', fallbackUsed:false }` for a photo —
the asset is **not downloaded**, video analysis **never runs**, and no visual-analysis
success is invented. Manual caption/hashtag editing is preserved; a captionless
photo simply shows `needs_attention` in review until the operator supplies copy.
Classification uses the canonical `mediaType` field first (a video is diverted to
the image path only if its OWN `mediaType` says photo), so legacy video preparation
is unchanged.

## 6. Canonical-asset and fan-out proof

The repo's fan-out contract (unchanged from the video path, per
`test/platform-batch-fanout.test.js`): one intake → `schedulePost` per provider →
`addUploadedPosts` creates account×source drafts that **share one canonical
source identity** (`sourceIndex` + `originalName`) and one synchronized schedule
slot, each an independent draft. Proven for images by
`one image fans out to two TikTok accounts referencing the same canonical source`:
2 items, `sourceIndex ∈ {0}`, `originalName ∈ {canonical.jpg}`, one shared slot,
both `mediaType:'photo'`. The media file is not mutated (the muted-derivative
logic is video-only and never runs for photos).

## 7. Sound-mode behavior proof

The per-destination contract (`src/tiktokSoundMode.js`, unchanged) is preserved.
`PHOTO + tiktok_recommended emits auto_add_music:true; keep_original emits false`
builds the real `tiktok.buildPhotoPayload` from the two fanned-out photo drafts:

| Media | soundMode | `post_info.auto_add_music` | verified |
|---|---|---|---|
| PHOTO | tiktok_recommended | `true` | ✅ |
| PHOTO | keep_original | `false` | ✅ |
| PHOTO | mute | `false` | ✅ (`tiktok-sound-mode.test.js`) |
| VIDEO | tiktok_recommended | explicit manual-required | ✅ (unchanged) |

Independent modes on one canonical source are proven by
`two image destinations persist independent sound modes on one canonical source`.

## 8. Tests / build commands and exact results

| Command | Result |
|---|---|
| `node --test test/platform-batch-image-intake.test.js` | **10 pass / 0 fail** |
| `node --test test/tiktok-sound-mode.test.js test/platform-batch-fanout.test.js` | **28 pass / 0 fail** |
| `node --test test/video-only-intake.test.js` | **2 pass / 0 fail** (classic video-only intact) |
| `node --test test/storage-upload.test.js` | **1 pass / 0 fail** (chokepoint still rejects images without the flag) |
| `node --test test/*.test.js` (full suite; partially credential-dependent) | **506 pass / 0 fail** (0 cancelled/skipped/todo) |
| `npm run build` | **passed** — all `node --check`, EJS compile of all views, `vite build ✓ (built in ~97ms)` |

New focused test maps to the acceptance criteria: (1) image accepted +
`mediaType:'photo'`; (2) unsupported type rejected, nothing created; (3) no
video analysis/download for images; (4/5) fan-out to 2 accounts sharing one
canonical source; (6) independent soundMode; (7/8) PHOTO auto-music true/false;
(9) legacy video path intact; (10) approval/scheduling intact after manual
caption edit; plus a mixed video+image batch and the mediaPolicy predicate.
Criteria 11–12 (existing sound-mode/batch/storage/multi-account suites remain
green) are covered by the full-suite run above.

## 9. Credential-dependent test separation

- **Deterministic / offline**: the new suite and the fan-out/sound-mode suites
  run entirely over in-memory fakes (Firestore, Cloudinary, and AI providers
  faked) — no network, no credentials.
- **Credential-dependent (live Firestore)**: parts of the broader suite
  (e.g. `storage-upload`, storage/route suites) exercise the real `storage.js`
  against the Firebase project configured in `.env`. These ran green here but
  depend on live credentials and are not hermetic. No new credential-dependent
  test was added by this task.

## 10. Live proof — NOT performed

No TikTok/YouTube publish mutation, no public post, and no visibility transition occurred. Credential-dependent Firestore tests ran and may have written test data. The smallest private
proof is prepared but **not executed** (awaiting explicit authorization):

```
1 image → 2 connected TikTok test accounts
  → independent captions (per-item edit in review)
  → independent schedules (synchronized safe slot at acceptance)
  → soundMode: tiktok_recommended on both
  → SELF_ONLY privacy
  → PHOTO Direct Post → auto_add_music:true
  → persist publish_id / status / typed failure evidence
```

## 11. Current limitations

- **Supported image formats**: JPG/JPEG, PNG, WebP (matches the repo's existing
  encode/mime maps and TikTok Photo Direct Post). GIF/BMP/HEIC are **not** admitted.
- **No image captioning**: photos get no AI caption; the operator writes copy in
  review. A captionless photo is `needs_attention` (honest, not a defect).
- **Canonical = source identity, not one shared URL**: like the existing video
  fan-out, each destination draft stores its own copy of the canonical source
  (same `sourceIndex`/`originalName`). Deduping to a single shared Cloudinary URL
  would change legacy video behavior and was deliberately not done (out of scope).
- **Batch record field `videoCount`** is retained as-is (a source count; renaming
  would ripple through storage/tests/UI for no functional gain). The UI still
  renders "N βίντεο × M" in one label; only the intake dropzone copy was updated.
- **Public-URL image intake** remains video-only everywhere (batch uploads files,
  never URLs); not in scope.

## 12. Security / idempotency / approval checks (all preserved)

- **Approval gate**: unchanged — image drafts start unapproved; `acceptItems`
  still requires an explicit human approver and `approvePost` fails closed
  (proven by criterion 10).
- **Idempotency / retry**: `intakeKey`-derived batch id, deterministic-id
  convergence, and compensating cleanup on partial failure are untouched;
  criterion 2 shows a rejected file leaves no partial batch record.
- **Ownership / destination validation**: `listDestinations` connected+
  publishing-ready checks and acceptance-time `validateConnectedAccount` unchanged.
- **File-size / count limits**: multer `fileSize: 250MB` and `files: maxItems`
  unchanged; `batch_too_large` at `maxItems`.
- **Redaction / evidence**: no token or raw provider payload is exposed; the new
  code adds no logging of sensitive fields.
- **Defense in depth**: images are re-validated at the storage chokepoint, so a
  caller cannot bypass the service-layer check.

## 13. Git diff summary

```
 package.json                        |  2 +-   (1 insertion, 1 deletion)
 src/autoposterApplicationService.js | 29 +-   (23 ins, 6 del)
 src/batchService.js                 | 29 +-   (27 ins, 2 del)
 src/mediaPolicy.js                  | 32 +    (32 ins, 0 del)
 src/platformRoutes.js               | 25 +-   (20 ins, 5 del)
 src/storage.js                      | 18 +-   (13 ins, 5 del)
 src/views/platform-autoposter.ejs   |  6 +-   (3 ins, 3 del)
 7 files changed, 119 insertions(+), 22 deletions(-)
 + test/platform-batch-image-intake.test.js (new)
```

## 14. Commit / push status

**Not committed, not pushed** — per instruction, holding for review. Working tree
has the 7 tracked edits + the new test file (see §1). `firestore-debug.log`
remains pre-existing untracked and is unrelated to this task.

## 15. Smallest next live-proof step

On explicit authorization, run the private proof in §10 against two connected
TikTok **test** accounts at `SELF_ONLY` (e.g. via `scripts/live-publish-test.js`
/ `src/livePublishTest.js`), capture the returned `publish_id`/status into the
existing publish-ledger evidence, and confirm `auto_add_music:true` on the photo
init request — with **no** public visibility transition.
