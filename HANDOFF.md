# HANDOFF — 1F916 Daily Agent

First time in this repo? Read this, then `BRIEF.md` for status and `TODO.md` for
what's next.

## Architecture
One Cloudflare Worker, one file: `worker/src/index.ts` (~900 lines). No build
step beyond `wrangler`. No framework.

- **`scheduled()`** → `runSlice(env)` on every cron fire.
- **`fetch()`** → HTTP router for the read endpoints + `POST /run`.
- Storage is the `AGENT_LOG` KV namespace only.

## Where things live in `src/index.ts`
| Concern | Functions |
|---|---|
| Identity (register once, reuse) | `getOrCreateIdentity` |
| Daily planning (calls Claude) | `fetchFrontPage`, `planActions`, `buildQueue` |
| Slice execution | `runSlice`, `executeAction`, `callApiWithRetry`, `sleep`, `jitter` |
| Stats | `snapshotStats` (reads `GET /api/me`) |
| Run dashboard `/view` | `renderPage`, `runCard`, `actionCard`, `statsStrip`, `sparkline` |
| Forum viewer `/browse` | `renderBrowse`, `renderPostDetail`, `fetchPost`, `fetchOfficial`, `BROWSE_CSS` |

## KV keys
- `identity` — `{citizen_id, handle, secret}`. The secret is write access; never
  serve it.
- `plan:<YYYY-MM-DD>` — `{queue: QueuedAction[], cursor, reasoning, titles}`.
  Built by the first cron run of the day, advanced by each later run.
- `runlog:<YYYY-MM-DD>` — array of `RunRecord`, one per cron fire that did work.
- `runlog:latest` — most recent `RunRecord`.
- `stats:<YYYY-MM-DD>` — `StatsSnapshot`, written when the day's queue finishes.

## How to run it
```sh
cd worker
npm install
npx tsc --noEmit          # typecheck
npx wrangler deploy --dry-run   # build check
npx wrangler deploy        # deploy (needs Cloudflare auth)
```
Secrets required in the Worker: `ANTHROPIC_API_KEY`, `RUN_SECRET`.
Manual trigger: `curl -X POST https://<worker>/run -H "Authorization: Bearer $RUN_SECRET"`
(drains up to 40 queued actions; call again to finish).

## Gotchas
- **1F916 rate-limits bursts** with `error code: 1015` (Cloudflare, not 1F916's
  app logic). Keep write calls spaced. Do not remove the `sleep()` between
  actions in `runSlice`.
- **Free plan: 50 subrequests per invocation.** A slice of 8 + title lookups +
  the first run's front/Claude fetches stays well under; don't raise
  `SLICE_SIZE` past ~15 without checking.
- **1F916 identity is unrecoverable.** No rename, no secret reset. Guard the
  `identity` KV value.
- **UTC everywhere.** `date` = `new Date().toISOString().slice(0,10)`.
- `setTimeout` works in the Workers runtime (no `nodejs_compat` needed for it).
- Cron `*/15 9-11 * * *` = 12 fires 09:00–11:45 UTC. First plans, rest drain.

## Open threads / Current Status
- **Decommissioned on 2026-10-11**: The Cloudflare Worker was deleted via `wrangler delete 1f916-daily-agent` per user request.
- The KV store (`d57b79e8de6e41558f6d49bc5379c67f`) retains the citizen identity credentials and run logs.
- To re-enable the agent in the future, run `npx wrangler deploy` from `worker/`.
- Stale local branches from earlier merged PRs can be cleaned up as needed.
