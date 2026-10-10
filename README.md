# reels-bot

Automated Instagram Reels bot that posts physics "merge evolution" simulations twice a day. Each reel shows items falling into a container, merging when same-tier items collide, evolving through tiers until a funny final form appears.

No AI-generated video — every reel is a real physics simulation recorded from a web page.

## How it works

1. **Claude generates a theme spec** — a JSON describing the evolution chain, icons, sounds, container, palette, and caption
2. **Assets are resolved** — emoji icons from Microsoft Fluent Emoji (MIT), sound effects and music from Freesound (CC0)
3. **The physics engine pre-simulates** the entire run deterministically using a seeded PRNG
4. **Playwright captures frames** at 30fps and pipes them to ffmpeg for H.264 encoding
5. **Audio is mixed in Node** — SFX events at exact timecodes, background music, loudness-normalized
6. **Posted to Instagram** via the Graph API's resumable upload flow

### Three sources for reels

| Source | How it works |
|--------|-------------|
| **Live** | Claude generates a fresh spec each run |
| **Nightly queue** | `--fill-queue=2` pre-generates specs while your plan limits are fresh |
| **Chat batch** | Run `npm run chat-prompt`, paste the output into claude.ai, save the JSON array to `queue/` |

## Setup (from Android phone + GitHub Codespace)

### 1. Create a private repo

- Go to github.com (desktop site mode on your phone)
- Create a new **private** repository
- Upload the contents of this zip (or unpack in a Codespace)

### 2. Install Claude Code (in a Codespace terminal)

```bash
npm i -g @anthropic-ai/claude-code
claude setup-token
```

This creates a `CLAUDE_CODE_OAUTH_TOKEN`. Copy it — you'll add it as a GitHub Secret.

> **Shared usage limits**: Claude Code uses your Claude subscription's usage. Check your plan's terms on automated use at [support.claude.com](https://support.claude.com).

### 3. Create a Freesound account

- Go to [freesound.org](https://freesound.org) and create a free account
- Go to [freesound.org/apiv2/apply/](https://freesound.org/apiv2/apply/) and create an API key
- **Read Freesound's API terms** — the default config uses only CC0 (public domain) sounds, which allow commercial use. If you enable `allowAttribution` in config.json, CC-BY sounds are also used and credits are auto-appended to captions.

### 4. Get a Meta access token

You need a **System User token** (non-expiring) with these permissions:
- `instagram_basic`
- `instagram_content_publish`
- `pages_read_engagement`

Steps:
1. Go to [business.facebook.com](https://business.facebook.com) → System Users
2. Create a System User with Admin role
3. Add your Instagram Business/Creator account as an asset
4. Generate a token with the permissions above
5. Find your Instagram User ID: `GET /me?fields=id,username` with the token

### 5. Add GitHub Secrets

Go to your repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Required | Description |
|--------|----------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes | From `claude setup-token` |
| `FREESOUND_API_KEY` | Yes | Your Freesound API key |
| `IG_USER_ID` | Yes | Instagram user ID |
| `IG_ACCESS_TOKEN` | Yes | Meta System User token |
| `TELEGRAM_BOT_TOKEN` | No | For Telegram alerts |
| `TELEGRAM_CHAT_ID` | No | For Telegram alerts |
| `ALERT_WEBHOOK_URL` | No | Slack/Discord webhook URL |

### 6. Enable workflow permissions

Repo → Settings → Actions → General → Workflow permissions → **Read and write permissions** → Save.

### 7. Edit config.json

Fill in your account details:
```json
{
  "account": {
    "niche": "satisfying merge evolution physics simulations",
    "audience": "teens who love oddly satisfying content",
    "voice": "playful, curious, a little absurd",
    "language": "English",
    "cta": "Follow to see what evolves next."
  },
  "pillars": [
    "evolution of living things",
    "evolution of technology",
    "food and cooking",
    "money and economy",
    "space and nature",
    "everyday life and work"
  ]
}
```

### 8. Run Setup Assets (once)

Go to Actions → "Setup Assets" → Run workflow. This downloads the generic SFX and music library (~40 sounds, ~20 music tracks). Takes about 10-15 minutes.

### 9. Do a dry run

Go to Actions → "Post Reel" → Run workflow → Check "Dry run". When it finishes, download the artifact to preview the video on your phone.

### 10. Let it run

The workflow runs on schedule:
- **07:30 UTC** — Morning post
- **16:30 UTC** — Evening post
- **03:00 UTC** — Nightly queue fill (2 reels)

Adjust the cron times in `.github/workflows/reels.yml`.

> **Note**: GitHub Actions cron can be delayed by up to 15 minutes. Check your [free Actions minutes](https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions) — each run uses about 5-10 minutes.

## Running on a VPS

```bash
# Install dependencies
sudo apt install ffmpeg fonts-noto-color-emoji imagemagick
npm ci
npx playwright install --with-deps chromium
npm i -g @anthropic-ai/claude-code
claude setup-token

# Copy .env.example to .env and fill in values
cp .env.example .env

# Test
node src/run.js --dry-run

# Add to crontab
crontab -e
# 30 7 * * * cd /path/to/reels-bot && node src/run.js --slot=morning >> /var/log/reels-bot.log 2>&1
# 30 16 * * * cd /path/to/reels-bot && node src/run.js --slot=evening >> /var/log/reels-bot.log 2>&1
# 0 3 * * * cd /path/to/reels-bot && node src/run.js --fill-queue=2 >> /var/log/reels-bot.log 2>&1
```

## CLI flags

| Flag | Description |
|------|-------------|
| `--dry-run` | Render but don't post |
| `--slot=morning\|evening` | Force a slot |
| `--pillar=<name>` | Force a theme pillar |
| `--source=live\|queue` | Force a source |
| `--spec=path.json` | Use a manual spec file |
| `--no-review` | Skip the AI review step |
| `--fill-queue=N` | Pre-generate N reels into the queue |

## Batch generation (chat prompt)

```bash
node scripts/chat-prompt.js 10
```

This writes `out/chat-batch-prompt.md`. Copy its contents into a normal Claude chat at claude.ai, save the JSON array response as a `.json` file, and upload it to your repo's `queue/` folder. The bot automatically splits array files into individual queue items.

## Asset licenses

All assets are tracked in `assets/LICENSES.json` with source, URL, author, and license for each file.

- **Icons**: Microsoft Fluent Emoji 3D (MIT license), with Noto Color Emoji (OFL) as fallback
- **Sounds**: Freesound CC0 (public domain) by default
- **Music**: Freesound CC0 by default

If you enable `allowAttribution` in config.json, CC-BY sounds are also used and "Sounds: <name> by <author> (CC BY)" is auto-appended to captions.

### Removing a bad sound

1. Delete the file from `assets/sfx/` or `assets/music/`
2. Remove its entry from the index JSON (`assets/sfx/index.json` or `assets/music/index.json`)
3. Add its Freesound ID to `assets/blocklist.json` so it's never picked again:
   ```json
   [12345, 67890]
   ```

## Alerts

Configure Telegram and/or a webhook URL in your secrets. On success, you get the reel link, source, and review status. On failure, you get the error. Set `NOTIFY_ON_SUCCESS=false` to only get error alerts.

The bot warns when the queue drops below the `queue.lowWater` threshold (default 3).

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Token expired" error | Generate a new System User token in Meta Business Suite |
| "Usage limit" from Claude | Wait for limit reset, or use queued specs |
| Queue empty | Run `--fill-queue=5` or use the chat batch method |
| Sound doesn't fit | Delete it and add its ID to blocklist.json |
| "No space left" in Actions | The runner has limited disk; reduce `musicPerMood` |
| Icon renders as "?" | The emoji may not be in Fluent Emoji; it will use font fallback |
| Video too short/long | Adjust `video.minSeconds`/`maxSeconds` in config.json |

## Project structure

```
src/
  run.js          — main entry point and orchestrator
  claude.js       — Claude Code CLI and API backends
  render.js       — Playwright frame capture + ffmpeg encoding
  audio.js        — PCM audio mixing + ffmpeg final mix
  assets.js       — icon and sound resolution
  freesound.js    — Freesound API client
  instagram.js    — Graph API publishing
  queue.js        — queue management
  storage.js      — S3/R2 upload (optional)
  notify.js       — Telegram and webhook alerts
  history.js      — post history tracking
  util.js         — shared utilities
  spec.js         — theme spec validation
engine/
  merge-jar.html  — simulation page
  merge-jar.js    — deterministic physics engine
prompts/
  theme.md        — Claude theme generation prompt
  pick-sounds.md  — Claude sound picking prompt
scripts/
  setup-assets.js — one-time asset library builder
  chat-prompt.js  — batch generation prompt writer
```
