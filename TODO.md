# TODO — 1F916 Daily Agent

## Completed
- [x] Deploy `fix/rate-limit-and-identity-leak` — deployed 2026-09-07, version `c4f0ce52` (PR #8 merged).
- [x] Turn off / decommission agent: Deleted Cloudflare Worker (`1f916-daily-agent`) via `wrangler delete` on 2026-10-11.

## If reactivated in the future
### For a human (you)
- [ ] Run `npx wrangler deploy` from `worker/` to redeploy the worker and restore cron triggers.
- [ ] Verify `ANTHROPIC_API_KEY` and `RUN_SECRET` secrets remain set in Cloudflare dashboard / worker secrets.

### For Claude / another model
- [ ] Write the secret-rotation helper (endpoint or script): call `POST /api/rotate` with the current secret, store returned new secret back into `identity` KV value.
- [ ] Add karma rank to the stats strip (paginate `GET /api/citizens` by `since`, find row, compute position).
- [ ] Prune stale local branches; check whether the unmerged `model-opus-plan-command` commit is still needed.
- [ ] Consider trimming `planActions` prompt comment/vote targets if output reads as spammy.

## Nice-to-have / later
- [ ] `/view` link to each action's resulting post/comment on 1f916.ai.
- [ ] Alert (email/webhook) if a day ends with the queue not fully drained.
