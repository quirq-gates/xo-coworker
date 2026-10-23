// Shells: the bottom dock that hosts them, the list that keeps track of them, and the sidebar row.
//
// The dock sits under the main column, outside every view, so moving between Home, projects and
// threads never detaches a terminal. Tabs are attached shells; the first tab, "Shells", lists every
// shell (running, then ended ones for the hour the backend keeps them) with Open, Rename and Close.
// Closing a tab only detaches: the shell keeps running until it is closed, or left unwatched for
// the backend's TTL. Nothing shows while the backend says shells are off.
//
// app.js calls: openProject, openWorkspace, openThread, showList, toggle, countFor, owns.

import { api } from "../api.js";
import { esc } from "../util.js";
import { ICON } from "../ui.js";
import * as K from "../keys.js";
import { mountShell } from "./term.js";
import { busyWith, isRunning, isDetached, stateLine, dotOf, runningOf, listRows, cleanName, nameFor, whereOf } from "./model.js";

const LIST = "list";
const OPEN_KEY = "xo-shells";       // sessionStorage: the tabs attached in this browser tab, so a reload reattaches
const SIZE_KEY = "xo-shells-dock";  // localStorage: the dock's height and whether it is minimised
const POLL_LIST = 15000;            // while the list is on screen
const POLL_IDLE = 60000;            // otherwise: the sidebar count and the badges stay roughly right
const MIN_H = 140;

const sget = (store, k, d) => { try { return JSON.parse(store.getItem(k)) ?? d; } catch { return d; } };
const sset = (store, k, v) => { try { store.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

/**
 * PROJ(folder) → a project's display name; notify({kind, text, sub}) → one line in the herald;
 * onChange() → the app re-renders what reads the counts (top bar buttons).
 */
export function createShells({ PROJ = (p) => p, notify = () => {}, onChange = () => {}, announce = () => {} } = {}) {
  const root = document.getElementById("shd");
  const side = document.getElementById("nv-shells");
  const saved = sget(localStorage, SIZE_KEY, {});
  const was = sget(sessionStorage, OPEN_KEY, null); // read before the first render writes it over
  const R = {
    enabled: false, reason: null, statusAt: 0,
    list: [], loaded: false, err: null,
    tabs: new Map(),      // id → {handle, pane, state, detail, title, exit}
    order: [],
    active: LIST,
    filter: null,         // a project's folder, "workspace", or null for every shell
    open: false, min: !!saved.min, h: saved.h || 320,
    edit: null,           // the shell being renamed
    confirm: null,        // {kind: "close", id, fg} | {kind: "detached", ids}
    busy: new Set(),      // shells with a write on its way
  };

  root.innerHTML =
    `<div class="shd-grip" role="separator" aria-orientation="horizontal" aria-label="Resize the shells panel" tabindex="0" title="Drag to resize"></div>` +
    `<header class="shd-bar"><div class="shd-tabs" role="tablist" aria-label="Shells"></div><div class="shd-acts"></div></header>` +
    `<div class="shd-body"><div class="shd-confirm" role="alertdialog" hidden></div><div class="shd-list" role="tabpanel" aria-label="Every shell"></div></div>`;
  const tabsEl = root.querySelector(".shd-tabs");
  const actsEl = root.querySelector(".shd-acts");
  const bodyEl = root.querySelector(".shd-body");
  const listEl = root.querySelector(".shd-list");
  const confirmEl = root.querySelector(".shd-confirm");
  const grip = root.querySelector(".shd-grip");

  const byId = (id) => R.list.find((t) => t.id === id) || null;
  const nameOf = (id) => byId(id)?.name || R.tabs.get(id)?.name || "Shell";
  const listShown = () => R.open && !R.min && R.active === LIST && !document.hidden;

  function upsert(t) {
    if (!t || !t.id) return;
    const i = R.list.findIndex((x) => x.id === t.id);
    if (i >= 0) R.list[i] = t; else R.list.push(t);
  }
  function persist() {
    sset(sessionStorage, OPEN_KEY, { tabs: R.order, active: R.active, open: R.open, filter: R.filter });
    sset(localStorage, SIZE_KEY, { h: R.h, min: R.min });
  }
  const changed = () => { render(); persist(); onChange(); };

  // ── status and the list ─────────────────────────────────────────────────
  let pollT = 0;
  async function refresh({ status = false } = {}) {
    clearTimeout(pollT);
    try {
      if (status || !R.statusAt || Date.now() - R.statusAt > POLL_IDLE - 1000) {
        const s = await api.terminalStatus();
        R.statusAt = Date.now();
        const was = R.enabled;
        R.enabled = !!s.enabled; R.reason = s.reason || null;
        if (was && !R.enabled) offNow(R.reason);
      }
      if (R.enabled) {
        const d = await api.terminals();
        R.list = d.terminals || [];
        R.loaded = true; R.err = null;
      }
    } catch (err) {
      // a backend without /api/terminal (404) has no shells; anything else keeps what we had
      if (err.status === 404 && !R.loaded) R.enabled = false;
      else R.err = err.message;
    }
    changed();
    clearTimeout(pollT); // another refresh may have finished meanwhile: keep one timer
    pollT = setTimeout(refresh, listShown() ? POLL_LIST : POLL_IDLE);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && R.enabled) refresh(); });

  /** Shells were turned off under us: every tab ends, and the UI goes away. */
  function offNow(reason) {
    for (const id of [...R.order]) detach(id, { quiet: true });
    R.open = false;
    if (reason) notify({ kind: "stopped", text: "Shells are off", sub: reason });
  }

  // ── tabs ────────────────────────────────────────────────────────────────
  function attach(id, { ticket = null, focus = true } = {}) {
    if (R.tabs.has(id)) { activate(id, { focus }); return; }
    const pane = document.createElement("div");
    pane.className = "shd-term";
    pane.setAttribute("role", "tabpanel");
    pane.dataset.pane = id;
    pane.innerHTML = `<div class="shd-x"></div><div class="shd-note" hidden></div>`;
    bodyEl.append(pane);
    const tab = { pane, state: "connecting", detail: null, title: "", exit: null, name: byId(id)?.name || "Shell" };
    R.tabs.set(id, tab);
    R.order.push(id);
    R.open = true; R.min = false;
    R.active = id;
    render();
    tab.handle = mountShell(pane.querySelector(".shd-x"), {
      id, ticket,
      keys: (e) => !(e.type === "keydown" && K.is(e, "shells")),
      on: {
        state: (s, detail) => { tab.state = s; tab.detail = detail || null; if (s === "ended" || s === "off") refreshSoon(); render(); },
        ready: (t) => { upsert(t); tab.name = t.name; tab.exit = null; render(); onChange(); },
        exit: (x) => { tab.exit = x; },
        title: (t) => { tab.title = String(t || "").slice(0, 200); renderTabs(); },
        error: (m) => notify({ kind: "stopped", text: nameOf(id), sub: m.message || m.code }),
      },
    });
    if (focus) requestAnimationFrame(() => tab.handle.focus());
    persist(); onChange();
  }
  function activate(id, { focus = true } = {}) {
    R.active = id; R.open = true; R.min = false;
    R.edit = null;
    render(); persist();
    const tab = R.tabs.get(id);
    if (tab) requestAnimationFrame(() => { tab.handle.refit(); if (focus) tab.handle.focus(); });
    else if (id === LIST) { refresh(); if (focus) requestAnimationFrame(() => tabsEl.querySelector(`[data-sh-tab="${LIST}"]`)?.focus()); }
  }
  /** Stop watching: the socket closes, the shell keeps running. */
  function detach(id, { quiet = false } = {}) {
    const tab = R.tabs.get(id);
    if (!tab) return;
    tab.handle.dispose();
    tab.pane.remove();
    R.tabs.delete(id);
    const i = R.order.indexOf(id);
    R.order.splice(i, 1);
    if (R.active === id) R.active = R.order[Math.min(i, R.order.length - 1)] || LIST;
    if (!quiet) { changed(); refreshSoon(); const t = R.tabs.get(R.active); if (t) t.handle.focus(); }
  }
  let soonT = 0;
  const refreshSoon = () => { clearTimeout(soonT); soonT = setTimeout(() => refresh(), 600); };

  // ── what the app asks for ────────────────────────────────────────────────
  async function create(body, where) {
    if (!R.enabled) return;
    try {
      const d = await api.openTerminal(body);
      upsert(d.terminal);
      attach(d.terminal.id, { ticket: d.ticket });
      announce(`Shell open in ${where}`);
    } catch (err) {
      notify({ kind: "stopped", text: "Couldn't open a shell", sub: err.message });
      if (err.code === "terminal_disabled") refresh({ status: true });
    }
  }
  /** The project's Shell button: a new shell in its folder, or its list when it has some already. */
  function openProject(pid, { fresh = false } = {}) {
    if (!fresh && runningOf(R.list, pid).length) return showList(pid);
    return create({ project: pid, name: nameFor(PROJ(pid)) }, PROJ(pid));
  }
  function openWorkspace({ fresh = false } = {}) {
    if (!fresh && R.list.some((t) => isRunning(t) && t.scope === "workspace")) return showList("workspace");
    return create({ name: "Workspace" }, "the workspace");
  }
  /**
   * A thread's Shell: its own worktree (from /api/chat/worktrees), else the project folder. A shell
   * already running there is brought back rather than opening a second.
   */
  async function openThread({ project, chatId, ts, title }) {
    if (!project || project === "workspace") return create({ name: nameFor(title) || "Workspace" }, "the workspace");
    let path = null;
    try {
      const d = await api.worktrees(chatId);
      const w = (d.worktrees || []).find((x) => x.thread_ts === ts && x.exists !== false && !x.error);
      path = w ? w.path : null;
    } catch { /* no worktree list: the project folder it is */ }
    const there = path && R.list.find((t) => isRunning(t) && t.project === project && (t.path === path || t.cwd === path));
    if (there) return attach(there.id);
    return create({ project, ...(path ? { path } : {}), name: nameFor(title) || nameFor(PROJ(project)) }, path ? "the thread's worktree" : PROJ(project));
  }
  function showList(filter = null) {
    R.filter = filter;
    R.confirm = null;
    activate(LIST);
  }
  /** The toggle key: open (where you left off), minimise, or open again. */
  function toggle() {
    if (!R.enabled) return;
    if (!R.open) { activate(R.active); return; }
    R.min = !R.min;
    changed();
    if (!R.min) activate(R.active);
    else if (root.contains(document.activeElement)) document.getElementById("scroller")?.focus({ preventScroll: true });
  }

  // ── closing ───────────────────────────────────────────────────────────────
  async function askClose(id) {
    let t = byId(id);
    try { t = (await api.terminal(id)).terminal; upsert(t); } catch { /* it may be gone: closing still tidies up */ }
    const fg = busyWith(t);
    if (fg) { R.confirm = { kind: "close", id, fg }; render(); confirmEl.querySelector("[data-sh-no]")?.focus(); return; }
    closeShell(id);
  }
  async function closeShell(id) {
    R.confirm = null;
    R.busy.add(id); render();
    const name = nameOf(id);
    try {
      await api.closeTerminal(id);
      announce(`${name} closed`);
    } catch (err) {
      if (err.code !== "terminal_not_found") notify({ kind: "stopped", text: `Couldn't close ${name}`, sub: err.message });
    } finally {
      R.busy.delete(id);
      detach(id, { quiet: true });
      R.list = R.list.filter((t) => t.id !== id);
      changed();
      refreshSoon();
    }
  }
  function askCloseDetached() {
    const ids = listRows(R.list, R.filter).filter(isDetached).map((t) => t.id);
    if (!ids.length) return;
    R.confirm = { kind: "detached", ids };
    render();
    confirmEl.querySelector("[data-sh-no]")?.focus();
  }
  async function closeDetached(ids) {
    R.confirm = null;
    for (const id of ids) R.busy.add(id);
    render();
    const failed = [];
    for (const id of ids) {
      try { await api.closeTerminal(id); } catch (err) { if (err.code !== "terminal_not_found") failed.push(err.message); }
      R.busy.delete(id);
      R.list = R.list.filter((t) => t.id !== id);
    }
    if (failed.length) notify({ kind: "stopped", text: `Couldn't close ${failed.length} of ${ids.length}`, sub: failed[0] });
    else announce(`${ids.length} detached shell${ids.length === 1 ? "" : "s"} closed`);
    changed();
    refreshSoon();
  }

  // ── renaming ──────────────────────────────────────────────────────────────
  function startRename(id) {
    R.edit = id;
    render();
    const inp = root.querySelector("[data-sh-name]");
    if (inp) { inp.focus(); inp.select(); }
  }
  async function saveRename(id, value) {
    R.edit = null;
    const name = cleanName(value);
    if (!name || name === nameOf(id)) { render(); return; }
    R.busy.add(id); render();
    try {
      const d = await api.renameTerminal(id, name);
      upsert(d.terminal);
      const tab = R.tabs.get(id);
      if (tab) tab.name = d.terminal.name;
    } catch (err) {
      notify({ kind: "stopped", text: "Couldn't rename the shell", sub: err.message });
    } finally {
      R.busy.delete(id);
      changed();
    }
  }

  // ── render ────────────────────────────────────────────────────────────────
  function render() {
    const show = R.enabled;
    side.hidden = !show;
    if (show) {
      const n = runningOf(R.list).length;
      const nEl = side.querySelector(".nr-n");
      const h = n ? String(n) : "";
      if (nEl.textContent !== h) nEl.textContent = h;
      side.setAttribute("aria-label", n ? `Shells, ${n} running` : "Shells");
      side.classList.toggle("is-on", R.open && !R.min && R.active === LIST);
    }
    root.hidden = !show || !R.open;
    root.classList.toggle("is-min", R.min);
    document.getElementById("app")?.classList.toggle("has-shd", show && R.open);
    root.style.setProperty("--shd-h", `${R.h}px`);
    if (root.hidden) return;
    renderTabs();
    renderActs();
    renderConfirm();
    listEl.hidden = R.active !== LIST;
    for (const [id, tab] of R.tabs) {
      tab.pane.hidden = R.active !== id;
      const note = noteFor(id, tab);
      const el = tab.pane.querySelector(".shd-note");
      el.hidden = !note;
      if (note && el._h !== note) { el.innerHTML = note; el._h = note; }
      tab.pane.classList.toggle("is-ended", tab.state === "ended" || tab.state === "off");
    }
    if (R.active === LIST) renderList();
  }

  function renderTabs() {
    const n = runningOf(R.list).length;
    const tabs = [`<button type="button" role="tab" class="shd-tab shd-tab-list" data-sh-tab="${LIST}" aria-selected="${R.active === LIST}" title="Every shell">${ICON.list}<span class="shd-tn">Shells</span>${n ? `<span class="shd-c">${n}</span>` : ""}</button>`];
    for (const id of R.order) {
      const tab = R.tabs.get(id);
      const t = byId(id);
      const dot = tab.state === "live" ? "on" : tab.state === "connecting" || tab.state === "retrying" ? "wait" : "ended";
      const tip = [nameOf(id), t ? whereOf(t, PROJ) : "", tab.title].filter(Boolean).join(" · ");
      tabs.push(`<span class="shd-tabw${R.active === id ? " is-on" : ""}"><button type="button" role="tab" class="shd-tab" data-sh-tab="${esc(id)}" aria-selected="${R.active === id}" title="${esc(tip)}"><i class="shd-dot d-${dot}" aria-hidden="true"></i><span class="shd-tn">${esc(nameOf(id))}</span></button>` +
        `<button type="button" class="shd-tx" data-sh-detach="${esc(id)}" aria-label="Stop watching ${esc(nameOf(id))}" title="Stop watching (it keeps running)">${ICON.close}</button></span>`);
    }
    const html = tabs.join("");
    if (tabsEl._h !== html) { tabsEl.innerHTML = html; tabsEl._h = html; }
  }

  function renderActs() {
    const id = R.active;
    const tab = R.tabs.get(id);
    let html = "";
    if (tab) {
      const t = byId(id);
      const sub = [t ? whereOf(t, PROJ) : "", tab.title && tab.title !== nameOf(id) ? tab.title : ""].filter(Boolean).join(" · ");
      html += (R.edit === id
        ? `<input class="shd-in" data-sh-name="${esc(id)}" maxlength="60" value="${esc(nameOf(id))}" aria-label="Shell name">`
        : `<span class="shd-where" title="${esc(t?.cwd || "")}">${esc(sub)}</span>`) +
        `<button type="button" class="shd-act" data-sh-rename="${esc(id)}" title="Rename">${ICON.edit}<span>Rename</span></button>` +
        `<button type="button" class="shd-act is-danger" data-sh-close="${esc(id)}"${R.busy.has(id) ? " disabled" : ""} title="Close the shell and everything running in it">${ICON.close}<span>Close shell</span></button>`;
    }
    html += `<button type="button" class="shd-act shd-ic" data-sh-min aria-label="${R.min ? "Show shells" : "Minimise shells"}" title="${R.min ? "Show" : "Minimise"} (${esc(K.label("shells"))})">${R.min ? ICON.chevron : ICON.minimize}</button>` +
      `<button type="button" class="shd-act shd-ic" data-sh-hide aria-label="Hide shells" title="Hide (they keep running)">${ICON.down}</button>`;
    // a name being typed is never replaced under the person's fingers
    if (R.edit && actsEl.querySelector("[data-sh-name]") === document.activeElement) return;
    if (actsEl._h !== html) { actsEl.innerHTML = html; actsEl._h = html; }
  }

  function renderConfirm() {
    const c = R.confirm;
    confirmEl.hidden = !c;
    if (!c) { confirmEl.innerHTML = ""; return; }
    const html = c.kind === "close"
      ? `<p><b>${esc(c.fg)}</b> is running in <b>${esc(nameOf(c.id))}</b>. Closing the shell stops it, and everything else started there.</p><div class="shd-ca"><button type="button" class="btn" data-sh-no>Keep it</button><button type="button" class="btn btn-danger" data-sh-yes>Close shell</button></div>`
      : `<p>Close <b>${c.ids.length} detached shell${c.ids.length === 1 ? "" : "s"}</b>? Everything running in ${c.ids.length === 1 ? "it" : "them"} stops.</p><div class="shd-ca"><button type="button" class="btn" data-sh-no>Keep them</button><button type="button" class="btn btn-danger" data-sh-yes>Close ${c.ids.length}</button></div>`;
    if (confirmEl._h !== html) { confirmEl.innerHTML = html; confirmEl._h = html; }
    confirmEl.setAttribute("aria-label", c.kind === "close" ? "Close this shell" : "Close detached shells");
  }

  function noteFor(id, tab) {
    const d = tab.detail || {};
    if (tab.state === "connecting") return "";
    if (tab.state === "retrying") return `<span class="spin" aria-hidden="true"></span><span>${esc(d.reason || "Reconnecting")} · trying again${d.wait ? ` in ${Math.max(1, Math.round(d.wait / 1000))} s` : ""}</span><button type="button" class="btn" data-sh-retry="${esc(id)}">Retry now</button>`;
    if (tab.state === "ended") {
      const x = tab.exit;
      const what = x ? (x.reason && x.reason !== "exited" ? x.reason : x.code == null ? "ended" : `exited${x.code ? ` with code ${x.code}` : ""}`) : d.reason || "ended";
      return `<span>This shell ${esc(what)}.</span><button type="button" class="btn" data-sh-detach="${esc(id)}">Close tab</button>`;
    }
    if (tab.state === "off") return `<span>Shells are off. ${esc(d.reason || "")}</span>`;
    if (tab.state === "error") return `<span>${esc(d.reason || "Couldn't attach.")}</span><button type="button" class="btn" data-sh-retry="${esc(id)}">Try again</button>`;
    return "";
  }

  function renderList() {
    // a name being typed is never replaced under the person's fingers
    if (R.edit && listEl.querySelector("[data-sh-name]") === document.activeElement) return;
    const f = R.filter;
    const rows = listRows(R.list, f);
    const where = f == null ? null : f === "workspace" ? "Workspace" : PROJ(f);
    const detached = rows.filter(isDetached).length;
    const now = Date.now();
    const head =
      `<div class="shl-head">` +
      (where ? `<span class="shl-f">${esc(where)}<button type="button" class="shl-all" data-sh-filter="">Show every shell</button></span>` : `<span class="shl-f">Every shell</span>`) +
      `<span class="shl-sp"></span>` +
      (detached ? `<button type="button" class="btn shl-cd" data-sh-closedet>Close all detached<span>${detached}</span></button>` : "") +
      `<button type="button" class="btn btn-pri" data-sh-new>${ICON.plus}New shell${where ? ` in ${esc(where)}` : " in the workspace"}</button>` +
      `</div>`;
    let body;
    if (!R.loaded && R.err) body = `<p class="shl-empty"><b>Couldn't read the shells.</b> ${esc(R.err)}</p>`;
    else if (!R.loaded) body = `<p class="shl-empty"><span class="spin" aria-hidden="true"></span> Reading…</p>`;
    else if (!rows.length) body = `<p class="shl-empty"><b>No shells${where ? ` in ${esc(where)}` : ""} yet.</b> New shell opens one in ${where ? (f === "workspace" ? "the projects folder" : "the project's folder") : "the projects folder"}. A shell keeps running when you look away, and comes back with its output.</p>`;
    else body = `<ul class="shl-list">${rows.map((t) => rowHtml(t, now)).join("")}</ul>`;
    const html = head + body + (R.err && R.loaded ? `<p class="shl-err">Couldn't refresh: ${esc(R.err)}</p>` : "");
    if (listEl._h !== html) { listEl.innerHTML = html; listEl._h = html; }
    if (R.edit) listEl.querySelector("[data-sh-name]")?.focus();
  }

  function rowHtml(t, now) {
    const id = esc(t.id);
    const run = isRunning(t);
    const name = R.edit === t.id
      ? `<input class="shd-in" data-sh-name="${id}" maxlength="60" value="${esc(t.name)}" aria-label="Shell name">`
      : `<b class="shl-n">${esc(t.name)}</b>`;
    const fg = run && t.foreground ? `<code class="shl-fg">${esc(t.foreground)}</code>` : "";
    const watched = R.tabs.has(t.id);
    return `<li class="shl-row${run ? "" : " is-ended"}${R.busy.has(t.id) ? " is-busy" : ""}">` +
      `<i class="shd-dot d-${dotOf(t)}" aria-hidden="true"></i>` +
      `<div class="shl-main">${name}<span class="shl-w" title="${esc(t.cwd || "")}">${esc(whereOf(t, PROJ))}</span>` +
      `<span class="shl-s">${fg}${esc(stateLine(t, now))}${watched ? " · open here" : ""}</span></div>` +
      `<div class="shl-acts">` +
      (run ? `<button type="button" class="btn" data-sh-open="${id}">${watched ? "Show" : "Open"}</button>` : "") +
      (run ? `<button type="button" class="shd-act shd-ic" data-sh-rename="${id}" aria-label="Rename ${esc(t.name)}" title="Rename">${ICON.edit}</button>` : "") +
      `<button type="button" class="shd-act shd-ic is-danger" data-sh-close="${id}"${R.busy.has(t.id) ? " disabled" : ""} aria-label="${run ? "Close" : "Forget"} ${esc(t.name)}" title="${run ? "Close the shell and everything running in it" : "Forget it"}">${ICON.close}</button>` +
      `</div></li>`;
  }

  // ── events ────────────────────────────────────────────────────────────────
  side.addEventListener("click", () => {
    if (R.open && !R.min && R.active === LIST && R.filter == null) { R.min = true; changed(); return; }
    showList(null);
  });
  root.addEventListener("click", (e) => {
    const t = e.target;
    const tb = t.closest("[data-sh-tab]");
    if (tb) { activate(tb.dataset.shTab); return; }
    const dt = t.closest("[data-sh-detach]");
    if (dt) { detach(dt.dataset.shDetach); return; }
    const op = t.closest("[data-sh-open]");
    if (op) { attach(op.dataset.shOpen); return; }
    const rn = t.closest("[data-sh-rename]");
    if (rn) { startRename(rn.dataset.shRename); return; }
    const cl = t.closest("[data-sh-close]");
    if (cl) { askClose(cl.dataset.shClose); return; }
    const rt = t.closest("[data-sh-retry]");
    if (rt) { R.tabs.get(rt.dataset.shRetry)?.handle.reconnect(); return; }
    if (t.closest("[data-sh-new]")) { const f = R.filter; if (f && f !== "workspace") openProject(f, { fresh: true }); else openWorkspace({ fresh: true }); return; }
    if (t.closest("[data-sh-closedet]")) { askCloseDetached(); return; }
    const fl = t.closest("[data-sh-filter]");
    if (fl) { R.filter = fl.dataset.shFilter || null; changed(); return; }
    if (t.closest("[data-sh-no]")) { R.confirm = null; render(); return; }
    if (t.closest("[data-sh-yes]")) { const c = R.confirm; if (c?.kind === "close") closeShell(c.id); else if (c) closeDetached(c.ids); return; }
    if (t.closest("[data-sh-min]")) { toggle(); return; }
    if (t.closest("[data-sh-hide]")) { R.open = false; changed(); document.getElementById("scroller")?.focus({ preventScroll: true }); return; }
    // a click on the minimised bar opens it again
    if (R.min && t.closest(".shd-bar")) { R.min = false; activate(R.active); }
  });
  root.addEventListener("keydown", (e) => {
    const inp = e.target.closest?.("[data-sh-name]");
    if (inp) {
      if (e.key === "Enter") { e.preventDefault(); saveRename(inp.dataset.shName, inp.value); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); R.edit = null; render(); }
      return;
    }
    if (owns(e)) return; // the shell has every key
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (R.confirm) { R.confirm = null; render(); return; }
      R.min = true; changed();
      document.getElementById("scroller")?.focus({ preventScroll: true });
      return;
    }
    // ← → between tabs
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.target.closest?.("[data-sh-tab]")) {
      const ids = [LIST, ...R.order];
      const i = ids.indexOf(e.target.closest("[data-sh-tab]").dataset.shTab);
      const nx = ids[(i + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length];
      e.preventDefault();
      activate(nx, { focus: false });
      tabsEl.querySelector(`[data-sh-tab="${CSS.escape(nx)}"]`)?.focus();
    }
  });
  root.addEventListener("focusout", (e) => {
    const inp = e.target.closest?.("[data-sh-name]");
    if (inp && R.edit === inp.dataset.shName) setTimeout(() => { if (R.edit === inp.dataset.shName && document.activeElement !== inp) saveRename(inp.dataset.shName, inp.value); }, 0);
  });

  // the grip: drag, or ↑ ↓ on it
  const clampH = (h) => Math.round(Math.max(MIN_H, Math.min(innerHeight * 0.85, h)));
  grip.addEventListener("pointerdown", (e) => {
    if (R.min) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const y0 = e.clientY, h0 = R.h;
    root.classList.add("is-dragging");
    const move = (ev) => { R.h = clampH(h0 + (y0 - ev.clientY)); root.style.setProperty("--shd-h", `${R.h}px`); };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      root.classList.remove("is-dragging");
      persist();
      R.tabs.get(R.active)?.handle.refit();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up, { once: true });
    grip.addEventListener("pointercancel", up, { once: true });
  });
  grip.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    R.h = clampH(R.h + (e.key === "ArrowUp" ? 32 : -32));
    render(); persist();
  });

  // a reload while a shell is on screen asks first (⌘W / Ctrl+W can't be caught)
  addEventListener("beforeunload", (e) => {
    if ([...R.tabs.values()].some((t) => t.state === "live")) { e.preventDefault(); e.returnValue = ""; }
  });

  /** Is this key event the shell's (inside a terminal), so the app's shortcuts must leave it alone? */
  function owns(e) {
    const el = e.target;
    return !!(el && el.closest && el.closest("#shd .xterm"));
  }

  // ── boot: shells on? then reattach what this browser tab had open ─────────
  (async () => {
    await refresh({ status: true });
    if (!R.enabled || !was) return;
    R.filter = was.filter ?? null;
    for (const id of was.tabs || []) if (isRunning(byId(id))) attach(id, { focus: false });
    const active = was.active === LIST || R.tabs.has(was.active) ? was.active : R.order[0] || LIST;
    R.open = !!was.open && (R.tabs.size > 0 || active === LIST);
    R.active = active;
    changed();
    R.tabs.get(R.active)?.handle.refit();
  })();

  return {
    get enabled() { return R.enabled; },
    /** Running shells: a project's (its folder name), the workspace's ("workspace"), or every one (null). */
    countFor: (p = null) => (p === "workspace" ? R.list.filter((t) => isRunning(t) && t.scope === "workspace").length : runningOf(R.list, p).length),
    openProject, openWorkspace, openThread, showList, toggle, owns,
  };
}
