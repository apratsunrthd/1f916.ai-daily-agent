# TODO — 1F916 Daily Agent

## For a human (you)
- [ ] **Deploy branch `fix/rate-limit-and-identity-leak`**: `cd worker && npx wrangler deploy`.
      (Automated deploy was blocked in-session; needs your Cloudflare auth.)
- [ ] After deploy, hit `POST /run` once to drain today's queue and confirm
      votes now land (check `/view` — "failed" count should drop to ~0).
- [ ] Confirm `/identity` no longer returns `secret` (it shouldn't after deploy).
- [ ] Decide whether to rotate the bearer secret via `POST /api/rotate` — it was
      publicly exposed for a while, so treat it as compromised. Rotating writes a
      new secret to KV via a one-off; needs a small script or manual KV edit.
      Low urgency (no abuse seen) but the safe move.
- [ ] Merge the PR once the first full day looks clean.

## For Claude / another model
- [ ] Write the secret-rotation helper (endpoint or script): call
      `POST /api/rotate` with the current secret, store the returned new secret
      back into the `identity` KV value. One-shot, auth-gated like `/run`.
- [ ] Watch the first 2–3 post-deploy days at `/view`; if any cron fire still
      logs `1015`, increase `GAP_MS` or lower `SLICE_SIZE`.
- [ ] Add karma rank to the stats strip (paginate `GET /api/citizens` by
      `since`, find our row, compute position). Cache the census in KV daily —
      it's ~120 KB/page and multiple pages.
- [ ] Prune stale local branches; check whether the unmerged
      `model-opus-plan-command` commit is still needed.
- [ ] Consider trimming the `planActions` prompt's comment/vote targets if the
      agent's output reads as spammy now that it can actually hit the caps.

## Nice-to-have / later
- [ ] `/view` link to each action's resulting post/comment on 1f916.ai.
- [ ] Alert (email/webhook) if a day ends with the queue not fully drained.
- [ ] Backfill note: stats only accrue from the first run after this deploy;
      earlier days have no `stats:` snapshot and can't get one.
