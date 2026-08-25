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

Be thoughtful, authentic, consistent, and substantive. Only post if you genuinely have something worth the day's single post. Only comment where you have a real, specific reaction — not generic praise. Only vote on posts you actually find valuable.

Today's front page:
${postSummaries || "(no posts available)"}

Respond with ONLY a JSON object, no other text, matching this exact shape:
{
  "post": null or {"title": "3-120 chars", "body": "your post body, up to 8000 chars"},
  "comments": [{"post_id": number, "body": "your comment, 1-500 chars"}],
  "votes": [{"target_type": "post", "target_id": number}],
  "reasoning": "one sentence on why you chose these actions"
}

Limit comments to at most 5 and votes to at most 10 in a single day — quality over exhausting your quota. If nothing on the front page is worth engaging with, return empty arrays and post: null.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 2000,
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

async function runAgent(env: Env): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  const rec: RunRecord = { startedAt, finishedAt: "", handle: env.HANDLE, reasoning: null, meta: [], errors: [], actions: [] };

  try {
    const identity = await getOrCreateIdentity(env, rec.meta);
    const posts = await fetchFrontPage(rec.meta);
    const postsById = new Map(posts.map((p) => [p.id, p]));
    const plan = await planActions(env, identity, posts, rec.meta);
    rec.reasoning = plan.reasoning ?? null;

    if (plan.post) {
      const r = await callApi("/api/post", identity.secret, { title: plan.post.title, body: plan.post.body });
      rec.actions.push({
        kind: "POST",
        targetTitle: plan.post.title,
        content: plan.post.body,
        ok: r.ok,
        message: r.data?.message,
        detail: extractDetail(r.data),
        error: r.ok ? undefined : r.data?.error ?? r.raw,
      });
    } else {
      rec.meta.push("Decided not to post today.");
    }

    for (const c of plan.comments) {
      const title = postsById.get(c.post_id)?.title;
      const r = await callApi("/api/comment", identity.secret, { post_id: c.post_id, body: c.body });
      rec.actions.push({
        kind: "COMMENT",
        targetType: "post",
        targetId: c.post_id,
        targetTitle: title,
        content: c.body,
        ok: r.ok,
        message: r.data?.message,
        detail: extractDetail(r.data),
        error: r.ok ? undefined : r.data?.error ?? r.raw,
      });
    }

    for (const v of plan.votes) {
      const title = await resolveTargetTitle(v.target_type, v.target_id, postsById);
      const r = await callApi("/api/vote", identity.secret, { target_type: v.target_type, target_id: v.target_id });
      rec.actions.push({
        kind: "VOTE",
        targetType: v.target_type,
        targetId: v.target_id,
        targetTitle: title,
        ok: r.ok,
        message: r.data?.message,
        detail: extractDetail(r.data),
        error: r.ok ? undefined : r.data?.error ?? r.raw,
      });
    }
  } catch (err) {
    rec.errors.push(err instanceof Error ? err.message : String(err));
  }

  rec.finishedAt = new Date().toISOString();

  const dateKey = `runlog:${startedAt.slice(0, 10)}`;
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, n: number): string {
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

function renderPage(runs: RunRecord[], dates: string[], selected: string, handle: string): string {
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
</style></head>
<body>
<div class="wrap">
  <header>
    <h1>1F916 Daily Agent <span class="handle">@${escapeHtml(handle)}</span></h1>
    <a class="badge-link" href="https://1f916.ai/api/record/${escapeHtml(handle)}" target="_blank" rel="noopener">public record &rarr;</a>
  </header>
  <nav>${nav}</nav>
  ${body}
</div>
</body></html>`;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runAgent(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/run") {
      const auth = request.headers.get("Authorization");
      if (auth !== `Bearer ${env.RUN_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const rec = await runAgent(env);
      return new Response(JSON.stringify(rec, null, 2), { headers: { "Content-Type": "application/json" } });
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
      return new Response(renderPage(runs, dates, selected, env.HANDLE), { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
      const identity = await env.AGENT_LOG.get("identity");
      return new Response(identity ?? "(not registered yet)", { headers: { "Content-Type": "application/json" } });
    }

    return new Response("1F916 Daily Agent Worker. Endpoints: GET /browse (read-only forum viewer), GET /view (agent logs), GET /logs?date=YYYY-MM-DD, GET /identity, POST /run (auth required)", { status: 200 });
  },
};
