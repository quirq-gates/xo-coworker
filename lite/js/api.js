// The HTTP side of XO Space's chat API (`/api/chat/*`), as much as lite needs. Same origin: serve.py
// proxies /api. Paths are relative, so the page also works under a path prefix.

const BASE = "api";

// Opened from Coder as `?coder_session_token=…`: keep the token for this tab, take it out of the
// address bar, and send it on every request (Coder's cookie expires after a minute).
const TOKEN_PARAM = "coder_session_token";
const token = (() => {
  let t = null;
  try {
    const url = new URL(location.href);
    t = url.searchParams.get(TOKEN_PARAM);
    if (t) { url.searchParams.delete(TOKEN_PARAM); history.replaceState(history.state, "", url); }
  } catch { /* not in a browser */ }
  try {
    if (t) sessionStorage.setItem("xo-coder-token", t);
    else t = sessionStorage.getItem("xo-coder-token");
  } catch { /* storage blocked */ }
  return t;
})();
export const authHeaders = () => (token ? { "Coder-Session-Token": token } : {});

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** An ApiError from a failed answer: {detail: {code, message}}, FastAPI's 422 list, or a plain detail. */
function errorOf(status, statusText, text) {
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  const d = data && data.detail;
  const code = (d && d.code) || (data && data.error) || `http_${status}`;
  let message = (d && d.message) || (typeof d === "string" ? d : "");
  if (Array.isArray(d)) message = d.map((e) => `${(e.loc || []).slice(1).join(".")}: ${e.msg}`).join("; ");
  return new ApiError(status, code, message || `${status} ${statusText || "error"}`);
}

const NETWORK = () => new ApiError(0, "network", "Can't reach the UI server. Is serve.py running?");
const SIGNED_OUT = () => new ApiError(401, "signed_out", "Signed out of the workspace. Reopen this app from XO.");

async function request(path, { method = "GET", body, query } = {}) {
  let url = BASE + path;
  if (query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v != null && v !== "") q.set(k, String(v));
    if (q.toString()) url += "?" + q;
  }
  const ms = method === "GET" ? 30000 : 20000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  let res;
  try {
    res = await fetch(url, {
      method, signal: ctl.signal, cache: "no-store", redirect: "manual",
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw err.name === "AbortError" ? new ApiError(0, "timeout", `XO didn't answer in ${ms / 1000} s.`) : NETWORK();
  } finally {
    clearTimeout(timer);
  }
  if (res.type === "opaqueredirect") throw SIGNED_OUT();
  const text = await res.text();
  if (!res.ok) throw errorOf(res.status, res.statusText, text);
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

const enc = encodeURIComponent;
const get = (path, query) => request(path, { query });
const send = (method, path, body) => request(path, { method, body });

/** A fresh id for a write that must never happen twice. */
export const clientId = () => `ui_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
/** The largest seq: "before this" is the newest page. */
export const NEWEST = 9007199254740991;

/** Where an <img> or link loads an attachment (they can't send headers, so the token rides along). */
export const attachmentUrl = (chat, id) =>
  `${BASE}/chat/chats/${enc(chat)}/attachments/${enc(id)}` + (token ? `?${TOKEN_PARAM}=${enc(token)}` : "");

/** Upload one file's bytes to a chat, with progress. → {promise → {id, name, type, bytes}, abort()} */
export function upload(chat, blob, name, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open("POST", `${BASE}/chat/chats/${enc(chat)}/attachments?name=${enc(name)}`);
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("Content-Type", blob.type || "application/octet-stream");
    if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded / (e.lengthComputable ? e.total : blob.size || 1));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(errorOf(xhr.status, xhr.statusText, xhr.responseText));
      try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new ApiError(xhr.status, "bad_answer", "XO's answer to the upload wasn't readable.")); }
    };
    xhr.onerror = () => reject(NETWORK());
    xhr.onabort = () => reject(Object.assign(new Error("Upload cancelled"), { name: "AbortError" }));
    xhr.send(blob);
  });
  return { promise, abort: () => xhr.abort() };
}

export const api = {
  status: () => get("/chat/status"),
  chats: () => get("/chat/chats"),
  threads: (chat) => get(`/chat/chats/${enc(chat)}/threads`),
  thread: (chat, ts) => get(`/chat/chats/${enc(chat)}/threads/${enc(ts)}`),
  /** {thread?, before_seq, limit} → {messages, next_before_seq} */
  messages: (chat, query) => get(`/chat/chats/${enc(chat)}/messages`, query),
  post: (chat, { text, threadTs, attachments }) => send("POST", `/chat/chats/${enc(chat)}/messages`, {
    text, client_id: clientId(), ...(threadTs ? { thread_ts: threadTs } : {}), ...(attachments && attachments.length ? { attachments } : {}),
  }),
  /** {resolved?, title?, label?} */
  patchThread: (chat, ts, body) => send("PATCH", `/chat/chats/${enc(chat)}/threads/${enc(ts)}`, body),
  sessions: (query) => get("/chat/sessions", query),
  review: (query) => get("/chat/review", query),
  decide: (id, body) => send("POST", `/chat/review/${enc(id)}/decision`, { ...body, idempotency_key: clientId() }),
  /** A session's stored frames, for the turn that's running when a thread opens. */
  events: (query) => get("/chat/events", query),
  /** Stop a session's running turn. */
  abort: (sessionId) => send("POST", "/chat/abort", { session_id: sessionId }),
  streamUrl: `${BASE}/chat/stream`,
};
