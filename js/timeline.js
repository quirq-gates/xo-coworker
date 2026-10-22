// Live mode: pure helpers between storm's rows (UI-reference §3) and the UI's message and ask
// shapes. No DOM, no fetch: tested from Node (tests/logic.test.mjs).


const COORDINATORS = new Set(["workspace-coordinator", "project-coordinator"]);

/**
 * A storm message row → the UI's message: {id, seq, at, who: you|coord|agent|system, text, fwd, job}.
 * author_kind owner|agent|system; an agent's author_id is its role (UI-reference §3 Message).
 */
export function uiMsg(row) {
  const who = row.author_kind === "owner" ? "you"
    : row.author_kind === "system" ? "system"
      : COORDINATORS.has(row.author_id) ? "coord" : "agent";
  const x = row.extra || {};
  const f = x.forwarded_from;
  return {
    id: row.id,
    seq: row.seq ?? null,
    at: Date.parse(row.created_at) || 0,
    who,
    role: row.author_id || null,
    text: String(row.text ?? ""),
    fwd: f && f.message_id ? { chatId: f.chat_id || null, id: f.message_id, via: f.via || [] } : null,
    job: x.job || null,
    noOne: !!row.reply_to, // XO's "This message reached no one: …" note
  };
}

/** Merge storm rows into a list ordered by seq (ids are not ordered). Returns {list, added}. */
export function mergeRows(list, incoming) {
  const byId = new Map(list.map((m) => [m.id, m]));
  const added = [];
  for (const row of incoming || []) {
    if (!row || !row.id) continue;
    const old = byId.get(row.id);
    if (!old) added.push(row);
    byId.set(row.id, old && old.seq != null && row.seq == null ? { ...row, seq: old.seq } : row);
  }
  return { list: [...byId.values()].sort(bySeq), added };
}
const bySeq = (a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity) || (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0);

/**
 * Optimistic rows whose server copy is already in `rows` (the stream can beat
 * the POST). Returns Map(localId → serverId). A server row is used once, and
 * only if no other local row claimed it (`taken`).
 */
export function echoes(locals, rows, taken = new Set()) {
  const out = new Map();
  const free = rows.filter((r) => r.who === "you" && !taken.has(r.id));
  for (const m of locals) {
    if (m.merged || m.status === "failed" || m.who !== "you") continue;
    const i = free.findIndex((r) => r.text === m.text && r.at >= m.at - 60000);
    if (i < 0) continue;
    out.set(m.id, free[i].id);
    free.splice(i, 1);
  }
  return out;
}

/** Plain text for a title: no markdown marks, links keep their words. */
export function plainText(md) {
  return String(md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split a message into a short title (its first sentence, ≤ max) and the rest. */
export function askText(md, max = 140) {
  const s = plainText(md);
  if (!s) return { title: "", rest: "" };
  const m = /^(.{12,}?[.?!:])(\s|$)/.exec(s);
  let title;
  if (m && m[1].length <= max) title = m[1].replace(/:$/, ".");
  else if (s.length <= max) title = s;
  else title = s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  const used = m && m[1].length <= max ? m[1].length : title.replace(/…$/, "").length;
  return { title, rest: s.slice(used).trim() };
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);

/**
 * What a storm thread asks of the person (UI-reference §3 Thread, §2.4 Item).
 * - Open review items on the thread are its asks, one each, in the queue's order (the server's
 *   risk, title, why and options travel with them; the UI decides nothing).
 * - needs_reply: the card's needs_you (the agent's last reply), answered in words.
 * - paused: the loop breaker stopped it; a reply in the thread resumes it.
 * The id carries the card's update time, so a new ask on the same thread is a new key.
 */
export function stormAsks(t, items = []) {
  const asks = [];
  for (const it of items) {
    asks.push({
      id: it.id, kind: it.kind, title: it.title || "It needs your decision", detail: it.why || "",
      risk: it.risk || "notable", riskReasons: it.risk_reasons || [], options: null,
      blocking: !!it.blocking, item: it, live: true, storm: true,
    });
  }
  if (asks.length) return asks;
  if (t.state === "needs_reply") {
    const full = String((t.card && t.card.needs_you) || t.happened || "").trim();
    const { title, rest } = askText(full);
    asks.push({ id: `${t.id}:${(t.card && t.card.updated_at) || t.lastAt}`, kind: "question", title: title || "It's waiting for your reply", detail: clip(rest, 220), full, risk: "notable", options: null, replyOnly: true, live: true });
  } else if (t.state === "paused") {
    const why = String(t.paused || "it was stuck on a denied step");
    asks.push({ id: `${t.id}:paused:${t.lastAt}`, kind: "question", title: "It paused and waits for you", detail: `Why: ${why}. A reply in the thread resumes it.`, full: why, risk: "notable", options: null, replyOnly: true, live: true, paused: true });
  } else if (t.state === "needs_approval") {
    // the item hasn't reached this tab yet (or was decided elsewhere a moment ago)
    asks.push({ id: `${t.id}:approval:${t.lastAt}`, kind: "approval", title: String((t.card && t.card.needs_you) || "It needs your decision"), detail: "Open the thread to see what it needs.", risk: "notable", options: null, replyOnly: true, live: true, pending: true });
  }
  return asks;
}

/**
 * Where each thread's card sits in a timeline. A thread is rooted on a
 * timeline row (thread ts = row id). Its card goes under the coordinator's
 * first reply after that root (within the next few rows, before another
 * root); otherwise it stands alone right after the root.
 * Returns Map(rowId → [threadId…]) and the set of roots placed standalone.
 */
export function threadAnchors(msgs, threadIds) {
  const ids = new Set(threadIds);
  const on = new Map();
  const alone = new Set();
  msgs.forEach((m, i) => {
    if (!ids.has(m.id)) return;
    let at = null;
    for (let j = i + 1; j < Math.min(msgs.length, i + 4); j++) {
      const n = msgs[j];
      if (ids.has(n.id)) break;
      if (n.who === "coord") { at = n.id; break; }
    }
    if (at) on.set(at, [...(on.get(at) || []), m.id]);
    else alone.add(m.id);
  });
  return { on, alone };
}

/**
 * The composer's @target. Only a token that names a known project (or the
 * Workspace) is a target; anything else is left in the text and reported.
 * Returns {pid, token, unknown}.
 */
export function parseTarget(text, projects) {
  const m = /(^|\s)@([\w.-]+)/.exec(String(text || ""));
  if (!m) return { pid: null, token: null, unknown: null };
  const q = m[2].toLowerCase();
  const p = (projects || []).find((x) => x.id.toLowerCase() === q || String(x.name || "").toLowerCase() === q);
  return p ? { pid: p.id, token: m[2], unknown: null } : { pid: null, token: null, unknown: m[2] };
}

/** Remove the @token that matched (and only that one). */
export function stripTarget(text, token) {
  if (!token) return String(text || "").trim();
  const re = new RegExp(`(^|\\s)@${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])\\s?`);
  return String(text || "").replace(re, "$1").trim();
}

const STORM_DOWN = new Set(["engine_not_running", "engine_elsewhere", "engine_failed", "store_refused", "store_failed", "stream_not_running"]);
const CLI_NAME = { claude_code: "Claude", codex: "Codex", antigravity: "Antigravity" };
/** A runtime's name as people say it (display only). */
export const cliName = (name) => CLI_NAME[name] || String(name || "The agent");

/** A plain title for a failed send (the storm error codes, UI-reference §2.2). */
export function sendErrorTitle(err) {
  if (!err) return "Message not sent";
  if (err.code === "router_off") return "The router is off";
  if (err.code === "chat_retired") return "This project was removed";
  if (err.code === "auth_required") return "The agent isn't connected";
  if (err.code === "no_runtime") return "No agent can run this";
  if (err.code === "coordinator_busy") return "The coordinator is busy";
  if (err.code === "thread_not_found" || err.code === "session_retired") return "This thread is gone";
  if (STORM_DOWN.has(err.code)) return "XO's chat engine isn't running";
  if (err.status === 501) return "Not supported by this agent";
  if (err.status === 403) return "Refused by the proxy";
  if (err.status === 0 || err.status === 502) return "Can't reach XO";
  return "Message not sent";
}

const hhmm = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };

/**
 * The one honest line about the connection and what can run, or null when all is well.
 * w: {error, conn, statusError, statusCode, runtimes, router, pools, loaded}
 */
export function connLine(w) {
  if (!w) return null;
  // the engine down is said as such: the UI server answered, so it isn't the network
  if (STORM_DOWN.has(w.statusCode) || STORM_DOWN.has(w.errorCode)) return { kind: "down", text: "XO's chat engine isn't running", sub: "retrying · nothing you write is lost" };
  if (w.error || w.statusError || w.conn === "down") return { kind: "down", text: "Can't reach XO", sub: "retrying · what you see may be out of date" };
  const rts = w.runtimes || [];
  if (rts.length && rts.every((r) => !r.cli || r.cli.logged_in === false || r.error)) {
    const r = rts[0];
    return { kind: "off", text: `${cliName(r.name)} isn't connected`, sub: "connect it in XO · sending waits until then" };
  }
  if (w.router && w.router.mode === "off") return { kind: "off", text: "The router is off", sub: "new messages to the Workspace and projects are refused · threads still take replies" };
  const pools = Object.values(w.pools || {});
  const closed = pools.find((p) => p.state === "closed");
  if (closed) return { kind: "wait", text: `Paused until ${hhmm(closed.resets_at)}`, sub: "usage limit · running work finishes, new work waits" };
  const paid = pools.find((p) => p.state === "paid");
  if (paid) return { kind: "wait", text: "Paused for your choice", sub: "your subscription moved onto paid usage · it's in Needs you" };
  return null;
}

/** Why sending is paused right now ("" when it isn't), for the composer. timeline: posting to a chat's timeline. */
export function sendBlock(w, { timeline = true } = {}) {
  if (!w) return "";
  if (STORM_DOWN.has(w.statusCode) || STORM_DOWN.has(w.errorCode)) return "XO's chat engine isn't running";
  if (w.error && !(w.projects && w.projects.length)) return "Can't reach XO right now";
  if (!w.loaded) return "Connecting to XO…";
  const rts = w.runtimes || [];
  if (rts.length && rts.every((r) => !r.cli || r.cli.logged_in === false || r.error)) return `${cliName(rts[0].name)} isn't connected`;
  if (timeline && w.router && w.router.mode === "off") return "The router is off";
  return "";
}

/** Run `fn` over `items`, at most `cap` at a time. */
export async function mapLimit(items, cap, fn) {
  const list = [...items];
  const run = async () => { while (list.length) await fn(list.shift()); };
  await Promise.all(Array.from({ length: Math.min(cap, list.length) }, run));
}

/**
 * A hop as one quiet line in a thread (ch 11 §16), said from who sent it to whom, from the hop's own
 * roles: forward, relay, brief, ask, status, answer. project: the thread's project name.
 */
export function hopLine(h, project) {
  const who = (role) => ({ thread: "this thread", "project-coordinator": `the ${project} coordinator`, "workspace-coordinator": "the Workspace", xo: "XO", owner: "you", person: "you" })[role] || "someone";
  const from = who(h.from_role), to = who(h.to_role);
  const state = h.state === "sent" ? " · not taken up yet" : h.state === "answered" ? " · answered" : "";
  const up = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const via = h.via || [];
  // a coordinator or XO acting for this thread says so
  const forThread = via.includes("thread") && h.from_role !== "thread" && h.to_role !== "thread" ? " on behalf of this thread" : "";
  switch (h.kind) {
    case "forward": return `Forwarded by the Workspace${state}`;
    case "brief": return `${via.includes("workspace") ? "Forwarded by the Workspace, via the project" : `From ${from}`}${state}`;
    case "relay": return h.from_role === "project-coordinator" && h.to_role === "thread" && (h.message_ids || []).length ? `The ${project} coordinator passed on your message${state}` : `${up(from)} wrote to ${to}${forThread}${state}`;
    case "ask": return `${up(from)} asked ${to}${forThread}${state}`;
    case "status": return `${up(from)} reported back to ${to}${state}`;
    case "answer": return `${up(from)} answered ${to}`;
    default: return "";
  }
}
