# Firestore-backed scheduling architecture

This replaces the local-JSON-file + node-cron scheduler with Firestore as
the single source of truth. It does not change posting logic, OAuth, or
the dashboard UI — only how scheduled jobs are stored and claimed.

## Why the old system lost jobs

Two separate problems, both caused by Render's web services having an
ephemeral filesystem:

1. **Data loss.** `data/posts.json` (and the TikTok/Instagram auth token
   files) lived only on local disk. Any restart — a redeploy, a crash, or
   the dyno spinning back up after being idle — reverts the filesystem to
   what was in the deployed image, silently dropping anything written at
   runtime.
2. **Missed wake-ups.** `node-cron` only fires while the Node process is
   alive. If the service spins down from inactivity, the cron job isn't
   "paused" — it simply doesn't exist until something else makes an HTTP
   request that wakes the dyno back up.

Moving the data to Firestore fixes (1). It does not, by itself, fix (2) —
you still need something external hitting `/api/cron/tick` on a schedule
(see "Wake-up trigger" below) so a sleeping dyno actually gets woken up in
time. The reason this combination is safe is idempotency: no matter how
many things call the scheduler, or how overlapping or delayed those calls
are, Firestore transactions guarantee each post is claimed and published
at most once.

## Firestore schema

### `posts/{postId}`

| Field | Type | Notes |
|---|---|---|
| `userId` | string | Owner. Placeholder value today (see `src/auth.js`); already wired through every query and rule. |
| `platform` | string | `"tiktok"` — the only platform the automatic scheduler publishes to today. Instagram is a manual/secondary action tracked via `lastInstagramResult`. |
| `accountId`, `tiktokOpenId` | string | Stable TikTok `open_id` owning this job. Jobs without either field are normalized as `legacy` and cannot publish automatically. |
| `username` | string | TikTok username captured with the job for display; it is not used as an identity key. |
| `caption`, `hashtags` | string | The post's text content. |
| `mediaType`, `mediaPath`, `videoPath`, `imagePath`, `fileName`, `originalName`, `mimeType` | string | Local media reference (kept flat, not nested under a `media` object — see note below). |
| `publicImageUrl`, `instagramMediaUrl` | string | Public HTTPS URLs needed for TikTok's `PULL_FROM_URL` photo flow and Instagram. |
| `privacyLevel`, `disableComment`, `disableDuet`, `disableStitch`, `contentDisclosure`, `yourBrand`, `brandedContent` | various | TikTok Direct Post API settings, unchanged from before. |
| `scheduledTimeUTC` | Timestamp \| null | When this should publish. Firestore `Timestamp`, not a string — needed for correct `<=` range queries. |
| `status` | string | `pending` \| `processing` \| `ready` \| `posted` \| `failed`. `processing` replaces the old `publishing` value (see naming note). |
| `approvedAt`, `approvedBy` | Timestamp \| null, string \| null | Human-approval gate, orthogonal to `status`. A job is a **draft** until `approvedAt` holds a real Timestamp; `claimPost()` refuses to claim unapproved jobs on every publish path (cron tick, `/run-scheduler`, admin/client "Publish Now"), failing closed on missing or corrupted values. Admin batch intake creates jobs unapproved; the client portal records the client's own single-post submission as approval (`client:@handle`). |
| `history` | array | Redacted evidence log, capped at 50 entries: `{ at, event, detail? }` for created/validated/edited/approved/approval_revoked/publish_attempt/posted/failed/retry_scheduled/lock_reclaimed. Never stores tokens or raw API payloads. |
| `fileSize`, `duplicateWarning` | number, string | Intake duplicate protection: same filename+size (or same public URL) already on the channel sets a human-readable warning on the new draft. Warn-only — the reviewer decides. |
| `lockedAt` | Timestamp \| null | Set when a worker claims the post; cleared on finalize. |
| `lockedBy` | string \| null | Which worker holds the claim. |
| `claimAttempts` | number | Incremented on every claim; used to give up after `SCHEDULER_MAX_ATTEMPTS`. |
| `order` | number | Manual queue ordering (move up/down). |
| `createdAt`, `updatedAt`, `postedAt`, `readyAt` | Timestamp \| null | Lifecycle timestamps. |
| `lastResult`, `lastInstagramResult` | map \| null | Raw publish attempt results, shown in the "Advanced" debug panel. |

**Naming notes, called out explicitly rather than silently applied:**

- The spec's `content` and `media` fields are represented as the flat
  fields above (`caption`/`hashtags`, `mediaType`/`mediaPath`/etc.) rather
  than nested `content: {}` / `media: {}` objects. Nesting them would mean
  rewriting every call site in `tiktok.js`, `instagram.js`, and the EJS
  view that reads `post.caption`, `post.mediaType`, and so on — a pure
  rename with no functional benefit, and directly in tension with "don't
  break posting logic / don't redesign the UI." If you'd still prefer the
  literal nested shape for schema aesthetics, it's a mechanical change —
  just say so.
- The in-flight state is called `processing`, not `publishing`, to match
  the spec's "pending → processing" wording. The dashboard still *shows*
  "Publishing" — that's a label string in `routes.js`, decoupled from the
  Firestore enum value on purpose.
- The terminal success state is still called `posted` (not `published`)
  because that's what the existing badges, CSS classes, and labels
  already say throughout `index.ejs`. Functionally identical to the
  spec's "published".

### `tiktokAccounts/{encodedOpenId}`

One document per TikTok account. `accountId` and `open_id` contain TikTok's
stable OAuth `open_id`; the record also stores that account's tokens, profile
labels, connection state, owner `userId`, and lifecycle timestamps. Workers
resolve credentials from each job's `accountId`, never from browser selection.

### `config/{settings|tiktokAuth|instagramAuth}`

`config/tiktokAuth` remains only as a backward-compatible source for lazy
migration into `tiktokAccounts`; new OAuth connections do not overwrite it.
Instagram remains disabled and retains its existing singleton document.

<!-- Historical single-account description retained for migration context.
Three singleton documents holding what used to be `data/settings.json`,
`data/tiktok_auth.json`, and `data/instagram_auth.json`. These aren't
named in the original spec (which is scoped to the posts collection), but
moving them into Firestore too was necessary: leaving OAuth tokens on
local disk would mean the scheduler has nothing to authenticate with
after the very first restart, which defeats the point of fixing the
scheduler. They remain single shared documents — there's still one TikTok
account and one Instagram account for the whole app, same as before.
Per-user social accounts would be a separate, bigger feature.
-->

## Atomic claim — preventing double-publish

`src/scheduler.js`'s `claimPost()` runs as a single Firestore transaction:
read the post, check its status, write `status: "processing"` plus lock
metadata. If two callers race for the same post — two ticks overlapping,
a tick and a manual "Post now" click, or (if you ever scale to multiple
Render instances) two separate processes — Firestore lets exactly one
transaction commit. The other sees on (re-)read that the status is no
longer claimable and returns `null` instead of publishing. This holds
regardless of how many processes are calling it; it is not based on an
in-memory flag.

The actual TikTok API call happens *outside* any transaction, after a
successful claim — transactions should never wrap a non-idempotent
network call, since the SDK can retry a transaction body on contention.

## Recovery flow

1. **Render restarts or redeploys.** Pending posts are untouched —
   they're rows in Firestore, not files on the dyno's disk or timers in
   its memory.
2. **The web service was asleep when a post became due.** The canonical
   Render Cron Job invokes `npm run scheduler:ping` every minute. That
   command calls `GET /api/cron/tick` with `CRON_SECRET` in the
   `x-cron-secret` header. There is no in-process scheduler timer.
   `render.yaml` declares the cron, but the file is only deployment intent:
   the Blueprint must be instantiated (or the exact cron service must be
   created) and the active `chanter-scheduler-ping` service must be verified
   in Render before scheduled dispatch is operational.
3. **The scheduler crashes before provider dispatch.** The post remains
   `processing` with a stable dispatch operation. After
   `SCHEDULER_STALE_LOCK_MINUTES` (default 10), a tick can return a claim
   that never entered the provider adapter to `pending`, subject to
   `SCHEDULER_MAX_ATTEMPTS` (default 5).
4. **The scheduler crashes after provider dispatch begins.** The stale
   claim is marked `outcome_unknown` and automatic redispatch is blocked.
   The durable dispatch operation ID and provider evidence must be
   reconciled before any founder-authorized retry. This fails closed
   instead of risking a duplicate provider publication.

## Multi-user

Every post carries `userId`. `storage.getPosts(userId)` /
`getPost(userId, id)` / `updatePost` / `deletePost` / `movePost` all
filter or verify ownership, so one user's post is structurally
unreachable from another user's requests — even though, today, every
request resolves to the same placeholder `userId` (see `src/auth.js`,
`APP_DEFAULT_USER_ID` env var). Wiring in real authentication later means
changing the body of one function (`attachUser` in `src/auth.js`) to set
`req.userId` from a verified session/token; nothing else needs to change.

## Indexes

See `firestore.indexes.json`. Three composite indexes: `(status,
scheduledTimeUTC)` for the claim query, `(status, lockedAt)` for the
stale-lock watchdog, and `(userId, order)` for the per-user dashboard
listing. These make the scheduler's queries index range-scans regardless
of how many total posts exist — claiming due posts doesn't get slower as
the collection grows into the thousands. If any index here turns out to
be misspecified, Firestore's own error message includes a direct console
link to create the exact missing one — so the worst case is one extra
click, not a silent failure.

## Required environment variables

Already present on Render per your dashboard: `FIREBASE_CLIENT_EMAIL`,
`FIREBASE_PRIVATE_KEY`, `FIREBASE_STORAGE_BUCKET`. Add:

- `FIREBASE_PROJECT_ID` — your Firebase project ID. (Falls back to
  `VITE_FIREBASE_PROJECT_ID` if you'd rather not duplicate it, but that
  var was almost certainly wired up for a separate frontend client SDK,
  not this server.)

Optional tuning (all have sane defaults):

- `APP_DEFAULT_USER_ID` (default `owner`)
- `SCHEDULER_STALE_LOCK_MINUTES` (default `10`)
- `SCHEDULER_MAX_ATTEMPTS` (default `5`)
- `SCHEDULER_BATCH_SIZE` (default `1`, maximum `10`)

## Migration

1. Enable **Cloud Firestore** (Native mode) in the same Firebase project
   you're already using for Storage, if it isn't enabled yet.
2. Add `FIREBASE_PROJECT_ID` to Render's environment.
3. `npm install` (adds `firebase-admin`).
4. Optionally deploy rules/indexes: `firebase deploy --only
   firestore:rules,firestore:indexes` (or create the composite indexes
   by hand in the console — same effect).
5. If you have meaningful queue data to preserve, run
   `npm run migrate:firestore:dry-run` against a checkout that still has
   `data/*.json` present, review the output, then `npm run
   migrate:firestore` for real. Given the dashboard currently shows an
   empty queue and one posted item, a clean cutover (reconnect TikTok,
   re-upload anything pending) is also a perfectly reasonable shortcut —
   there's very little to lose.
6. Deploy the new code.
7. Verify: `/health` should report Firestore-backed counts; reconnect
   TikTok/Instagram if you skipped the migration step; upload a test post
   scheduled two minutes out and confirm it publishes; then manually
   restart the Render service and confirm a still-pending post survives
   and still fires on schedule — that last check is the actual fix being
   tested.
