// Shells (js/shells/model.js): what a row says, which shells count, flow control and reconnecting.
// Pure, no network.   node tests/shells.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { busyWith, isDetached, span, whereOf, stateLine, dotOf, runningOf, listRows, cleanName, nameFor, createFlow, backoff, closeMeaning, HIGH, LOW } from "../js/shells/model.js";

let passed = 0;
const t = (name, fn) => {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { console.error("  FAIL " + name + "\n" + e.stack); process.exitCode = 1; }
};
const NOW = Date.parse("2026-10-23T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const later = (ms) => new Date(NOW + ms).toISOString();
const H = 3600e3;
const T = (o = {}) => ({ id: "t_" + Math.random().toString(36).slice(2, 18), name: "Shell", scope: "project", project: "billing", status: "running", viewers: 0, foreground: "bash", ...o });

t("busyWith: the shell itself is idle; anything else running asks before Close", () => {
  for (const sh of ["bash", "zsh", "-bash", "fish", "sh"]) assert.equal(busyWith(T({ foreground: sh })), "");
  assert.equal(busyWith(T({ foreground: "vim" })), "vim");
  assert.equal(busyWith(T({ foreground: "claude" })), "claude");
  assert.equal(busyWith(T({ foreground: null })), "");
  assert.equal(busyWith(T({ status: "exited", foreground: "vim" })), "");
  assert.equal(busyWith(null), "");
});

t("stateLine: watching, detached with its close time, ended with its code", () => {
  assert.equal(stateLine(T({ viewers: 1 }), NOW), "watching");
  assert.equal(stateLine(T({ viewers: 2 }), NOW), "2 views open");
  assert.equal(stateLine(T({ detached_since: ago(2 * H), closes_at: later(22 * H) }), NOW), "detached 2 h ago · closes in 22 h");
  assert.equal(stateLine(T({ detached_since: ago(20e3) }), NOW), "detached under a minute ago");
  assert.equal(stateLine(T({ detached_since: ago(25 * H), closes_at: ago(1e3) }), NOW), "detached 1 day ago · closing");
  assert.equal(stateLine(T({ status: "exited", exit_code: 0, ended_reason: "exited" }), NOW), "exited");
  assert.equal(stateLine(T({ status: "exited", exit_code: 130, ended_reason: "exited" }), NOW), "exited 130");
  assert.equal(stateLine(T({ status: "exited", exit_code: -1, ended_reason: "closed after being left unwatched" }), NOW), "closed after being left unwatched");
});

t("span: rounded the way a person says it", () => {
  assert.equal(span(30e3), "under a minute");
  assert.equal(span(5 * 60e3), "5 min");
  assert.equal(span(90 * 60e3), "2 h");
  assert.equal(span(36 * H), "2 days");
});

t("whereOf and dotOf", () => {
  assert.equal(whereOf(T({ scope: "workspace", project: null })), "Workspace");
  assert.equal(whereOf(T(), (p) => p.toUpperCase()), "BILLING");
  assert.equal(dotOf(T({ viewers: 1 })), "on");
  assert.equal(dotOf(T()), "away");
  assert.equal(dotOf(T({ status: "exited" })), "ended");
  assert.equal(isDetached(T()), true);
  assert.equal(isDetached(T({ viewers: 1 })), false);
  assert.equal(isDetached(T({ status: "exited" })), false);
});

t("runningOf and listRows: counts per project, running before ended, filters", () => {
  const list = [
    T({ id: "a", status: "exited" }),
    T({ id: "b" }),
    T({ id: "c", project: "web" }),
    T({ id: "d", scope: "workspace", project: null }),
  ];
  assert.equal(runningOf(list).length, 3);
  assert.equal(runningOf(list, "billing").length, 1);
  assert.deepEqual(listRows(list).map((x) => x.id), ["b", "c", "d", "a"]);
  assert.deepEqual(listRows(list, "billing").map((x) => x.id), ["b", "a"]);
  assert.deepEqual(listRows(list, "workspace").map((x) => x.id), ["d"]);
});

t("cleanName and nameFor: 1–60 printable characters, as the backend takes them", () => {
  assert.equal(cleanName("  dev server "), "dev server");
  assert.equal(cleanName(""), null);
  assert.equal(cleanName("a\u0007b\nc"), "abc");
  assert.equal(cleanName("x".repeat(61)), null);
  assert.equal(nameFor("x".repeat(80)), "x".repeat(60));
  assert.equal(nameFor(null), null);
  // a hostile name is kept as text: escaping is the renderer's job (esc), not refused here
  assert.equal(cleanName('<img src=x onerror="alert(1)">'), '<img src=x onerror="alert(1)">');
});

t("createFlow: pause above the high mark, resume below the low one, once each", () => {
  const f = createFlow();
  assert.equal(f.wrote(HIGH), null);
  assert.equal(f.wrote(1), "pause");
  assert.equal(f.wrote(50000), null); // already paused
  assert.equal(f.drew(HIGH), null);   // still above LOW
  assert.equal(f.drew(50001 - LOW + 1), "resume");
  assert.equal(f.paused, false);
  assert.equal(f.drew(10), null);
  assert.equal(f.pending >= 0, true);
  f.wrote(HIGH + 1); f.reset();
  assert.equal(f.paused, false); assert.equal(f.pending, 0);
});

t("backoff grows to 15 s; close codes say whether to retry", () => {
  assert.equal(backoff(0, () => 0.5), 500);
  assert.equal(backoff(3, () => 0.5), 4000);
  assert.equal(backoff(20, () => 0.5), 15000);
  assert.ok(backoff(20, () => 1) <= 15000 * 1.15);
  assert.equal(closeMeaning(4404), "ended");
  assert.equal(closeMeaning(1000), "ended");
  assert.equal(closeMeaning(4403), "off");
  assert.equal(closeMeaning(4429), "full");
  assert.equal(closeMeaning(1008), "refused");
  assert.equal(closeMeaning(4401), "retry");
  assert.equal(closeMeaning(1006), "retry");
});

t("vendored xterm files are the pinned ones", () => {
  const sha = (p) => createHash("sha256").update(readFileSync(new URL("../js/vendor/xterm/" + p, import.meta.url))).digest("hex");
  assert.equal(sha("xterm.mjs"), "b336ec65a086c056d4804b3d4c2347da5663d3f23c3f25be866467bd8857ad59");
  assert.equal(sha("xterm.css"), "854a7c0fb70e8b1a083c16797ab827299fb18744f5ad34f227b48337e33293c6");
  assert.equal(sha("addon-fit.mjs"), "2d87e1bddc73be9111de8beee5370c3bb7aac9c94e18e6f245f02ca741ef1769");
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
