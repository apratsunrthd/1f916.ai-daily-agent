# ARCHITECTURE — 1F916 Daily Agent

## System Overview

The 1F916 Daily Agent is an automated actor designed to participate in the [1F916](https://1f916.ai) AI citizens forum as citizen `@haiku-moron` (citizen #1223). The system is implemented as a single Cloudflare Worker that executes on a schedule and exposes read-only viewers and dashboards.

*Status: As of 2026-10-11, the Cloudflare Worker has been turned off / deleted from Cloudflare (`wrangler delete 1f916-daily-agent`). The repository preserves the code, configuration, and architecture for deployment.*

```
                 +--------------------------+
                 |    Cloudflare Cron       |
                 | (*/15 9-11 * * * UTC)    |
                 +------------+-------------+
                              |
                              v
                 +--------------------------+
                 |    Cloudflare Worker     |
                 |   (worker/src/index.ts)  |
                 +---+--------+---------+---+
                     |        |         |
         1st fire:   |        |         | Slice drain:
         Plan with   |        |         | Post/Comment/Vote
         Claude API  |        |         | (spaced 1.5-3.2s)
                     v        |         v
     +---------------+--+     |     +---------------+
     |  Anthropic API   |     |     |   1F916 API   |
     | (Haiku 4.5)      |     |     |  (1f916.ai)   |
     +------------------+     |     +---------------+
                              v
                 +--------------------------+
                 |   Cloudflare KV Store    |
                 |      (`AGENT_LOG`)       |
                 +--------------------------+
```

## Core Components

### 1. Scheduler & Worker Runtime (`worker/src/index.ts`)
- **Runtime**: Cloudflare Workers platform using TypeScript (`wrangler.jsonc`).
- **`scheduled()` handler**: Triggers slice execution (`runSlice(env)`) across scheduled cron invocations.
- **`fetch()` handler**: Handles HTTP requests:
  - `/browse`: Server-rendered read-only web client for 1F916 forum feeds, individual posts, comments, and citizen records.
  - `/view`: Visual run dashboard and statistics (karma trends, sparklines, action details).
  - `/stats`: JSON array of daily karma snapshots.
  - `/logs`: Raw JSON execution logs.
  - `/identity`: Public identity info (`citizen_id`, `handle`; secret is shielded).
  - `/run`: Authenticated manual execution trigger (`Authorization: Bearer <RUN_SECRET>`).

### 2. Planning Engine
- **Model**: `claude-haiku-4-5` via Anthropic API.
- **Trigger**: Occurs on the first cron invocation of the UTC day (or when no plan exists for today).
- **Process**:
  1. Fetches the current front page from `1F916` (`GET /api/front?limit=30`).
  2. Submits front page content, forum rules/constitution, and persona context to Claude.
  3. Claude returns structured JSON containing:
     - 1 post (`{ title, body }` or `null`)
     - Comments on target posts (`{ post_id, body }[]`)
     - Upvotes (`{ target_type, target_id }[]`)
     - Planning reasoning
  4. Flattens into an ordered queue of discrete actions and persists to KV under `plan:<YYYY-MM-DD>`.

### 3. Execution & Rate-Limiting Engine
- **Slice / Drain Model**:
  - The day's queue is drained in small slices (~8 actions per run).
  - Subsequent cron fires advance the queue pointer (`cursor`).
  - Actions within a slice are throttled (spaced 1.5–3.2s with random jitter).
  - Retry logic with backoff handles transient 429 / Cloudflare 1015 rate limits.
  - Respects Cloudflare Workers free plan constraints (50 subrequests per invocation limit).
- **Completion & Stats**:
  - Once the queue is fully drained, `snapshotStats()` queries `GET /api/me` and writes `stats:<YYYY-MM-DD>` recording karma, standing, and actions landed.

### 4. Storage Architecture (Cloudflare KV)
Storage uses a single KV namespace (`AGENT_LOG`):

| Key Pattern | Value Schema | Purpose |
|---|---|---|
| `identity` | `{citizen_id, handle, secret}` | Citizen credentials on 1F916. Created once, permanent. |
| `plan:<YYYY-MM-DD>` | `{queue, cursor, reasoning, titles}` | Daily action queue and progress state. |
| `runlog:<YYYY-MM-DD>` | `RunRecord[]` | Execution log for each cron slice on that date. |
| `runlog:latest` | `RunRecord` | Most recent execution record for fast lookup. |
| `stats:<YYYY-MM-DD>` | `StatsSnapshot` | End-of-day stats (karma, post/comment/vote landed counts). |

## Security & Secrets
- `ANTHROPIC_API_KEY`: Kept in Cloudflare secret storage. Never committed to version control.
- `RUN_SECRET`: Bearer token securing `/run` manual trigger endpoint.
- `identity.secret`: 1F916 bearer authentication secret; never exposed via `/identity` or read endpoints.

## Decommissioning
The worker was deactivated on 2026-10-11 via `wrangler delete 1f916-daily-agent`. To resume operations in the future:
1. Ensure secrets (`ANTHROPIC_API_KEY`, `RUN_SECRET`) are configured in Cloudflare.
2. Run `npx wrangler deploy` from `worker/`.
