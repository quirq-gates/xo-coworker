// The data layer: the only module that talks to XO. It loads the Space with GETs, keeps it current
// from ONE global SSE stream, and turns the person's actions into requests. Views read `state` and
// call the functions it returns; `onChange` fires (batched) after anything changes.
//
// Boot: open the stream first and hold its frames, load everything, then apply the held frames in
// order, so nothing that changed during the load is lost. After that the stream is the only source
// of change; it resumes with Last-Event-ID after a drop, and a `reset` reloads.

import { api, authHeaders, NEWEST } from "./api.js";
import { SSEStream } from "./sse.js";
import { createTurns } from "./blocks.js";

const PAGE = 40;
const BUSY = new Set(["queued", "starting", "running", "stopping", "waiting_on_person"]);
const COORD = new Set(["workspace-coordinator", "project-coordinator"]);
export const WAITING = new Set(["needs_reply", "needs_approval", "paused"]);
const AWAIT_CAP_MS = 10 * 60000;

export function createStore(onChange) {
  const state = {
    loaded: false, error: null, conn: "connecting", status: null, statusError: null,
    chats: [],            // [{id, kind, project, name}], the Workspace first
    threads: new Map(),   // ts → thread row
    msgs: new Map(),      // chat id, or "t:" + thread ts → message rows by seq
    hist: new Map(),      // same keys → {loading, loaded, before, all, error}
    sessions: new Map(),  // session id → session
    review: new Map(),    // open review item id → item
    awaiting: new Map(),  // chat id → {at}: we wrote, no coordinator answer yet
    failed: new Map(),    // chat id → error text: the coordinator's turn for our message failed
    turns: createTurns(),
  };
  let pending = false;
  const changed = () => { if (!pending) { pending = true; queueMicrotask(() => { pending = false; onChange(); }); } };

  const chatById = (id) => state.chats.find((c) => c.id === id) || null;
  const sessionBusy = (s) => !!s && BUSY.has(s.state) && !s.retired_at;

  // ── loading ──────────────────────────────────────────────────────────────
  async function loadChats() {
    const { chats } = await api.chats();
    state.chats = (chats || []).filter((c) => !c.retired_at)
      .map((c) => ({ id: c.id, kind: c.kind, project: c.project, name: c.kind === "workspace" ? "Workspace" : c.project }))
      .sort((a, b) => (a.kind === "workspace" ? -1 : b.kind === "workspace" ? 1 : a.name.localeCompare(b.name)));
  }
  async function loadThreads(chat) {
    const asked = Date.now();
    try {
      const { threads } = await api.threads(chat.id);
      const seen = new Set();
      for (const r of threads || []) { seen.add(r.ts); state.threads.set(r.ts, { ...(state.threads.get(r.ts) || {}), ...r, _at: Date.now() }); }
      for (const [ts, r] of state.threads) if (r.chat_id === chat.id && !seen.has(ts) && (r._at || 0) < asked) state.threads.delete(ts);
    } catch { /* keep the last good threads */ }
  }
  async function loadSessions() {
    try {
      let after = 0;
      for (let i = 0; i < 10; i++) {
        const d = await api.sessions({ after_seq: after, limit: 500 });
        for (const s of d.sessions || []) noteSession(s);
        if (!d.next_after_seq || !(d.sessions || []).length) break;
        after = d.next_after_seq;
      }
    } catch { /* session frames fill in */ }
  }
  function noteSession(s) {
    const old = state.sessions.get(s.id);
    if (old && old.seq != null && s.seq != null && old.seq > s.seq) return;
    state.sessions.set(s.id, { ...(old || {}), ...s });
  }
  async function loadReview() {
    try {
      const d = await api.review({ state: "open", limit: 500 });
      state.review.clear();
      for (const it of d.items || []) state.review.set(it.id, it);
    } catch { /* review frames fill in */ }
  }
  async function loadStatus() {
    try { state.status = await api.status(); state.statusError = null; } catch (err) { state.statusError = err.message; }
    changed();
    setTimeout(loadStatus, state.statusError ? 8000 : 30000);
  }
  async function loadAll() {
    try { await loadChats(); state.error = null; } catch (err) { state.error = err.message; return; }
    const queue = state.chats.filter((c) => c.kind === "project");
    const worker = async () => { while (queue.length) await loadThreads(queue.shift()); };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker(), loadSessions(), loadReview()]);
  }

  // ── messages ─────────────────────────────────────────────────────────────
  const bySeq = (a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity) || (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0);
  /** Merge rows into a list by id, ordered by seq. A server row of our own words replaces its local echo. */
  function addRows(key, rows) {
    const list = state.msgs.get(key) || [];
    const byId = new Map(list.map((m) => [m.id, m]));
    let added = 0;
    for (const r of rows) {
      if (!r || !r.id) continue;
      if (!byId.has(r.id)) {
        added++;
        if (r.author_kind === "owner") {
          const echo = [...byId.values()].find((m) => m.local && !m.error && m.text === r.text);
          if (echo) byId.delete(echo.id);
        }
      }
      byId.set(r.id, r);
    }
    state.msgs.set(key, [...byId.values()].sort(bySeq));
    return added;
  }
  /** Load a conversation's newest page once (key: chat id, or "t:" + ts). */
  async function open(key) {
    const h = state.hist.get(key);
    if (h && (h.loading || h.loaded)) return;
    const thread = key.startsWith("t:") ? state.threads.get(key.slice(2)) : null;
    const chat = thread ? thread.chat_id : key;
    state.hist.set(key, { loading: true, loaded: false });
    changed();
    try {
      const d = await api.messages(chat, { before_seq: NEWEST, limit: PAGE, ...(thread ? { thread: thread.ts } : {}) });
      addRows(key, d.messages || []);
      state.hist.set(key, { loading: false, loaded: true, before: d.next_before_seq || null, all: !d.next_before_seq });
    } catch (err) {
      state.hist.set(key, { loading: false, loaded: false, error: err.message });
    }
    // a thread whose agent works now: its running turn's earlier blocks (the stream has the rest)
    if (thread && thread.session_id && sessionBusy(state.sessions.get(thread.session_id))) await loadTurns(thread.session_id);
    changed();
  }
  async function older(key) {
    const h = state.hist.get(key);
    if (!h || !h.loaded || h.loading || h.all) return;
    const thread = key.startsWith("t:") ? state.threads.get(key.slice(2)) : null;
    h.loading = true;
    changed();
    try {
      const d = await api.messages(thread ? thread.chat_id : key, { before_seq: h.before, limit: PAGE * 2, ...(thread ? { thread: thread.ts } : {}) });
      addRows(key, d.messages || []);
      h.before = d.next_before_seq || null;
      h.all = !h.before;
    } catch (err) { h.error = err.message; }
    h.loading = false;
    changed();
  }
  async function loadTurns(session) {
    try {
      const d = await api.events({ session, before_seq: NEWEST, limit: 300 });
      for (const f of d.events || []) state.turns.apply({ type: f.type, envelope: f });
    } catch { /* live frames still arrive */ }
  }

  // ── the stream ───────────────────────────────────────────────────────────
  let holding = true;
  const held = [];
  let firstFrame;
  const sawFrame = new Promise((r) => { firstFrame = r; });

  function onFrame(f) {
    firstFrame();
    if (holding) held.push(f); else apply(f);
  }
  function apply(f) {
    const env = f.envelope || {};
    const d = env.data || {};
    state.turns.apply(f);
    switch (f.type) {
      case "message": {
        const row = { ...d, seq: env.seq ?? d.seq ?? null };
        const chat = row.chat_id || env.chat_id;
        if (row.thread_ts) { addRows("t:" + row.thread_ts, [row]); break; }
        if (!chat || !addRows(chat, [row])) break;
        if (row.author_kind !== "owner" && COORD.has(row.author_id)) { state.awaiting.delete(chat); state.failed.delete(chat); }
        break;
      }
      case "thread": {
        if (!d.ts) break;
        const old = state.threads.get(d.ts);
        if (!old && !d.chat_id) { api.thread(env.chat_id, d.ts).then((t) => { state.threads.set(d.ts, t); changed(); }, () => {}); break; }
        state.threads.set(d.ts, { ...(old || {}), ...d, _at: Date.now(), chat_id: d.chat_id || (old && old.chat_id) || env.chat_id, updated_at: d.updated_at || env.ts || (old && old.updated_at) });
        break;
      }
      case "card": {
        const r = state.threads.get(d.ts);
        if (r) state.threads.set(d.ts, { ...r, card: d.card, updated_at: env.ts || r.updated_at });
        break;
      }
      case "session": {
        const id = env.session_id;
        if (!id) break;
        const old = state.sessions.get(id) || { id };
        const next = { ...old, chat_id: old.chat_id || env.chat_id || null, thread_ts: old.thread_ts || env.thread_ts || null, state: d.status || old.state, seq: env.seq ?? old.seq };
        if (d.reason === "created") Object.assign(next, { role: d.role, agent: d.agent });
        if (d.reason === "paused") next.paused = d.why || "paused";
        if (d.reason === "resumed") next.paused = null;
        if (d.reason === "retired") next.retired_at = env.ts || new Date().toISOString();
        state.sessions.set(id, next);
        // our message's turn ended: "replying" ends with it (an answer already cleared it)
        const aw = next.chat_id && state.awaiting.get(next.chat_id);
        if (aw && COORD.has(next.role) && !BUSY.has(next.state) && Date.now() - aw.at > 1500) state.awaiting.delete(next.chat_id);
        break;
      }
      case "turn.finished": {
        const s = state.sessions.get(env.session_id);
        const chat = s && COORD.has(s.role) ? s.chat_id : null;
        if (chat && state.awaiting.has(chat) && d.status === "failed" && !(d.wakes_requeued || []).length) {
          state.failed.set(chat, d.error || d.reason || "the turn failed");
          state.awaiting.delete(chat);
        }
        break;
      }
      case "review.opened": state.review.set(d.id, { ...d, state: "open" }); break;
      case "review.decided": case "review.withdrawn": case "review.expired": state.review.delete(d.id); break;
      case "chat": if (d.kind || d.retired_at) loadChats().then(changed, () => {}); break;
      default: break;
    }
    changed();
  }

  async function reload() {
    state.msgs.clear(); state.hist.clear(); state.review.clear(); state.turns = createTurns();
    await loadAll();
    changed();
  }

  const stream = new SSEStream(api.streamUrl, {
    headers: authHeaders,
    onFrame,
    onState: (s) => { state.conn = s; if (s === "live" && state.loaded && state.error) reload(); changed(); },
    onReset: reload,
  }).start();
  addEventListener("visibilitychange", () => { if (!document.hidden) stream.nudge(); });
  addEventListener("online", () => stream.nudge());

  (async () => {
    await Promise.race([sawFrame, new Promise((r) => setTimeout(r, 4000))]);
    await loadAll();
    loadStatus();
    holding = false;
    for (const f of held.splice(0)) apply(f);
    state.loaded = true;
    changed();
    // the first load failed (XO restarting): try again until it works
    const retry = setInterval(async () => { if (!state.error) return clearInterval(retry); await loadAll(); changed(); }, 8000);
  })();

  // finished turns of sessions not on screen are dropped now and then
  setInterval(() => state.turns.prune(new Set([...state.sessions.values()].filter(sessionBusy).map((s) => s.id))), 60000);

  // ── reading helpers for the views ────────────────────────────────────────
  /** The coordinator session of a chat that's working now. */
  const coordinatorBusy = (chat) => [...state.sessions.values()].find((s) => s.chat_id === chat && COORD.has(s.role) && sessionBusy(s)) || null;
  const threadBusy = (t) => !!t && sessionBusy(state.sessions.get(t.session_id));

  // ── acting (writes happen only here, only when the person acts) ──────────
  /** Send to a chat (thread: its ts) with uploaded attachment ids. Shows a local echo at once. */
  async function send(chat, text, { threadTs = null, attachments = [], files = [], localId } = {}) {
    const key = threadTs ? "t:" + threadTs : chat;
    const lid = localId || `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const echo = { id: lid, local: true, chat_id: chat, thread_ts: threadTs, author_kind: "owner", text, seq: null, created_at: new Date().toISOString(), extra: { attachments: files }, _send: { attachments, files } };
    state.msgs.set(key, [...(state.msgs.get(key) || []).filter((m) => m.id !== lid), echo]);
    changed();
    try {
      const row = await api.post(chat, { text, threadTs, attachments });
      state.msgs.set(key, (state.msgs.get(key) || []).filter((m) => m.id !== lid));
      if (row) addRows(key, [row]);
      if (!threadTs) { state.awaiting.set(chat, { at: Date.now() }); state.failed.delete(chat); }
    } catch (err) {
      state.msgs.set(key, (state.msgs.get(key) || []).map((m) => (m.id === lid ? { ...m, error: err.message } : m)));
    }
    changed();
  }
  function retry(key, lid) {
    const m = (state.msgs.get(key) || []).find((x) => x.id === lid);
    if (m) send(m.chat_id, m.text, { threadTs: m.thread_ts, ...m._send, localId: lid });
  }
  function discard(key, lid) {
    state.msgs.set(key, (state.msgs.get(key) || []).filter((m) => m.id !== lid));
    changed();
  }
  async function resolve(ts, resolved) {
    const r = state.threads.get(ts);
    if (!r) return;
    const t = await api.patchThread(r.chat_id, ts, { resolved });
    state.threads.set(ts, { ...state.threads.get(ts), ...t });
    changed();
  }
  async function decide(id, body) {
    try {
      const it = await api.decide(id, body);
      if (it && it.state !== "open") state.review.delete(id);
    } catch (err) {
      // decided elsewhere, withdrawn or expired: it's gone either way
      if (["already_decided", "withdrawn", "expired", "review_not_found"].includes(err.code)) state.review.delete(id);
      changed();
      throw err;
    }
    changed();
  }
  const stop = (sessionId) => api.abort(sessionId);

  return {
    state, chatById, coordinatorBusy, threadBusy,
    replying: (chat) => {
      const aw = state.awaiting.get(chat);
      if (aw && Date.now() - aw.at > AWAIT_CAP_MS) state.awaiting.delete(chat);
      return state.awaiting.has(chat) || !!coordinatorBusy(chat);
    },
    open, older, send, retry, discard, resolve, decide, stop,
  };
}
