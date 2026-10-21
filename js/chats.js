// Chats: plain chats with one agent, outside the coordinators (UI-reference §2.1, §4.4). A new chat
// is set up from the runtime's own feature list (folder, agent, model, effort, permission mode,
// never "bypass"); the conversation is your prompts (observation's /api/messages, where a plain
// chat's history lives) and the agent's work as storm's turn blocks, the same look as a thread.
// While a turn runs, a message joins it (the runtime's send_while_running) or, by choice, interrupts
// it ("send now"), which first says how many background tasks it would stop (409 would_stop_runs).

import { api, clientId, NEWEST } from "./api.js";
import { esc } from "./world.js";
import { ICON } from "./ui.js";
import { renderMarkdown } from "./markdown.js";
import { turnHtml } from "./turnview.js";
import { cliName } from "./timeline.js";

const MODE_WORDS = {
  auto: ["Auto", "Its own safety check decides; most actions run unasked."],
  ask: ["Ask first", "It asks you before each action."],
  accept_edits: ["Edits", "It edits files freely and asks for the rest."],
  plan: ["Plan only", "It plans and changes nothing."],
  deny_unasked: ["Rules only", "Only what your rules allow; the rest is refused."],
};
const BUSY = new Set(["queued", "starting", "running", "stopping"]);
const PREFS = "cv-chat-prefs";
const store = { get() { try { return JSON.parse(localStorage.getItem(PREFS) || "{}"); } catch { return {}; } }, set(v) { try { localStorage.setItem(PREFS, JSON.stringify(v)); } catch { /* private */ } } };
const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; if (!Number.isFinite(s)) return ""; return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }); };

export function createChats({ world, announce, heraldShow, go, schedule }) {
  const C = { list: null, loading: false, err: null, titles: new Map(), hist: new Map(), local: new Map(), prefs: { mode: "auto", ...store.get() }, models: new Map(), pop: { open: false }, confirm: null };
  const live = world.mode !== "demo";

  const sessions = () => Object.values(world.state.sessions || {}).filter((s) => s.role === "plain" && !s.retired_at);
  const session = (sid) => (world.state.sessions || {})[sid] || null;
  const runtime = (name) => (world.state.runtimes || []).find((r) => r.name === name) || (world.state.runtimes || [])[0] || null;
  const feature = (rt, key) => (rt && rt.features && rt.features.features && rt.features.features[key]) || null;
  const offers = (rt, key) => { const f = feature(rt, key); return !!f && (f.support === "native" || f.support === "emulated"); };

  // ── the list ────────────────────────────────────────────────────────────
  async function loadList() {
    if (!live || C.loading) return;
    C.loading = true;
    try {
      const d = await api.sessions({ role: "plain", before_seq: NEWEST, limit: 100 });
      for (const s of d.sessions || []) world.state.sessions[s.id] = { ...(world.state.sessions[s.id] || {}), ...s };
      C.list = true; C.err = null;
      // titles: the first thing you asked, read from the chat's own history (a few at a time)
      const todo = sessions().filter((s) => s.native_id && !C.titles.has(s.id)).slice(0, 24);
      await Promise.all(todo.map((s) => titleOf(s)));
    } catch (err) { C.err = err.message; }
    C.loading = false;
    schedule();
  }
  async function titleOf(s) {
    C.titles.set(s.id, null);
    try {
      const d = await api.observedMessages(s.native_id, { limit: 5 });
      const first = (d.messages || []).find((m) => m.data && m.data.role === "user");
      const text = first ? (first.parts || []).map((p) => (p.data && p.data.type === "text" ? p.data.text : "")).join(" ").trim() : "";
      C.titles.set(s.id, text ? text.replace(/\s+/g, " ").slice(0, 120) : null);
    } catch { /* stays untitled */ }
  }
  const titleFor = (s) => C.titles.get(s.id) || `A chat in ${folderWord(s.cwd)}`;
  const folderWord = (cwd) => (!cwd ? "your home folder" : cwd.replace(/^\/home\/[^/]+\/?/, "~/").replace(/^~\/$/, "~"));

  function listItems() {
    if (!live) return [{ key: "chats-demo", html: `<p class="m-note">Chats run in Live: a plain chat with one agent, in a folder you choose.</p>` }];
    const rows = sessions().sort((a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at));
    if (!C.list && !rows.length) return [{ key: "chats-load", html: `<p class="m-note">${C.err ? `Couldn't read your chats: ${esc(C.err)}` : "Reading your chats…"}</p>` }];
    if (!rows.length) return [{ key: "chats-none", html: `<div class="calm ch-calm"><div class="calm-mark">${ICON.thread}</div><h2>No chats yet.</h2><p>Ask anything below. A chat is one agent in one folder, outside your projects' coordinators.</p></div>` }];
    return [{ key: "chats-list", html: `<ul class="ch-list" aria-label="Your chats">${rows.map((s) => {
      const busy = BUSY.has(s.state);
      return `<li><button type="button" class="ch-row" data-go="c:${esc(s.id)}"><i class="g g-${busy ? "working" : s.state === "waiting_on_person" ? "needs_reply" : "idle"}" aria-hidden="true"></i>` +
        `<span class="ch-main"><span class="ch-t">${esc(titleFor(s))}</span><span class="ch-m">${esc(folderWord(s.cwd))} · ${esc(cliName(s.agent))}${s.model ? ` · ${esc(s.model)}` : ""} · ${esc((MODE_WORDS[s.permission_mode] || [s.permission_mode])[0] || "")}</span></span>` +
        `<span class="ch-a">${busy ? "Working" : esc(ago(s.updated_at || s.created_at))}</span></button></li>`;
    }).join("")}</ul>` }];
  }

  // ── one chat ────────────────────────────────────────────────────────────
  async function loadChat(sid) {
    const s = session(sid);
    if (!s || !live) return;
    const h = C.hist.get(sid) || { loading: false, loaded: false, user: [], error: null };
    C.hist.set(sid, h);
    if (h.loading || h.loaded) return;
    h.loading = true; schedule();
    try {
      const [m] = await Promise.all([
        s.native_id ? api.observedMessages(s.native_id, { limit: 200 }) : { messages: [] },
        world.act.loadTurns ? world.act.loadTurns(sid) : null,
      ]);
      h.user = (m.messages || []).filter((x) => x.data && x.data.role === "user").map((x) => ({ id: x.id, at: Date.parse(x.time_created) || 0, text: (x.parts || []).map((p) => (p.data && p.data.type === "text" ? p.data.text : "")).join("\n").trim() })).filter((x) => x.text);
      h.loaded = true; h.error = null;
      if (!C.titles.get(sid) && h.user[0]) C.titles.set(sid, h.user[0].text.replace(/\s+/g, " ").slice(0, 120));
    } catch (err) { h.error = err.message; }
    h.loading = false; schedule();
  }
  function chatItems(sid) {
    const s = session(sid);
    if (!s) return [{ key: "chat-gone", html: `<p class="m-note">This chat isn't here any more.</p>` }];
    const h = C.hist.get(sid) || {};
    const items = [];
    const mine = [...(h.user || [])];
    // your prompts sent from this tab and not in its history yet
    for (const l of C.local.get(sid) || []) if (!mine.some((m) => m.text === l.text && Math.abs(m.at - l.at) < 120000)) mine.push(l);
    const turns = world.state.turns ? world.state.turns.list((t) => t.session === sid) : [];
    const all = [
      ...mine.map((m) => ({ at: m.at, kind: "you", m })),
      // storm stamps whole seconds and the CLI records your prompt a moment after the turn starts:
      // a turn follows the prompt that woke it, so it sorts 3 s later than its start
      ...turns.map((t) => ({ at: (Date.parse(t.at) || 0) + 3000, kind: "turn", t })),
    ].sort((a, b) => a.at - b.at || (a.kind === "you" ? -1 : 1));
    if (h.loading && !all.length) items.push({ key: "chat-load", html: `<p class="m-note">Reading the chat…</p>` });
    if (h.error) items.push({ key: "chat-err", html: `<p class="m-note">Couldn't read its history: ${esc(h.error)}</p>` });
    for (const x of all) {
      if (x.kind === "you") {
        const m = x.m;
        const meta = m.status === "sending" ? `<div class="meta"><i class="spin" aria-hidden="true"></i>Sending</div>`
          : m.status === "failed" ? `<div class="meta is-err"><span title="${esc(m.err || "")}">${esc(m.errTitle || "Not sent")}</span><button type="button" class="meta-btn" data-chat-retry="${esc(m.id)}">${ICON.retry}Retry</button></div>`
          : m.added ? `<div class="meta"><span>Added to the turn in progress</span></div>` : "";
        items.push({ key: `u:${m.id}`, html: `<div class="m m-you${m.status === "failed" ? " is-failed" : ""}"><div class="bubble">${esc(m.text)}</div>${meta}</div>` });
      } else {
        const inner = turnHtml(x.t, world.state.turns.blocksOf(x.t), { open: world.ui ? world.ui.tbOpen : {} });
        if (inner) items.push({ key: `turn:${x.t.id}`, html: `<div class="m m-them m-turn"><div class="av av-t">${ICON.thread}</div><div class="mb">${inner}</div></div>` });
      }
    }
    if (!all.length && !h.loading && !h.error) items.push({ key: "chat-empty", html: `<p class="m-note">Nothing here yet.</p>` });
    return items;
  }
  function headHtml(v) {
    if (v === "chats") return `<span class="tw-t"><h1 id="conv-title">Chats</h1><span class="pj-s">One agent, one folder, outside your projects' coordinators</span></span>`;
    const s = session(v.slice(2));
    if (!s) return `<span class="tw-t"><h1 id="conv-title">Chat</h1></span>`;
    const busy = BUSY.has(s.state);
    return `<span class="tw-t"><h1 id="conv-title">${esc(titleFor(s))}</h1><span class="pj-s">${esc(folderWord(s.cwd))} · ${esc(cliName(s.agent))}${s.model ? ` · ${esc(s.model)}` : ""}${s.effort ? ` · ${esc(s.effort)}` : ""} · ${esc((MODE_WORDS[s.permission_mode] || [s.permission_mode || ""])[0])}</span></span>` +
      `<span class="badge st-${busy ? "working" : "resolved"}"><i class="g g-${busy ? "working" : "idle"}" aria-hidden="true"></i>${busy ? "Working" : "Idle"}</span>`;
  }

  // ── the composer's line and the new chat's setup ─────────────────────────
  function setup() {
    const p = C.prefs;
    const rt = runtime(p.agent);
    return { rt, agent: rt ? rt.name : null, model: p.model || null, effort: p.effort || null, mode: p.mode || "auto", cwd: p.cwd || "" };
  }
  function targetHtml(v) {
    if (v === "chats") {
      const st = setup();
      if (!st.agent) return `<span class="tg-warn">${ICON.pause}</span><span>No agent can chat here yet</span>`;
      return `<span class="tg-t">${ICON.thread}</span><span>New chat in <b>${esc(st.cwd || "~")}</b> · ${esc(cliName(st.agent))} · ${esc(st.model || "default")} · ${esc(MODE_WORDS[st.mode] ? MODE_WORDS[st.mode][0] : st.mode)}</span><span class="tg-ch">Change</span>`;
    }
    const s = session(v.slice(2));
    if (!s) return "";
    if (BUSY.has(s.state)) {
      const rt = runtime(s.agent);
      const steer = (feature(rt, "send_while_running") || {}).behaviour === "steered";
      return `<span class="tg-t">${ICON.thread}</span><span>${steer ? "Adds to the turn in progress" : "Waits for the turn in progress"}</span>${offers(rt, "interrupt") ? `<span class="tg-ch" data-now>${C.now === s.id ? "Sending now ✓" : "Send now instead"}</span>` : ""}`;
    }
    return `<span class="tg-t">${ICON.thread}</span><span>Reply in <b>this chat</b></span>`;
  }

  async function openSetup(anchor) {
    const pop = document.getElementById("cs-pop");
    C.pop = { open: true, anchor };
    const st = setup();
    if (st.agent && !C.models.has(st.agent)) { try { C.models.set(st.agent, (await api.models(st.agent)).models || []); } catch { C.models.set(st.agent, []); } }
    renderSetup();
    pop.hidden = false;
    pop.focus({ preventScroll: true });
  }
  function renderSetup() {
    const pop = document.getElementById("cs-pop");
    if (!C.pop.open) return;
    const st = setup();
    const rts = world.state.runtimes || [];
    const models = (C.models.get(st.agent) || []).filter((m) => !m.is_default && (m.family_default || !m.family));
    const cur = models.find((m) => m.id === st.model);
    const efforts = cur && cur.takes_effort ? (cur.efforts && cur.efforts.length ? cur.efforts : ["low", "medium", "high"]) : !cur ? ((feature(st.rt, "effort") || {}).values || []) : [];
    const modes = ((feature(st.rt, "permissions.mode") || {}).values || ["auto"]).filter((m) => m !== "bypass");
    const folders = [{ id: "", name: "Your home folder" }, ...world.state.projects.filter((p) => p.kind === "project").map((p) => ({ id: p.id, name: p.name }))];
    pop.innerHTML = `<header class="iq-h"><h2>New chat</h2></header>` +
      `<div class="iq-sec"><label class="cs-f"><span>Folder</span><select data-cs="cwd">${folders.map((f) => `<option value="${esc(f.id)}"${f.id === st.cwd ? " selected" : ""}>${esc(f.name)}</option>`).join("")}</select></label>` +
      (rts.length > 1 ? `<label class="cs-f"><span>Agent</span><select data-cs="agent">${rts.map((r) => `<option value="${esc(r.name)}"${r.name === st.agent ? " selected" : ""}>${esc(cliName(r.name))}</option>`).join("")}</select></label>` : "") +
      `<label class="cs-f"><span>Model</span><select data-cs="model"><option value="">The agent's default</option>${models.map((m) => `<option value="${esc(m.id)}"${m.id === st.model ? " selected" : ""}>${esc(m.name)}${m.description ? ` · ${esc(m.description)}` : ""}</option>`).join("")}</select></label>` +
      (efforts.length ? `<label class="cs-f"><span>Effort</span><select data-cs="effort"><option value="">Default</option>${efforts.map((e) => `<option value="${esc(e)}"${e === st.effort ? " selected" : ""}>${esc(e)}</option>`).join("")}</select></label>` : "") +
      `</div><div class="iq-sec"><p class="iq-lab">What it may do</p><div class="cs-modes" role="radiogroup" aria-label="What it may do">${modes.map((m) => `<button type="button" role="radio" class="set-choice${m === st.mode ? " is-on" : ""}" aria-checked="${m === st.mode}" data-csmode="${esc(m)}"><span class="sc-dot" aria-hidden="true"></span><span class="sc-b"><b>${esc((MODE_WORDS[m] || [m])[0])}</b><span>${esc((MODE_WORDS[m] || ["", ""])[1])}</span></span></button>`).join("")}</div></div>` +
      `<footer class="iq-f"><span>Used for your next new chat.</span><button type="button" class="iq-back" data-cs-done>Done</button></footer>`;
    const a = C.pop.anchor;
    if (a && !matchMedia("(max-width: 760px)").matches) {
      pop.classList.remove("is-sheet");
      const r = a.getBoundingClientRect(); const w = Math.min(400, innerWidth - 24);
      pop.style.width = `${w}px`; pop.style.left = `${Math.max(12, Math.min(r.left, innerWidth - w - 12))}px`; pop.style.top = `${Math.max(12, r.top - pop.offsetHeight - 10)}px`;
    } else { pop.style.left = pop.style.top = pop.style.width = ""; pop.classList.add("is-sheet"); }
  }
  function closeSetup() { C.pop.open = false; const pop = document.getElementById("cs-pop"); pop.hidden = true; C.pop.anchor?.focus?.({ preventScroll: true }); }
  const setPref = (k, v) => { C.prefs = { ...C.prefs, [k]: v || null }; if (k === "agent") { C.prefs.model = null; C.prefs.effort = null; } if (k === "model") C.prefs.effort = null; store.set(C.prefs); };

  // ── sending ─────────────────────────────────────────────────────────────
  async function send(v, text) {
    const sid = v.startsWith("c:") ? v.slice(2) : null;
    const local = { id: `lc${Date.now().toString(36)}`, at: Date.now(), text, status: "sending", cid: clientId() };
    if (!sid) {
      const st = setup();
      if (!st.agent) { announce("No agent can chat here yet."); return; }
      local.body = { text, client_id: local.cid, agent: st.agent, ...(st.model ? { model: st.model } : {}), ...(st.effort ? { effort: st.effort } : {}), permission_mode: st.mode, ...(st.cwd ? { cwd: st.cwd } : {}) };
    } else {
      const s = session(sid);
      const rt = s ? runtime(s.agent) : null;
      // while a turn runs: "now" when chosen (and offered), else "add" where the runtime steers a
      // running turn; a runtime that queues takes the message for its next turn (no delivery)
      const steer = (feature(rt, "send_while_running") || {}).behaviour === "steered";
      const delivery = s && BUSY.has(s.state) ? (C.now === sid && offers(rt, "interrupt") ? "now" : steer ? "add" : null) : null;
      local.body = { text, client_id: local.cid, session_id: sid, ...(delivery ? { delivery } : {}) };
      (C.local.get(sid) || C.local.set(sid, []).get(sid)).push(local);
      schedule();
    }
    await deliver(local, sid);
  }
  async function deliver(local, sid) {
    local.status = "sending";
    try {
      const r = await api.prompt(local.body);
      local.status = "sent";
      if (!sid) {
        world.state.sessions[r.session_id] = { ...(world.state.sessions[r.session_id] || {}), id: r.session_id, role: "plain", state: "queued", agent: local.body.agent, model: local.body.model || null, effort: local.body.effort || null, permission_mode: local.body.permission_mode, cwd: local.body.cwd || "", created_at: new Date().toISOString() };
        C.titles.set(r.session_id, local.body.text.replace(/\s+/g, " ").slice(0, 120));
        C.local.set(r.session_id, [local]);
        C.hist.set(r.session_id, { loading: false, loaded: true, user: [], error: null });
        go("c:" + r.session_id);
      }
      if (local.body.delivery === "now") C.now = null;
      announce("Sent.");
    } catch (err) {
      if (err.code === "would_stop_runs") {
        // say what "now" would stop; resend the same request (same client_id) only if the person agrees
        C.confirm = { local, sid, count: err.count };
        local.status = "held";
      } else {
        local.status = "failed"; local.errTitle = err.code === "auth_required" ? "The agent isn't connected" : err.status === 501 ? "This agent can't chat yet" : err.status === 0 || err.status === 502 ? "Can't reach XO" : "Not sent"; local.err = err.message;
        if (!sid) { heraldShow({ kind: "stopped", text: local.errTitle, sub: err.message }, 7000); }
      }
    }
    schedule();
  }
  function confirmHtml() {
    const c = C.confirm;
    if (!c) return "";
    return `<div class="ch-confirm" role="alertdialog" aria-labelledby="chc-h"><p id="chc-h"><b>Sending now stops ${c.count} background task${c.count === 1 ? "" : "s"}</b> (sub-agents or shells) this chat started.</p>` +
      `<div class="set-fa"><button type="button" class="btn" data-chc="add">Add to the turn instead</button><button type="button" class="btn btn-danger" data-chc="now">Stop them and send</button></div></div>`;
  }
  function resolveConfirm(choice) {
    const c = C.confirm;
    if (!c) return;
    C.confirm = null;
    if (choice === "now") c.local.body = { ...c.local.body, delivery: "now", confirm_stop_runs: c.count };
    else c.local.body = { ...c.local.body, delivery: "add" };
    C.now = null;
    deliver(c.local, c.sid);
  }

  // PR 24: an unconfirmed "now" that became "add" says so; the message joined the running turn
  world.onEvent((e) => {
    if (e.kind !== "now_became_add") return;
    for (const list of C.local.values()) for (const l of list) if ((e.wakes || []).includes(`msg:prompt:${l.cid}`)) l.added = true;
    schedule();
  });

  return {
    live,
    isChats: (v) => v === "chats" || (v && v.startsWith("c:")),
    open(v) { if (v === "chats") loadList(); else if (v.startsWith("c:")) loadChat(v.slice(2)); },
    items: (v) => (v === "chats" ? listItems() : chatItems(v.slice(2))),
    headHtml, targetHtml, confirmHtml, resolveConfirm,
    placeholder: (v) => (v === "chats" ? "Ask anything to start a chat…" : "Reply in this chat…"),
    session: (v) => (v && v.startsWith("c:") ? session(v.slice(2)) : null),
    busy: (v) => { const s = v && v.startsWith("c:") ? session(v.slice(2)) : null; return !!(s && BUSY.has(s.state)); },
    send, openSetup, closeSetup, setPref, renderSetup,
    toggleNow: (v) => { const sid = v.slice(2); const s = session(sid); if (!s || !offers(runtime(s.agent), "interrupt")) return; C.now = C.now === sid ? null : sid; schedule(); },
    retry(id) { for (const [sid, list] of C.local) { const l = list.find((x) => x.id === id); if (l) { deliver(l, sid); return; } } },
    get setupOpen() { return C.pop.open; },
  };
}
