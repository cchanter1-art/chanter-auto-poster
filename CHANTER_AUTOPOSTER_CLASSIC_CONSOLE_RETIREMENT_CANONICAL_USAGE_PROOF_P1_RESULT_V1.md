# CHANTER AUTOPOSTER — CLASSIC CONSOLE RETIREMENT + CANONICAL USAGE PROOF P1 — RESULT V1

**Repository:** `apps/chanter-auto-poster`
**Branch:** `product/retire-classic-composer-p1`
**Commit:** `ba3bb3d` (parent `b05f660`)
**Date:** 2026-07-25

---

## 1. Executive verdict

Delivered, with one capability gap stated plainly in §12 rather than papered over.

`/platform/compose` is now the only customer-facing creation UI in the admin Platform boundary. `/private/autoposter` is a dashboard: the intake panel, the preflight panel that reviewed it, ~750 lines of composer JavaScript and 30 now-unused CSS rules are gone, replaced by a single Compose action. No duplicate form remains hidden in the DOM — asserted by name across five route test files.

The absorption was cheaper than it looked, and that is the main finding: **`applicationService.schedulePost` already accepted every classic capability** — `mediaUrl`, `preparedMedia`, `youtube.{title,description}`, `files`, `caption`, `hashtags`. Only the batch intake *projection* was missing. Nothing in the publishing engine was rewritten.

`POST /upload` is **retained as a deprecated compatibility adapter**, not deleted. That is a deliberate call with evidence behind it (§8), and it is what keeps recurring-daily series working while the composer has no equivalent.

Tests 620/620, build green, branch pushed, **not merged**.

---

## 2. Checkpoint closeout evidence

Verified from git before any new work.

| Claim in the P0 report | Verified | Evidence |
|---|---|---|
| Branch `product/unified-composer-entitlements-p0` exists, pushed | Yes | local and `origin/` refs both `b05f660` |
| Commit `1ea8766` | **Refined** | `1ea8766` is present but is the branch's **parent**, not its tip. Tip is `b05f660`, the result-doc commit made after that report was written. Not a divergence — an extra commit. |
| Parent `5359b82` | Yes | `git rev-parse 1ea8766^` → `5359b82…` |
| `main` == `origin/main` == merge-base | Yes | all three `5359b82…`; fast-forward possible |
| Tests 609/609 | Yes | re-ran → `# pass 609 # fail 0` |
| Build green | Yes | re-ran → `vite build ✓` |
| `firestore-debug.log` untracked | Yes | still untracked, untouched |

Closeout executed:

- `git merge --ff-only` → `Updating 5359b82..b05f660`, `Fast-forward`
- `git push origin main` → `5359b82..b05f660  main -> main`
- Post-push: `main` and `origin/main` both `b05f6601a79aece9f2d12841d2ca1512bbf69b55`
- `git merge-base --is-ancestor 1ea8766 main` → **true**; `git branch --contains 1ea8766` → `main`

No force-push, no history rewrite, no unrelated tracked changes.

---

## 3. Repository-truth map

### Live classic intake fields, traced to execution

| Field | Live? | Already supported downstream? | Needed |
|---|---|---|---|
| `caption`, `hashtags` | Yes | `schedulePost` ✔ (batch already forwarded) | nothing |
| Auto Caption toggle | Yes | **Already in the canonical path** — `batchService.generateItemCopy` calls `autoCaption.analyzeVideoForCaption` per item during preparation | UI statement only |
| Auto Music (`autoMusicToken`) | Yes | `schedulePost` accepts `preparedMedia`; `storage.addUploadedPosts` already matched it **per file** by name+size | intake plumbing + list support |
| `publicMediaUrl` | Yes | `schedulePost` accepts `mediaUrl`; `validateMedia` validates HTTPS + video-only | intake plumbing |
| `youtubeTitle` / `youtubeDescription` | Yes | `schedulePost` validates `youtube.{title,description}` and rejects a missing title | intake plumbing + relax the batch guard |
| `targetChannels` (multi-account) | Yes | already the composer's Accounts step | nothing |
| `repeatMode`/`endDate`/`approveSeries` (recurring daily) | **Yes** | `schedulePost` supports `mode: 'recurring_daily'` | **not absorbed — see §12** |
| `offsetMinutes` ("minutes between channels") | Yes | — | deliberately not absorbed; removed from the customer flow in P0 |

### Dependencies on the classic form

`test/max-scheduler-routes.test.js`, `test/multichannel-routes.test.js`, `test/private-routes.test.js`, `test/video-only-intake.test.js`, `test/youtube-site-acceptance.test.js` all asserted intake DOM. Every one was rewritten at the correct boundary (§10), none deleted.

### Must remain as compatibility API

`POST /upload` — four test files exercise it as an API contract (video-only policy, multi-channel fan-out, Max Scheduler offsets, recurring-daily, duplicate-submit, unknown-result handling).

---

## 4. Canonical capability absorption

All through the existing services; no second media pipeline, no second scheduling model.

**Media step** — `publicMediaUrl` behind a collapsed "Already hosted" disclosure. `createBatch` accepts it as the ONE alternative source (contributing exactly one item). Files *and* a URL together are refused as `ambiguous_media_source` rather than silently preferring one. URL intake stays video-only via the unchanged `validateMedia` contract.

**Media step** — Auto Music toggle, staged through the same `POST /api/auto-caption` endpoint the classic form used: one signed token per file, redeemed at submit. `storage.addUploadedPosts` now accepts a **list** of prepared derivatives; the per-file name+size match is unchanged, so a derivative can only ever replace the exact source it was rendered from. A mismatched, stale or expired token is dropped with a warning and the original upload is used — never a substitution of the wrong media. The row is hidden for URL sources, which are used as-is.

**Caption step** — Auto Caption is stated, not re-implemented: blank caption ⇒ per-video generation during preparation. When the provider is unconfigured the composer says so instead of offering a control that cannot run.

**Caption step** — YouTube title/description in a `provider-fields` block revealed only when a YouTube destination is selected. YouTube is consequently selectable at intake now (`isIntakeSelectableProvider` returns true); its reason for being disabled — "no way to collect a title" — no longer holds.

### The YouTube rule, unchanged in substance and strengthened

Server-side in `createBatch`:

| Case | Result |
|---|---|
| YouTube destination, no typed title | `provider_not_batchable` (409) — same code as before |
| YouTube destination, whitespace title | `provider_not_batchable` |
| YouTube destination, title, **>1 source** | `provider_title_ambiguous` (409) — **new** |
| YouTube destination, title, 1 source | accepted; title reaches the draft, never derived from the caption |

The new ambiguity guard exists because one title silently describing several videos is exactly the quiet wrong the original guard was protecting against.

---

## 5. Canonical payload / service changes

```
/platform/compose
  → POST /api/platform/batches      (+ publicMediaUrl, autoMusicTokens, youtubeTitle, youtubeDescription)
  → batchService.createBatch        (+ mediaUrl, preparedMedia, youtube; sourceCount; YouTube guards)
  → applicationService.schedulePost (UNCHANGED — already accepted all of it)
  → storage.addUploadedPosts        (preparedMedia may now be a list; match logic unchanged)
```

One validation path, one entitlement path, one replay path, one scheduling path, one approval gate. `schedulePost` was not modified.

---

## 6. Dashboard changes (`/private/autoposter`)

**Removed:** intake panel (`panel-upload` + form), its inline provider-switch script, the Preflight panel, the composer JavaScript (upload validation, Fast-Schedule XHR, preflight, release-plan preview), and 30 CSS rules proven unused by a scan of the markup outside `<style>`.

**Added:** one `panel-compose` with a single `data-compose-link` → `/platform/compose`.

**Retained:** connected channels and provider state, Release Queue, publishing log/history, failures, evidence links, campaign accounting, queue view toggle and background refresh, Creative Engine, and the daily posting-time setting (`POST /settings`) — a queue-level operational config, not a per-post schedule field.

`src/views/index.ejs`: 2829 → 1661 lines.

---

## 7. Exact routes retained / removed / adapted

| Route | Disposition |
|---|---|
| `GET /platform/compose` | canonical creation UI (unchanged path, extended) |
| `GET /platform/compose/:batchId` | canonical review + accept |
| `GET /platform/autoposter`, `…/batches/:id` | 302 → canonical (from P0) |
| `POST /api/platform/batches` | canonical submission; now carries the absorbed fields |
| `POST /api/auto-caption` | retained — now serves the composer's Auto Music/Caption staging |
| `GET /private/autoposter` | retained, dashboard-only |
| `POST /upload` | **retained, deprecated adapter** (§8) |
| `POST /settings`, `/schedule`, `/posts/*` | retained — dashboard operations |
| `/client/autoposter/*` | untouched (§9) |

---

## 8. `POST /upload` decision and rationale

**Option B — compatibility adapter.** Reasons, in order of weight:

1. **It is not dead.** Four test files exercise it as an API contract: `video-only-intake` (media policy on every creation path), `multichannel-routes` (fan-out), `max-scheduler-routes` (explicit offsets, recurring daily, unknown-result handling), plus references elsewhere. Removing it deletes live, proven behaviour.
2. **Recurring-daily has no composer equivalent yet** (§12). `/upload` is currently the only working path for it.
3. **It is already an adapter, not a second implementation.** It resolves accounts, projects the multipart body onto `schedulePost`, and formats the reply. Entitlements, idempotency, validation, scheduling and the approval gate are all `schedulePost`'s.

Added: `Deprecation: true` and `Link: </platform/compose>; rel="successor-version"` (RFC 8594 style) — honest to machine callers, breaking none. **Not a redirect** — a redirected POST would silently discard the body; asserted in test.

---

## 9. Client portal impact

**Retained and unaffected.** `/client/autoposter` sits behind a distinct client-session boundary (`requireClientSession`, `clientAuth.js`) with its own upload route, its own view, and its own media rules. Nothing in this slice touches it; `test/client-routes.test.js` and the client half of `test/video-only-intake.test.js` pass unchanged. Merging it into the admin composer is a separate auth/product decision and was not attempted.

---

## 10. Files changed

| File | Δ | What |
|---|---|---|
| `src/views/index.ejs` | −1168 | Intake panel, inline script, preflight, composer JS, dead CSS removed; one Compose action added |
| `src/batchService.js` | +58/−15 | `mediaUrl` source, `preparedMedia`, `youtube` metadata, `sourceCount`, conditional YouTube guards |
| `src/platformRoutes.js` | +55/−12 | Forwards absorbed fields; Auto Music token resolution; YouTube selectable; capability locals |
| `src/views/platform-compose.ejs` | +155/−21 | Media URL disclosure, Auto Music, contextual YouTube fields, Auto Caption statement, readiness |
| `src/routes.js` | +20/−2 | `POST /upload` deprecation headers + adapter documentation |
| `src/storage.js` | +11/−3 | `preparedMedia` accepts a list; per-file match unchanged |
| `public/platform/platform.css` | +21 | `provider-fields`, media-URL disclosure |
| `test/unified-composer.test.js` | +233 | 9 new tests: absorption, staging safety, repeated use, failure recovery |
| `test/storage-upload.test.js` | +52/−6 | Real-storage proof of the prepared-media list + mismatch safety |
| `test/youtube-site-acceptance.test.js` | +47/−27 | Target selection re-proven at the composer; console keeps identity/readiness |
| `test/max-scheduler-routes.test.js` | +42/−29 | Dashboard boundary + adapter deprecation contract |
| `test/platform-batch-fanout.test.js` | +55/−9 | Three-case YouTube rule |
| `test/multichannel-routes.test.js`, `test/private-routes.test.js`, `test/video-only-intake.test.js`, `test/platform-destination-chips.test.js` | +33/−32 | Boundary rewrites |

16 files, +811 / −1319.

---

## 11. Validation

`npm test` → **620 tests, 620 pass, 0 fail** (611 before this slice + 9 new). `npm run build` → `node --check` all sources, EJS compile of all views, `vite build ✓`.

### Live DOM/HTTP proof (real router + real views, session gate stubbed as in tests)

**Composer carries every absorbed capability** — `GET /platform/compose?plan=creator`:
```
autoMusicToggle: true   publicMediaUrl: true   mediaUrlCollapsed: true
youtubeTitle: true      youtubeDescription: true   youtubeFieldsHiddenNow: true
autoCaptionNote: "Κενή λεζάντα σημαίνει Auto Caption ανά βίντεο κατά την προετ…"
destinations: account-a/b/c (tiktok, enabled), UC-chanter (youtube, ENABLED — was disabled)
steps: [upload, accounts, caption, schedule, review]   composerForms: 1
```

**YouTube fields are contextual and the title actually gates readiness** (one file staged through the real dropzone):
```
TikTok only        → youtube fields hidden,  submit enabled
+ YouTube, no title→ fields shown, submit DISABLED,
                     review: ✔1 αρχείο / ✔2 λογαριασμοί / · Απαιτείται τίτλος YouTube / ✔Συντομότερα / ·Δεν είναι έτοιμο
+ title typed      → submit enabled, review: … ✔ Έτοιμο
```

**URL source + multi-account, no history in the composer** (`?plan=studio`):
```
selected: "3 accounts selected"
review:   ✔ Media URL / ✔ 3 λογαριασμοί / ✔ Λεζάντα: αυτόματη προετοιμασία / ✔ Συντομότερα · 14:40 / ✔ Έτοιμο
autoMusicRowHidden: true   (a hosted URL is used as-is)
batchList: false   anyRecentBatches: false
```

**Dashboard is composer-free** — real HTTP fetches of `/private/autoposter` inside the suite, all passing:
```
private-routes        pass 1  — no Prepare Campaign, no auto-caption/music toggles, one /platform/compose link
multichannel-routes   pass 1  — no Target Publishing Channels, no name="targetChannels", no btn-create
max-scheduler-routes  pass 1  — no upload-form, no <input type="file">, no data-preflight, one data-compose-link
video-only-intake     pass 2  — no file picker; server-side video-only rule unchanged
youtube-site-acceptance pass 7 — console keeps identity/readiness/disconnect; targeting proven in the composer
```

**No screenshots were captured** — the Browser pane was not displayed, so `computer{action:"screenshot"}` timed out. Every figure above is DOM/HTTP output I actually produced.

---

## 12. Repeated-use readiness, approval and no-public-transition

Deterministic, through the **real** `batchService` fan-out (`test/unified-composer.test.js`):

| Proof | Result |
|---|---|
| Three drafts: single-account, multi-account (3), URL-sourced | 1 + 3 + 1 = **5 durable drafts**, 3 distinct batch records |
| All appear in work history | each `batchId` found via `listBatches` |
| Approval still mandatory | every post `approvedAt === null` |
| Nothing published | every post `status === 'scheduled'`; no provider call anywhere in the suite |
| Replay does not duplicate | replaying two intake keys → `replayed: true`, post count stays **5** |
| Injected failure is visible | unconnected destination → `destination_unavailable`, message names the cause |
| Failure leaves no partial state | `posts.length === 0` after rejection |
| Failure is recoverable | the same `intakeKey` succeeds once corrected — not a poisoned slot |

Auto Music staging safety is proven against **real storage**: an exact name+size match is replaced; a same-name/different-size derivative is **not** substituted (`autoMusicApplied: false`, original retained).

---

## 13. Limitations and risks

**1. Recurring-daily series are not in the composer.** `repeatMode=daily` + `endDate` + `approveSeries` remain reachable only through `POST /upload`. This is the one live classic capability without a canonical UI.

Why not absorbed: `createBatch`'s model is "one plan, N source slots" (`computeBatchSchedulePlan` + `applyBatchSourceSchedule`). Recurring-daily is the opposite shape — *one* source repeated across *many* dates — and grafting it in means extending a well-tested scheduling core with a repeat semantic, not adding intake plumbing. Doing it badly risks the scheduling guarantees this task requires preserving. `/upload` keeps the capability alive and tested meanwhile. **This is the honest gap; it is the recommended next step (§15).**

**2. `POST /upload` still exists.** Intended (§8), but it means a determined caller can still create posts outside the composer. It is not linked from any UI, is deprecation-signalled, and shares the same entitlement/approval path, so it cannot bypass safety — only the UI.

**3. Auto Music staging is synchronous at intake.** Each file costs one `POST /api/auto-caption` round trip (FFmpeg mix) before submit becomes ready. For a large batch this is slow. The composer blocks readiness while staging (`musicPending`) rather than submitting half-prepared work, but it does not yet parallelise or background it.

**4. Auto Music is not offered for URL sources.** The mixer needs an uploaded file. The control hides rather than failing at submit.

**5. `publicMediaUrl` yields exactly one item.** Matching the classic behaviour; no multi-URL intake.

**6. Preflight is gone.** Its checks (channel, asset, caption, window) are now the composer's Review step. Nothing equivalent remains on the dashboard, which is correct — it was intake readiness — but it is a visible change for anyone who used it as a status panel.

---

## 14. Branch, commit, push, merge status

| | |
|---|---|
| Previous checkpoint | `b05f660` (contains `1ea8766`) fast-forwarded to `main`, pushed, verified aligned |
| Branch | `product/retire-classic-composer-p1` |
| Commit | `ba3bb3d` |
| Push | **pushed** to `origin` |
| Merge to `main` | **not performed** — requires explicit authorization after review |
| `firestore-debug.log` | untracked, uncommitted, untouched |
| Force-push / history rewrite | none |
| Scratch data | preview harness and scripts stayed in the scratchpad; the temporary `.claude/launch.json` entry was removed |

---

## 15. Recommended next step

**Bring recurring-daily into the canonical composer** — the single remaining classic capability without a canonical UI, and the last reason `POST /upload` must stay functional rather than merely tolerated.

Concretely: give `createBatch` a repeat-aware schedule mode that delegates to the `recurring_daily` path `schedulePost` already implements (rather than extending `computeBatchSchedulePlan`'s slot model), surface it in the composer's collapsed advanced scheduling with the existing "approve the whole series" gate, and port the recurring assertions from `max-scheduler-routes.test.js` onto the canonical contract. Once that lands, `POST /upload` can be retired under §7 Option A with zero live callers — proven, not assumed.
