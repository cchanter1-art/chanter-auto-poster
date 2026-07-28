# CHANTER Platform Accounts Surface Simplification P0 Result V1

## 1. Starting main HEAD

`6495f7fcad85c5543c30ae0474661b530be33e78`

Local `main` and `origin/main` matched before the feature branch was created.

## 2. Actual route, view, and style trace

Before this change, the customer Accounts navigation linked to
`/private/autoposter#accounts`. That destination was handled by
`GET /private/autoposter` in `src/routes.js`, rendered the large
`src/views/index.ejs` control-room view, and used its inline dashboard styles
and client behavior.

The simplified surface is now served by:

- route: `GET /private/autoposter/accounts`;
- handler: the existing `renderAutoPoster` data path in `src/routes.js`;
- view: `src/views/platform-accounts.ejs`;
- styles: the scoped Accounts rules in `public/platform/platform.css`;
- navigation: `src/views/_platform-nav.ejs`.

Existing account switch, OAuth connection, client-access, and disconnect
contracts remain the action targets.

## 3. Before-state summary

The old Accounts destination exposed the complete AutoPoster command center:
channel status paragraphs, provider and verification details, connection and
removal controls, client-portal explanations, YouTube and Instagram
configuration copy, plan and usage cards, composer controls, queue metrics,
publishing history, and internal/legacy terminology. Accounts was an anchor
inside that dashboard instead of a focused customer task.

## 4. Final interaction model

The default connected state shows:

1. `Current Account`;
2. the account handle;
3. a short text-and-dot connection signal;
4. `Switch`;
5. `Add Account`;
6. `Client Access`;
7. `Done`.

`Done` returns to `/platform/compose`. When there is no account, `Add Account`
is the single dominant action and `Done` remains a quiet escape to Composer.

The connected default contains four primary actions and 11 persistent visible
words excluding the account handle.

## 5. Removed or relocated elements

Removed from the default surface:

- plan and usage cards;
- queue, scheduled-post, and provider metrics;
- verification timestamps;
- provider configuration explanations;
- dry-run, internal, legacy, and server-side terminology;
- duplicated channel/account state;
- dashboard and posting controls unrelated to account management.

Relocated behind explicit disclosure:

- provider selection under `Add Account`;
- account selection under `Switch`;
- provider identity and verification date under `Manage`;
- client-access revoke under `Manage`;
- TikTok removal and YouTube disconnect under `Manage`;
- YouTube private-upload state under `Manage`;
- plan, usage, and Instagram state under `Manage`.

## 6. Files changed

Production:

- `package.json`
- `public/platform/platform.css`
- `src/auth.js`
- `src/routes.js`
- `src/views/_platform-nav.ejs`
- `src/views/client-access-generated.ejs`
- `src/views/platform-accounts.ejs`
- `src/views/platform-compose.ejs`

Tests:

- `test/admin-auth.test.js`
- `test/platform-accounts-surface.test.js`

Result:

- `CHANTER_PLATFORM_ACCOUNTS_SURFACE_SIMPLIFICATION_P0_RESULT_V1.md`

## 7. Desktop and mobile evidence

All browser proof used a local mocked renderer with no credentials and no
provider calls.

- before desktop, 1440 x 900:
  `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\accounts-before-desktop-1440x900.png`
- before mobile, 390 x 844:
  `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\accounts-before-mobile-390x844.png`
- after desktop default, 1440 x 900:
  `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\accounts-after-desktop-default-1440x900.png`
- after desktop disclosure, 1440 x 900:
  `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\accounts-after-desktop-disclosure-1440x900.png`
- after mobile default, 390 x 844:
  `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\accounts-after-mobile-default-390x844.png`
- after mobile disclosure, 390 x 844:
  `C:\Users\IT\.codex\visualizations\2026\07\28\019fa7d6-2771-77a2-8fdc-f4e0c5a9aabb\accounts-after-mobile-disclosure-390x844.png`

Observed browser evidence:

- desktop default rendered four primary actions and 11 persistent words;
- desktop disclosure kept technical and destructive controls subordinate;
- mobile default used a two-by-two action layout;
- mobile document width matched the viewport client width, with no horizontal
  overflow;
- keyboard-visible focus styling is present;
- connection state is conveyed with text as well as color;
- Switch submitted through the existing local account-selection route and
  returned an `Account switched` notice;
- browser console errors and warnings: 0.

## 8. Focused and full test totals

- Accounts plus auth focus:
  `node --test test/platform-accounts-surface.test.js test/admin-auth.test.js`
  - 13 passed, 0 failed.
- Canonical regression:
  `node --test test/platform-canonical-execution.test.js test/platform-canonical-route.test.js test/platform-work-providers.test.js test/runtime-control-routes.test.js`
  - 54 passed, 0 failed.
- Customer-surface regression:
  `node --test test/platform-customer-surface.test.js test/unified-composer.test.js test/platform-destination-chips.test.js test/platform-shell.test.js`
  - 82 passed, 0 failed.
- Full suite: `npm test`
  - 663 passed, 0 failed.

## 9. Build and diff-check results

- `npm run build`: PASS; EJS compilation, JavaScript syntax checks, and Vite
  production build completed successfully.
- `git diff --check`: PASS.

## 10. Commit hash

Single-commit target:
`platform/accounts-surface-simplification-p0`

The exact final hash is recorded in the task final response and confirmed by
the remote ref after push. A Git commit cannot contain its own final hash
inside a file included in that same commit; changing the file would change the
hash. This preserves the required one exact-scope commit without recording a
false or stale identifier here.

## 11. Remote branch confirmation

Target remote ref:
`origin/platform/accounts-surface-simplification-p0`

The exact `git ls-remote` confirmation is recorded in the task final response
after the single feature commit is pushed.

## 12. Final git status

Expected after the single scoped commit and push:

```text
?? firestore-debug.log
```

`firestore-debug.log` was not edited, deleted, staged, or committed.

## 13. Remaining blockers

none

## 14. Final verdict

PASS

The original dashboard-style Accounts destination is replaced by a calm,
button-first customer surface. Required capabilities remain reachable,
secondary detail is disclosed on demand, all required automated and browser
checks pass, and no merge, deployment, feature-flag activation, provider
mutation, approval, or publication was performed.
