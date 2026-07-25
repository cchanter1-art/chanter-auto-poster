# CHANTER AUTOPOSTER — UNIFIED COMPOSER + ENTITLEMENT COLLAPSE P0 — RESULT V1

**Repository:** `apps/chanter-auto-poster`
**Branch:** `product/unified-composer-entitlements-p0`
**Commit:** `1ea8766` (parent `5359b82`)
**Date:** 2026-07-25

---

## 1. Executive verdict

Delivered. There is now one canonical customer posting surface, `/platform/compose`, that serves one account and many accounts through the same page, the same form and the same endpoint. Package capabilities unlock inside it and are enforced server-side before anything durable is written. The former bulk-only page is redirected and its template deleted rather than left as a second implementation.

The central finding is that **Single and Multi were never two products**. Both surfaces already funnelled into one command path — `applicationService.schedulePost`, which already enforced entitlements via `commercialService.authorizeSchedule`. The duplication was entirely at the UI/route boundary. That made this a surface collapse, not a publishing-engine rewrite, and is why the diff is bounded.

One scoping decision is deliberately **not** what the task literally asked for, and is stated plainly in §11: the classic console's legacy intake form still exists. Removing it was rejected as a speculative rewrite. Read §11 before treating this as complete.

Tests 609/609, build green, branch pushed, **not merged**.

---

## 2. Previous checkpoint closeout evidence

Repository truth was verified against the prior report before any new work.

| Claim | Verified | Evidence |
|---|---|---|
| Branch `platform/module-agnostic-work-ingestion-p1` at `5359b82` | Yes | `git branch -avv`, HEAD `5359b82` |
| Based on `6e3249a` | Yes | `git rev-parse 5359b82^` → `6e3249a87ee0…` |
| `6e3249a` == `main` == `origin/main` | Yes | all three resolved identically |
| Contains module-agnostic ingestion changes | Yes | `git show --stat` — `platformWorkProviders.js`, `platformAutoPosterProvider.js`, `platformOperatorProvider.js`, `test/platform-work-providers.test.js` (+641) |
| Tests 581/581 | Yes | re-ran `npm test` → `# pass 581 # fail 0` |
| Build green | Yes | re-ran `npm run build` → `vite build ✓` |
| Push not performed | Yes | no `origin/platform/module-agnostic-work-ingestion-p1` existed |
| `firestore-debug.log` pre-existing untracked | Yes | still untracked; **not** committed, **not** deleted |

No mismatch found, so the closeout proceeded:

- pushed `platform/module-agnostic-work-ingestion-p1` → `origin`
- fast-forward merged into `main` (`Updating 6e3249a..5359b82`, `Fast-forward`)
- pushed `main` (`6e3249a..5359b82 main -> main`)
- post-push verification: `main`, `origin/main`, feature branch and its remote **all resolve to `5359b82f990cb215c7e51b6336e5ccec41d26b1c`**

No force-push, no history rewrite.

> Note: `git push` emits a `remote: This repository moved` notice (origin is `chanterAi/…`, GitHub canonicalises to `ChanterAi/…`). Pushes succeed; this is cosmetic. Worth normalising the remote URL at some point, but it is not part of this slice.

---

## 3. Repository-truth map

### Customer posting surfaces found

| Surface | Route | Template | Submission | Role |
|---|---|---|---|---|
| Bulk / "Multi" | `GET /platform/autoposter` | `platform-autoposter.ejs` | `POST /api/platform/batches` → `batchService.createBatch` | N files × M destinations |
| Classic / "Single" | `GET /private/autoposter` | `index.ejs` (form at :1003) | `POST /upload` | 1+ files, one provider, optional multi-channel |
| Client portal | `GET /client/autoposter` | `client-portal.ejs` | `POST /client/autoposter/upload` | separate client-session auth boundary |

**There is no Single/Multi toggle control anywhere in the repository.** The split was expressed as two separate customer modules in `platformModules.js` — `autoposter` (bulk) and `publishing-queue` (classic console). That registry is where the customer actually chose between two products.

### The convergence that already existed

```
POST /upload            ─┐
                         ├─→ applicationService.schedulePost ─→ commercialService.authorizeSchedule
batchService.createBatch ┘                                       (entitlements already enforced)
```

Shared validation, scheduling, draft state and approval gating were already single-sourced. Nothing about the publishing engine needed to change.

### Entitlement source (real, pre-existing)

`src/planCatalog.js` declares **`starter`, `creator`, `studio`, `legacy_full_access`** — the task's caution about fabricating `Starter/Pro/Business` did not apply; `Starter` is real, `Pro`/`Business` are not and were not introduced. Entitlements: `workspaceLimit`, `providerLimit`, `connectedAccountLimit`, `scheduledPostsPerCycle`, `activeQueueLimit`, `batchSizeLimit`, `schedulingHorizonDays`, `runtimeScheduling`, `advancedEvidence`. Resolution runs through `subscriptionService` → `entitlementResolver` → `commercialService`. Billing is explicitly unconfigured (`monthlyPrice: null`, `billing.configured: false`) and stayed that way.

### Duplication actually removed

Two composer UIs (dropzone, destination selection, scheduling, submit) with divergent scheduling models and divergent copy. One template deleted.

---

## 4. Canonical route and flow

**Composer:** `GET /platform/compose`
**Review + Accept:** `GET /platform/compose/:batchId` (renders the existing `platform-batch.ejs`)

```
1 Upload  →  2 Accounts  →  3 Caption  →  4 Schedule  →  5 Review  →  6 Accept
```

Steps 1–5 are one page shell (`platform-compose.ejs`) with a step rail reporting completion (`✔ 3 αρχεία`, `✔ 3 λογαριασμοί`, `✔ Λεζάντα…`, `✔ Συντομότερα · 14:06`, `✔ Έτοιμο`). Step 6 lands on the durable record where the human approval gate already lives — acceptance was **not** moved into the composer, because that gate is the product's safety boundary.

`/platform/compose` was chosen over reusing `/platform/autoposter` so the canonical route does not carry the old bulk-only name, and over `/private/autoposter` because §11 of the task designates that console as the dashboard.

---

## 5. Previous vs new architecture

| | Before | After |
|---|---|---|
| Customer posting entries | 2 modules (`autoposter`, `publishing-queue`) | 1 composer entry; console reframed as dashboard |
| Composer templates | 2 | 1 |
| Nav creation entries | 0 explicit (reached via Modules) | 1 explicit `Compose` |
| Selection control | checkbox list (bulk) / radio+checkbox (classic) | one control; `checkbox` when multi-account is unlocked, `radio` when locked |
| Scheduling models shown | 3 tabs (bulk) + repeat/offset (classic) | 1 decision, advanced collapsed |
| Command path | already shared | unchanged, still shared |
| Package rules | none at composer level | one seam, enforced both sides |

---

## 6. Entitlement source and enforcement boundary

New canonical seam: **`src/composerPolicy.js`**. It is the only place mapping plan entitlements → composer capabilities.

| Capability | Derived from | Starter | Creator | Studio | Legacy |
|---|---|---|---|---|---|
| `maxDestinationsPerPost` | `connectedAccountLimit` ∧ ceiling 10 | 2 | 5 | 10 | 10 |
| `multiAccountPosting` | `maxDestinationsPerPost > 1` | ✔ | ✔ | ✔ | ✔ |
| `perAccountOverrides` | derived from `multiAccountPosting` | ✔ | ✔ | ✔ | ✔ |
| `maxItemsPerDraft` | `batchSizeLimit` ∧ config `maxItems` | 5 | 25 | 30 | 30 |
| `advancedScheduling` | `batchSizeLimit > 1` \| unmetered | ✔ | ✔ | ✔ | ✔ |
| `schedulingHorizonDays` | passthrough | 7 | 30 | 90 | ∞ |

**Compatibility rule honoured:** every real plan retains exactly what it could already do. The seam only narrows structural ceilings by real plan limits; it takes nothing away. A single-destination package is reachable only via an explicit `entitlementOverride` — that is the state the locked presentation exists for, and it is tested.

**Enforcement:** `batchService.createBatch` calls `composerPolicy.checkComposerSubmission` immediately after resolving commercial scope and **before** `createBatchRecord` — so a refusal creates no partial state. Failures return HTTP 403 with codes `multi_account_locked`, `destination_limit_reached`, `draft_size_limit_reached`. The UI mirrors the same seam; it is never the boundary.

**One honest correction.** I first added a `per_account_overrides_locked` rule. Because `perAccountOverrides` is derived from `multiAccountPosting`, a package lacking it also caps destinations at 1, so the destination rule always fires first — the branch was **unreachable**, and the test I wrote for it was passing on the multi-account message while claiming to test override gating. I removed the dead branch and replaced the test with one that asserts the equivalence across the whole reachable space and names which rule actually fires. Gating per-account variation any harder would have removed variation every real plan has today.

---

## 7. Scheduling simplification

One decision:

```
◉ Συντομότερα · Earliest safe slot
○ Προγραμματισμός · Schedule   [date] [time]
```

Removed from the customer flow: the 3 scheduling mode tabs, the `staggerMinutes` field, and the classic console's `offsetMinutes` ("Minutes between channels"). Spacing is computed server-side from the one base time using `config.batchIntake.staggerDefaultMinutes`.

Proven (`one base time governs the whole draft; spacing is internal`): base `2026-07-11T09:00:00.000Z` is honoured exactly, and the 3 items are spaced by exactly the server default. Timezone proven separately: `09:00` at UTC+3 → `06:00Z`.

Multi-day scheduling (`dateRange`, `dailySlots`) survives — collapsed inside a closed `<details>`, shown only when entitled **and** when more than one item is staged — so no existing capability was removed.

---

## 8. History / dashboard movement

The bulk page rendered a "Πρόσφατες παρτίδες / Recent batches" list inside the composer. That is gone. The composer shows only the current draft's readiness (`#review-list`).

History and operational detail remain reachable and untouched at `/platform/work`, `/platform/approvals`, `/platform/evidence`, `/platform/health`, and the `publishing-queue` module (`/private/autoposter`) whose registry summary is now explicitly "Connected channels, release queue, publish history." No evidence, audit data or operational visibility was deleted.

---

## 9. Files changed

| File | Δ | What |
|---|---|---|
| `src/composerPolicy.js` | **new** | The canonical capability seam + submission check |
| `src/views/platform-compose.ejs` | **new** | The one composer, 6 steps |
| `test/unified-composer.test.js` | **new** | 28 tests across the validation matrix |
| `src/views/platform-autoposter.ejs` | **deleted** (−526) | The second composer implementation |
| `src/batchService.js` | +46/−12 | Capability enforcement; `getComposerCapabilities`; `MAX_DESTINATIONS` sourced from the seam |
| `src/platformRoutes.js` | +49/−17 | `/platform/compose`, `/platform/compose/:batchId`, two legacy redirects, caption forwarding |
| `public/platform/platform.css` | +111 | Step rail, lock line, review list, per-account rows, advanced disclosure |
| `src/platformModules.js` | +11/−4 | AutoPoster → canonical composer; console reframed as dashboard |
| `src/platformStatus.js` | +1/−1 | Work-item href → canonical review route |
| `src/views/_platform-nav.ejs` | +3 | One `Compose` entry |
| `src/views/platform-batch.ejs` | +2/−2 | Breadcrumb + post-delete redirect → canonical |
| `package.json` | +1/−1 | Build manifest: `composerPolicy.js`, `platform-compose.ejs`, new test |
| `test/platform-destination-chips.test.js` | +42/−33 | Layer 2 retargeted to the canonical composer |
| `test/platform-shell.test.js` | +9/−6 | Canonical href/route assertions |
| `test/platform-work-providers.test.js` | +2/−2 | Canonical href assertions |

15 files, +1859/−585.

---

## 10. Routes removed, redirected, retained

| Route | Disposition |
|---|---|
| `GET /platform/compose` | **new** canonical composer |
| `GET /platform/compose/:batchId` | **new** canonical review + accept |
| `GET /platform/autoposter` | **302 →** `/platform/compose` |
| `GET /platform/autoposter/batches/:batchId` | **302 →** `/platform/compose/:batchId` |
| `POST /api/platform/batches` | retained — the one canonical submission path (now also forwards caption/hashtags) |
| all other `/api/platform/*` | retained unchanged |
| `POST /upload`, `/private/autoposter` | retained — see §11 |

Redirects are thin, contain no second implementation, appear in no navigation, and are covered by tests.

---

## 11. Limitations and unresolved risks

**1. The classic console still contains a working single-post intake form.** This is the one acceptance criterion not fully met (`Single and Multi are no longer visible product modes` holds at the Platform customer boundary, not globally).

Why I stopped there rather than pushing through: removing it would have (a) gutted ~25 live assertions in `test/max-scheduler-routes.test.js` that legitimately guard that form's duplicate-submit protection, unknown-result handling and field-reset semantics, and (b) required the canonical composer to first reabsorb Auto Caption, Auto Music, `publicMediaUrl` and YouTube title/description, which the batch path does not accept at intake. That is a second slice with real product risk, not a redirect. The task forbids speculative rewrites and reducing test strictness; doing this properly conflicts with both.

Mitigation in place: `/private/autoposter` is now declared as the dashboard, is not the canonical composer entry, and the Platform's single creation entry points at `/platform/compose`. **Residual risk: a customer who navigates to the classic console can still compose there, through a different UI.** That is the honest state.

**2. The client portal (`/client/autoposter`) was not touched.** It sits behind a different auth boundary (client sessions, not admin) and was out of the bounded diff.

**3. "Earliest safe slot" is computed client-side** as `now + safetyBufferMinutes + 2min` in the user's timezone. The server re-validates and refuses a non-future base, so a skewed client clock produces a clear rejection rather than bad data — but it is a rejection, not a silent correction.

**4. `perAccountOverrides` currently cannot diverge from `multiAccountPosting`.** It is named separately for the UI and as the documented seam for a future billing rule, and a test asserts the equivalence so a future split cannot happen silently without also adding the server rule it would then need.

**5. No screenshots were captured.** The Browser pane was not displayed, so `computer{action:"screenshot"}` timed out. All UI evidence below is DOM/HTTP, actually produced. No visual claim is made beyond it.

---

## 12. Evidence

### Automated

`npm test` → **609 tests, 609 pass, 0 fail** (581 pre-existing + 28 new). `npm run build` → `node --check` across all sources, EJS compile of all 14 views, `vite build ✓`.

The 28 new tests cover: capability derivation across the real catalog; access preservation per plan; compatibility default; locked-state reachability; submission refusals with codes; a static check that **no plan id appears in `platform-compose.ejs`, `platformRoutes.js` or `batchService.js`**; one-shell/no-mode-selector; one-vs-many parity; locked presentation with no upsell; per-account gating; one scheduling decision (asserting absence of `staggerMinutes`/`offsetMinutes`); advanced-scheduling removal; history absence; review determinism; identical command path; caption delivery; base-time and stagger correctness; timezone; server-side refusals leaving zero state; intake replay restoring rather than duplicating; live redirects; single nav entry; dashboard separation.

### Live DOM / HTTP (real router + real views, session gate stubbed as in tests)

**Canonical composer, Creator package** — `GET /platform/compose?plan=creator`:
```
title: "Compose — CHANTER Platform"      composerForms: 1
steps: [upload, accounts, caption, schedule, review]
nav:   [Overview, Compose, Modules, Work, Approvals, Evidence, System health]
selectionControlType: ["checkbox"]        hasHistoryList: false
scheduleFields: { date: 1, time: 1 }      staggerField: false
advancedOpen: false                       YouTube chip: disabled
```

**One account then many, same page, same form** (3 files staged through the real dropzone input):
```
1 selected → "1 account selected"  · review: ✔ 3 αρχεία / ✔ 1 λογαριασμός / ✔ Λεζάντα / ✔ Συντομότερα · 14:06 / ✔ Έτοιμο  · submit enabled
3 selected → "3 accounts selected" · review: ✔ 3 αρχεία / ✔ 3 λογαριασμοί / ✔ Λεζάντα / ✔ Συντομότερα · 14:06 / ✔ Έτοιμο  · submit enabled
per-account variation toggle: hidden at 1 destination, visible at 3
```

**Locked package** — `?plan=starter&limit=1`:
```
controlType: ["radio"]        lockLine: "Multiple accounts | Locked by your package"
perAccountToggleExists: false  perAccountLockedExists: true
after attempting a 2nd selection: "1 account selected" (selected: [account-c])
upsellLinks (pricing|billing|upgrade|checkout|plans): []
```

**Legacy redirects** (live HTTP):
```
/platform/autoposter                      → opaqueredirect → lands /platform/compose            (200)
/platform/autoposter/batches/batch-xyz-789 → opaqueredirect → lands /platform/compose/batch-xyz-789 (200)
```

**Server-side refusal** (real `batchService` + real fan-out, deterministic tests):
```
starter + connectedAccountLimit 1, 2 destinations → BatchServiceError multi_account_locked (403), posts created: 0
starter (limit 2), 3 destinations                 → destination_limit_reached, limit 2, current 3, posts created: 0
studio, 2 destinations, varied sound              → accepted, per-account values preserved independently
```

**End-to-end draft path without publishing:** `createBatch` produces drafts with `approved !== true` and `status === 'scheduled'` for both the 1-account and 3-account cases; intake replay with the same `intakeKey` returns `replayed: true` with one stored post, not two.

The preview harness lived only in the scratchpad; the temporary `.claude/launch.json` entry was removed.

---

## 13. Branch, commit, push, merge status

| | |
|---|---|
| Previous checkpoint | `5359b82` pushed, fast-forward merged into `main`, `main` pushed, all refs aligned |
| Branch | `product/unified-composer-entitlements-p0` |
| Commit | `1ea8766` |
| Push | **pushed** to `origin` |
| Merge to `main` | **not performed** — no explicit authority to merge this slice |
| `firestore-debug.log` | untracked, uncommitted, undeleted |
| Force-push / history rewrite | none |

---

## 14. Recommended next step

**Retire the classic console's intake form** — the one open item from §11. It is a self-contained slice: port Auto Caption, Auto Music, `publicMediaUrl` and YouTube title/description into the canonical composer's Caption step (extending `createBatch` to accept them, which `schedulePost` already supports), then reduce `/private/autoposter` to the dashboard it is already declared to be and rewrite the intake assertions in `test/max-scheduler-routes.test.js` against the canonical composer. That closes the last visible second composer and makes the acceptance criterion true globally rather than at the Platform boundary only.
