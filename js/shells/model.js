// Shells, the pure part: what a shell's row says, which ones count, and the flow-control
// watermarks. No DOM and no network, so Node can test it (tests/shells.test.mjs).
//
// A shell is the backend's T (/api/terminal/sessions): {id, name, scope, project, path, cwd, status,
// exit_code, ended_reason, foreground, viewers, created_at, detached_since, closes_at, ended_at, …}.

import { toMs } from "../util.js";

/** The programs that are "just the shell": closing one of these loses nothing that's running. */
const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "ash", "nu", "pwsh", "login"]);

/** Is something other than the shell itself running in it (vim, npm, claude…)? Then Close asks first. */
export const busyWith = (t) => {
  const fg = t && t.status === "running" && t.foreground ? String(t.foreground) : "";
  return fg && !SHELLS.has(fg.replace(/^-/, "").toLowerCase()) ? fg : "";
};

export const isRunning = (t) => !!t && t.status === "running";
export const isDetached = (t) => isRunning(t) && !t.viewers;

/** "2 min", "3 h", "1 day": a span of time in words, rounded the way a person would. */
export function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "under a minute";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "1 day" : `${d} days`;
}

/** Where a shell opens, in words: "Workspace", the project, or the project and the folder in it. */
export function whereOf(t, projectName = (p) => p) {
  if (!t || t.scope === "workspace" || !t.project) return "Workspace";
  return projectName(t.project);
}

/**
 * The state line of one shell's row, as plain text (the caller escapes it):
 * "watching", "2 people watching", "detached 2 h ago · closes in 22 h", "exited 1", "closed".
 */
export function stateLine(t, now = Date.now()) {
  if (!t) return "";
  if (t.status !== "running") {
    if (t.ended_reason && t.ended_reason !== "exited") return t.ended_reason;
    return t.exit_code == null ? "ended" : t.exit_code === 0 ? "exited" : `exited ${t.exit_code}`;
  }
  if (t.viewers > 1) return `${t.viewers} views open`;
  if (t.viewers === 1) return "watching";
  const since = toMs(t.detached_since);
  const closes = toMs(t.closes_at);
  const bits = [Number.isFinite(since) ? `detached ${span(now - since)} ago` : "detached"];
  if (Number.isFinite(closes)) bits.push(closes - now > 0 ? `closes in ${span(closes - now)}` : "closing");
  return bits.join(" · ");
}

/** The status dot: running and watched, running unwatched, or ended. */
export const dotOf = (t) => (!isRunning(t) ? "ended" : t.viewers ? "on" : "away");

/** Running shells, for the sidebar count and a project's badge (`project` null = every one). */
export const runningOf = (list, project = null) =>
  (list || []).filter((t) => isRunning(t) && (project == null || t.project === project));

/**
 * The list view's rows: the filter applied (a project's folder name, "workspace", or null for all),
 * running ones first, then ended ones (the backend keeps those for an hour), each oldest first.
 */
export function listRows(list, filter = null) {
  const keep = (t) => filter == null || (filter === "workspace" ? t.scope === "workspace" : t.project === filter);
  const rows = (list || []).filter(keep);
  return [...rows.filter(isRunning), ...rows.filter((t) => !isRunning(t))];
}

/** A shell name the backend takes: 1–60 printable characters, trimmed; null when it wouldn't. */
export function cleanName(s) {
  // eslint-disable-next-line no-control-regex
  const v = String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return v && v.length <= 60 ? v : null;
}

/** A default name for a new shell: the thread's title or the project, cut to fit. */
export const nameFor = (s) => cleanName(String(s ?? "").slice(0, 60));

// ── flow control: xterm's write callbacks as watermarks ──────────────────────────────────────
export const HIGH = 100 * 1024; // more than this written but not yet drawn: ask the server to pause
export const LOW = 10 * 1024;   // drawn down below this: resume

/**
 * Counts bytes handed to the terminal and not yet drawn. `wrote(n)` and `drew(n)` return
 * "pause" or "resume" exactly when the viewer should send one, else null.
 */
export function createFlow({ high = HIGH, low = LOW } = {}) {
  let pending = 0, paused = false;
  return {
    get pending() { return pending; },
    get paused() { return paused; },
    wrote(n) {
      pending += n;
      if (!paused && pending > high) { paused = true; return "pause"; }
      return null;
    },
    drew(n) {
      pending = Math.max(0, pending - n);
      if (paused && pending < low) { paused = false; return "resume"; }
      return null;
    },
    /** A new connection starts clean (the server starts a new viewer unpaused). */
    reset() { pending = 0; paused = false; },
  };
}

// ── reconnecting ─────────────────────────────────────────────────────────────────────────────
/** The wait before reconnect attempt `n` (0-based): 0.5 s doubling to 15 s, with a little jitter. */
export const backoff = (n, rand = Math.random) => Math.round(Math.min(15000, 500 * 2 ** n) * (0.85 + 0.3 * rand()));

/**
 * What a socket close means: "ended" (the shell is gone or finished; don't retry), "off" (shells
 * were turned off), "refused" (a protocol error from us; don't loop), or "retry".
 */
export function closeMeaning(code) {
  if (code === 4404 || code === 1000) return "ended";
  if (code === 4403) return "off";
  if (code === 1008 || code === 1009) return "refused";
  return "retry"; // 4401 (a stale ticket: the retry fetches a fresh one), 1006 (network, serve.py restart)…
}
