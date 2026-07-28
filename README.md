# CHANTER AutoPoster

The canonical workspace, plan, entitlement, usage, and future billing boundary is documented in [docs/AUTOPOSTER_SAAS_FOUNDATION.md](docs/AUTOPOSTER_SAAS_FOUNDATION.md). Billing and checkout are intentionally not implemented.

Protected Node.js + Express product surface for the CHANTER content workflow. Upload videos, prepare captions/hashtags, optionally generate Auto Caption and Auto Music output, schedule releases for connected TikTok or YouTube channels, review the Release Queue, and submit due items through the implemented provider path. YouTube uploads are private-only with subscriber notifications disabled.

AutoPoster is the first CHANTER commercial/public product candidate, but the operating language is intentionally conservative: TikTok API acceptance is not the same as a verified live public post unless TikTok returns a public post URL or an operator verifies it manually.

This app does not scrape TikTok, bypass TikTok security, automate unofficial account behavior, or guarantee final publication outside TikTok's own API and moderation flow.

## Current Product Scope

- Image and video upload through a protected admin surface.
- Cloudinary-backed durable media URLs with HTTPS public URL fallback.
- Multi-account TikTok connection and active-channel selection.
- Encrypted YouTube OAuth custody and private-only video uploads.
- Multi-channel campaign scheduling when multiple target channels are selected.
- Max Scheduler start-time plus per-channel release offset.
- Daily recurring campaigns with inclusive start/end dates, one-series approval, live job-count preview, and timezone-stable local posting times. See [docs/AUTOPOSTER_RECURRING_CAMPAIGNS.md](docs/AUTOPOSTER_RECURRING_CAMPAIGNS.md).
- Release Queue views for active channel and all channels.
- Auto Caption and Auto Music for uploaded videos when providers/tools are configured.
- Manual verification and manual-post fallback when API publication cannot be verified.
- Optional Instagram dry-run/test path; keep Instagram disabled unless explicitly configured.

## Install

```bash
npm install
```

If PowerShell blocks `npm.ps1`, use:

```powershell
npm.cmd install
```

## Run Locally

```bash
npm run dev
```

Then open:

```text
http://localhost:3000
```

If port `3000` is already in use, set `PORT` before running:

```powershell
$env:PORT = "3001"
npm.cmd run dev
```

Health check:

```text
GET /health
```

## Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

`.env.example` is the source of truth for runtime variable names. It contains no real secrets.

Required for normal protected operation:

- `ADMIN_PASSWORD`
- `CRON_SECRET`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `TIKTOK_CLIENT_KEY`
- `TIKTOK_CLIENT_SECRET`
- `TIKTOK_REDIRECT_URI`

Required for deployed scheduled publishing:

- `APP_URL`, set to the Render web-service origin.
- `PUBLIC_BASE_URL`, set only when local media paths must resolve to a public HTTPS origin.
- Matching `CRON_SECRET` on both the Render web service and cron service.

Optional providers and integrations:

- Auto Caption: one or more of `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `QWEN_API_KEY`.
- Auto Music: local `music-library` plus FFmpeg/FFprobe, with optional `AUTO_MUSIC_TOKEN_SECRET`.
- Canonical Platform execution: keep `PLATFORM_CANONICAL_EXECUTION_ENABLED=false`
  unless the Operator submit/control tokens, dedicated media-reference secret,
  Runtime control token, and persistent `uploads/canonical-staged` volume are
  all configured. The enabled path never falls back to the legacy direct write.
- Instagram: keep `ENABLE_INSTAGRAM=false`, `INSTAGRAM_TEST_MODE=true`, and `INSTAGRAM_PUBLISH_ENABLED=false` unless the Meta app is fully configured and public publishing is intentionally enabled.

`PUBLIC_BASE_URL` is only a fallback. For testing, paste a per-post `publicMediaUrl` such as `https://chanterr.com/media/tiktok-posts/test-image.png` into the queue item.

## Auto Caption Engine

Set at least one of `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `QWEN_API_KEY` on the web service to enable the upload form's Auto Caption toggle. `AI_PROVIDER=gemini` is the default. With the toggle on, selecting an uploaded video calls the protected `POST /api/auto-caption` preflight endpoint before the normal `/upload` form can create or schedule a job.

The backend uses packaged FFmpeg and FFprobe binaries to inspect the video, extract five chronological JPEG frames, and detect an audio stream. When audio and an OpenAI key exist, it creates a compact mono MP3 and sends it to the optional transcription model. Caption generation always receives the five frames, transcript when available, original filename, and video metadata.

Provider attempts start with `AI_PROVIDER`, then continue through configured Gemini, OpenAI, and Qwen adapters without repeating a provider. A quota or API failure automatically advances to the next configured provider. If every provider fails, the server returns deterministic local copy with 8-15 safe hashtags instead of failing the upload workflow. Existing manual caption and hashtag text is preserved as the first choice for this fallback.

Qwen uses its OpenAI-compatible multimodal chat endpoint. Set `QWEN_BASE_URL` to the compatible-mode `/v1` base for the region associated with the API key. Model names are configurable because provider availability varies by account and region.

The response fills the editable Caption and Hashtags fields. Turning Auto Caption off leaves the original manual workflow unchanged. If frame analysis or the AI request fails, existing manual text is preserved; a blank caption must be filled manually before scheduling.

Optional binary overrides are available for environments that manage FFmpeg separately:

```env
FFMPEG_PATH=/absolute/path/to/ffmpeg
FFPROBE_PATH=/absolute/path/to/ffprobe
```

Temporary analysis uploads, extracted frames, and extracted audio are deleted after each request. `GET /health` reports only provider/library readiness flags; API keys remain server-side and are never included in HTML or JSON responses.

## Auto Background Music Engine

Auto Music reuses the Auto Caption frame, transcript, filename, and metadata analysis to classify the video into one of five local categories. The server selects the highest-scoring entry from `music-library/musicCatalog.json`, then uses FFmpeg to render an MP4 before the normal `/upload` workflow creates or schedules the post.

Each catalog record contains `id`, `filename`, `category`, `mood`, `bpm`, `intensity`, and `tags`. Audio files live under:

```text
music-library/anime-epic/
music-library/cyberpunk-dark/
music-library/motivation-calm/
music-library/emotional-orchestral/
music-library/aggressive-trap/
```

The included demo MP3 files are original synthetic audio generated by `npm run music:generate-demo`. Replace them with music you have the right to embed and update the catalog filenames and metadata. Do not add third-party tracks without the required commercial and synchronization rights.

When source audio exists, it remains at full volume and background music is mixed at `AUTO_MUSIC_BACKGROUND_VOLUME`, clamped to 0.15-0.25. Silent videos receive the music at normal level. Both paths trim to the video duration and apply short fades. The browser receives only a short-lived signed prepared-media token; signing secrets and local paths are never exposed.

The rendered MP4 is uploaded to Cloudinary and becomes the durable media URL used by post-now and scheduled jobs. If selection, FFmpeg, token verification, or rendered upload fails, the server uploads the original video and continues. A preflight render staged across a service restart or another web instance also degrades to the original upload rather than blocking posting.

## TikTok Setup

1. Create a TikTok Developer app.
2. Enable Login Kit.
3. Enable the Content Posting API.
4. Register this redirect URI:

```text
http://localhost:3010/auth/tiktok/callback
```

5. Request the `video.publish` scope.
6. Add the app credentials to `.env`, then click `Connect TikTok` in the dashboard.

Photo posting uses TikTok's official Content Posting API endpoint:

```text
POST https://open.tiktokapis.com/v2/post/publish/content/init/
```

The image URL sent to TikTok must be HTTPS and publicly accessible. Localhost callback URLs are okay for OAuth testing, but localhost image URLs are not okay for TikTok posting.

## TikTok Publish Result Truth

TikTok Content Posting API responses can mean different things:

- `API accepted`: AutoPoster submitted the request and TikTok accepted the API payload.
- `Needs manual verification`: TikTok accepted the request but did not return a public URL, or the job needs operator review.
- `Posted verified`: only use this when a public TikTok URL is returned or an operator verifies the post inside TikTok.
- `Failed`: TikTok, media storage, auth, validation, or network handling rejected the attempt.

For compatibility, Firestore still uses the existing `posted` status after a successful API response. The visible UI and public demo language must treat that state as API acceptance unless a public URL or manual verification confirms the final post.

## Instagram Setup

Instagram support is parallel to TikTok. The existing scheduler still publishes through TikTok only; Instagram is triggered through the dedicated dashboard test button or API endpoint.

1. Create a Meta app and add Facebook Login/Instagram Graph API access.
2. Add a Facebook Page connected to an Instagram professional account.
3. Register this redirect URI:

```text
http://localhost:3010/auth/instagram/callback
```

4. Add the Meta app credentials to `.env`.
5. Keep `INSTAGRAM_TEST_MODE=true` and `INSTAGRAM_PUBLISH_ENABLED=false` while developing.
6. Click `Connect Instagram` in the dashboard, then use `Test Instagram` on a queued item.

Instagram publishing uses the official content publishing flow:

```text
POST /{ig-user-id}/media
GET /{container-id}?fields=id,status,status_code
POST /{ig-user-id}/media_publish
```

In test mode, CHANTER creates the media container and records/logs the API response, but skips `media_publish` so nothing is posted publicly. To allow public publishing later, set both:

```env
INSTAGRAM_TEST_MODE=false
INSTAGRAM_PUBLISH_ENABLED=true
```

Images, videos, and reels must be reachable through a public HTTPS URL. For videos/reels, add an `Instagram media URL` on the queue item or configure `PUBLIC_BASE_URL` so uploaded media resolves to a public URL.

Useful local endpoints:

```text
GET  /auth/instagram/start
GET  /auth/instagram/callback
GET  /api/instagram/status
GET  /api/instagram/status?containerId=...
POST /api/instagram/publish
```

`POST /api/instagram/publish` accepts JSON or form data:

```json
{
  "postId": "local-post-id",
  "mediaUrl": "https://example.com/image.jpg",
  "publishType": "photo",
  "caption": "Caption",
  "dryRun": true
}
```

Use `publishType` values `photo`, `reel`, or `story`. Every Instagram OAuth, discovery, media-container, status, and publish step is logged to the server console with access tokens redacted for Meta App Review screencasts.

## Manual Fallback

If TikTok API credentials or a public image URL are not configured, the scheduler still works locally:

1. Uploaded media is queued and scheduled.
2. The scheduler checks every minute.
3. When a pending item is due and cannot be API-published, it is marked `ready`.
4. The dashboard shows media and caption controls for manual verification.
5. After posting manually in TikTok, click `Mark posted manually`.

## Render Scheduling

`render.yaml` defines a web service and one Render Cron Job that calls
`/api/cron/tick` every minute. The file alone does not create either service:
the repository must be attached as a Render Blueprint instance, or the exact
cron service must be created through the existing Render deployment process.
After setup, verify that the Render workspace lists `chanter-scheduler-ping` as
an active cron service; a committed but uninstantiated Blueprint is not a
scheduler.

Set `APP_URL` on the cron service to the Render web-service URL. Both services
must use the same `CRON_SECRET`; the Blueprint environment group handles this
when deployed from `render.yaml`. `SCHEDULER_BATCH_SIZE` bounds each tick and
defaults to one so restoring a trigger cannot release an overdue backlog in one
unreviewed wave.

There is no in-process timer. Firestore is the source of truth, so a sleeping or restarted web service recovers overdue `scheduled` jobs on the next external tick. Each job is atomically changed to `processing` before TikTok submission, then to the existing compatibility state (`posted` for API acceptance or `failed` for terminal failure). The UI must still distinguish API acceptance from externally verified live publication.

Render runtime checklist:

- Web service: set admin, Firebase, Cloudinary, TikTok, optional provider, and optional Instagram variables from `.env.example`.
- Cron service: set `APP_URL` to the web service URL and share the same `CRON_SECRET`.
- Firebase: deploy Firestore indexes before enabling cron.
- TikTok: use the deployed `TIKTOK_REDIRECT_URI`, not the local callback.
- Media: configure Cloudinary for durable uploads; use `PUBLIC_BASE_URL` only for existing public HTTPS media.
- Secrets: never expose API keys or OAuth tokens through `VITE_` variables or frontend code.
- Optional/legacy aliases in `.env.example` exist for compatibility and should stay blank unless the deployment explicitly needs them.

Deploy the required Firestore indexes before enabling the cron job:

```bash
firebase deploy --only firestore:indexes
```

To run and inspect one tick manually:

```bash
curl -H "x-cron-secret: $CRON_SECRET" "$APP_URL/api/cron/tick"
curl -H "x-cron-secret: $CRON_SECRET" "$APP_URL/api/debug/jobs"
```

The tick response reports `now`, `checked`, `due`, `posted`, `failed`, and `errors`. Render logs include `[CRON_TICK]`, `[CRON_QUERY]`, `[JOB_FOUND]`, `[JOB_DUE]`, `[POST_START]`, and either `[POST_SUCCESS]` or `[POST_FAILED]`.

## Data Storage

Queue state, settings, and OAuth tokens remain in Firestore. New image and video uploads are sent from the Node.js backend to Cloudinary with `resource_type: "auto"`; Firestore stores the returned `secure_url` as `mediaUrl`. The local `uploads/` directory is temporary staging only, so Render restarts do not remove scheduled media.

Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` on the Render web service. The API secret is server-only and must never use a `VITE_` prefix or be added to frontend code.

After deployment, verify Cloudinary connectivity and an optional upload/read/delete cycle using the existing `CRON_SECRET`:

```bash
curl -H "x-cron-secret: $CRON_SECRET" "$APP_URL/api/storage/health?write=1"
```

The Add Media form also accepts an HTTPS Public Media URL without a file. When one file and a public URL are submitted together, the URL is used automatically if Cloudinary exhausts its upload retries.

Posts uploaded before this storage change may still reference Render-local `/uploads/...` paths. Re-upload those pending items after deployment if their media is no longer present.

## Public Proof Language

Safe public/demo language:

- "TikTok accepted the publish request."
- "Scheduled through CHANTER AutoPoster."
- "Needs manual verification."
- "Release prepared for the selected TikTok channel."

Unsafe unless externally verified:

- "Guaranteed posted."
- "Fully published live."
- "Public TikTok URL confirmed."
- "Posted to TikTok" when only API acceptance is known.

## Project Structure

```text
chanter-auto-poster/
  package.json
  .env.example
  README.md
  src/
    server.js
    config.js
    cloudinary.js
    scheduler.js
    storage.js
    tiktok.js
    routes.js
    views/
      index.ejs
  render.yaml
  firestore.indexes.json
  uploads/             # temporary staging only
```
