// The storm client's pure parts: the SSE parser and stream resume (js/sse.js), and the block
// store (js/blocks.js), against a turn recorded from the real backend and hand-made edge cases.
// No network: nothing here talks to a server.
//   node tests/storm.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createParser, SSEStream } from "../js/sse.js";
import { createTurns } from "../js/blocks.js";

let passed = 0;
const pending = [];
const t = (name, fn) => {
  const run = async () => {
    try { await fn(); passed++; console.log("  ok  " + name); }
    catch (e) { console.error("  FAIL " + name + "\n" + e.stack); process.exitCode = 1; }
  };
  pending.push(run);
};

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const framesOf = (text) => createParser().feed(text).map((f) => ({ type: f.event, id: f.id, envelope: JSON.parse(f.data) }));

// ── the SSE parser ────────────────────────────────────────────────────────
t("parser: events, ids, multi-line data, comments, CRLF", () => {
  const p = createParser();
  const out = p.feed(": hello\r\nid: 7\r\nevent: message\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\nevent: heartbeat\ndata: {}\n\n");
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].event, out[0].id, out[0].data], ["message", "7", '{"a":\n1}']);
  assert.deepEqual([out[1].event, out[1].id, out[1].lastId], ["heartbeat", null, "7"]);
});
t("parser: frames split across chunks at any byte", () => {
  const text = fixture("plain-turn.sse");
  const whole = createParser().feed(text);
  for (const size of [1, 3, 17, 512]) {
    const p = createParser();
    const got = [];
    for (let i = 0; i < text.length; i += size) got.push(...p.feed(text.slice(i, i + size)));
    assert.equal(got.length, whole.length, `chunk ${size}`);
    assert.deepEqual(got.map((f) => f.id), whole.map((f) => f.id));
  }
});
t("parser: a lone CR at a chunk edge then LF is one line break", () => {
  const p = createParser();
  assert.equal(p.feed("event: a\r").length, 0);
  const out = p.feed("\ndata: x\r\n\r\n");
  assert.deepEqual(out.map((f) => [f.event, f.data]), [["a", "x"]]);
});
t("parser: no data, no event; ids with NUL ignored", () => {
  const p = createParser();
  assert.equal(p.feed("event: x\n\n").length, 0);
  const out = p.feed("id: 4\0\ndata: y\n\n");
  assert.equal(out[0].id, null);
});
t("recorded turn: every frame parses, stored frames carry N or N:k ids", () => {
  const text = fixture("plain-turn.sse");
  const frames = framesOf(text);
  assert.equal(frames.length, text.split("\n").filter((l) => l.startsWith("event:")).length);
  for (const f of frames) {
    assert.equal(f.envelope.type, f.type);
    if (f.envelope.seq != null) assert.match(f.id, /^\d+(:\d+)?$/);
    else assert.equal(f.id, null);
  }
});

// ── the block store ───────────────────────────────────────────────────────
t("recorded turn: blocks fold to activity, thinking, answer", () => {
  const T = createTurns();
  for (const f of framesOf(fixture("plain-turn.sse"))) T.apply(f);
  const [turn] = T.list();
  assert.equal(turn.status, "finished");
  assert.deepEqual(turn.wakes, ["msg:prompt:u1-fixture-plain-1"]);
  const blocks = T.blocksOf(turn);
  assert.deepEqual(blocks.map((b) => [b.type, b.index, b.done]), [["activity", 0, true], ["thinking", 1, true], ["answer", 2, true]]);
  assert.equal(blocks[0].header, "Ran a command");
  assert.equal(blocks[0].rows[0].status, "ok");
  assert.equal(blocks[1].header, "Thought for 3s");
  assert.match(blocks[2].text, /markdown/);
  assert.equal(T.byWake("msg:prompt:u1-fixture-plain-1"), turn);
});
t("recorded turn: mid-stream state shows streaming text and a live thinking header", () => {
  const frames = framesOf(fixture("plain-turn.sse"));
  const T = createTurns();
  const upto = frames.findIndex((f) => f.type === "block.updated" && f.envelope.data.type === "text");
  for (const f of frames.slice(0, upto + 1)) T.apply(f);
  const turn = T.list()[0];
  assert.equal(turn.status, "running");
  const blocks = T.blocksOf(turn);
  const text = blocks.find((b) => b.type === "text");
  assert.ok(text && !text.done && text.text.length > 10, "the text streams in");
  assert.equal(T.running("cse_73214cf9dde24689"), turn);
});
t("rule 1: a second block.started only adds the index", () => {
  const T = createTurns();
  const env = (type, data, seq = null) => ({ type, envelope: { type, seq, turn_id: "tu", session_id: "s", data } });
  T.apply(env("turn.started", { origin: "person" }, 1));
  T.apply(env("block.started", { block: { id: "b", type: "text", index: null, text: "" } }));
  T.apply(env("block.updated", { block_id: "b", type: "text", append: "Hel" }));
  T.apply(env("block.updated", { block_id: "b", type: "text", append: "lo" }));
  T.apply(env("block.started", { block: { id: "b", type: "text", index: 0, text: "IGNORED" } }, 2));
  const b = T.blocksOf(T.get("tu"))[0];
  assert.deepEqual([b.index, b.text], [0, "Hello"]);
});
t("rule 2: rows patch by call id; output appends, output replaces", () => {
  const T = createTurns();
  const env = (type, data, seq = null) => ({ type, envelope: { type, seq, turn_id: "tu", session_id: "s", data } });
  T.apply(env("turn.started", {}, 1));
  T.apply(env("block.started", { block: { id: "g", type: "activity", index: 0, header: "Running", rows: [{ call_id: "c1", kind: "command", line: "ls", status: "running" }] } }, 2));
  T.apply(env("block.updated", { block_id: "g", type: "activity", header: "Running", rows: [{ call_id: "c1", kind: "command", line: "ls", status: "running", output_append: "a\n" }] }));
  T.apply(env("block.updated", { block_id: "g", type: "activity", rows: [{ call_id: "c1", output_append: "b\n" }, { call_id: "p", kind: null, line: "Writing… · 1.5 KB", status: "running", pending: true, bytes: 1500 }] }));
  let rows = T.blocksOf(T.get("tu"))[0].rows;
  assert.equal(rows[0].output, "a\nb\n");
  assert.equal(rows.length, 2);
  T.apply(env("block.updated", { block_id: "g", type: "activity", rows: [{ call_id: "c1", output: "only this" }, { call_id: "p", kind: "create_file", line: "Writing `x.py` · 2 KB", status: "running", pending: undefined }] }));
  rows = T.blocksOf(T.get("tu"))[0].rows;
  assert.equal(rows[0].output, "only this");
  assert.equal(rows[1].kind, "create_file");
});
t("rule 3 and 5: finished blocks stay; open ones drop at turn.finished", () => {
  const T = createTurns();
  const env = (type, data, seq = null) => ({ type, envelope: { type, seq, turn_id: "tu", session_id: "s", data } });
  T.apply(env("turn.started", {}, 1));
  T.apply(env("block.started", { block: { id: "a", type: "text", index: null, text: "" } }));
  T.apply(env("block.started", { block: { id: "th", type: "thinking", index: null, header: "Thinking…", steps: [] } }));
  T.apply(env("block.finished", { block: { id: "a", type: "answer", index: 0, text: "Done." } }, 3));
  T.apply(env("block.updated", { block_id: "a", type: "text", append: "LATE" }));
  T.apply(env("turn.finished", { status: "finished" }, 4));
  const blocks = T.blocksOf(T.get("tu"));
  assert.deepEqual(blocks.map((b) => [b.id, b.type, b.text]), [["a", "answer", "Done."]]);
});
t("rule 4: a snapshot replaces a running turn's open blocks, keeps finished ones", () => {
  const T = createTurns();
  const env = (type, data, seq = null, turn = "tu") => ({ type, envelope: { type, seq, turn_id: turn, session_id: "s", data } });
  T.apply(env("turn.started", {}, 1));
  T.apply(env("block.finished", { block: { id: "g0", type: "activity", index: 0, header: "Read a file", rows: [] } }, 2));
  T.apply(env("block.started", { block: { id: "x", type: "text", index: null, text: "stale" } }));
  T.apply({ type: "snapshot", envelope: { type: "snapshot", data: { seq: 9, turns: [{ turn_id: "tu", session_id: "s", seq: 1, held: ["rv_1"], blocks: [{ id: "y", type: "text", index: null, text: "fresh" }] }] } } });
  const turn = T.get("tu");
  assert.deepEqual(T.blocksOf(turn).map((b) => [b.id, b.text ?? b.header]), [["g0", "Read a file"], ["y", "fresh"]]);
  assert.deepEqual(turn.held, ["rv_1"]);
});
t("rule 6: a cold session or a newer turn ends a turn that never finished", () => {
  const T = createTurns();
  const env = (type, data, seq, turn = "t1", session = "s") => ({ type, envelope: { type, seq, turn_id: turn, session_id: session, data } });
  T.apply(env("turn.started", {}, 1));
  T.apply(env("block.started", { block: { id: "o", type: "text", index: null, text: "x" } }, null));
  T.apply(env("turn.started", {}, 5, "t2"));
  assert.equal(T.get("t1").status, "ended");
  assert.equal(T.blocksOf(T.get("t1")).length, 0);
  T.apply(env("block.started", { block: { id: "o2", type: "text", index: null, text: "y" } }, null, "t2"));
  T.apply({ type: "session", envelope: { type: "session", seq: 6, session_id: "s", data: { status: "cold", reason: "idle" } } });
  assert.equal(T.get("t2").status, "ended");
  assert.equal(T.running("s"), null);
});
t("history pages applied out of order never reopen a finished block", () => {
  const frames = framesOf(fixture("plain-turn.sse"));
  const stored = frames.filter((f) => f.envelope.seq != null);
  const T = createTurns();
  const half = Math.floor(stored.length / 2);
  for (const f of stored.slice(half)) T.apply(f); // the newer page first
  for (const f of stored.slice(0, half)) T.apply(f);
  const turn = T.list()[0];
  assert.equal(turn.status, "finished");
  assert.deepEqual(T.blocksOf(turn).map((b) => [b.type, b.done]), [["activity", true], ["thinking", true], ["answer", true]]);
});

// ── the stream: resume, reset, bad ids (a fake fetch; no network) ─────────
function fakeServer(responses) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, lastId: opts.headers["Last-Event-ID"] || null, token: opts.headers["Coder-Session-Token"] || null });
    const r = responses.shift();
    if (!r) return new Promise(() => {}); // hang: the test closes the stream
    if (r.status && r.status !== 200) {
      return { ok: false, status: r.status, type: "basic", json: async () => r.body };
    }
    const enc = new TextEncoder();
    const chunks = r.chunks.slice();
    return { ok: true, status: 200, type: "basic", body: { getReader: () => ({ read: async () => (chunks.length ? { value: enc.encode(chunks.shift()), done: false } : { value: undefined, done: true }) }) } };
  };
  return { calls, fetchImpl };
}
const sse = (id, type, data) => `${id ? `id: ${id}\n` : ""}event: ${type}\ndata: ${JSON.stringify({ type, id, seq: id ? +String(id).split(":")[0] : null, data })}\n\n`;
const until = async (cond, ms = 2000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 5)); } };

t("stream: resumes with the last id it got, and sends the token header", async () => {
  const srv = fakeServer([{ chunks: [sse("3", "message", {}), sse(null, "heartbeat", {}), sse("4:0", "block.finished", {})] }, { chunks: [sse("5", "message", {})] }]);
  const got = [];
  const s = new SSEStream("api/chat/stream", { fetchImpl: srv.fetchImpl, headers: () => ({ "Coder-Session-Token": "tok" }), onFrame: (f) => got.push(f.id) }).start();
  await until(() => srv.calls.length >= 3);
  s.close();
  assert.deepEqual(got, ["3", null, "4:0", "5"]);
  assert.deepEqual(srv.calls.map((c) => c.lastId), [null, "4:0", "5"]);
  assert.equal(srv.calls[0].token, "tok");
});
t("stream: reset slow resumes from from_seq; retention reloads first", async () => {
  const srv = fakeServer([
    { chunks: [sse("7", "message", {}), sse(null, "reset", { from_seq: "7", reason: "slow" })] },
    { chunks: [sse(null, "reset", { from_seq: "120", reason: "retention" })] },
    { chunks: [sse("121", "message", {})] },
  ]);
  const resets = [];
  const s = new SSEStream("u", { fetchImpl: srv.fetchImpl, onFrame: () => {}, onReset: async (r) => { resets.push(r.reason); } }).start();
  await until(() => srv.calls.length >= 4);
  s.close();
  // slow: resume from the last frame; retention: reload, then resume from the store's head
  assert.deepEqual(srv.calls.slice(0, 4).map((c) => c.lastId), [null, "7", "120", "121"]);
  assert.deepEqual(resets, ["retention"]);
});
t("stream: a 400 bad_last_event_id starts again from now", async () => {
  const srv = fakeServer([{ status: 400, body: { detail: { code: "bad_last_event_id", message: "x" } } }, { chunks: [sse("1", "message", {})] }]);
  const s = new SSEStream("u", { lastId: "garbage", fetchImpl: srv.fetchImpl, onFrame: () => {} }).start();
  await until(() => srv.calls.length >= 2);
  s.close();
  assert.deepEqual(srv.calls.slice(0, 2).map((c) => c.lastId), ["garbage", null]);
});
t("stream: storm unavailable (503) is reported with its code, then retried", async () => {
  const srv = fakeServer([{ status: 503, body: { detail: { code: "engine_not_running", message: "Storm isn't running." } } }]);
  const states = [];
  const s = new SSEStream("u", { fetchImpl: srv.fetchImpl, onFrame: () => {}, onState: (st, info) => states.push([st, info && info.code]) }).start();
  await until(() => states.some(([, c]) => c === "engine_not_running"));
  s.close();
  assert.ok(states.some(([st, c]) => st === "reconnecting" && c === "engine_not_running"), JSON.stringify(states));
});

for (const run of pending) await run();
console.log(`${passed} passed${process.exitCode ? ", with failures" : ""}`);
