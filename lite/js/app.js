// xo-coworker lite: every view. Three of them, picked by the address's hash:
//   #/            Needs you: open review items and threads waiting on you, then what's working
//   #/c/<chat>    the Workspace or a project: its threads, its timeline, the composer
//   #/t/<ts>      a thread: checklist, card, its asks, messages, live activity, reply
// Views read store.state and call store.*; one render per animation frame after any change.

import { createStore, WAITING } from "./store.js";
import { esc, renderMarkdown, renderInline } from "./markdown.js";
import { activityHtml, elapsed } from "./activity.js";
import { upload, attachmentUrl } from "./api.js";

const $ = (s) => document.querySelector(s);
const store = createStore(() => schedule());
const S = store.state;

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;
const STATE_WORD = { working: "Working", needs_reply: "Needs reply", needs_approval: "Needs approval", paused: "Paused", failed: "Failed", done: "Done", resolved: "Resolved" };
const YES = new Set(["allow", "approve", "done", "continue", "answer"]);

// ── the view ────────────────────────────────────────────────────────────────
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  if (h.startsWith("c/")) return { kind: "chat", chat: h.slice(2), key: h.slice(2) };
  if (h.startsWith("t/")) return { kind: "thread", ts: h.slice(2), key: "t:" + h.slice(2) };
  return { kind: "home", key: "home" };
}
let view = route();
const chatOfView = (v = view) => (v.kind === "chat" ? v.chat : v.kind === "thread" ? S.threads.get(v.ts)?.chat_id || null : null);

// ── helpers ─────────────────────────────────────────────────────────────────
const chatName = (id) => store.chatById(id)?.name || "a removed project";
const threadsOf = (chat) => [...S.threads.values()].filter((t) => t.chat_id === chat).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
const itemsOf = (ts) => [...S.review.values()].filter((it) => it.thread_ts === ts);
const waitingThreads = () => [...S.threads.values()].filter((t) => WAITING.has(t.state) && store.chatById(t.chat_id));
const time = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const today = d.toDateString() === new Date().toDateString();
  return (today ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " ") + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};
const fmtSize = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
function checklist(md) {
  const items = [];
  for (const raw of String(md || "").split("\n")) {
    const line = raw.trim().replace(/^[-+]\s+/, "");
    const st = { "✱": "doing", "○": "todo", "◯": "todo", "✓": "done", "✔": "done" }[line[0]];
    if (st) items.push({ st, text: line.slice(1).trim() });
  }
  return items;
}
const pill = (t) => {
  const busy = store.threadBusy(t);
  const word = t.state === "working" && !busy ? "Idle" : STATE_WORD[t.state] || t.state;
  return `<span class="pill s-${esc(t.state)}${busy ? " busy" : ""}">${esc(word)}</span>`;
};
const progress = (t) => { const c = checklist(t.status_md); return c.length ? `<span class="prog">${c.filter((i) => i.st === "done").length}/${c.length}</span>` : ""; };

/** Replace only the children whose html changed (keeps typed text and scroll), in order. */
function reconcile(el, items) {
  const old = new Map([...el.children].map((c) => [c.dataset.k, c]));
  let prev = null;
  for (const { k, html } of items) {
    let node = old.get(k);
    if (!node || node._html !== html) {
      const tpl = document.createElement("template");
      tpl.innerHTML = html.trim();
      const n = tpl.content.firstElementChild || document.createElement("div");
      n.dataset.k = k; n._html = html;
      if (node) node.replaceWith(n);
      node = n;
    }
    old.delete(k);
    const want = prev ? prev.nextSibling : el.firstChild;
    if (want !== node) el.insertBefore(node, want);
    prev = node;
  }
  for (const n of old.values()) n.remove();
}
const setHtml = (el, html) => { if (el._html !== html) { el.innerHTML = html; el._html = html; } };

// ── sidebar ─────────────────────────────────────────────────────────────────
function navHtml() {
  const needs = S.review.size + waitingThreads().filter((t) => !itemsOf(t.ts).length).length;
  const row = (href, name, on, extra = "") => `<a href="${href}" class="nrow${on ? " on" : ""}">${esc(name)}${extra}</a>`;
  let html = row("#/", "Needs you", view.kind === "home", needs ? `<span class="badge">${needs}</span>` : "");
  const cur = chatOfView();
  for (const c of S.chats) {
    const ts = threadsOf(c.id);
    const wait = ts.filter((t) => WAITING.has(t.state)).length + [...S.review.values()].filter((it) => !it.thread_ts && it.chat_id === c.id).length;
    const busy = ts.some((t) => store.threadBusy(t)) || !!store.coordinatorBusy(c.id);
    if (c.kind === "project" && html.indexOf('class="side-l"') < 0) html += `<p class="side-l">Projects</p>`;
    html += row(`#/c/${encodeURIComponent(c.id)}`, c.name, cur === c.id, (busy ? `<i class="dot" title="Working"></i>` : "") + (wait ? `<span class="badge">${wait}</span>` : ""));
  }
  return html;
}

// ── review items and waiting threads (Needs you, and inside a thread) ───────
function evidence(it) {
  const d = it.detail || {};
  const parts = [];
  const pre = (label, text) => parts.push(`<p class="ev-l">${esc(label)}</p><pre>${esc(String(text))}</pre>`);
  if (d.command) pre("Command", d.command);
  if (d.diff) pre("Change", d.diff);
  if (Array.isArray(d.paths) && d.paths.length) pre(d.paths.length === 1 ? "File" : "Files", d.paths.join("\n"));
  if (d.url) pre("Address", d.url);
  if (d.plan) parts.push(`<p class="ev-l">The plan</p><div class="prose">${renderMarkdown(String(d.plan))}</div>`);
  if (d.text) parts.push(`<div class="prose">${renderMarkdown(String(d.text))}</div>`);
  for (const [k, label] of [["purpose", "For"], ["first_task", "First task"], ["schedule", "When"]]) if (d[k]) parts.push(`<p><b>${label}:</b> ${esc(d[k])}</p>`);
  if (d.job && d.job.prompt) pre("What it will do each time", d.job.prompt);
  return parts.length ? `<details class="ev"><summary>Details</summary>${parts.join("")}</details>` : "";
}
function itemHtml(it, { showWhere = true } = {}) {
  const t = it.thread_ts ? S.threads.get(it.thread_ts) : null;
  const where = t ? `<a href="#/t/${encodeURIComponent(t.ts)}">${esc(t.title || "Thread")}</a> · ${esc(chatName(t.chat_id))}` : it.chat_id ? esc(chatName(it.chat_id)) : "Your account";
  const opts = Array.isArray(it.options) ? it.options : [];
  let answer = "";
  if (it.kind === "question") {
    const qs = (it.detail && Array.isArray(it.detail.questions)) ? it.detail.questions : [];
    const one = qs.length === 1 ? qs[0] : null;
    answer = qs.map((q) => `<p class="q">${renderInline(q.question || "", true)}</p>`).join("") +
      (one && Array.isArray(one.options) ? `<div class="opts">${one.options.map((o) => `<button type="button" class="btn" data-answer="${esc(o.label)}" title="${esc(o.description || "")}">${esc(o.label)}</button>`).join("")}</div>` : "") +
      `<div class="inline"><input type="text" data-words placeholder="Answer in words" aria-label="Answer in words"><button type="button" class="btn primary" data-answer-words>Answer</button></div>`;
  }
  const buttons = opts.filter((o) => it.kind !== "question" || !YES.has(o.decision))
    .map((o) => `<button type="button" class="btn${YES.has(o.decision) && !o.scope ? " primary" : ""}${YES.has(o.decision) && it.risk === "destructive" ? " danger" : ""}" data-opt="${esc(o.id)}" title="${esc(o.sentence || o.why || "")}">${esc(o.label || o.decision)}</button>`).join("");
  const note = opts.some((o) => o.note) ? `<input type="text" class="note" data-note placeholder="Note for Send back (optional)" aria-label="Note">` : "";
  return `<article class="card item r-${esc(it.risk || "notable")}" data-item="${esc(it.id)}">` +
    (showWhere ? `<p class="where">${where}</p>` : "") +
    `<h3>${esc(it.title || "It needs your decision")}</h3>` + (it.why ? `<p class="why">${esc(it.why)}</p>` : "") +
    evidence(it) + answer + note + (buttons ? `<div class="opts">${buttons}</div>` : "") + `<p class="err" data-err hidden></p></article>`;
}
function waitingHtml(t) {
  const c = t.card || {};
  return `<article class="card wait" data-wait="${esc(t.ts)}"><p class="where"><a href="#/t/${encodeURIComponent(t.ts)}">${esc(t.title || "Thread")}</a> · ${esc(chatName(t.chat_id))} ${pill(t)}</p>` +
    `<div class="prose">${renderMarkdown(c.needs_you || (t.state === "paused" ? "It paused and waits for you. A reply resumes it." : "It's waiting for your reply."))}</div>` +
    `<div class="inline"><input type="text" data-reply placeholder="Reply to this thread" aria-label="Reply"><button type="button" class="btn primary" data-reply-send>Reply</button></div></article>`;
}

// ── views ───────────────────────────────────────────────────────────────────
function homeItems() {
  const out = [];
  for (const it of S.review.values()) out.push({ k: "i:" + it.id, html: itemHtml(it) });
  for (const t of waitingThreads()) if (!itemsOf(t.ts).length) out.push({ k: "w:" + t.ts, html: waitingHtml(t) });
  if (!out.length) out.push({ k: "none", html: `<p class="empty">Nothing needs you right now.</p>` });
  const working = [...S.threads.values()].filter((t) => store.threadBusy(t) && store.chatById(t.chat_id));
  if (working.length) out.push({ k: "working", html: `<section class="list"><h2>Working now</h2>${working.map(threadRow).join("")}</section>` });
  return out;
}
function threadRow(t) {
  return `<a class="trow" href="#/t/${encodeURIComponent(t.ts)}">${pill(t)}<span class="tt">${esc(t.title || "Thread")}</span>${progress(t)}<span class="tw">${esc(chatName(t.chat_id))}</span></a>`;
}
function chatHead(chat) {
  const c = store.chatById(chat);
  if (!c) return [{ k: "none", html: `<p class="empty">${S.loaded ? "This project isn't here." : "Loading…"}</p>` }];
  const ts = threadsOf(chat);
  const open = ts.filter((t) => t.state !== "resolved" && t.state !== "done");
  const closed = ts.length - open.length;
  const items = [...S.review.values()].filter((it) => !it.thread_ts && it.chat_id === chat);
  return [
    { k: "threads", html: `<div class="threads">${open.map(threadRow).join("")}` +
      (closed ? `<details><summary>${closed} finished</summary>${ts.filter((t) => !open.includes(t)).map(threadRow).join("")}</details>` : "") +
      (!ts.length && c.kind === "project" ? `<p class="empty">No threads yet.</p>` : "") + `</div>` },
    ...items.map((it) => ({ k: "i:" + it.id, html: itemHtml(it, { showWhere: false }) })),
  ];
}
function threadHead(t) {
  if (!t) return [{ k: "none", html: `<p class="empty">${S.loaded ? "This thread isn't here." : "Loading…"}</p>` }];
  const c = t.card || {};
  const list = checklist(t.status_md);
  const resolved = t.state === "resolved";
  return [{ k: "top", html: `<div class="th-top"><div class="th-actions">${pill(t)}${t.branch ? `<code class="branch">${esc(t.branch)}</code>` : ""}` +
    `<button type="button" class="btn" data-act="resolve">${resolved ? "Reopen" : "Resolve"}</button></div>` +
    (list.length ? `<ol class="check">${list.map((i) => `<li class="ck-${i.st}"><i class="m">${i.st === "done" ? "✓" : i.st === "doing" ? "✱" : "○"}</i><span>${renderInline(i.text, true)}</span></li>`).join("")}</ol>` : "") +
    (WAITING.has(t.state) && c.needs_you ? `<div class="needs"><b>Needs you</b><div class="prose">${renderMarkdown(c.needs_you)}</div></div>` : "") +
    (c.happened ? `<details class="happened"${WAITING.has(t.state) ? "" : " open"}><summary>What happened</summary><div class="prose">${renderMarkdown(c.happened)}</div></details>` : "") + `</div>` },
    ...itemsOf(t.ts).map((it) => ({ k: "i:" + it.id, html: itemHtml(it, { showWhere: false }) }))];
}

const WHO = { "workspace-coordinator": "Coordinator", "project-coordinator": "Coordinator" };
const cache = new Map(); // message id → [text, html]
function msgHtml(m, key) {
  const who = m.author_kind === "owner" ? "you" : m.author_kind === "system" ? "system" : "agent";
  const name = who === "you" ? "You" : who === "system" ? "XO" : WHO[m.author_id] || (key.startsWith("t:") ? "Agent" : m.author_id || "Agent");
  let body = cache.get(m.id);
  if (!body || body[0] !== m.text) { body = [m.text, renderMarkdown(String(m.text || ""))]; cache.set(m.id, body); }
  const x = m.extra || {};
  const files = Array.isArray(x.attachments) ? x.attachments.filter((a) => a && a.id) : [];
  const fileHtml = files.length ? `<ul class="files">${files.map((a) => {
    const url = m.local ? null : attachmentUrl(m.chat_id, a.id);
    const img = url && /^image\//.test(a.type || "");
    return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">` : "<span>"}${img ? `<img src="${esc(url)}" alt="${esc(a.name)}" loading="lazy">` : `📄 ${esc(a.name)} <small>${esc(fmtSize(a.bytes))}</small>`}${url ? "</a>" : "</span>"}</li>`;
  }).join("")}</ul>` : "";
  const t = !key.startsWith("t:") ? S.threads.get(m.id) : null;
  const status = m.local ? (m.error ? `<span class="m-err">Not sent: ${esc(m.error)} <button type="button" class="link" data-retry="${esc(m.id)}">Retry</button> <button type="button" class="link" data-discard="${esc(m.id)}">Edit</button></span>` : `<span class="m-sending">Sending…</span>`) : "";
  return `<article class="msg w-${who}${m.local ? " local" : ""}">` +
    `<p class="meta"><b>${esc(name)}</b> <time>${esc(time(m.created_at))}</time>${x.forwarded_from ? ` <span class="fwd">forwarded from ${esc(chatName(x.forwarded_from.chat_id))}</span>` : ""} ${status}</p>` +
    (m.text ? `<div class="prose">${body[1]}</div>` : "") + fileHtml +
    (t ? `<a class="tchip" href="#/t/${encodeURIComponent(t.ts)}">${pill(t)} ${esc(t.title || "Thread")} ${progress(t)}</a>` : "") + `</article>`;
}

// ── render ──────────────────────────────────────────────────────────────────
let raf = 0, shown = null;
function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }
const scroller = $("#scroll");
const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;

function render() {
  setHtml($("#nav"), navHtml());
  const conn = S.conn === "down" ? "Live updates are down; retrying." : S.conn === "reconnecting" ? "Reconnecting…" : "";
  const banner = S.error ? `Can't load XO: ${S.error}` : S.statusError ? `XO isn't answering: ${S.statusError}` : conn;
  $("#banner").hidden = !banner;
  $("#banner").textContent = banner;
  const waitN = S.review.size + waitingThreads().filter((t) => !itemsOf(t.ts).length).length;
  document.title = (waitN ? `(${waitN}) ` : "") + "XO Space";

  const switching = shown !== view.key;
  const atBottom = switching || nearBottom();
  const h0 = scroller.scrollHeight, top0 = scroller.scrollTop;
  const first0 = $("#msgs").firstElementChild?.dataset.k;
  const msgs = $("#msgs");

  if (view.kind === "home") {
    setHtml($("#bar"), `<b>Needs you</b>`);
    reconcile($("#head"), []);
    reconcile(msgs, S.loaded ? homeItems() : [{ k: "load", html: `<p class="empty">Loading…</p>` }]);
    setHtml($("#live"), "");
    $("#typing").hidden = true;
    $("#older").hidden = true;
    $("#composer").hidden = true;
  } else {
    const t = view.kind === "thread" ? S.threads.get(view.ts) : null;
    const chat = chatOfView();
    if (S.loaded && (view.kind === "chat" ? store.chatById(chat) : t)) store.open(view.key);
    setHtml($("#bar"), view.kind === "chat"
      ? `<b>${esc(chatName(chat))}</b>`
      : `<a href="#/c/${encodeURIComponent(chat || "")}">${esc(chat ? chatName(chat) : "")}</a> <span class="sep">/</span> <b>${esc(t ? t.title || "Thread" : "Thread")}</b>`);
    reconcile($("#head"), view.kind === "chat" ? chatHead(chat) : threadHead(t));
    const h = S.hist.get(view.key) || {};
    $("#older").hidden = !(h.loading || h.error || (h.loaded && h.all));
    $("#older").textContent = h.loading ? "Loading…" : h.error ? `Couldn't load messages: ${h.error}` : "The beginning of this conversation.";
    reconcile(msgs, (S.msgs.get(view.key) || []).map((m) => ({ k: m.id, html: msgHtml(m, view.key) })));
    // live activity: the thread's agent, or this chat's coordinator
    const sid = t ? (store.threadBusy(t) ? t.session_id : null) : store.coordinatorBusy(chat)?.id;
    const turn = sid ? S.turns.running(sid) || { at: S.sessions.get(sid)?.updated_at } : null;
    setHtml($("#live"), turn ? activityHtml(turn, turn.blocks ? S.turns.blocksOf(turn) : [], { canStop: true }) : "");
    const typing = view.kind === "chat" && !sid && store.replying(chat) ? "Replying…" : S.failed.get(chat) && view.kind === "chat" ? `The coordinator's turn failed: ${S.failed.get(chat)}` : "";
    $("#typing").hidden = !typing;
    $("#typing").textContent = typing;
    $("#composer").hidden = !(view.kind === "chat" ? store.chatById(chat) : t);
    say.placeholder = view.kind === "thread" ? "Reply to this thread" : `Message ${chatName(chat)}`;
  }
  composerState();

  if (switching) { shown = view.key; scroller.scrollTop = view.kind === "home" ? 0 : scroller.scrollHeight; }
  else if (view.kind !== "home" && atBottom) scroller.scrollTop = scroller.scrollHeight;
  else if (first0 && msgs.firstElementChild?.dataset.k !== first0) scroller.scrollTop = top0 + (scroller.scrollHeight - h0); // older rows above
  if (view.kind !== "home" && scroller.scrollHeight <= scroller.clientHeight + 40) store.older(view.key);
}
scroller.addEventListener("scroll", () => { if (view.kind !== "home" && scroller.scrollTop < 200) store.older(view.key); });
setInterval(() => { for (const el of document.querySelectorAll("[data-since]")) el.textContent = elapsed(Math.max(0, Math.floor((Date.now() - +el.dataset.since) / 1000))); }, 1000);

addEventListener("hashchange", () => {
  saveDraft();
  view = route();
  loadDraft();
  document.body.classList.remove("nav-open");
  schedule();
});

// ── composer: text, files, send ─────────────────────────────────────────────
const say = $("#say");
const drafts = new Map();
const trays = new Map(); // view key → [{lid, file, name, size, state: up|done|failed, pct, att, err, abort}]
const tray = () => trays.get(view.key) || [];
function saveDraft() { if (say.value) drafts.set(view.key, say.value); else drafts.delete(view.key); }
function loadDraft() { say.value = drafts.get(view.key) || ""; grow(); }
function grow() { say.style.height = "auto"; say.style.height = Math.min(say.scrollHeight, 220) + "px"; }

function composerState() {
  const chips = tray();
  const up = chips.some((c) => c.state === "up");
  const bad = chips.some((c) => c.state === "failed");
  $("#send").disabled = up || bad || (!say.value.trim() && !chips.length);
  $("#send").textContent = up ? "Uploading…" : "Send";
  const html = chips.map((c) => `<li class="chip c-${c.state}">${esc(c.name)} <small>${c.state === "up" ? Math.round(c.pct * 100) + "%" : c.state === "failed" ? esc(c.err) : esc(fmtSize(c.size))}</small>` +
    (c.state === "failed" && !c.final ? `<button type="button" class="link" data-chip-retry="${c.lid}">Retry</button>` : "") +
    `<button type="button" class="x" data-chip-rm="${c.lid}" aria-label="Remove ${esc(c.name)}">✕</button></li>`).join("");
  $("#tray").hidden = !chips.length;
  setHtml($("#tray"), html);
}

const FINAL = new Set(["too_large", "unsupported_type", "empty_file", "chat_retired", "chat_not_found"]);
function startUpload(key, c) {
  const chat = chatOfView();
  if (!chat) return;
  c.state = "up"; c.pct = 0; c.err = null;
  const u = upload(chat, c.file, c.name, (p) => { c.pct = p; composerState(); });
  c.abort = u.abort;
  u.promise.then((att) => { c.state = "done"; c.att = att; }, (err) => {
    if (err.name === "AbortError") return;
    c.state = "failed"; c.final = FINAL.has(err.code); c.err = err.code === "unsupported_type" ? "Not text, an image or a PDF" : err.message;
  }).finally(() => { if (view.key === key) composerState(); });
}
function addFiles(files) {
  if (view.kind === "home") return;
  const key = view.key;
  const list = trays.get(key) || [];
  for (const f of files) {
    if (list.length >= MAX_FILES) break;
    const c = { lid: Math.random().toString(36).slice(2), file: f, name: f.name || "pasted", size: f.size };
    list.push(c);
    if (f.size > MAX_BYTES) Object.assign(c, { state: "failed", final: true, err: "Over 25 MB" });
    else if (!f.size) Object.assign(c, { state: "failed", final: true, err: "Empty file" });
    else startUpload(key, c);
  }
  trays.set(key, list);
  composerState();
}
$("#file").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });
say.addEventListener("paste", (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } });
document.querySelector(".main").addEventListener("dragover", (e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
document.querySelector(".main").addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } });
$("#tray").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-chip-rm]"), re = e.target.closest("[data-chip-retry]");
  const list = tray();
  if (rm) { const c = list.find((x) => x.lid === rm.dataset.chipRm); if (c && c.abort) c.abort(); trays.set(view.key, list.filter((x) => x !== c)); }
  if (re) { const c = list.find((x) => x.lid === re.dataset.chipRetry); if (c) startUpload(view.key, c); }
  composerState();
});

say.addEventListener("input", () => { grow(); composerState(); });
say.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); } });
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = say.value.trim();
  const chips = tray();
  if ($("#send").disabled || (!text && !chips.length)) return;
  const chat = chatOfView();
  const atts = chips.map((c) => c.att);
  store.send(chat, text, { threadTs: view.kind === "thread" ? view.ts : null, attachments: atts.map((a) => a.id), files: atts });
  say.value = ""; trays.delete(view.key); drafts.delete(view.key); grow();
  scroller.scrollTop = scroller.scrollHeight;
  composerState();
});

// ── clicks ──────────────────────────────────────────────────────────────────
function bodyFor(it, o, card) {
  if (o.scope === "thread") return { decision: "allow", scope: "thread" };
  if (o.scope === "rule") return { decision: "allow", option: o.id, rule_sentence: o.sentence };
  const body = { decision: o.decision };
  const note = card.querySelector("[data-note]")?.value.trim();
  if (o.note && note) body.note = note.slice(0, 4000);
  return body;
}
async function decide(card, body, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  const err = card.querySelector("[data-err]");
  for (const b of card.querySelectorAll("button")) b.disabled = true;
  try { await store.decide(card.dataset.item, body); } catch (e) {
    for (const b of card.querySelectorAll("button")) b.disabled = false;
    err.hidden = false; err.textContent = e.message;
  }
}
document.addEventListener("click", async (e) => {
  const el = e.target;
  const card = el.closest("[data-item]");
  if (card) {
    const it = S.review.get(card.dataset.item);
    if (!it) return;
    const opt = el.closest("[data-opt]");
    if (opt) {
      const o = (it.options || []).find((x) => x.id === opt.dataset.opt);
      if (!o) return;
      const sure = YES.has(o.decision) && (o.hold_to_confirm || it.risk === "destructive") ? `${o.label || "Allow"}: ${it.title}?` : null;
      return decide(card, bodyFor(it, o, card), sure);
    }
    if (el.closest("[data-answer]")) return decide(card, { decision: "answer", option: el.closest("[data-answer]").dataset.answer.slice(0, 200) });
    if (el.closest("[data-answer-words]")) {
      const words = card.querySelector("[data-words]").value.trim();
      if (words) return decide(card, { decision: "answer", answer: words });
    }
  }
  const wait = el.closest("[data-wait]");
  if (wait && el.closest("[data-reply-send]")) {
    const input = wait.querySelector("[data-reply]");
    const t = S.threads.get(wait.dataset.wait);
    if (t && input.value.trim()) { store.send(t.chat_id, input.value.trim(), { threadTs: t.ts }); input.value = ""; }
    return;
  }
  const act = el.closest("[data-act]")?.dataset.act;
  if (act === "resolve" && view.kind === "thread") {
    const t = S.threads.get(view.ts);
    if (t) store.resolve(t.ts, t.state !== "resolved").catch((err) => alert(err.message));
  }
  if (act === "stop") {
    const t = view.kind === "thread" ? S.threads.get(view.ts) : null;
    const sid = t ? t.session_id : store.coordinatorBusy(chatOfView())?.id;
    if (sid) { el.disabled = true; el.textContent = "Stopping…"; store.stop(sid).catch((err) => alert(err.message)); }
  }
  const retry = el.closest("[data-retry]");
  if (retry) store.retry(view.key, retry.dataset.retry);
  const discard = el.closest("[data-discard]");
  if (discard) {
    const m = (S.msgs.get(view.key) || []).find((x) => x.id === discard.dataset.discard);
    if (m) { say.value = m.text; grow(); store.discard(view.key, m.id); say.focus(); }
  }
  const copy = el.closest("[data-copy]");
  if (copy) navigator.clipboard?.writeText(copy.closest(".md-code").querySelector("pre").innerText).then(() => { copy.textContent = "Copied"; });
  const tlink = el.closest("a[data-thread]");
  if (tlink) { e.preventDefault(); location.hash = `#/t/${tlink.dataset.thread}`; }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.matches("[data-words]")) e.target.closest("[data-item]").querySelector("[data-answer-words]").click();
  if (e.target.matches("[data-reply]")) e.target.closest("[data-wait]").querySelector("[data-reply-send]").click();
});
$("#menu").addEventListener("click", (e) => { e.stopPropagation(); const on = document.body.classList.toggle("nav-open"); $("#menu").setAttribute("aria-expanded", String(on)); });
document.querySelector(".main").addEventListener("click", () => { document.body.classList.remove("nav-open"); $("#menu").setAttribute("aria-expanded", "false"); });

loadDraft();
schedule();
