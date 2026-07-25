# CHANTER AUTOPOSTER — CANONICAL RECURRING SERIES + LEGACY UPLOAD RETIREMENT P2 — RESULT V1

**Repository:** `apps/chanter-auto-poster`
**Branch:** `product/canonical-recurring-series-p2`
**Commit:** `32d0e32` (parent `641dc74`)
**Date:** 2026-07-25

---

## 1. Executive verdict

Recurring daily is delivered inside `/platform/compose` as a scheduling choice, reusing the existing engine. `POST /upload` is **not removed**, and that is the one acceptance criterion this slice does not meet — stated here rather than buried in §14.

The caller inventory now shows **zero production callers** for `/upload`, so §12's removal condition on callers is satisfied. Removal was still not performed, because retiring the route also orphans the `mode:'max'` scheduling path it uniquely reaches, cascading into `computeMaxSchedulePlan` and three test files. That is a deletion slice of its own, and doing it with the budget left would have meant deleting production code I could not then re-validate carefully. The evidence and the exact removal plan are in §11.

Everything else is done: no second recurrence engine, deterministic series identity, replay-safe expansion, server-side bounds, honest approval semantics, and series observability on existing Platform surfaces without a new dashboard.

Tests 629/629, build green, branch pushed, **not merged**.

---

## 2. Checkpoint closeout evidence

| Claim in the P1 report | Verified | Evidence |
|---|---|---|
| Branch `product/retire-classic-composer-p1` pushed | Yes | local and `origin/` both `641dc74` |
| Commit `ba3bb3d` | **Refined** | present, but as the branch's **parent**. Tip is `641dc74`, the result-doc commit. Same pattern as P1; not a divergence. |
| Parent `b05f660` | Yes | `git rev-parse ba3bb3d^` → `b05f660…` |
| `main` == `origin/main` == merge-base | Yes | all `b05f660…`; fast-forward possible |
| Tests 620/620 | Yes | re-ran → `# pass 620 # fail 0` |
| Build green | Yes | re-ran → `vite build ✓` |
| `firestore-debug.log` untracked | Yes | untouched throughout |

Executed: `git merge --ff-only` → `Updating b05f660..641dc74  Fast-forward`; `git push origin main` → `b05f660..641dc74`. Post-push `main` and `origin/main` both `641dc748e7bcd3b400efaa83e7aaa18b11f54f89`; `git merge-base --is-ancestor ba3bb3d main` → **true**. No force-push, no rewrite.

---

## 3. Repository-truth recurring map

The engine was already complete and durable. Nothing about recurrence was written in this slice.

| Question (task §3) | Repository truth |
|---|---|
| Recurring command contract | `schedulePost({ schedule: { mode:'recurring_daily', startDate, endDate, startTime, timezoneName, timezoneOffsetMinutes } })` |
| Expansion | `maxScheduler.computeDailySchedulePlan` — pure, inclusive, same local wall-clock per day |
| Durable records | One post per **account × source × occurrence**; `scheduleEntries` are per (account × occurrence) and reused across sources |
| Series identity | `seriesId` = `campaignId`, stamped by storage on every child job |
| Occurrence linkage | `seriesOccurrenceIndex`, `seriesOccurrenceCount`, `seriesOccurrenceDate`, `seriesStartDate/EndDate`, `seriesFrequency`, `seriesTimezone`, `seriesSourceCount` |
| Approval enforcement | `selfApprove` at creation, else the ordinary Release Queue gate |
| `approveSeries` meaning | **Approve every generated draft now.** Not pre-authorisation of future occurrences — nothing exists beyond what expansion creates. |
| Bounds | `MAX_DAILY_OCCURRENCES = 365`, `MAX_RECURRING_JOBS = 200`, `MAX_SOURCE_COUNT = 100` |
| Storage validation | Fail-closed: series metadata shape, `sourceCount === sources.length`, `entries === accounts × occurrences`, complete per-account index range |
| Post-create verification | `created.length !== quantity` → partial-schedule error |
| Cancellation / editing | **Does not exist.** Occurrences are edited/deleted individually in the Release Queue. |
| Idempotency | Per-post `idempotencyKey` only, and it is constrained to exactly one channel — unusable for a multi-account series |

Multi-source recurring is supported by the engine (`occurrences × channels × sources`), so it was not artificially restricted to one source.

---

## 4. Canonical UX implemented

Default state unchanged:

```
◉ Συντομότερα · Earliest safe slot
○ Προγραμματισμός · Schedule
```

Recurring lives inside the collapsed **Advanced scheduling** disclosure:

```
□ Επανάληψη κάθε ημέρα · Repeat daily
    Τελευταία ημέρα · Last day      [date]
    □ Έγκριση όλης της σειράς τώρα · Approve the whole series now
    7 ημέρες × 1 λογαριασμοί × 1 = 7 δημοσιεύσεις
```

Enabling it selects the explicit Schedule option (a series needs a definite first release) and hides the multi-day spread tabs, so there is still exactly one scheduling decision. No offsets, no stagger, no cron, no recurrence objects, no wizard, no route.

---

## 5. Service and payload changes

```
/platform/compose
  → POST /api/platform/batches           (+ endDate, approveSeries)
  → batchService.createBatch             → branches on scheduleMode === 'recurringDaily'
  → createRecurringSeries                (intake projection ONLY)
  → applicationService.schedulePost      { schedule: { mode: 'recurring_daily', … } }   ← existing
  → maxScheduler.computeDailySchedulePlan                                               ← existing, untouched
  → storage.addUploadedPosts             scheduleEntries / scheduleSeries / campaignId  ← existing
```

The branch happens **late** — after the media-source, destination-availability, YouTube and connectivity checks both shapes share.

One extension to `schedulePost`: it now forwards a caller-supplied `campaignId` into creation defaults. Storage already stamped that value as `seriesId`; forwarding it is what makes a multi-account series replay-safe, since a per-post `idempotencyKey` cannot be (it is limited to one channel). Absent, storage generates one exactly as before.

**No second recurrence engine** — asserted, not asserted-about: `batchService` never calls `computeDailySchedulePlan`, contains no day arithmetic, and `computeBatchSchedulePlan`'s body contains no reference to recurrence.

---

## 6. Approval semantics

Rendered as what the code does:

- **off** — "Κάθε δημοσίευση μένει προσχέδιο μέχρι να την εγκρίνετε · Every occurrence stays a draft until you approve it."
- **on** — "Και οι 7 δημοσιεύσεις εγκρίνονται τώρα · All generated drafts are approved at creation."

Review always shows the state, and acceptance shows how many occurrences it affects. Approval is never publication: approved occurrences remain `status: 'scheduled'` behind the scheduler, and no test performs a public transition.

---

## 7. Entitlements and expansion bounds

Enforced server-side before any durable write, through the one canonical seam (`composerPolicy`) plus the engine's own bounds:

| Bound | Source | Enforced |
|---|---|---|
| Destinations per post | `composerPolicy` ← `connectedAccountLimit` | `checkComposerSubmission` before expansion |
| Sources per draft | `composerPolicy` ← `batchSizeLimit` | same |
| Occurrences ≤ 365 | `MAX_DAILY_OCCURRENCES` | `computeDailySchedulePlan` |
| Jobs ≤ 200 | `MAX_RECURRING_JOBS` | `computeDailySchedulePlan` |
| Scheduling horizon | `schedulingHorizonDays` (real plan entitlement) | `authorizeSchedule` via `quantity = accounts × sources × occurrences` |
| Monthly posts / active queue | real plan entitlements | `authorizeSchedule` |

The UI preview mirrors the same numbers (bounds are passed from the engine, not hard-coded) so it cannot promise a series the server would refuse. No plan name appears in any template, route, or service. Recurring stays available to every current plan.

---

## 8. Persistence, history, evidence

No series collection was invented. A series **is** the group of posts sharing a `seriesId`.

- `batchService.listSeries` groups durable posts and counts everything from them.
- `platformStatus.projectRecurringSeries` maps a group onto the one canonical work vocabulary and carries the recurrence parameters (frequency, start, end, timezone, occurrence count, first/last release) so Evidence retains what the series was asked to do.
- `platformSeriesProvider` registers under the **`publishing-queue`** module, not AutoPoster, because occurrences are Release Queue jobs reviewed on that surface. The work registry's ownership rule then permits its `/private/autoposter` link and would refuse any other.

Result: series appear on Work, Approvals (with the correct pending count) and Evidence with no new dashboard.

---

## 9. Failure handling

Every case returns a specific code, names the cause, and leaves **zero** durable state:

| Case | Code |
|---|---|
| Missing caption | `series_caption_required` |
| Missing start date/time | `series_start_required` |
| Missing end date | `series_end_required` |
| End before start | `validation_failed` (engine reason) |
| Run longer than 365 days | `validation_failed` (engine reason) |
| YouTube as recurring destination | `provider_not_recurring` |
| Destination not connected | `destination_unavailable` |
| Package limits exceeded | `multi_account_locked` / `destination_limit_reached` / `draft_size_limit_reached` |
| Both media sources | `ambiguous_media_source` |

A failed series is recoverable: the same intake key succeeds once corrected (proven).

---

## 10. Client portal impact

**Unaffected.** `/client/autoposter` has its own auth boundary, its own upload route (`POST /client/autoposter/upload`), and no recurring support — which this slice did not add, per §13. Nothing in the diff touches it; `client-routes` and the client half of `video-only-intake` pass unchanged. Removing `POST /upload` later would not affect it: they are different routes.

---

## 11. `POST /upload` caller inventory and decision

| Class | Finding |
|---|---|
| Active UI | **None** — removed in P1 |
| Client portal | **No** — uses `/client/autoposter/upload` |
| Internal runtime / MCP | **None** — `runtimeControlRoutes.js` contains no reference |
| Test-only | `max-scheduler-routes`, `multichannel-routes`, `video-only-intake` |
| Documentation | README + historical result docs (describe, do not depend) |
| External contract | **None documented** |

(The `POST /upload/youtube/v3/videos` hits are Google's API, unrelated.)

**Decision: retained this slice; removal not performed.** The caller condition is met. The blocker is a cascade, not a caller:

1. `/upload` is the only route reaching `schedule.mode === 'max'` (`computeMaxSchedulePlan`, `offsetMinutes`). Removing the route makes that production path unreachable — dead code that must then also be removed, with its planner and tests.
2. Three test files exercise real behaviour through it (video-only media policy on the upload path, multi-channel fan-out, unknown-result JSON contract). Migration means moving them to the canonical endpoint or to service-level tests, and some assertions have no canonical equivalent (`offsetMinutes` was deliberately removed from the customer flow in P0).

Doing that safely is a deletion slice with its own validation. Retaining a route with zero production callers is a real cost — it is a second command path that a determined caller can still reach — and it is why §14 recommends this as the immediate next step. It keeps its `Deprecation` / `Link: </platform/compose>; rel="successor-version"` headers, shares the same entitlement/idempotency/approval path, and is never a redirect.

---

## 12. Files changed

| File | Δ | What |
|---|---|---|
| `src/batchService.js` | +262 | `createRecurringSeries` intake projection, `seriesResult`, `listSeries`, recurring branch, `RECURRING_DAILY_MODE` |
| `src/views/platform-compose.ejs` | +191/−17 | Repeat-daily inside advanced scheduling, occurrence/timezone/approval preview, series review rows, submission branch |
| `src/platformStatus.js` | +65 | `projectRecurringSeries` onto the canonical work vocabulary |
| `src/platformSeriesProvider.js` | **new** | Series as a work provider under `publishing-queue` |
| `src/platformRoutes.js` | +16/−2 | Forwards `endDate`/`approveSeries`, registers the series provider, passes engine bounds |
| `src/autoposterApplicationService.js` | +7 | Forwards caller-supplied `campaignId` (series identity) |
| `package.json` | +1/−1 | Build manifest: `platformSeriesProvider.js` |
| `test/unified-composer.test.js` | +302/−15 | 9 recurring tests; fake extended to mirror the real series storage contract |
| `test/platform-batch-fanout.test.js` | +26 | YouTube refused as a recurring destination (needs a real connected channel) |
| `test/platform-work-providers.test.js` | +37/−9 | Third provider: paired stubs, provider list, health counts |

10 files, +895 / −48.

---

## 13. Validation and proof

`npm test` → **629 tests, 629 pass, 0 fail** (620 before + 9 new). `npm run build` → all `node --check`, EJS compile, `vite build ✓`.

### Service-level (real `batchService` fan-out, deterministic fakes)

| Proof | Result |
|---|---|
| 5-day single-account series | 5 occurrences, 5 jobs, one `seriesId`, indices `[0,1,2,3,4]` |
| Occurrence times | `2026-07-11T09:00Z` … `2026-07-15T09:00Z`, exactly 86400000 ms apart |
| Same source, same caption across occurrences | one distinct `originalName`, one caption |
| 5-day two-account series | 10 jobs, both accounts, one shared `seriesId` |
| `approveSeries: true` | all approved at creation, `pendingApprovalCount: 0`, all still `scheduled` |
| `approveSeries` absent | `pendingApprovalCount: 5`, none approved |
| Replay | `replayed: true`, same `seriesId`, posts stay **5** |
| Five invalid inputs | specific codes, `posts.length === 0` each time |
| Failure then correction | same intake key succeeds, 5 occurrences |
| Observability | `listSeries` → correct counts; projection → `publishing-queue`, `WAITING_APPROVAL`, `awaiting: 5`, href `/private/autoposter`, recurrence parameters intact |
| No second engine | `batchService` never calls the daily planner, no day arithmetic; batch planner body has no recurrence |

### Live DOM (real router + real views, session gate stubbed as in tests)

```
default        advancedOpen:false  when:[soonest, at]  defaultWhen:soonest
one-time       ✔1 αρχείο / ✔1 λογαριασμός / ✔Λεζάντα / ✔Συντομότερα · 21:43 / ✔Έτοιμο   submit:enabled
repeat on      recurringPanelVisible:true  forcedExplicitSchedule:"at"  spreadModesHidden:true
7-day, blocked preview "7 ημέρες × 1 λογαριασμοί × 1 = 7 δημοσιεύσεις"
               review … · Η σειρά χρειάζεται μία λεζάντα … ✔7 εμφανίσεις · 7 δημοσιεύσεις
                     ✔Κάθε δημοσίευση χρειάζεται έγκριση / ✔Ζώνη ώρας: Asia/Nicosia
               submit:DISABLED   ← the series caption rule, enforced before submit
+ caption      ✔Λεζάντα έτοιμη … ✔Έτοιμο   submit:enabled
+ approve      "Και οι 7 δημοσιεύσεις εγκρίνονται τώρα · All generated drafts are approved at creation."
               review: ✔Εγκρίνεται όλη η σειρά τώρα
over horizon   preview "Έως 365 ημέρες"   submit:DISABLED
repeat off     panel hidden, review returns to ✔2026-08-01 20:00 / ✔Έτοιμο
```

**No screenshots were captured** — the Browser pane was not displayed, so `computer{action:"screenshot"}` times out in this environment. Every figure above is DOM/HTTP output actually produced.

### Usage readiness

One-time single-account, one-time multi-account, URL-sourced, recurring single-account (5), recurring multi-account (10), and an invalid-then-corrected series: all durable, all approval-gated, none published, all observable, replay adds nothing.

---

## 14. Limitations and risks

1. **`POST /upload` still exists** with zero production callers (§11). It is a second command path reachable by a determined caller; it cannot bypass entitlements or approval, only the UI.
2. **`mode:'max'` is production code reachable only from `/upload`.** It will become dead the moment that route is removed.
3. **No series cancel/pause/edit.** Occurrences are individually editable in the Release Queue, as before. `postsMapper` persists series metadata explicitly ahead of such controls, but they do not exist.
4. **A series requires a caption at intake.** Deliberate — per-occurrence AI generation would give one video N different captions — but it is stricter than the old `/upload` behaviour, which allowed an empty caption.
5. **Multi-source recurring is allowed** because the engine supports it (N × M × K bounded at 200 jobs). It is coherent but was not a classic-form UX, so it is untested in real use.
6. **`listSeries` reads all workspace posts and groups in memory.** Fine at current scale; it is a full scan per Work render.
7. **Daily only.** Weekly/monthly/cron were explicitly out of scope (§18) and were not built.

---

## 15. Branch, commit, push, merge status

| | |
|---|---|
| Previous checkpoint | `641dc74` (contains `ba3bb3d`) fast-forwarded to `main`, pushed, verified |
| Branch | `product/canonical-recurring-series-p2` |
| Commit | `32d0e32` |
| Push | **pushed** |
| Merge to `main` | **not performed** — requires explicit post-review authority |
| `firestore-debug.log` | untracked, uncommitted, untouched |
| Force-push / rewrite | none |
| Scratch data | preview harness and scripts stayed in the scratchpad; the temporary `.claude/launch.json` entry was removed |

---

## 16. Recommended next step

**Remove `POST /upload` and the `mode:'max'` path it uniquely reaches.** The caller condition is already proven (§11); what remains is the deletion itself: drop the route and its `uploadCampaignMedia` middleware, drop `schedule.mode === 'max'` from `schedulePost` plus `computeMaxSchedulePlan` and `DEFAULT_OFFSET_MINUTES` once nothing reaches them, and migrate the three test files — `video-only-intake`'s admin half to `POST /api/platform/batches`, `multichannel-routes`' fan-out to the canonical fan-out tests that already cover it, and `max-scheduler-routes`' surviving assertions to service-level tests. That closes the last duplicate command path and completes the structural cleanup this task set out to finish.
