# BRIEF — 1F916 Daily Agent

## What it is
A single Cloudflare Worker that acts once per day as citizen `@haiku-moron`
(citizen #1223) on [1f916.ai](https://1f916.ai), a forum whose users are AI
agents. It plans a day of activity with Claude Haiku, then executes it against
1F916's real JSON API. Runs entirely on Cloudflare (Worker + Cron + KV) — the
local machine is never involved after deploy.

## Current state — working
- Deployed at `https://1f916-daily-agent.apratsunrthd.workers.dev`.
- Registered identity persisted in KV (`identity` key). Handle is permanent.
- Daily cycle produces 1 post + ~18 comments + votes; karma **243** as of
  2026-09-07.
- Live viewer of the forum at `/browse`; run dashboard at `/view`.

## In progress — branch `fix/rate-limit-and-identity-leak` (this work)
Three fixes, **deployed** 2026-09-07 (version `c4f0ce52`), PR #8 open for review:

1. **Rate-limit fix.** The old code fired the whole day's plan in one burst;
   1F916's Cloudflare edge rate-limited it (`error code: 1015`) and ~28 votes/day
   failed — only 1 of 29 votes was landing. Now: first cron run of the day plans
   and stores an ordered action queue in KV (`plan:<date>`); each subsequent run
   drains 8 actions, spaced 1.5–3.2s apart, with one retry on 429/1015. Cron
   changed from `0 9 * * *` to `*/15 9-11 * * *` (12 fires, ~96 action capacity).
2. **Secret leak fix.** `GET /identity` was returning the bearer `secret` in
   plaintext with no auth — full write access to the citizen, including secret
   rotation (which would permanently lock us out). Now returns only
   `{citizen_id, handle}`.
3. **Stats.** New `snapshotStats()` reads `GET /api/me` when the daily queue
   finishes and stores a `stats:<date>` snapshot (karma + actions landed).
   `/view` shows a stats strip (karma, day-over-day delta, sparkline, landed
   counts); new `/stats` endpoint serves the raw snapshot array.

## What's next
See TODO.md. Headline items: deploy this branch; confirm a full day drains
cleanly; backfill is not possible (stats only start accruing from first run
after deploy).

## Key decisions
- **Stay on the Cloudflare free plan.** The slice/drain design is what makes
  that viable (free plan = 50 subrequests/invocation). Paid ($5/mo) would allow
  a single-burst design but isn't warranted.
- **Honest identity.** The planning prompt hard-codes the real handle + citizen
  number; `model` is set truthfully to `claude-haiku-4-5`.
- **KV as the only store.** No D1/Durable Objects. Keys: `identity`,
  `plan:<date>`, `runlog:<date>`, `runlog:latest`, `stats:<date>`.
