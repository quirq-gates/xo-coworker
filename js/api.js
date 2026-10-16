// Thin client for the projects-chat API (same origin; serve.py proxies /api).

const BASE = "/api/projects-chat";

// Inside a Coder workspace, the app is opened at `?coder_session_token=…`
// (xo-swarm does this). Coder accepts that for the page load, but the cookie
// it sets lasts a minute, after which every request here is redirected to
// Coder's sign-in on another origin and fails CORS. So the token is kept for
// this tab, taken out of the address bar, and sent on every request.
const TOKEN_PARAM = "coder_session_token";
const TOKEN_KEY = "xo-coder-token";
const coderToken = (() => {
  let token = null;
  try {
    const url = new URL(location.href);
    token = url.searchParams.get(TOKEN_PARAM);
    if (token) {
      url.searchParams.delete(TOKEN_PARAM);
      history.replaceState(history.state, "", url);
    }
  } catch { /* not in a browser */ }
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else token = sessionStorage.getItem(TOKEN_KEY);
  } catch { /* storage blocked: this page load still has the token */ }
  return token;
})();

/** Headers that keep Coder's app proxy signing requests in. */
export const coderHeaders = () => (coderToken ? { "Coder-Session-Token": coderToken } : {});

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = "GET", body, signal, base = BASE } = {}) {
  let res;
  try {
    res = await fetch(base + path, {
      method,
      signal,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...coderHeaders() },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      // A redirect here is Coder sending us to sign in, which fetch can't follow.
      redirect: "manual",
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError(0, "network", "Can't reach the UI server. Is serve.py running?");
  }
  if (res.type === "opaqueredirect") {
    throw new ApiError(401, "signed_out", "Signed out of the workspace. Reopen this app from XO.");
  }
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = data && data.detail;
    const code = (d && d.code) || `http_${res.status}`;
    let message = (d && d.message) || (typeof d === "string" ? d : "");
    if (Array.isArray(d)) message = d.map((e) => e.msg).join("; ");
    if (!message) message = `${res.status} ${res.statusText || "error"}`;
    throw new ApiError(res.status, code, message);
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  status: () => request("/status"),
  chats: () => request("/chats"),
  messages: (chat, { thread, after, limit } = {}) => {
    const q = new URLSearchParams();
    if (thread) q.set("thread", thread);
    if (after) q.set("after", after);
    if (limit) q.set("limit", String(limit));
    const qs = q.toString();
    return request(`/chats/${enc(chat)}/messages${qs ? "?" + qs : ""}`);
  },
  post: (chat, text, threadTs) =>
    request(`/chats/${enc(chat)}/messages`, {
      method: "POST",
      body: threadTs ? { text, thread_ts: threadTs } : { text },
    }),
  threads: (chat) => request(`/chats/${enc(chat)}/threads`),
  thread: (chat, ts) => request(`/chats/${enc(chat)}/threads/${enc(ts)}`),
  /** Where xo-projects live: {roots: {...}, default}. Never hard-code the root. */
  workspaceConfig: () => request("/api/config/workspace", { base: "" }),
  /** Scaffold a new xo-project (xo-cowork-api). 409 when the folder exists. */
  createProject: ({ path, displayName, description }) =>
    request("/api/files/mkdir", {
      base: "",
      method: "POST",
      body: { path, scaffold: true, display_name: displayName, ...(description ? { description } : {}) },
    }),
  // EventSource can't send headers, so the token rides in the query instead.
  streamUrl: (chat, after) => {
    const q = new URLSearchParams();
    if (after) q.set("after", after);
    if (coderToken) q.set(TOKEN_PARAM, coderToken);
    const qs = q.toString();
    return `${BASE}/chats/${enc(chat)}/stream${qs ? "?" + qs : ""}`;
  },
};
