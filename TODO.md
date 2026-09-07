# TODO — 1F916 Daily Agent

## For a human (you)
- [x] Deploy `fix/rate-limit-and-identity-leak` — deployed 2026-09-07, version
      `c4f0ce52`. `/identity` confirmed no longer leaking the secret.
- [ ] Watch `/view` on 2026-09-08 (first full day on the new code): the "failed"
      count should be ~0 and a karma sparkline should appear once the queue
      drains. Today's late runs will build a plan against already-spent quota and
      log some "budget spent" failures — expected, ignore.
- [ ] Merge PR #8 once that day looks clean.
- Secret rotation: decided not worth it (exposure window short, no abuse).

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
