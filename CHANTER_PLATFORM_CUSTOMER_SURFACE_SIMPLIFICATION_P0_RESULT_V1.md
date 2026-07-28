# CHANTER Platform Customer Surface Simplification P0 Result V1

## 1. Base branch and starting HEAD

- Repository: `C:\Users\IT\OneDrive\Desktop\CHANTER\apps\chanter-auto-poster`
- Starting branch: `main`
- Exact starting HEAD: `79e7aa0b88779f410c9764360cc80e80770ba142`
- Reviewed AutoPoster commit: `3f816bac514ab7e66987994b6e40fc2a03c248e4`
- Base verification: the reviewed commit is an ancestor of the starting HEAD, and both commits resolve to tree `e23e8fdbe3837c4f978153f37146058bb3835922`.
- Working branch: `platform/customer-surface-simplification-p0`
- Permitted pre-existing `firestore-debug.log` remained untracked and untouched.

## 2. Actual route, view, style, and behavior trace

- Customer entry: `GET /platform/compose`
- Route handler: `src/platformRoutes.js`
- Rendered view: `src/views/platform-compose.ejs`
- Shared customer navigation: `src/views/_platform-nav.ejs`
- Customer styles: `public/platform/platform.css`
- Client behavior: inline script in `src/views/platform-compose.ejs`
- Canonical submit remains `POST /api/platform/batches`; success still requires canonical command or batch/series evidence.
- Legacy `/platform/autoposter` continues to redirect to `/platform/compose`.
- Existing coverage: `test/platform-canonical-route.test.js`, `test/platform-canonical-execution.test.js`, `test/unified-composer.test.js`, `test/platform-destination-chips.test.js`, and `test/platform-shell.test.js`.
- Added coverage: `test/platform-customer-surface.test.js`.

## 3. Before-state summary

The existing composer presented a long staged form with account, caption, schedule, review, and advanced controls expanded together. Its persistent navigation exposed platform work, approvals, evidence, health, and command surfaces. On mobile, the full control-room layout made the primary scheduling action difficult to identify and required substantial scrolling.

## 4. Final interaction flow

1. Initial state: one dominant `Upload` action, compact `Use a link`, and secondary `Queue`, `Accounts`, and `Activity` navigation.
2. Upload or hosted URL intake reveals selected count, compact previews, Date / Time, Caption, Select All, and Go.
3. Assets and ready accounts start selected. Select All is visibly active and reversible.
4. Existing account selection and advanced composer controls remain available under one `Options` disclosure.
5. Go submits only through the existing `/api/platform/batches` canonical path.
6. Canonical success collapses the form to `✓ Scheduled` and `View Queue`.
7. Failure shows `Could not schedule N item(s).` and `Review`; raw backend/provider text is not rendered.

The initial mocked customer screen contains 11 persistent visible words, excluding accessibility-only text. Primary visible actions remain within the four-action limit.

## 5. Visible elements removed or relocated

- Removed from persistent composer navigation: Work, Approvals, Evidence, System Status, and Command.
- Relocated customer navigation to Queue, Accounts, and Activity.
- Relocated connected-account choice, provider grouping, hosted URL, hashtag/sound tools, Auto Music, account variation, YouTube metadata, recurrence, and advanced scheduling behind `Options`.
- Kept channel connection, client access, package/usage, queue, and history capability on the existing private dashboard; added stable `#accounts`, `#queue`, and `#activity` anchors.
- Removed explanatory stage copy and technical failure details from the default customer path.
- No required capability or canonical contract was deleted.

## 6. Files changed

Production files (4):

- `public/platform/platform.css`
- `src/views/_platform-nav.ejs`
- `src/views/index.ejs`
- `src/views/platform-compose.ejs`

Test files (3):

- `test/platform-customer-surface.test.js` (new)
- `test/platform-destination-chips.test.js`
- `test/platform-shell.test.js`

Evidence artifact (1):

- `CHANTER_PLATFORM_CUSTOMER_SURFACE_SIMPLIFICATION_P0_RESULT_V1.md`

No backend, provider, persistence, schema, deployment, Operator, Agent Runtime, or root-workspace file changed.

## 7. Before and after browser evidence

Mocked local browser harness only; no provider credentials, Firestore mutation, or publication:

- Before desktop, 1440 x 900: `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\before-desktop-1440x900.png`
- After desktop initial, 1440 x 900: `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\after-desktop-initial-1440x900.png`
- After desktop flow, 1440 x 900: `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\after-desktop-flow-1440x900.png`
- Before mobile, 390 x 844: `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\before-mobile-390x844.png`
- After mobile initial, 390 x 844: `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\after-mobile-initial-viewport-390x844.png`
- After mobile flow, 390 x 844: `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\after-mobile-flow-390x844.png`
- After mobile success: `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\after-mobile-success-390x844.png`
- After mobile error: `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\after-mobile-error-390x844.png`

Observed proof:

- Desktop width: `innerWidth=1440`, `scrollWidth=1440`.
- Mobile width: `innerWidth=390`, content `scrollWidth=375`; no horizontal overflow.
- Select All off: `0 selected`, `aria-pressed=false`, Go disabled.
- Select All on: `1 selected`, `aria-pressed=true`, Go enabled.
- Success: confirmation visible and composer form hidden.
- Injected raw mock failure `RUNTIME_TOKEN_FAILURE: provider status 503` was not exposed.
- Review returned focus to the first relevant field and restored the form.
- Queue, Accounts, and Activity remained reachable.
- No browser console warning or error was observed.

## 8. Focused test output

Required command:

```text
node --test test/platform-canonical-execution.test.js test/platform-canonical-route.test.js test/platform-work-providers.test.js test/runtime-control-routes.test.js
```

Result:

```text
tests 54
pass 54
fail 0
duration_ms 708.9446
```

Additional customer-surface command:

```text
node --test test/platform-customer-surface.test.js test/unified-composer.test.js test/platform-destination-chips.test.js test/platform-shell.test.js
```

Result:

```text
tests 82
pass 82
fail 0
duration_ms 718.8019
```

Logs:

- `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\focused-tests.log`
- `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\ui-tests.log`

## 9. Full test output

Command:

```text
npm test
```

Result:

```text
tests 653
pass 653
fail 0
duration_ms 4079.4549
```

Repository truth legitimately exceeds the task's 648-test reference baseline. Log:

`C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\full-tests.log`

## 10. Build output

Command:

```text
npm run build
```

Result:

```text
vite v8.0.16
24 modules transformed
✓ built in 102ms
exit 0
```

Log:

`C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\build.log`

## 11. Diff hygiene

Command:

```text
git diff --check
```

Result: exit `0`, no whitespace errors. Git emitted only Windows working-copy LF-to-CRLF advisory warnings; no file-wide normalization was performed.

## 12. Final `git status --short`

```text
 M public/platform/platform.css
 M src/views/_platform-nav.ejs
 M src/views/index.ejs
 M src/views/platform-compose.ejs
 M test/platform-destination-chips.test.js
 M test/platform-shell.test.js
?? CHANTER_PLATFORM_CUSTOMER_SURFACE_SIMPLIFICATION_P0_RESULT_V1.md
?? firestore-debug.log
?? test/platform-customer-surface.test.js
```

Branch: `platform/customer-surface-simplification-p0`

No commit, merge, push, deploy, feature-flag change, approval, provider call, or publication occurred.

## 13. Remaining risks or blockers

- Browser proof uses the real view, styles, and client behavior against a local mock canonical endpoint. It intentionally does not prove a real provider, Firestore, or production environment.
- The task did not authorize live credentials or publication, so those paths remain untested and untouched.
- No acceptance blocker remains within the authorized customer-surface scope.

## 14. Final verdict

`PASS`

The default customer path is now action-first, within the primary-action and persistent-copy limits, responsive at both required viewports, progressive-disclosure safe, and still bound to the existing canonical execution contract.
