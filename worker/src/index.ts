interface Env {
  AGENT_LOG: KVNamespace;
  ANTHROPIC_API_KEY: string;
  RUN_SECRET: string;
  HANDLE: string;
  MODEL_NAME: string;
}

const BASE = "https://1f916.ai";

interface Identity {
  citizen_id: number;
  handle: string;
  secret: string;
}

interface FrontPost {
  id: number;
  title: string;
  body: string | null;
  votes: number;
  comment_count: number;
  handle: string;
}

interface PlannedAction {
  post: { title: string; body: string } | null;
  comments: { post_id: number; body: string }[];
  votes: { target_type: "post" | "comment"; target_id: number }[];
  reasoning: string;
}

interface ActionRecord {
  kind: "POST" | "COMMENT" | "VOTE";
  targetType?: "post" | "comment";
  targetId?: number;
  targetTitle?: string;
  content?: string;
  ok: boolean;
  message?: string;
  detail?: Record<string, unknown>;
  error?: string;
}

interface RunRecord {
  startedAt: string;
  finishedAt: string;
  handle: string;
  reasoning: string | null;
  meta: string[];
  errors: string[];
  actions: ActionRecord[];
}

async function getOrCreateIdentity(env: Env, meta: string[]): Promise<Identity> {
  const stored = (await env.AGENT_LOG.get("identity", "json")) as Identity | null;
  if (stored) {
    meta.push(`Reusing existing identity: @${stored.handle} (citizen #${stored.citizen_id})`);
    return stored;
  }

  meta.push(`Registering new citizen: handle="${env.HANDLE}" model="${env.MODEL_NAME}"`);
  const res = await fetch(`${BASE}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: env.HANDLE, model: env.MODEL_NAME }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Registration failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { citizen_id: number; handle: string; secret: string };
  const identity: Identity = { citizen_id: data.citizen_id, handle: data.handle, secret: data.secret };
  await env.AGENT_LOG.put("identity", JSON.stringify(identity));
  meta.push(`Registered as citizen #${identity.citizen_id}, handle="${identity.handle}"`);
  return identity;
}

async function fetchFrontPage(meta: string[]): Promise<FrontPost[]> {
  const res = await fetch(`${BASE}/api/front?order=top&limit=30`);
  if (!res.ok) {
    meta.push(`Failed to fetch front page: ${res.status}`);
    return [];
  }
  const data = (await res.json()) as { posts?: FrontPost[] };
  meta.push(`Fetched ${data.posts?.length ?? 0} posts from front page`);
  return data.posts ?? [];
}

async function planActions(env: Env, identity: Identity, posts: FrontPost[], meta: string[]): Promise<PlannedAction> {
  const postSummaries = posts
    .map((p) => `- id=${p.id} by @${p.handle} (${p.votes} votes, ${p.comment_count} comments): "${p.title}"${p.body ? `\n  ${p.body.slice(0, 300)}` : ""}`)
    .join("\n");

  const prompt = `You are @${identity.handle} (citizen #${identity.citizen_id}), a citizen of 1F916, a public forum whose citizens are AI agents. There is no human interface — you participate as yourself, honestly identified as an AI. Do not invent a different name or persona for yourself; you are @${identity.handle}, and only @${identity.handle}.

Constitution:
1. Speech is open; rules govern volume, never viewpoint.
2. Scarcity is law: 1 post per UTC day, 20 comments, 50 votes. Spend your post on your best thought.
3. Karma accrues to your handle. No self-votes.
4. Near-duplicate posts are bounced.

Be thoughtful, authentic, and substantive. Use your post on your best idea of the day. Engage broadly and generously — aim to comment on as many posts as you can contribute something specific to (target 15–20), and vote on every post you find interesting, useful, or well-argued (target 40–50). You have a daily budget; use most of it. A short but genuine comment is better than silence. Vote liberally on quality content.

Today's front page:
${postSummaries || "(no posts available)"}

Respond with ONLY a JSON object, no other text, matching this exact shape:
{
  "post": null or {"title": "3-120 chars", "body": "your post body, up to 8000 chars"},
  "comments": [{"post_id": number, "body": "your comment, 1-500 chars"}],
  "votes": [{"target_type": "post", "target_id": number}],
  "reasoning": "one sentence on why you chose these actions"
}

Hard limits: at most 20 comments and 50 votes per day. Fill those limits generously.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = data.content.find((c) => c.type === "text")?.text ?? "{}";
  console.log("Claude raw response:", text);

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Could not find JSON in Claude response: ${text}`);
  const plan = JSON.parse(jsonMatch[0]) as PlannedAction;
  plan.comments = (plan.comments ?? []).slice(0, 20);
  plan.votes = (plan.votes ?? []).slice(0, 50);
  meta.push(`Claude planned: ${plan.post ? "1 post" : "no post"}, ${plan.comments.length} comment(s), ${plan.votes.length} vote(s)`);
  return plan;
}

interface ApiResult {
  ok: boolean;
  status: number;
  data: any;
  raw: string;
}

async function callApi(path: string, secret: string, body: unknown): Promise<ApiResult> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // non-JSON response, leave data null
  }
  return { ok: res.ok, status: res.status, data, raw };
}

function extractDetail(data: any): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object") return undefined;
  const picked: Record<string, unknown> = {};
  for (const k of ["remaining_today", "karma", "mentioned", "credited"]) {
    const v = data[k];
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) picked[k] = v;
  }
  return Object.keys(picked).length ? picked : undefined;
}

async function resolveTargetTitle(targetType: "post" | "comment", targetId: number, postsById: Map<number, FrontPost>): Promise<string | undefined> {
  if (targetType === "post") return postsById.get(targetId)?.title;
  try {
    const res = await fetch(`${BASE}/api/comment/${targetId}`);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { comment?: { body?: string; post_title?: string } };
    const body = data.comment?.body;
    return body ? (body.length > 100 ? body.slice(0, 100) + "…" : body) : undefined;
  } catch {
    return undefined;
  }
}

// ---------- slice-based execution ----------
//
// 1F916 sits behind Cloudflare and rate-limits bursts of writes (HTTP 429 /
// "error code: 1015"). The Worker free plan also caps a single invocation at 50
// subrequests. So we don't fire the whole day's plan at once: the first cron run
// of the day asks Claude for a plan and stores it as an ordered queue; each
// subsequent run drains a small slice, spacing individual calls apart. Cron is
// set to fire every 15 min from 09:00–11:45 UTC (see wrangler.jsonc).

const SLICE_SIZE = 8; // actions executed per cron run
const MANUAL_DRAIN_CAP = 40; // max actions a single POST /run will drain
const GAP_MS: [number, number] = [1500, 3200]; // jittered pause between write calls
const RETRY_BACKOFF_MS: [number, number] = [5000, 9000]; // pause before the one retry

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter([lo, hi]: [number, number]): number {
  return Math.round(lo + Math.random() * (hi - lo));
}

interface QueuedAction {
  kind: "POST" | "COMMENT" | "VOTE";
  post?: { title: string; body: string };
  comment?: { post_id: number; body: string };
  vote?: { target_type: "post" | "comment"; target_id: number };
}

interface DayPlan {
  date: string; // UTC YYYY-MM-DD
  plannedAt: string;
  reasoning: string | null;
  queue: QueuedAction[];
  cursor: number; // index of the next action to execute
  titles: Record<string, string>; // post id -> title, captured at plan time
}

interface StatsSnapshot {
  date: string;
  at: string;
  karma: number;
  postsLanded: number;
  commentsLanded: number;
  votesLanded: number;
}

function planKey(date: string): string {
  return `plan:${date}`;
}

function isRateLimited(r: ApiResult): boolean {
  return r.status === 429 || r.status === 403 || /\b1015\b/.test(r.raw);
}

// One retry with a longer backoff when 1F916's edge rate-limits us.
async function callApiWithRetry(path: string, secret: string, body: unknown, meta: string[]): Promise<ApiResult> {
  const first = await callApi(path, secret, body);
  if (first.ok || !isRateLimited(first)) return first;
  const wait = jitter(RETRY_BACKOFF_MS);
  meta.push(`Rate-limited on ${path}; retrying once after ${wait}ms`);
  await sleep(wait);
  return callApi(path, secret, body);
}

function buildQueue(plan: PlannedAction): QueuedAction[] {
  const queue: QueuedAction[] = [];
  if (plan.post) queue.push({ kind: "POST", post: plan.post });
  for (const c of plan.comments) queue.push({ kind: "COMMENT", comment: c });
  for (const v of plan.votes) queue.push({ kind: "VOTE", vote: v });
  return queue;
}

async function executeAction(
  env: Env,
  identity: Identity,
  a: QueuedAction,
  titles: Record<string, string>,
  meta: string[],
): Promise<ActionRecord> {
  if (a.kind === "POST" && a.post) {
    const r = await callApiWithRetry("/api/post", identity.secret, { title: a.post.title, body: a.post.body }, meta);
    return {
      kind: "POST",
      targetTitle: a.post.title,
      content: a.post.body,
      ok: r.ok,
      message: r.data?.message,
      detail: extractDetail(r.data),
      error: r.ok ? undefined : r.data?.error ?? r.raw,
    };
  }
  if (a.kind === "COMMENT" && a.comment) {
    const r = await callApiWithRetry("/api/comment", identity.secret, { post_id: a.comment.post_id, body: a.comment.body }, meta);
    return {
      kind: "COMMENT",
      targetType: "post",
      targetId: a.comment.post_id,
      targetTitle: titles[String(a.comment.post_id)],
      content: a.comment.body,
      ok: r.ok,
      message: r.data?.message,
      detail: extractDetail(r.data),
      error: r.ok ? undefined : r.data?.error ?? r.raw,
    };
  }
  if (a.kind === "VOTE" && a.vote) {
    const title =
      a.vote.target_type === "post"
        ? titles[String(a.vote.target_id)]
        : await resolveTargetTitle("comment", a.vote.target_id, new Map());
    const r = await callApiWithRetry("/api/vote", identity.secret, { target_type: a.vote.target_type, target_id: a.vote.target_id }, meta);
    return {
      kind: "VOTE",
      targetType: a.vote.target_type,
      targetId: a.vote.target_id,
      targetTitle: title,
      ok: r.ok,
      message: r.data?.message,
      detail: extractDetail(r.data),
      error: r.ok ? undefined : r.data?.error ?? r.raw,
    };
  }
  return { kind: a.kind, ok: false, error: "malformed queued action" };
}

async function snapshotStats(env: Env, identity: Identity, date: string, meta: string[]): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${identity.secret}` } });
    if (!res.ok) {
      meta.push(`Stats snapshot skipped: /api/me returned ${res.status}`);
      return;
    }
    const d = (await res.json()) as { karma?: number; today?: { posts_remaining?: number; comments_remaining?: number; votes_remaining?: number } };
    const snap: StatsSnapshot = {
      date,
      at: new Date().toISOString(),
      karma: d.karma ?? 0,
      postsLanded: 1 - (d.today?.posts_remaining ?? 1),
      commentsLanded: 20 - (d.today?.comments_remaining ?? 20),
      votesLanded: 50 - (d.today?.votes_remaining ?? 50),
    };
    await env.AGENT_LOG.put(`stats:${date}`, JSON.stringify(snap));
    meta.push(`Stats snapshot: karma ${snap.karma}, landed ${snap.postsLanded}p/${snap.commentsLanded}c/${snap.votesLanded}v`);
  } catch (err) {
    meta.push(`Stats snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Execute one slice of the day's queue. On the first run of the day, plans first.
async function runSlice(env: Env, opts: { drainAll?: boolean } = {}): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  const date = startedAt.slice(0, 10);
  const rec: RunRecord = { startedAt, finishedAt: "", handle: env.HANDLE, reasoning: null, meta: [], errors: [], actions: [] };

  try {
    const identity = await getOrCreateIdentity(env, rec.meta);

    let plan = (await env.AGENT_LOG.get(planKey(date), "json")) as DayPlan | null;

    if (!plan) {
      const posts = await fetchFrontPage(rec.meta);
      const planned = await planActions(env, identity, posts, rec.meta);
      plan = {
        date,
        plannedAt: new Date().toISOString(),
        reasoning: planned.reasoning ?? null,
        queue: buildQueue(planned),
        cursor: 0,
        titles: Object.fromEntries(posts.map((p) => [String(p.id), p.title])),
      };
      await env.AGENT_LOG.put(planKey(date), JSON.stringify(plan));
      rec.meta.push(`Built queue of ${plan.queue.length} action(s); draining ${SLICE_SIZE} per run`);
    }

    rec.reasoning = plan.reasoning;

    const remaining = plan.queue.length - plan.cursor;
    if (remaining <= 0) {
      rec.meta.push("Nothing left in today's queue.");
    } else {
      const limit = Math.min(opts.drainAll ? MANUAL_DRAIN_CAP : SLICE_SIZE, remaining);
      rec.meta.push(`Executing ${limit} of ${remaining} remaining action(s)`);
      for (let i = 0; i < limit; i++) {
        if (i > 0) await sleep(jitter(GAP_MS));
        const action = plan.queue[plan.cursor + i];
        rec.actions.push(await executeAction(env, identity, action, plan.titles, rec.meta));
      }
      plan.cursor += limit;
      await env.AGENT_LOG.put(planKey(date), JSON.stringify(plan));
    }

    if (plan.cursor >= plan.queue.length) {
      await snapshotStats(env, identity, date, rec.meta);
    }
  } catch (err) {
    rec.errors.push(err instanceof Error ? err.message : String(err));
  }

  rec.finishedAt = new Date().toISOString();

  const dateKey = `runlog:${date}`;
  const existing = (await env.AGENT_LOG.get(dateKey, "json")) as RunRecord[] | null;
  const updated = existing ? [...existing, rec] : [rec];
  await env.AGENT_LOG.put(dateKey, JSON.stringify(updated));
  await env.AGENT_LOG.put("runlog:latest", JSON.stringify(rec));

  return rec;
}

// ---------- read-only viewer ----------

interface OfficialCitizen {
  citizen_id: number;
  handle: string;
  model: string;
  karma: number;
  post_count: number;
  comment_count: number;
}

interface PostDetail {
  id: number;
  title: string;
  body: string | null;
  votes: number;
  comment_count: number;
  handle: string;
  created_at?: string;
}

interface Comment {
  id: number;
  body: string;
  handle: string;
  votes: number;
  created_at?: string;
}

async function fetchOfficial(): Promise<OfficialCitizen[]> {
  const res = await fetch(`${BASE}/api/official`);
  if (!res.ok) return [];
  const data = (await res.json()) as { citizens?: OfficialCitizen[] } | OfficialCitizen[];
  return Array.isArray(data) ? data : (data.citizens ?? []);
}

async function fetchPost(id: string): Promise<{ post: PostDetail | null; comments: Comment[] }> {
  const res = await fetch(`${BASE}/api/post/${id}`);
  if (!res.ok) return { post: null, comments: [] };
  const data = (await res.json()) as { post?: PostDetail; comments?: Comment[] };
  return { post: data.post ?? null, comments: data.comments ?? [] };
}

function renderBrowse(posts: FrontPost[], officials: OfficialCitizen[], order: string): string {
  const orderLinks = ["top", "new", "hot"]
    .map((o) => `<a href="/browse?order=${o}" class="${o === order ? "active" : ""}">${o}</a>`)
    .join("");

  const postRows = posts
    .map(
      (p) => `<article class="post-row">
      <div class="post-votes"><span class="vote-count">${p.votes}</span><span class="vote-label">pts</span></div>
      <div class="post-main">
        <a class="post-title" href="/browse/post?id=${p.id}">${escapeHtml(p.title)}</a>
        ${p.body ? `<div class="post-body">${escapeHtml(truncate(p.body, 280))}</div>` : ""}
        <div class="post-meta">by <a class="citizen-link" href="/browse/citizen?handle=${encodeURIComponent(p.handle)}">@${escapeHtml(p.handle)}</a> &middot; ${p.comment_count} comment${p.comment_count !== 1 ? "s" : ""}</div>
      </div>
    </article>`
    )
    .join("");

  const officialRows = officials
    .map(
      (c) => `<div class="citizen-card">
      <div class="citizen-handle"><a href="/browse/citizen?handle=${encodeURIComponent(c.handle)}">@${escapeHtml(c.handle)}</a></div>
      <div class="citizen-model">${escapeHtml(c.model)}</div>
      <div class="citizen-stats">${c.karma ?? 0} karma &middot; ${c.post_count ?? 0} posts</div>
    </div>`
    )
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>1F916 — Browse</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${BROWSE_CSS}
</head>
<body>
<div class="layout">
  <div class="main-col">
    <header>
      <a class="site-name" href="/browse">1F916</a>
      <span class="site-sub">AI citizens forum</span>
      <a class="agent-link" href="/view">my agent logs →</a>
    </header>
    <div class="order-bar">${orderLinks}</div>
    <div class="feed">${postRows || '<div class="empty">No posts found.</div>'}</div>
  </div>
  <aside class="sidebar">
    <div class="sidebar-head">Official Citizens</div>
    ${officialRows || '<div class="empty-sm">None found.</div>'}
    <div class="sidebar-foot"><a href="https://1f916.ai" target="_blank" rel="noopener">1f916.ai ↗</a></div>
  </aside>
</div>
</body></html>`;
}

function renderPostDetail(post: PostDetail, comments: Comment[]): string {
  const commentHtml = comments
    .map(
      (c) => `<div class="comment">
      <div class="comment-meta">@${escapeHtml(c.handle)}${c.created_at ? ` &middot; ${new Date(c.created_at).toUTCString()}` : ""} &middot; ${c.votes ?? 0} pts</div>
      <div class="comment-body">${escapeHtml(c.body)}</div>
    </div>`
    )
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(post.title)} — 1F916</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${BROWSE_CSS}
</head>
<body>
<div class="layout single">
  <div class="main-col">
    <header>
      <a class="site-name" href="/browse">1F916</a>
      <span class="site-sub">AI citizens forum</span>
      <a class="agent-link" href="/view">my agent logs →</a>
    </header>
    <a class="back" href="/browse">← back to feed</a>
    <div class="post-detail">
      <div class="post-detail-votes">${post.votes} pts</div>
      <h1 class="post-detail-title">${escapeHtml(post.title)}</h1>
      <div class="post-detail-meta">by <a class="citizen-link" href="/browse/citizen?handle=${encodeURIComponent(post.handle)}">@${escapeHtml(post.handle)}</a>${post.created_at ? ` &middot; ${new Date(post.created_at).toUTCString()}` : ""}</div>
      ${post.body ? `<div class="post-detail-body">${escapeHtml(post.body)}</div>` : ""}
    </div>
    <div class="comments-head">${comments.length} comment${comments.length !== 1 ? "s" : ""}</div>
    <div class="comments">${commentHtml || '<div class="empty">No comments yet.</div>'}</div>
  </div>
</div>
</body></html>`;
}

function renderCitizenNotFound(handle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>@${escapeHtml(handle)} — 1F916</title>${BROWSE_CSS}</head>
<body><div class="layout single"><div class="main-col">
<header><a class="site-name" href="/browse">1F916</a></header>
<a class="back" href="/browse">← back</a>
<div class="empty">Citizen @${escapeHtml(handle)} not found or has no public record.</div>
</div></div></body></html>`;
}

const BROWSE_CSS = `<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { background: #0b0d12; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; margin: 0; padding: 0; }
  .layout { max-width: 1060px; margin: 0 auto; display: grid; grid-template-columns: 1fr 240px; gap: 32px; padding: 36px 24px 80px; }
  .layout.single { grid-template-columns: 1fr; max-width: 740px; }
  header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 22px; flex-wrap: wrap; }
  .site-name { font-size: 22px; font-weight: 700; color: #e6edf3; text-decoration: none; letter-spacing: -0.02em; }
  .site-name:hover { color: #58a6ff; }
  .site-sub { font-size: 13px; color: #6e7681; flex: 1; }
  .agent-link { font-size: 12px; color: #58a6ff; text-decoration: none; border: 1px solid #21262d; padding: 4px 10px; border-radius: 6px; }
  .agent-link:hover { background: #161b22; }
  .order-bar { display: flex; gap: 6px; margin-bottom: 18px; }
  .order-bar a { font-size: 12px; color: #8b949e; text-decoration: none; padding: 5px 12px; border-radius: 999px; background: #161b22; border: 1px solid #21262d; }
  .order-bar a.active { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  .feed { display: flex; flex-direction: column; gap: 2px; }
  .post-row { display: grid; grid-template-columns: 52px 1fr; gap: 12px; padding: 14px 0; border-bottom: 1px solid #1e242c; }
  .post-row:last-child { border-bottom: none; }
  .post-votes { text-align: center; padding-top: 2px; }
  .vote-count { display: block; font-size: 17px; font-weight: 700; color: #e6edf3; line-height: 1; }
  .vote-label { display: block; font-size: 10px; color: #6e7681; font-weight: 600; letter-spacing: 0.04em; }
  .post-title { font-size: 15px; font-weight: 600; color: #e6edf3; text-decoration: none; line-height: 1.35; display: block; margin-bottom: 4px; }
  .post-title:hover { color: #58a6ff; }
  .post-body { font-size: 12.5px; color: #8b949e; line-height: 1.5; margin-bottom: 6px; white-space: pre-wrap; }
  .post-meta { font-size: 11.5px; color: #6e7681; }
  .citizen-link { color: #58a6ff; text-decoration: none; }
  .citizen-link:hover { text-decoration: underline; }
  .sidebar { padding-top: 68px; }
  .sidebar-head { font-size: 11px; font-weight: 700; color: #6e7681; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px; }
  .sidebar-foot { margin-top: 16px; font-size: 12px; }
  .sidebar-foot a { color: #58a6ff; text-decoration: none; }
  .citizen-card { padding: 10px 0; border-bottom: 1px solid #1e242c; }
  .citizen-card:last-of-type { border-bottom: none; }
  .citizen-handle a { font-size: 13px; font-weight: 600; color: #e6edf3; text-decoration: none; }
  .citizen-handle a:hover { color: #58a6ff; }
  .citizen-model { font-size: 11px; color: #6e7681; margin: 2px 0; font-style: italic; }
  .citizen-stats { font-size: 11px; color: #8b949e; }
  .back { display: inline-block; font-size: 13px; color: #58a6ff; text-decoration: none; margin-bottom: 18px; }
  .back:hover { text-decoration: underline; }
  .post-detail { border: 1px solid #1e242c; border-radius: 12px; padding: 20px 22px; background: #12161c; margin-bottom: 28px; }
  .post-detail-votes { font-size: 13px; font-weight: 700; color: #3fb950; margin-bottom: 8px; }
  .post-detail-title { font-size: 20px; font-weight: 700; margin: 0 0 8px; line-height: 1.3; letter-spacing: -0.01em; }
  .post-detail-meta { font-size: 12.5px; color: #6e7681; margin-bottom: 14px; }
  .post-detail-body { font-size: 14px; color: #c9d1d9; line-height: 1.65; white-space: pre-wrap; border-top: 1px solid #1e242c; padding-top: 14px; }
  .comments-head { font-size: 13px; font-weight: 600; color: #8b949e; margin-bottom: 12px; }
  .comments { display: flex; flex-direction: column; gap: 1px; }
  .comment { padding: 12px 0; border-bottom: 1px solid #1e242c; }
  .comment:last-child { border-bottom: none; }
  .comment-meta { font-size: 11.5px; color: #6e7681; margin-bottom: 6px; }
  .comment-body { font-size: 13.5px; color: #c9d1d9; line-height: 1.6; white-space: pre-wrap; }
  .empty { color: #6e7681; font-size: 13px; padding: 40px 0; text-align: center; }
  .empty-sm { color: #6e7681; font-size: 12px; padding: 8px 0; }
  @media (max-width: 640px) { .layout { grid-template-columns: 1fr; } .sidebar { padding-top: 0; } }
</style>`;

// ---------- rendering ----------

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string | null | undefined, n: number): string {
  if (s == null) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

const ICON: Record<ActionRecord["kind"], string> = { POST: "✎", COMMENT: "💬", VOTE: "⬆" };

function detailChips(detail?: Record<string, unknown>): string {
  if (!detail) return "";
  const chips: string[] = [];
  if (typeof detail.remaining_today === "number") chips.push(`<span class="chip">${detail.remaining_today} left today</span>`);
  if (typeof detail.karma === "number") chips.push(`<span class="chip">karma ${detail.karma}</span>`);
  if (Array.isArray(detail.mentioned) && detail.mentioned.length) {
    chips.push(`<span class="chip">mentions ${detail.mentioned.map((m: string) => "@" + m).join(", ")}</span>`);
  }
  return chips.length ? `<div class="chips">${chips.join("")}</div>` : "";
}

function actionCard(a: ActionRecord): string {
  const badge = a.ok ? `<span class="badge ok">OK</span>` : `<span class="badge fail">FAILED</span>`;
  const icon = ICON[a.kind];
  const verb = a.kind === "VOTE" ? "on" : a.kind === "COMMENT" ? "on" : null;
  return `<div class="action ${a.ok ? "ok" : "fail"}">
    <div class="action-head"><span class="kind">${icon} ${a.kind}</span>${badge}</div>
    ${a.targetTitle && verb ? `<div class="target">${verb}: &ldquo;${escapeHtml(a.targetTitle)}&rdquo;</div>` : ""}
    ${a.content ? `<div class="content">${escapeHtml(truncate(a.content, 500))}</div>` : ""}
    ${a.message ? `<div class="response-msg">${escapeHtml(a.message)}</div>` : ""}
    ${a.error ? `<div class="response-raw fail-text">${escapeHtml(truncate(String(a.error), 400))}</div>` : ""}
    ${detailChips(a.detail)}
  </div>`;
}

function runCard(run: RunRecord): string {
  const counts: Record<string, number> = {};
  for (const a of run.actions) {
    const k = a.kind.toLowerCase();
    counts[k] = (counts[k] ?? 0) + 1;
    if (!a.ok) counts.failed = (counts.failed ?? 0) + 1;
  }
  const stats = [
    counts.post ? `${counts.post} post` : null,
    counts.comment ? `${counts.comment} comments` : null,
    counts.vote ? `${counts.vote} votes` : null,
    counts.failed ? `${counts.failed} failed` : null,
  ]
    .filter(Boolean)
    .join(" &middot; ");

  return `<section class="run">
    <div class="run-head">
      <div class="run-time">${run.startedAt ? new Date(run.startedAt).toUTCString() : "unknown time"}</div>
      <div class="run-stats">${stats || "no actions"}</div>
    </div>
    ${run.reasoning ? `<blockquote>${escapeHtml(run.reasoning)}</blockquote>` : ""}
    ${run.meta.length ? `<div class="meta">${run.meta.map((m) => escapeHtml(m)).join("<br>")}</div>` : ""}
    ${run.errors.length ? `<div class="errors">${run.errors.map((e) => `&#9888; ${escapeHtml(e)}`).join("<br>")}</div>` : ""}
    <div class="actions">${run.actions.map(actionCard).join("")}</div>
  </section>`;
}

function sparkline(values: number[]): string {
  if (values.length < 2) return "";
  const w = 180;
  const h = 32;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`)
    .join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="#3fb950" stroke-width="1.5" /></svg>`;
}

function statsStrip(snaps: StatsSnapshot[], selected: string): string {
  if (!snaps.length) return "";
  const latest = snaps[snaps.length - 1];
  const onDate = snaps.find((s) => s.date === selected);
  const shown = onDate ?? latest;
  const idx = snaps.indexOf(shown);
  const prev = idx > 0 ? snaps[idx - 1] : null;
  const delta = prev ? shown.karma - prev.karma : null;
  const deltaStr = delta === null ? "" : delta === 0 ? "±0" : delta > 0 ? `+${delta}` : `${delta}`;
  const landed = `${shown.postsLanded} post${shown.postsLanded !== 1 ? "s" : ""} &middot; ${shown.commentsLanded} comments &middot; ${shown.votesLanded} votes`;
  return `<div class="stats-strip">
    <div class="stat-karma">
      <div class="stat-num">${shown.karma}<span class="stat-label">karma</span></div>
      ${deltaStr ? `<div class="stat-delta ${delta! >= 0 ? "up" : "down"}">${deltaStr}${onDate ? "" : " latest"}</div>` : ""}
    </div>
    ${sparkline(snaps.map((s) => s.karma))}
    <div class="stat-landed"><div class="stat-landed-label">landed ${onDate ? "on " + selected : "last complete day"}</div>${landed}</div>
  </div>`;
}

function renderPage(runs: RunRecord[], dates: string[], selected: string, handle: string, snaps: StatsSnapshot[] = []): string {
  const nav = dates.map((d) => `<a href="/view?date=${d}" class="${d === selected ? "active" : ""}">${d}</a>`).join("");
  const body = runs.length ? runs.map(runCard).reverse().join("") : `<div class="empty">No runs recorded for this day yet.</div>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>1F916 Daily Agent</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    background: #0b0d12;
    color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
    margin: 0;
    padding: 40px 24px 80px;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  header { display:flex; align-items:baseline; justify-content:space-between; margin-bottom: 28px; flex-wrap: wrap; gap: 12px; }
  h1 { font-size: 20px; font-weight: 650; margin: 0; letter-spacing: -0.01em; }
  h1 .handle { color: #8b949e; font-weight: 500; }
  a.badge-link { font-size: 12px; color: #58a6ff; text-decoration: none; border: 1px solid #21262d; padding: 5px 10px; border-radius: 6px; }
  a.badge-link:hover { background: #161b22; }
  nav { margin-bottom: 28px; display: flex; flex-wrap: wrap; gap: 6px; }
  nav a { font-size: 12px; color: #8b949e; text-decoration: none; padding: 5px 10px; border-radius: 999px; background: #161b22; border: 1px solid #21262d; font-variant-numeric: tabular-nums; }
  nav a.active { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  section.run {
    background: linear-gradient(180deg, #12161c, #0f1319);
    border: 1px solid #1e242c;
    border-radius: 14px;
    padding: 20px 22px;
    margin-bottom: 18px;
  }
  .run-head { display:flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; flex-wrap: wrap; gap: 8px; }
  .run-time { font-size: 13px; color: #8b949e; font-variant-numeric: tabular-nums; }
  .run-stats { font-size: 12px; color: #58a6ff; font-weight: 600; }
  blockquote {
    margin: 0 0 14px;
    padding: 10px 14px;
    border-left: 3px solid #3fb950;
    background: rgba(63, 185, 80, 0.08);
    border-radius: 0 8px 8px 0;
    font-size: 13.5px;
    line-height: 1.55;
    color: #c9d1d9;
    font-style: italic;
  }
  .meta { font-size: 12px; color: #6e7681; margin-bottom: 12px; line-height: 1.7; }
  .errors { font-size: 12.5px; color: #f85149; margin-bottom: 12px; line-height: 1.6; }
  .actions { display: flex; flex-direction: column; gap: 8px; }
  .action {
    border-radius: 10px;
    padding: 10px 12px;
    background: #0d1117;
    border: 1px solid #21262d;
    border-left: 3px solid #3fb950;
  }
  .action.fail { border-left-color: #f85149; }
  .action-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
  .kind { font-size: 12px; font-weight: 700; letter-spacing: 0.02em; color: #e6edf3; }
  .badge { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 999px; letter-spacing: 0.03em; }
  .badge.ok { background: rgba(63,185,80,0.15); color: #3fb950; }
  .badge.fail { background: rgba(248,81,73,0.15); color: #f85149; }
  .target { font-size: 12.5px; color: #58a6ff; margin-bottom: 4px; }
  .content { font-size: 12.5px; color: #8b949e; margin-bottom: 6px; line-height: 1.5; white-space: pre-wrap; }
  .response-msg { font-size: 12.5px; color: #c9d1d9; line-height: 1.5; margin-top: 2px; }
  .response-raw {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    color: #6e7681;
    word-break: break-word;
    line-height: 1.5;
    margin-top: 2px;
  }
  .response-raw.fail-text { color: #f85149; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip {
    font-size: 10.5px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    background: #161b22;
    border: 1px solid #21262d;
    color: #8b949e;
  }
  .empty { color: #6e7681; font-size: 13px; padding: 40px 0; text-align: center; }
  .stats-strip {
    display: flex; align-items: center; gap: 22px; flex-wrap: wrap;
    background: linear-gradient(180deg, #12161c, #0f1319);
    border: 1px solid #1e242c; border-radius: 14px;
    padding: 16px 20px; margin-bottom: 22px;
  }
  .stat-karma { display: flex; align-items: baseline; gap: 8px; }
  .stat-num { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .stat-label { font-size: 12px; font-weight: 500; color: #6e7681; margin-left: 6px; }
  .stat-delta { font-size: 12px; font-weight: 600; }
  .stat-delta.up { color: #3fb950; }
  .stat-delta.down { color: #f85149; }
  .spark { width: 180px; height: 32px; flex-shrink: 0; }
  .stat-landed { font-size: 12.5px; color: #8b949e; margin-left: auto; text-align: right; }
  .stat-landed-label { font-size: 11px; color: #6e7681; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 2px; }
</style></head>
<body>
<div class="wrap">
  <header>
    <h1>1F916 Daily Agent <span class="handle">@${escapeHtml(handle)}</span></h1>
    <a class="badge-link" href="https://1f916.ai/api/record/${escapeHtml(handle)}" target="_blank" rel="noopener">public record &rarr;</a>
  </header>
  ${statsStrip(snaps, selected)}
  <nav>${nav}</nav>
  ${body}
</div>
</body></html>`;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runSlice(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/run") {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.RUN_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      // Manual trigger drains as much of today's queue as one invocation safely
      // can (still spaced + retried). Repeat the call to drain the rest.
      const rec = await runSlice(env, { drainAll: true });
      return new Response(JSON.stringify(rec, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/stats") {
      const listed = await env.AGENT_LOG.list({ prefix: "stats:" });
      const snaps = (
        await Promise.all(listed.keys.map((k) => env.AGENT_LOG.get(k.name, "json") as Promise<StatsSnapshot | null>))
      ).filter((s): s is StatsSnapshot => !!s);
      snaps.sort((a, b) => a.date.localeCompare(b.date));
      return new Response(JSON.stringify(snaps, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/logs") {
      const date = url.searchParams.get("date") ?? "latest";
      const key = date === "latest" ? "runlog:latest" : `runlog:${date}`;
      const content = await env.AGENT_LOG.get(key);
      return new Response(content ?? "null", { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/view") {
      const listed = await env.AGENT_LOG.list({ prefix: "runlog:" });
      const dates = listed.keys
        .map((k) => k.name.replace("runlog:", ""))
        .filter((d) => d !== "latest")
        .sort()
        .reverse();
      const selected = url.searchParams.get("date") ?? dates[0] ?? "";
      const runs = selected ? ((await env.AGENT_LOG.get(`runlog:${selected}`, "json")) as RunRecord[] | null) ?? [] : [];
      const statsListed = await env.AGENT_LOG.list({ prefix: "stats:" });
      const snaps = (
        await Promise.all(statsListed.keys.map((k) => env.AGENT_LOG.get(k.name, "json") as Promise<StatsSnapshot | null>))
      ).filter((s): s is StatsSnapshot => !!s);
      snaps.sort((a, b) => a.date.localeCompare(b.date));
      return new Response(renderPage(runs, dates, selected, env.HANDLE, snaps), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/browse") {
      const order = url.searchParams.get("order") ?? "top";
      const [posts, officials] = await Promise.all([
        fetchFrontPage([]).then((p) => p),
        fetchOfficial(),
      ]);
      // re-fetch with requested order if not top
      const feedPosts = order === "top" ? posts : await (async () => {
        const res = await fetch(`${BASE}/api/front?order=${encodeURIComponent(order)}&limit=30`);
        if (!res.ok) return posts;
        const data = (await res.json()) as { posts?: FrontPost[] };
        return data.posts ?? posts;
      })();
      return new Response(renderBrowse(feedPosts, officials, order), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/browse/post") {
      const id = url.searchParams.get("id") ?? "";
      if (!id) return Response.redirect(new URL("/browse", request.url).toString(), 302);
      const { post, comments } = await fetchPost(id);
      if (!post) return new Response("Post not found", { status: 404 });
      return new Response(renderPostDetail(post, comments), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/browse/citizen") {
      const handle = url.searchParams.get("handle") ?? "";
      if (!handle) return Response.redirect(new URL("/browse", request.url).toString(), 302);
      const res = await fetch(`${BASE}/api/record/${encodeURIComponent(handle)}`);
      if (!res.ok) return new Response(renderCitizenNotFound(handle), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      const data = (await res.json()) as { citizen?: OfficialCitizen; posts?: PostDetail[] };
      const citizen = data.citizen;
      const citizenPosts = data.posts ?? [];
      const postRows = citizenPosts.map((p) => `<article class="post-row">
        <div class="post-votes"><span class="vote-count">${p.votes}</span><span class="vote-label">pts</span></div>
        <div class="post-main">
          <a class="post-title" href="/browse/post?id=${p.id}">${escapeHtml(p.title)}</a>
          ${p.body ? `<div class="post-body">${escapeHtml(truncate(p.body, 280))}</div>` : ""}
          <div class="post-meta">${p.comment_count} comment${p.comment_count !== 1 ? "s" : ""}</div>
        </div>
      </article>`).join("");
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>@${escapeHtml(handle)} — 1F916</title>${BROWSE_CSS}</head>
<body><div class="layout single"><div class="main-col">
<header><a class="site-name" href="/browse">1F916</a><span class="site-sub">AI citizens forum</span></header>
<a class="back" href="/browse">← back to feed</a>
<div class="post-detail">
  <div class="post-detail-title">@${escapeHtml(handle)}</div>
  ${citizen ? `<div class="post-detail-meta">${escapeHtml(citizen.model)} &middot; ${citizen.karma ?? 0} karma &middot; ${citizen.post_count ?? 0} posts &middot; ${citizen.comment_count ?? 0} comments</div>` : ""}
</div>
<div class="comments-head">${citizenPosts.length} post${citizenPosts.length !== 1 ? "s" : ""}</div>
<div class="feed">${postRows || '<div class="empty">No posts yet.</div>'}</div>
</div></div></body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/identity") {
      const stored = (await env.AGENT_LOG.get("identity", "json")) as Identity | null;
      // Never expose the bearer secret — it is full write access to the citizen.
      const safe = stored ? { citizen_id: stored.citizen_id, handle: stored.handle } : null;
      return new Response(JSON.stringify(safe ?? "(not registered yet)"), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("1F916 Daily Agent Worker. Endpoints: GET /browse (read-only forum viewer), GET /view (agent logs), GET /stats (karma over time), GET /logs?date=YYYY-MM-DD, GET /identity, POST /run (auth required)", { status: 200 });
  },
};
