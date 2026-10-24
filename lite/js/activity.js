// What an agent is doing right now: its running turn's blocks (js/blocks.js keeps them from the
// stream), as a compact live panel. The server words every header and row; this only lays them out.

import { esc, renderMarkdown, renderInline } from "./markdown.js";

const SHOW = 4; // the newest blocks shown; older ones are counted

export const elapsed = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

function mark(r) {
  if (r.status === "running") return r.waiting ? `<i class="m wait" title="Waiting for you">!</i>` : `<i class="spin" aria-hidden="true"></i>`;
  if (r.status === "error") return `<i class="m err" title="Failed">✕</i>`;
  if (r.status === "denied" || r.status === "cancelled") return `<i class="m den" title="${esc(r.status)}">■</i>`;
  return `<i class="m ok" title="Done">✓</i>`;
}

function blockHtml(b) {
  switch (b.type) {
    case "thinking":
      return `<div class="ab think">${esc(b.header || (b.done ? "Thought" : "Thinking…"))}</div>`;
    case "activity": {
      const rows = b.rows || [];
      const live = rows.filter((r) => r.status === "running" || r.waiting);
      const shown = (live.length ? live : rows.slice(-1));
      return `<div class="ab act"><div class="ah">${renderInline(b.header || "Working", true)}<span class="n">${rows.length}</span></div>` +
        `<ul>${shown.map((r) => `<li class="${r.waiting ? "is-wait" : ""}">${mark(r)}<span>${renderInline(r.line || r.tool || "", true)}</span></li>`).join("")}</ul></div>`;
    }
    case "plan":
      return `<div class="ab plan"><div class="ah">${esc(b.header || "Plan")}</div><ul>${(b.items || []).map((i) => `<li class="ck-${esc(i.state)}"><i class="m">${i.state === "done" ? "✓" : i.state === "doing" ? "✱" : "○"}</i><span>${renderInline(i.text || "", true)}</span></li>`).join("")}</ul></div>`;
    case "text": case "narration": case "answer":
      return b.text ? `<div class="ab text prose">${renderMarkdown(b.text)}</div>` : "";
    default:
      return "";
  }
}

/** The running turn as HTML, or "" when nothing runs. `blocks` in order (turns.blocksOf). */
export function activityHtml(turn, blocks, { canStop = false } = {}) {
  if (!turn) return "";
  const since = Date.parse(turn.at) || Date.now();
  const waiting = blocks.some((b) => (b.rows || []).some((r) => r.waiting));
  const shown = blocks.slice(-SHOW);
  const hidden = blocks.length - shown.length;
  return `<section class="activity${waiting ? " is-wait" : ""}" aria-label="What the agent is doing">` +
    `<header><i class="spin" aria-hidden="true"></i><b>${waiting ? "Waiting for you" : "Working"}</b>` +
    `<span class="since" data-since="${since}">${elapsed(Math.max(0, Math.floor((Date.now() - since) / 1000)))}</span>` +
    (hidden ? `<span class="more">+${hidden} earlier</span>` : "") +
    (canStop ? `<button type="button" class="btn stop" data-act="stop">Stop</button>` : "") + `</header>` +
    shown.map(blockHtml).join("") + `</section>`;
}
