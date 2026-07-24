# AutoPoster — TikTok Per-Destination Sound Mode (P0) — Result V1

One canonical image or video can fan out to multiple TikTok accounts with an
**independent sound mode per destination**. The mode is a typed, validated enum
resolved honestly at the TikTok provider boundary; the canonical stored asset is
never mutated.

---

## 1. Repository

| | |
|---|---|
| Path | `C:\Users\IT\OneDrive\Desktop\CHANTER\apps\chanter-auto-poster` |
| Branch | `main` |
| Parent HEAD (before this work) | `f9befcdfe0c70f62968b9626a28c4aa1246ab85b` |
| Implementation commit | **`0a4b58dac9e7e9ca8bdb7938f6f51281cfc75488`** — `feat(autoposter): per-destination TikTok sound mode (P0)` (committed & pushed to `origin/main`) |

### Commit & remote verification

The implementation landed as a single commit of exactly the 11 files below
(721 insertions, 18 deletions); `firestore-debug.log` was **not** staged or
committed.

```
$ git rev-parse HEAD
0a4b58dac9e7e9ca8bdb7938f6f51281cfc75488
$ git rev-parse origin/main            # after: git fetch origin main
0a4b58dac9e7e9ca8bdb7938f6f51281cfc75488
$ git ls-remote origin -h refs/heads/main
0a4b58dac9e7e9ca8bdb7938f6f51281cfc75488   refs/heads/main
```

**Local HEAD == remote HEAD — verified.** (This docs commit — which records the
hash and this verification — is a separate follow-up commit on `main`, mirroring
the repo's existing `docs: record final commit hash and push confirmation`
convention; the implementation commit above is the substantive change.)

### git status (short) — after commit + push

```
?? firestore-debug.log
```

`firestore-debug.log` is **untouched and untracked** — it pre-existed this work
(mtime `2026-07-23`, before this session), is not in the index, and was neither
created, written, nor staged. The working tree is otherwise clean.

---

## 2. Files changed — and why each is required

Every file maps to exactly one link in the required persistence/behavior chain:

> batch input → fan-out item → post/job record → mapper → scheduler dispatch →
> TikTok provider payload/result → retained evidence

| File | Δ | Why it is required (which link) |
|---|---|---|
| `src/tiktokSoundMode.js` | **NEW** | The canonical typed contract: enum `keep_original \| mute \| tiktok_recommended`, `normalizeSoundMode` (fail-safe default), `isSoundMode`, and `resolveSoundCapability` (the single honest media×mode resolver). Pure, no I/O — every other layer defers to it. |
| `src/tiktok.js` | +147 | **Provider payload/result** link. `buildPhotoPayload` emits `post_info.auto_add_music`; the video path selects a muted derivative for `mute`; `tiktok_recommended` on video returns an explicit manual result **before any external call**; temp derivatives are always cleaned up. |
| `src/autoMusic.js` | +35 | `deriveMutedVideo` — the muted derivative for **VIDEO + mute**, reusing this module's existing ffmpeg resolution + injectable `runCommand`. `-map 0 -c copy -an` (fast remux, no re-encode) writes a **distinct** file; refuses to overwrite its source. |
| `src/postsMapper.js` | +9 | **Mapper** link. `postFromDoc` reads `soundMode` with the safe default (legacy → `keep_original`); `mapPatchToFirestore` normalizes any generic patch so an invalid value can never reach storage. |
| `src/storage.js` | +14 | **Post/job record** link. `normalizeTargetAccounts` carries per-target `soundMode`; the fan-out write stamps each destination copy of one canonical asset with its own validated `soundMode`. |
| `src/autoposterApplicationService.js` | +16 | **Fan-out item** link. `schedulePost` accepts a per-account `soundModes` map and attaches an independent, validated `soundMode` to each resolved account (and the legacy single-account fallback). |
| `src/batchService.js` | +16 | **Batch input** link. `normalizeDestinations` preserves+validates each destination's `soundMode`; `createBatch` passes the per-account `soundModes` map into `schedulePost`. |
| `src/views/platform-autoposter.ejs` | +46 | **UI**. One per-destination Sound control (Original / Muted / TikTok sound), threaded into the submitted destinations; an honest note appears only when a selected mode needs manual TikTok completion. |
| `package.json` | +1 line (2 tokens) | Registers `src/tiktokSoundMode.js` and `test/tiktok-sound-mode.test.js` in the existing `build` `node --check` list, keeping the new source file under the same syntax gate as every other `src/*` file (established repo convention). |
| `test/tiktok-sound-mode.test.js` | **NEW** | Focused tests: contract/normalization, PHOTO `auto_add_music`, legacy default, capability matrix, mute no-overwrite, and the honest video `tiktok_recommended` refusal (asserts no init call). |
| `test/platform-batch-fanout.test.js` | +57 | Fan-out persistence over the real application service + batch service: two accounts on one asset persist different modes; N×M preserves each mode independently; unspecified → safe default. The storage fake now mirrors the real `soundMode` contract. |

No unrelated cleanup, no redesign, no new repository, no music-catalog change.

---

## 3. Behavior matrix (exact)

| Media | Sound mode | Provider behavior |
|---|---|---|
| PHOTO | `tiktok_recommended` | Photo Direct Post, `post_info.auto_add_music: true` |
| PHOTO | `keep_original` | `auto_add_music: false` (photo has no source audio — silent) |
| PHOTO | `mute` | `auto_add_music: false` (silent; honest — no invented mute-for-photo) |
| VIDEO | `keep_original` | Existing video uploaded unchanged |
| VIDEO | `mute` | Muted derivative (`ffmpeg -map 0 -c copy -an`) uploaded from a throwaway temp; canonical asset untouched; temp cleaned on every path |
| VIDEO | `tiktok_recommended` | `{ ok:false, mode:'manual', code:'SOUND_MODE_MANUAL_REQUIRED' }` returned **before** any creator-info/init call; terminal (not a transient/retryable code) |

Compatibility default: any missing / unknown / legacy value resolves to
**`keep_original`** at every layer, preserving exact pre-feature behavior.
Deterministic post IDs and idempotency are unaffected (`soundMode` is not part
of the ID hash).

---

## 4. Build / test results

| Command | Result |
|---|---|
| `npm run build` | **PASS** — `node --check` all `src/*` (incl. `src/tiktokSoundMode.js`), EJS compile (incl. `platform-autoposter.ejs`), `vite build` |
| `node --test test/tiktok-sound-mode.test.js` | **17 tests, 17 pass, 0 fail** |
| `node --test test/*.test.js` (full suite) | **496 tests, 496 pass, 0 fail, 0 skipped** |

### Required-test coverage (7 / 7)

1. PHOTO + `tiktok_recommended` emits `auto_add_music=true` — ✅
2. Two accounts, same asset, different sound modes persisted — ✅
3. Fan-out preserves each destination sound mode independently (N×M) — ✅
4. Legacy records receive the safe default (`keep_original`) — ✅
5. VIDEO + `mute` does not mutate the canonical asset — ✅
6. VIDEO + `tiktok_recommended` does not silently claim unsupported automation — ✅
7. Existing TikTok, scheduler, batch, and multi-account suites remain green — ✅

---

## 5. Deterministic proof

- Full suite green (496/496) with zero live external mutation.
- Sound-mode contract, payload shaping, legacy default, mute no-mutation, and the
  honest video refusal are all covered by deterministic unit tests (mocked
  storage + `fetch`, injected `runCommand` — no real ffmpeg, no network).
- Fan-out persistence proven over the **real** application service + batch service
  on an in-memory storage fake that mirrors the real `soundMode` contract.
- Intake UI rendered deterministically off-server (sample destinations): the
  per-destination control, the honest manual-completion note, and the inline
  client script all render/parse.

---

## 6. Live proof — NOT performed

No public post was made. No external provider mutation occurred. `privacyLevel`
remains `SELF_ONLY` throughout. The live SELF_ONLY proof path was intentionally
**not** executed and awaits explicit authorization + real credentials.

Smallest controlled live-proof step (private only): with a connected TikTok test
account, create a 1-video batch fanned to that account three times (one per mode),
approve, and let the scheduler dispatch under `SELF_ONLY` — confirming
keep_original posts unchanged, mute uploads a muted derivative, and
tiktok_recommended returns the manual result — stopping before any public mutation.

---

## 7. Current limitations

- **Image batch fan-out is NOT implemented** — batch intake remains **video-only**
  (guards in `platformRoutes.js` multer `fileFilter`, `autoposterApplicationService.validateMedia`
  `videoOnly:true`, and `storage.addUploadedPosts`). The PHOTO `auto_add_music`
  payload contract exists and is unit-tested, but no image can reach the fan-out
  UI today, so "same image → many accounts → auto music" is not yet reachable
  end-to-end.
- VIDEO + `mute` derives at publish time (download-to-temp + remux), bounded by the
  intake 250 MB cap and cleaned up on every path.
- VIDEO + `tiktok_recommended` is a deliberate terminal manual outcome (no blind
  retry), surfaced with a UI note at intake; it is not auto-published.
- No per-item sound editing was added on the review page; the control lives at
  intake (where "per destination" is set). `changePostDestination` preserves an
  item's existing `soundMode` when its account changes.

---

## 8. Smallest next task — same image → multiple accounts → independent TikTok auto music

Everything downstream already exists: per-destination `soundMode` is threaded and
persisted, and **PHOTO + `tiktok_recommended` → `auto_add_music=true`** is
implemented and unit-tested. The only missing piece is **admitting image media
into the batch fan-out intake**. Smallest correct increment:

1. **Relax the video-only guards for images in the batch path only**
   - `src/platformRoutes.js` — `batchUpload` `fileFilter` (currently `isVideoUploadFile`).
   - `src/autoposterApplicationService.js` — `validateMedia` (currently `videoOnly:true`) for the batch/`batch_sync` path.
   - `src/storage.js` — `addUploadedPosts` video-only guard loop.
   (Reuse `mediaPolicy` image predicates already present in the codebase; keep the
   classic single-post path untouched.)
2. **Give images a non-video preparation path** — batch preparation calls
   `autoCaption.analyzeVideoForCaption`, which assumes a video stream. For an image
   item, skip (or route to an image-aware caption path) so preparation succeeds
   without an ffprobe video-stream requirement.
3. **No change needed** to sound-mode threading or to `buildPhotoPayload`: an image
   destination set to `tiktok_recommended` already yields `auto_add_music=true`, so
   the same image fanned to multiple accounts produces independent TikTok auto music
   per destination the moment images are allowed through intake.

Bound the increment to images in the batch intake path; do not weaken the
single-post video-only contract or any approval / retry / idempotency / evidence
control.
