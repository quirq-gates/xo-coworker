// Exercises the UI's pure modules (markdown, model, timeline) against fixed
// cases and against live storm data through the proxy (GET only: nothing is written).
//   node tests/logic.test.mjs            (UI server on 127.0.0.1:5180)
//   XO_UI=http://127.0.0.1:5180 node tests/logic.test.mjs
import assert from "node:assert/strict";
import { renderMarkdown, renderInline, threadLinks } from "../js/markdown.js";
import { parseChecklist, tasksOf } from "../js/model.js";
import { request } from "../js/api.js";
import { uiMsg, mergeRows, echoes, askText, stormAsks, threadAnchors, parseTarget, stripTarget, sendErrorTitle, connLine, currentPools, sendBlock, mapLimit, plainText, hopLine } from "../js/timeline.js";

let passed = 0;
const t = (name, fn) => {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { console.error("  FAIL " + name + "\n" + e.stack); process.exitCode = 1; }
};

// ── markdown safety and features ─────────────────────────────────────────
t("escapes raw html", () => {
  const out = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.ok(!out.includes("<script") && !out.includes("<img"));
  assert.ok(out.includes("&lt;script&gt;"));
});
t("javascript: links are not links", () => {
  const out = renderMarkdown("[click](javascript:alert(1)) and [x](data:text/html,hi)");
  assert.ok(!out.includes("<a"), out);
  assert.ok(out.includes("click"));
});
t("attribute breakout in http link is escaped", () => {
  const out = renderInline('[a](https://x.y/"onmouseover="alert(1))');
  assert.ok(!/href="[^"]*"onmouseover/.test(out), out);
});
t("thread links become in-app anchors", () => {
  const out = renderMarkdown("Sent to [Power operator + tests](#cmsg_0mv6m0vxl000834eada7).");
  assert.match(out, /<a href="#cmsg_0mv6m0vxl000834eada7" class="md-tlink" data-thread="cmsg_0mv6m0vxl000834eada7">Power operator \+ tests<\/a>/);
  assert.deepEqual(threadLinks("[a](#cmsg_abc) [b](#cmsg_def) [a](#cmsg_abc)"), ["cmsg_abc", "cmsg_def"]);
});
t("http links open in new tab", () => {
  const out = renderMarkdown("see https://example.com/a?b=1, and [docs](https://x.dev)");
  assert.match(out, /href="https:\/\/example.com\/a\?b=1" target="_blank" rel="noopener noreferrer nofollow"/);
  assert.match(out, /href="https:\/\/x.dev"/);
});
t("bold, italic, code, lists, fences", () => {
  const out = renderMarkdown("**bold** *it* _it2_ `a<b`\n\n- one\n- two\n  - nested\n\n1. x\n2. y\n\n```py\nprint('<hi>')\n```");
  assert.ok(out.includes("<strong>bold</strong>") && out.includes("<em>it</em>") && out.includes("<em>it2</em>"));
  assert.ok(out.includes("<code>a&lt;b</code>"));
  assert.ok(out.includes("<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>"), out);
  assert.ok(out.includes("<ol><li>x</li><li>y</li></ol>"));
  assert.ok(out.includes('<div class="md-code"><div class="md-code-head"><span>py</span>'));
  assert.ok(out.includes("print(&#39;&lt;hi&gt;&#39;)"));
});
t("snake_case is not italic", () => {
  assert.ok(!renderInline("thread_budget_usd and XO_ROUTER_MODE").includes("<em>"));
});

// ── checklist, grouping ──────────────────────────────────────────────────
t("a hop line names who sent it to whom, from the hop's own roles", () => {
  const line = (h) => hopLine(h, "demo-proj");
  assert.equal(line({ kind: "relay", from_role: "thread", to_role: "project-coordinator" }), "This thread wrote to the demo-proj coordinator");
  assert.equal(line({ kind: "relay", from_role: "xo", to_role: "project-coordinator" }), "XO wrote to the demo-proj coordinator");
  assert.equal(line({ kind: "ask", from_role: "project-coordinator", to_role: "workspace-coordinator", via: ["thread", "project"] }), "The demo-proj coordinator asked the Workspace on behalf of this thread");
  assert.equal(line({ kind: "relay", from_role: "project-coordinator", to_role: "thread", message_ids: ["cmsg_1"] }), "The demo-proj coordinator passed on your message");
  assert.equal(line({ kind: "relay", from_role: "project-coordinator", to_role: "thread", message_ids: [] }), "The demo-proj coordinator wrote to this thread", "a relay with only a note is the coordinator writing");
  assert.equal(line({ kind: "ask", from_role: "xo", to_role: "project-coordinator", state: "sent" }), "XO asked the demo-proj coordinator · not taken up yet");
  assert.equal(line({ kind: "answer", from_role: "workspace-coordinator", to_role: "project-coordinator" }), "The Workspace answered the demo-proj coordinator");
  assert.equal(line({ kind: "status", from_role: "thread", to_role: "project-coordinator", state: "answered" }), "This thread reported back to the demo-proj coordinator · answered");
  assert.equal(line({ kind: "brief", from_role: "project-coordinator", to_role: "thread", via: ["workspace"] }), "Forwarded by the Workspace, via the project");
  assert.equal(line({ kind: "forward", from_role: "workspace-coordinator", to_role: "project-coordinator" }), "Forwarded by the Workspace");
});

t("checklist parse", () => {
  const c = parseChecklist("✓ Added ^\n✱ Fixing tests\n○ Waiting on owner\n- ✓ bullet done\nNote line");
  assert.equal(c.total, 4);
  assert.equal(c.done, 2);
  assert.equal(c.doing, 1);
  assert.equal(c.items.at(-1).state, "note");
});
t("tasks leave notes out of the count and the bar", () => {
  const c = tasksOf("# Plan\n✓ one\n✱ two\nnote");
  assert.deepEqual(c.items.map((i) => i.state), ["done", "doing"]);
  assert.deepEqual([c.total, c.done, c.doing], [2, 1, 1]);
});

// ── storm rows and the live timeline (js/timeline.js) ────────────────────
t("storm rows map to the UI's authors (role ids)", () => {
  const base = { id: "cmsg_a1", seq: 4, created_at: "2026-01-01T00:00:00Z", text: "hi", extra: {} };
  assert.equal(uiMsg({ ...base, author_kind: "owner", author_id: "owner" }).who, "you");
  assert.equal(uiMsg({ ...base, author_kind: "agent", author_id: "workspace-coordinator" }).who, "coord");
  assert.equal(uiMsg({ ...base, author_kind: "agent", author_id: "project-coordinator" }).who, "coord");
  assert.equal(uiMsg({ ...base, author_kind: "agent", author_id: "thread" }).who, "agent");
  assert.equal(uiMsg({ ...base, author_kind: "system", author_id: "xo" }).who, "system");
  const f = uiMsg({ ...base, author_kind: "owner", author_id: "owner", extra: { forwarded_from: { chat_id: "chat_ws", message_id: "cmsg_0", via: ["workspace"] } } });
  assert.deepEqual(f.fwd, { chatId: "chat_ws", id: "cmsg_0", via: ["workspace"] });
  assert.equal(f.at, Date.parse(base.created_at));
  assert.equal(f.seq, 4);
  assert.equal(uiMsg({ ...base, author_kind: "system", author_id: "xo", reply_to: "cmsg_x" }).noOne, true);
});
t("rows merge by id and sort by seq (storm ids are not ordered)", () => {
  const a = { id: "cmsg_ff", seq: 1 }, b = { id: "cmsg_00", seq: 2 }, c = { id: "cmsg_77", seq: 3 };
  let { list, added } = mergeRows([c], [b, a]);
  assert.deepEqual(list.map((r) => r.id), ["cmsg_ff", "cmsg_00", "cmsg_77"]);
  assert.equal(added.length, 2);
  ({ list, added } = mergeRows(list, [{ id: "cmsg_00", text: "again" }]));
  assert.equal(added.length, 0);
  assert.equal(list.find((r) => r.id === "cmsg_00").seq, 2, "a frame without seq keeps the known seq");
});
t("an optimistic row is matched to its server echo once", () => {
  const now = Date.parse("2026-01-01T00:00:10Z");
  const locals = [{ id: "l1", who: "you", text: "go", at: now, status: "sending" }, { id: "l2", who: "you", text: "go", at: now + 1, status: "sending" }, { id: "l3", who: "you", text: "x", at: now, status: "failed" }];
  const rows = [{ id: "cmsg_a", who: "you", text: "go", at: now + 400 }, { id: "cmsg_b", who: "coord", text: "go", at: now + 500 }, { id: "cmsg_c", who: "you", text: "x", at: now + 10 }];
  const m = echoes(locals, rows);
  assert.deepEqual([...m], [["l1", "cmsg_a"]]);
  assert.equal(echoes(locals, rows, new Set(["cmsg_a"])).size, 0);
  // an old identical message is not an echo
  assert.equal(echoes([locals[0]], [{ id: "cmsg_old", who: "you", text: "go", at: now - 3600000 }]).size, 0);
});
t("ask titles come from the first sentence, plain text", () => {
  assert.deepEqual(askText("I need **some** answers first. The repo has no [retry](#cmsg_1) handling."), { title: "I need some answers first.", rest: "The repo has no retry handling." });
  const long = askText("x".repeat(300));
  assert.ok(long.title.length <= 140 && long.title.endsWith("…"));
  assert.equal(plainText("```js\ncode\n```\n# Head"), "Head");
});
t("storm asks: review items first, then needs_reply in words, paused, a pending approval", () => {
  const th = { id: "cmsg_t", state: "needs_reply", lastAt: 5, card: { needs_you: "Which provider should I use? SendGrid or SES.", updated_at: "u1" } };
  const [a] = stormAsks(th);
  assert.deepEqual([a.kind, a.options, a.replyOnly, a.title, a.id], ["question", null, true, "Which provider should I use?", "cmsg_t:u1"]);
  assert.notEqual(stormAsks({ ...th, card: { ...th.card, updated_at: "u2" } })[0].id, a.id);
  assert.deepEqual(stormAsks({ ...th, state: "working" }), []);
  const item = { id: "rv_1", kind: "permission", title: "Run `npm install`", why: "needs a package", risk: "notable", risk_reasons: ["network"], blocking: true, state: "open" };
  const [b] = stormAsks({ ...th, state: "needs_approval" }, [item]);
  assert.deepEqual([b.id, b.kind, b.risk, b.item === item, b.replyOnly], ["rv_1", "permission", "notable", true, undefined]);
  assert.equal(stormAsks({ ...th, state: "needs_approval" })[0].pending, true);
  const [p] = stormAsks({ ...th, state: "paused", paused: "stuck on a denied step" });
  assert.match(p.detail, /stuck on a denied step/);
});
t("thread cards sit under the coordinator's reply to the root, else alone", () => {
  const rows = [{ id: "r1", who: "you" }, { id: "c1", who: "coord" }, { id: "r2", who: "you" }, { id: "r3", who: "you" }, { id: "x", who: "you" }];
  const { on, alone } = threadAnchors(rows, ["r1", "r2", "r3"]);
  assert.deepEqual([...on], [["c1", ["r1"]]]);
  assert.deepEqual([...alone].sort(), ["r2", "r3"]);
});
t("@project targets: only a known project is stripped", () => {
  const ps = [{ id: "workspace", name: "Workspace" }, { id: "billing-api", name: "billing-api" }];
  assert.deepEqual(parseTarget("@billing-api add tests", ps), { pid: "billing-api", token: "billing-api", unknown: null });
  assert.equal(parseTarget("@Workspace hi", ps).pid, "workspace");
  assert.deepEqual(parseTarget("ask @nope about it", ps), { pid: null, token: null, unknown: "nope" });
  assert.equal(parseTarget("mail me at a@b.c", ps).unknown, null);
  assert.equal(stripTarget("add @billing-api tests", "billing-api"), "add tests");
  assert.equal(stripTarget("@billing-api.x keep", "billing-api"), "@billing-api.x keep");
  assert.equal(stripTarget("no token", null), "no token");
});
t("send errors say what happened, in plain words", () => {
  assert.equal(sendErrorTitle({ code: "router_off", status: 409 }), "The router is off");
  assert.equal(sendErrorTitle({ code: "chat_retired", status: 409 }), "This project was removed");
  assert.equal(sendErrorTitle({ code: "engine_not_running", status: 503 }), "XO's chat engine isn't running");
  assert.equal(sendErrorTitle({ status: 501 }), "Not supported by this agent");
  assert.equal(sendErrorTitle({ status: 403 }), "Refused by the proxy");
  assert.equal(sendErrorTitle({ status: 502 }), "Can't reach XO");
  assert.equal(sendErrorTitle({ status: 400 }), "Message not sent");
  assert.equal(sendErrorTitle({ code: "timeout", status: 0 }), "No answer from XO");
});
t("the connection line and the send block are honest", () => {
  const rt = [{ name: "claude_code", cli: { logged_in: true } }];
  const ok = { loaded: true, conn: "live", runtimes: rt, router: { mode: "agent" }, pools: {} };
  assert.equal(connLine(ok), null);
  assert.equal(sendBlock(ok), "");
  assert.equal(connLine({ ...ok, error: "x" }).kind, "down");
  assert.equal(connLine({ ...ok, conn: "down" }).kind, "down");
  assert.match(connLine({ ...ok, statusError: "x", statusCode: "engine_not_running" }).text, /engine isn't running/);
  assert.match(connLine({ ...ok, error: "Storm isn't running yet.", errorCode: "engine_not_running" }).text, /engine isn't running/, "not blamed on the network");
  assert.match(connLine({ ...ok, runtimes: [{ name: "claude_code", cli: { logged_in: false } }] }).text, /Claude isn't connected/);
  assert.equal(sendBlock({ ...ok, runtimes: [{ name: "claude_code", cli: { logged_in: false } }] }), "Claude isn't connected");
  assert.match(connLine({ ...ok, router: { mode: "off" } }).text, /router is off/);
  assert.equal(sendBlock({ ...ok, router: { mode: "off" } }, { timeline: false }), "", "threads still take replies");
  assert.match(connLine({ ...ok, pools: { p: { state: "closed", resets_at: "2026-10-21T14:05:00Z" } } }).text, /^Paused until /);
  assert.equal(connLine({ ...ok, pools: { p: { state: "warn" } } }), null, "warn only holds later work: no line");
  assert.equal(sendBlock({ ...ok, loaded: false }), "Connecting to XO…");
  assert.equal(connLine({ ...ok, error: null, errorCode: null }), null, "a recovered state has no line");
});
t("an old account's closed pool pauses nothing after a re-login (if1 #1)", () => {
  const rt = (account) => [{ name: "claude_code", cli: { logged_in: true, account } }];
  const pools = {
    "claude_code:acct-70c53cc54fd1": { pool: "claude_code:acct-70c53cc54fd1", state: "open" },
    "claude_code:acct-d6f9c7186766": { pool: "claude_code:acct-d6f9c7186766", state: "closed", resets_at: "2026-10-22T23:00:00Z" },
  };
  const base = { loaded: true, conn: "live", router: { mode: "auto" } };
  assert.equal(connLine({ ...base, runtimes: rt("acct-70c53cc54fd1"), pools }), null, "the new account is usable: no line");
  assert.equal(sendBlock({ ...base, runtimes: rt("acct-70c53cc54fd1"), pools }), "", "and no paused composer");
  assert.match(connLine({ ...base, runtimes: rt("acct-d6f9c7186766"), pools }).text, /^Paused until /, "the current account's pool closed: as before");
  assert.match(connLine({ ...base, runtimes: rt(undefined), pools }).text, /^Paused until /, "an unknown account: as before");
  assert.equal(connLine({ ...base, runtimes: rt("acct-new"), pools }), null, "an account with no pool row yet counts as open");
  const paid = { "claude_code:acct-old": { pool: "claude_code:acct-old", state: "paid" } };
  assert.equal(connLine({ ...base, runtimes: rt("acct-new"), pools: paid }), null, "paid on an old account: no line");
  assert.equal(currentPools(pools, rt("acct-70c53cc54fd1")).length, 1);
  assert.equal(currentPools({ p: { state: "closed" } }, rt("x")).length, 1, "an id that isn't runtime:account still counts");
});
await (async () => {
  let peak = 0, now = 0;
  await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async () => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 5)); now--; });
  t("mapLimit caps parallel fetches", () => assert.equal(peak, 3));
})();

// ── a request that never settles gives up (if1 #6) ─────────────────────────
await (async () => {
  const real = globalThis.fetch;
  const seen = [];
  // a fetch that never answers, but honours its signal, as a half-open connection does
  globalThis.fetch = (url, opts) => new Promise((_, reject) => {
    seen.push(opts);
    opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  try {
    let err = null;
    const t0 = Date.now();
    try { await request("/chat/chats/x/messages", { method: "POST", body: { text: "hi", client_id: "ui_1" }, timeout: 60 }); } catch (e) { err = e; }
    t("a write that never settles fails as a timeout", () => {
      assert.ok(err && err.code === "timeout" && err.status === 0, String(err && err.code));
      assert.equal(sendErrorTitle(err), "No answer from XO");
      assert.ok(Date.now() - t0 < 1000);
      assert.equal(JSON.parse(seen[0].body).client_id, "ui_1", "a retry is the same request");
    });
    const ctl = new AbortController();
    const p = request("/chat/status", { signal: ctl.signal, timeout: 5000 });
    ctl.abort();
    let err2 = null;
    try { await p; } catch (e) { err2 = e; }
    t("a caller's own abort stays an AbortError, not a timeout", () => assert.equal(err2 && err2.name, "AbortError"));
  } finally {
    globalThis.fetch = real;
  }
})();

// ── live data from storm (GET only: this suite never writes) ─────────────
const BASE = (process.env.XO_UI || "http://127.0.0.1:5180") + "/api/chat";
const get = async (p) => {
  const r = await fetch(BASE + p); // GET only
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  return r.json();
};
try {
  const { chats } = await get("/chats");
  const runtimes = (await get("/runtimes")).runtimes;
  t(`storm: ${chats.length} chats, the workspace first; ${runtimes.length} runtime(s) with a feature list`, () => {
    assert.equal(chats[0].kind, "workspace");
    for (const c of chats) assert.match(c.id, /^chat_/);
    for (const r of runtimes) assert.ok(r.features && r.features.features, r.name);
  });
  let threadsSeen = 0;
  for (const c of chats) {
    const m = await get(`/chats/${c.id}/messages?before_seq=9007199254740991&limit=40`);
    const { threads } = await get(`/chats/${c.id}/threads`);
    threadsSeen += threads.length;
    const rows = m.messages.map(uiMsg);
    t(`${c.project || "workspace"}: timeline maps by seq (${rows.length} msgs, ${threads.length} threads)`, () => {
      for (let i = 1; i < rows.length; i++) assert.ok(rows[i].seq > rows[i - 1].seq, "oldest first");
      for (const r of rows) assert.ok(["you", "coord", "agent", "system"].includes(r.who) && Number.isFinite(r.at) && r.id);
      for (const th of threads) {
        assert.ok(["working", "needs_reply", "needs_approval", "done", "failed", "resolved", "paused"].includes(th.state), th.state);
        parseChecklist(th.status_md || "");
        stormAsks({ id: th.ts, state: th.state, card: th.card, lastAt: 0 });
      }
    });
  }
  console.log(`      ${threadsSeen} thread(s) across the chats`);
} catch (e) {
  console.error("live data unavailable:", e.message);
  process.exitCode = 1;
}
console.log(`${passed} passed${process.exitCode ? ", with failures" : ""}`);
