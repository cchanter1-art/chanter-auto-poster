# AUTOPOSTER — MULTI-ACCOUNT DESTINATION CHIPS P0 — RESULT V1

**Status:** complete · review correction applied (English-only UI copy) · tests and build green · **not committed / not pushed** · no provider call, no network mutation.

> **Revision note (post-review):** implementation review passed with one required product-language correction. CHANTER Platform is worldwide-first and **English-only**, so every destination-chip UI string introduced by this task was converted from Greek-first/bilingual to concise English-only copy. Fan-out, validation, providers, scheduler, privacy, sound mode, and styling architecture were **not** changed by that correction — copy only. Details in §7a; final results in §9.

---

## 1. Repository state

- Repository: `C:\Users\IT\OneDrive\Desktop\CHANTER\apps\chanter-auto-poster`
- Branch: `main`
- Base commit at start: `fe48d1f docs(autoposter): close batch privacy control P0`
- Working tree at finish (nothing staged, nothing committed):

```
 M package.json
 M public/platform/platform.css
 M src/platformRoutes.js
 M src/views/platform-autoposter.ejs
?? src/destinationChips.js
?? test/platform-destination-chips.test.js
?? firestore-debug.log        <- pre-existing, untracked before this task, not mine
```

---

## 2. Repository-truth inspection (done before editing)

The task brief assumed a *single-destination* batch experience. **Repository truth contradicted that**, and the plan was adjusted to match the code rather than the brief:

| Brief assumed | Repository truth |
|---|---|
| Single-destination batch creation | Multi-select **already existed** — `platform-autoposter.ejs` rendered a flat checkbox list, and multiple accounts could already be selected |
| Fan-out needs building | Fan-out **already existed and was already tested** — `batchService.createBatch` groups by provider and calls `applicationService.schedulePost({ accountIds: [...] })`; proven by `test/platform-batch-fanout.test.js` |
| Duplicate handling needs building | `normalizeDestinations` (batchService.js:55) already dedupes on `provider|accountId` |
| Validation needs building | Unknown/disconnected/not-publishing-ready already fail closed **before any post is created** (batchService.js:249-258) |

**Therefore the actual gap was purely the selector UI**: a flat, ungrouped checkbox list with no provider grouping, no selected-count, and no select-all/clear. No publishing logic was redesigned, and **no parallel destination model was introduced**.

Identified contracts, all reused unchanged:

- Destination list endpoint/service: `batchService.listDestinations()` → `{ provider, providerDisplayName, accountId, label, publishingReady }`
- Request field carrying destination IDs: `destinations` (JSON string in the multipart body), parsed by `parseJsonArray` (platformRoutes.js:83)
- Fan-out input: `applicationService.schedulePost({ provider, accountIds, soundModes, ... })`
- Connected/publishing-ready filtering: `connectionStatus === 'connected'` + schedulable/active provider + `publishingReady === true`
- Existing tests for fan-out/destination/duplicates: `platform-batch-fanout.test.js`, `platform-destination.test.js`, `platform-batch.test.js`

### One inspection finding that shaped the design

**YouTube is a hard, already-tested exclusion at batch intake.** `batchService.createBatch` throws `provider_not_batchable` for any YouTube destination (batchService.js:238-244), because YouTube requires a human-entered per-video title that cannot exist at bulk intake. Previously the route silently *filtered YouTube out of the page entirely*, so an operator with a connected YouTube channel simply never saw it.

The brief explicitly asks for YouTube to appear as a grouped chip (`YouTube — @chantercy`). Both requirements are satisfied by rendering YouTube **grouped and visibly disabled with a stated reason**, rather than either hiding it (loses the brief's requirement) or enabling it (would hit a 409 and contradict a tested invariant). This is a visibility change only — the backend rule is untouched.

---

## 3. Exact files changed

| File | Change |
|---|---|
| `src/destinationChips.js` | **New.** Pure, dependency-free grouping helper: `groupDestinationsByProvider()`, `countSelectableAccounts()`. Presentation only — no filtering authority, no new destination model. |
| `src/platformRoutes.js` | `/platform/autoposter` now passes `destinationGroups` + `selectableCount` instead of a flat `destinations` array; declares `isIntakeSelectableProvider` (YouTube not selectable at intake) and the operator-facing reason. |
| `src/views/platform-autoposter.ejs` | Flat checkbox list → provider-grouped chips; added selected-count, per-provider "Select all", "Clear selection", empty-selection submit validation; empty-state gate now keys off `selectableCount`. |
| `public/platform/platform.css` | `.destination-item` → `.destination-chip` + group/row/head/count/disabled styles, `:focus-visible` ring, mobile wrapping. |
| `package.json` | Registered `src/destinationChips.js` and `test/platform-destination-chips.test.js` in the `build` syntax-check chain. |
| `test/platform-destination-chips.test.js` | **New.** 17 deterministic offline tests (3 layers). |

Not modified: `batchService.js`, `autoposterApplicationService.js`, `storage.js`, `tiktok.js`, `scheduler.js`, `tiktokPrivacy.js`, `tiktokSoundMode.js`. **No file outside this repository was touched.**

---

## 4. Previous vs new flow

**Previous** — one flat, ungrouped list; YouTube invisible; no count:

```
[x] TIKTOK @dailymemeai  [sound v]
[ ] TIKTOK @ai__sphynx   [sound v]
```

**New** — grouped by provider, count, per-group select-all, clear; English-only:

```
Destinations                                        1 account selected

Select one or more connected accounts. Each video creates a separate,
independent draft for every selected destination.

TIKTOK                                                     [Select all]
 [x] TIKTOK @ai__sphynx [sound v]   [ ] TIKTOK @dailymemeai [sound v]

YOUTUBE
 [ ] YOUTUBE @chantercy  (disabled — "YouTube requires a title for each
                          video. Assign it during review.")

[Clear selection]
```

Operator flow (unchanged in shape, as the brief requires):

```
upload media → select 1..N destination chips → create batch once
  → existing fan-out creates one draft per selected destination
  → review each destination independently
```

Placement is on the batch creation/intake page, above `Δημιουργία παρτίδας` (Create batch). No already-created review draft was turned into a multi-destination object. The per-item destination dropdown in review is untouched and still available for reassignment.

---

## 5. Reused fan-out contract

Unchanged end to end. The chips write into the **same** field the fan-out already consumed:

```
selected chips
  → [{ provider, accountId, soundMode }]
  → FormData 'destinations' (JSON)
  → POST /api/platform/batches
  → parseJsonArray → batchService.createBatch
  → normalizeDestinations (dedupe)
  → applicationService.schedulePost({ provider, accountIds, soundModes })

1 canonical source × N selected destination IDs = N independent destination drafts
```

Captured live from the browser (real page, real submit) — exactly the pre-existing shape:

```json
[{"provider":"tiktok","accountId":"acct-b","soundMode":"keep_original"},
 {"provider":"tiktok","accountId":"acct-a","soundMode":"keep_original"}]
```

Each generated draft retains: same canonical source identity (`sourceIndex`), own destination/account ID, independent caption/hashtags, independent schedule, independent TikTok privacy, independent TikTok sound mode, independent approval state, deterministic/idempotent creation (`intakeKey` → `deriveBatchId`).

---

## 6. Validation and duplicate behavior

| Case | Behavior | Where |
|---|---|---|
| Zero selected | Submit button disabled; keyboard submit shows *"Select at least one destination before creating the batch."*; server also rejects | view + `createBatch` |
| Unknown destination ID | Rejected `409 destination_unavailable` **before any post is created** | batchService.js:249-258 |
| Disconnected destination | Same — rejected before creation | same |
| Non-publishing-ready | Excluded from the page; rejected server-side if submitted | route filter + `listDestinations` |
| Duplicate destination IDs | Normalized (deduped on `provider\|accountId`) — one draft per account | `normalizeDestinations` |
| Non-selectable provider (YouTube) | Chip disabled; filtered from the client selection set; `409 provider_not_batchable` backstop | view + JS + batchService.js:238 |
| More than 10 destinations | Blocked client-side with a notice; `too_many_destinations` server-side | view + `MAX_DESTINATIONS` |
| Any validation failure | **No partial batch** — nothing is created; compensating cleanup removes the reserved record | batchService.js:358-368 |

Defence in depth: the disabled chip is excluded from the client selection set, **and** the server independently refuses it. Proven adversarially in §8.

---

## 7. UI states

- **Unselected** — `--border` (`rgb(38,44,56)`), calm.
- **Selected** — accent border `rgb(201,169,97)` + tinted background (`:has(input:checked)`), verified by computed style.
- **Focus** — `2px` accent outline with offset on the chip itself via `:has(input:focus-visible)`, not just the native box.
- **Disabled** — `opacity .55`, `cursor: not-allowed`, `aria-disabled="true"`, plus a visible reason.
- **Count** — `aria-live="polite"`, so changes are announced: *none selected* → *1 προορισμός επιλεγμένος · 1 selected* → *2 προορισμοί επιλεγμένοι · 2 selected*.
- Semantics: real `<input type="checkbox">` inside a `<label>` — one-click toggle, Tab-reachable, Space-togglable, multi-select native.
- **No hidden preselection** — every rendered chip is unchecked (asserted in tests).
- Mobile (375px): `flex-wrap: wrap`, chips stack, `overflowsViewport: false`, `bodyScrollsHorizontally: false`.
- Greek-first bilingual labels, matching the surrounding page. No full-page redesign.

---

## 7a. UI copy — English-only (post-review correction)

CHANTER Platform is worldwide-first and English-only. Every destination-chip string this task introduced is now English-only. Exact final copy:

| Element | Final copy |
|---|---|
| Section heading | `Destinations` |
| Section note | `Select one or more connected accounts. Each video creates a separate, independent draft for every selected destination.` |
| Per-provider select-all button | `Select all` |
| Clear button | `Clear selection` |
| Count — zero | `No accounts selected` |
| Count — one | `1 account selected` |
| Count — many | `N accounts selected` |
| Empty-selection validation | `Select at least one destination before creating the batch.` |
| YouTube disabled-chip reason | `YouTube requires a title for each video. Assign it during review.` |
| Destination-limit notice | `Up to 10 destinations per batch.` |

Provider group headings and chip labels render from live data as `TikTok` / `YouTube` and `TikTok — @dailymemeai`, `TikTok — @ai__sphynx`, `YouTube — @chantercy` — already English/neutral.

Browser-verified full text of the chip component (Greek characters found: **none**):

```
Destinations  No accounts selected
Select one or more connected accounts. Each video creates a separate,
independent draft for every selected destination.
TikTok  Select all  TikTok @ai__sphynx  TikTok @dailymemeai
YouTube  YouTube @chantercy
YouTube requires a title for each video. Assign it during review.
Clear selection
```

A regression test (`destination-chip copy is English-only`) asserts each string above **and** scans the rendered chip region for any Greek code point, so this cannot silently regress.

### Scope boundary — two deliberate exclusions

Per the review instruction *"keep existing unrelated legacy page copy untouched unless it is directly inside the new destination-chip component"*:

1. **Surrounding page copy is unchanged** and remains Greek-first legacy: page title/subtitle, dropzone, scheduling tabs and fields, capacity preview, the `Δημιουργία παρτίδας` submit button, recent-batches list, footer note. None of it is part of the destination-chip component.
2. **The per-destination sound `<select>` remains Greek-first** (`Αρχικός · Original`, `Χωρίς ήχο · Muted`, `Ήχος TikTok · TikTok sound`, `aria-label="Ήχος · Sound"`). It renders *inside* each chip, but it is pre-existing legacy sound-mode copy that this task only **relocated**, not introduced — and the review instruction explicitly lists sound mode as do-not-change. It was therefore left alone rather than converted unasked. **This is the one place where a chip still shows Greek**; converting it is a one-line change, flagged for a decision.

### One string changed that was not newly introduced

`Up to 10 destinations per batch.` (was `Έως 10 προορισμοί ανά παρτίδα.`) is pre-existing copy, but it sits in the chip-selection handler **and the new English `Select all` button triggers it**. Leaving it would have made a new English control emit a Greek error, so it was converted. Both call sites (checkbox change + select-all) now use the English string. No behavior changed.

---

## 8. One-media → N-drafts proof

**Service level** (real `batchService` + real application service, in-memory storage):

```
1 media × 3 selected accounts → result.items.length === 3
  destinationCount 3, videoCount 1
  distinct sourceIndex values: 1   (same canonical source identity)
  distinct scheduledAt values: 1   (synchronized slot)
  accountIds: {account-a, account-b, account-c}   (each draft its own destination)
  distinct post ids: 3             (three independent drafts)
  every item approved !== true; every post status 'scheduled'  (nothing published)
```

**Browser level** (real page rendered by the real EJS view + real grouping helper, in a mocked Express harness):

| Check | Result |
|---|---|
| Chips rendered | 3, grouped `TikTok` (2) then `YouTube` (1) |
| Labels | `TikTok — @ai__sphynx`, `TikTok — @dailymemeai`, `YouTube — @chantercy` |
| Initial state | nothing selected, count = `No accounts selected` |
| One click selects | `['tiktok\|acct-a']`, count `1 account selected` |
| Click again deselects | `[]`, count `No accounts selected` |
| Multiple selectable | `['tiktok\|acct-b','tiktok\|acct-a']`, count `2 accounts selected` |
| Select all TikTok | both selected, count `2 accounts selected` |
| Clear selection | `[]`, count `No accounts selected` |
| Real click on disabled YouTube chip **and its label** | stays `checked: false` |
| Empty-selection submit | notice `Select at least one destination before creating the batch.`, submit blocked |
| Keyboard | chip focusable, Space toggles, count updates; disabled chip not focusable |
| Greek in chip component | **none** (sound `<select>` excluded — see §7a) |
| Console errors | none |

**Adversarial check** — the YouTube box was *force-checked in the DOM* (simulating tampered/stale client state) alongside the two TikTok chips, then the form was submitted. The captured payload contained **only the two TikTok destinations**; the count still read *2 selected*. A disabled chip cannot reach the fan-out contract even when the DOM is manipulated.

---

## 9. Test and build results

### Deterministic / offline (no credentials, no network)

Focused destination-chip tests, re-run after the English-only correction:

```
test/platform-destination-chips.test.js   18 pass  0 fail   <- NEW (+1: English-only copy)
test/platform-batch-fanout.test.js        11 pass  0 fail
test/platform-batch.test.js               12 pass  0 fail
test/platform-destination.test.js         11 pass  0 fail
test/platform-batch-image-intake.test.js  10 pass  0 fail
test/platform-batch-privacy-control.test.js 13 pass 0 fail
test/platform-batch-delete.test.js         6 pass  0 fail
test/approval-gate.test.js                 5 pass  0 fail
test/tiktok-sound-mode.test.js            17 pass  0 fail
```

### Full suite (final)

```
npm test  →  # tests 537   # pass 537   # fail 0   # skipped 0   # todo 0
             # duration_ms 3602
```

Baseline before this task was green on the same batch/destination files (57 pass across the five platform files); the pre-correction run was 536/536. The +1 is the new English-only copy test. No regression was introduced at any point.

### Build (final)

```
npm run build  →  prebuild + all node --check + EJS compile of all 9 views + vite build
                  ✓ built in 102ms   (exit 0)
```

The intake view compiles as part of the build's EJS step. This run did **not** leave `public/autoposter-dashboard/*` dirty.

### Deterministic vs credential-dependent

Everything reported above is **deterministic and offline**. The new test file follows the established pattern of `platform-batch-fanout.test.js`: the real `mediaPolicy`, real application service, and real `batchService` run over in-memory storage fakes, with only Firestore, Cloudinary, and AI providers faked; the template layer is rendered with `ejs.render` against the real view file. No test in this task requires `.env` credentials, and none was skipped.

No credential-dependent test was run in this task — none was needed, and running one would risk touching live Firestore.

---

## 10. No-provider-mutation statement

**No live provider call, network mutation, or publish occurred at any point.**

- No TikTok, YouTube, Instagram, or Cloudinary endpoint was contacted.
- No token was read, refreshed, or re-issued; token custody untouched.
- The browser harness is a mocked Express server rendering the real view; its `POST /api/platform/batches` **captures the payload and returns 400 without creating anything** — the real batch service was never invoked from the browser.
- All service-level proofs run against in-memory fakes.
- Every draft produced in tests ends `approved !== true`, `status === 'scheduled'` — the approval gate and scheduler remain the only path to publication, unchanged.

---

## 11. Diff summary

```
 package.json                      |   2 +-
 public/platform/platform.css      |  58 ++++++++++++++++----
 src/platformRoutes.js             |  39 ++++++++++----
 src/views/platform-autoposter.ejs | 111 ++++++++++++++++++++++++++++++--------
 4 files changed, 168 insertions(+), 42 deletions(-)
 + src/destinationChips.js                  (new,  88 lines)
 + test/platform-destination-chips.test.js  (new, 541 lines, 18 tests)
 + AUTOPOSTER_MULTI_ACCOUNT_DESTINATION_CHIPS_P0_RESULT_V1.md   (this artifact)
```

---

## 12. Limitations and notes

1. **YouTube is shown disabled, not selectable.** This is deliberate and matches the tested backend invariant. If YouTube should become selectable at intake, that is a separate change requiring a per-video title capture step at intake — explicitly out of scope here.
2. **`Select all` is per-provider, not global**, and stops at `MAX_DESTINATIONS` (10) with a notice rather than silently overshooting. There is no global select-all; with the current bound it would rarely differ, and a per-provider control matches the grouping.
3. **Screenshots could not be captured** — the Browser pane was not displayed, so the compositor returned no frames. Visual state was instead verified through computed styles and DOM assertions (border colours, outline, opacity, bounding rects), which is what the acceptance criteria actually require. No visual claim here is unverified.
4. **Two pre-existing quirks were confirmed, not introduced:** `firestore-debug.log` was already untracked at session start; the sound-mode `<select>` still renders for every selectable destination including non-TikTok ones (pre-existing behavior, untouched).
5. **A real bug was found and fixed during verification:** the disabled attribute was first emitted through EJS `<%= %>`, which HTML-escaped the quotes and produced `aria-disabled=&#34;true&#34;`. Caught by the accessibility assertion, fixed with an `<% if %>` block, re-verified in the browser.
6. `.claude/launch.json` gained a git-ignored `chips-smoke` entry pointing at a scratchpad harness (matching the existing pattern of prior smoke entries). It is not part of the diff.
7. **The per-destination sound `<select>` inside each chip is still Greek-first** — see §7a. It is legacy sound-mode copy this task only relocated, and sound mode was named do-not-change, so it was deliberately not converted. This is the single remaining mixed-language element inside the chip component and needs a product decision; it is a one-line change if English is wanted.
8. **The rest of the intake page remains Greek-first legacy copy** (title, dropzone, scheduling, submit button, footer). Only the destination-chip component was converted, per the review scope. Two of those legacy strings are destination-*adjacent* and may catch the eye even though they sit outside the chip component: the capacity preview (`N βίντεο × M προορισμοί …`) and the recent-batches row (`… προορισμοί`). Both were left untouched deliberately. If the whole page — or the whole Platform surface — should become English-only, that is a separate, larger pass.

---

## 13. Stop condition

| Requirement | Status |
|---|---|
| Connected accounts appear as clickable multi-select chips | ✅ grouped by provider, provider + handle shown |
| One or multiple accounts selectable before batch creation | ✅ one-click toggle, multi-select, count, select-all, clear |
| Fan-out creates exactly one draft per selected account | ✅ 1 media × 3 accounts = 3 independent drafts |
| Invalid/duplicate destinations fail safely | ✅ deduped; unknown/disconnected/not-ready rejected before creation; no partial batch |
| Destination-chip UI copy is English-only | ✅ all 8 prescribed strings applied; zero Greek in the chip component (one flagged legacy exception, §7a) |
| Legacy unrelated page copy untouched | ✅ only the chip component was changed |
| Fan-out / validation / providers / scheduler / privacy / sound mode / styling architecture unchanged | ✅ copy-only correction; submitted payload byte-identical before and after |
| Tests and build pass | ✅ 537/537 tests, build exit 0 |
| Result artifact complete | ✅ this document |
| No provider call / commit / push | ✅ none |

**Not committed. Not pushed. Awaiting review.**
