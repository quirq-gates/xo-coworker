# xo-coworker: how the frontend works, what it needs from the backend, and a lightweight version

Written against `main` @ 69021ff. The backend shapes below were checked against the live API on `:5002`.

> Note: the README is out of date. It describes `/api/projects-chat/*`, a `stream.js` and polling
> every 15 s. The code now talks to **storm** (`/api/chat/*`) over **one global SSE stream** (`js/sse.js`),
> and polls almost nothing.

---

## 1. The shape of it

No build step, no npm, no framework: `index.html` + ES modules + two CSS files + `serve.py`.

```
browser ──▶ serve.py (:5180) ──▶ XO API (:5002)
             ├─ serves the static files
             └─ proxies /api/* (same-origin guard, route denylist, SSE relayed unbuffered)
```

About 9,000 lines of JS and 2,000 of CSS. Where the weight is:

| Lines | File | What it does |
|---:|---|---|
| 2,359 | `js/app.js` | every view, the render loop, composer, navigation, clicks, sheets, ⌘K, Create Project |
| 1,056 | `js/decide.js` | the "Needs you" panel and thread decision card: ranking, Undo window, hold-to-confirm, Teach a rule |
| 816 | `js/storm.js` | **the data layer**: boot, the stream, normalising rows into the world, every write |
| 390 | `js/chats.js` | "Chats": plain one-agent chats outside the coordinators |
| 331 | `js/timeline.js` | pure helpers: message rows → UI messages, dedupe/merge, asks, `@project` parsing |
| 289 | `js/settings.js` | settings page: router, models, rules, worktrees |
| 254 | `js/intel.js` | the model/effort chip |
| 237 | `js/attach.js` | files on a message: checks, upload tray, large paste → file |
| 222 | `js/blocks.js` | the live "what the agent is doing" turn blocks, built from stream frames |
| 219 | `js/kit.js`, 67 `pacing.js`, 72 `content.js` | decision-kit rules, what speaks up vs waits, cost/evidence lines |
| 190 | `js/sse.js` | the SSE client: fetch-based, Last-Event-ID resume, backoff, watchdog |
| ~800 | `viewer.js`, `runsview.js`, `turnview.js`, `highlight.js`, `markdown.js`, `keys.js`, `ui.js`, `util.js`, `model.js`, `world.js`, `review.js` | file viewer, sub-agent runs, turn rendering, syntax highlight, safe markdown, shortcuts, icons/motion |
| 1,895 | `css/app.css` | all of the UI |

## 2. How it works

### State: one "world" object, one-way data flow

- `world.js` creates a plain `state` object and a pub/sub (`subscribe`, `onEvent`).
- `storm.js` (`stormSource`) is the **only** thing that touches the network. It fills `state`, calls `emit()` on change, and exposes every write as `world.act.*` (`ask`, `reply`, `resolve`, `decideItem`, `watch`, `watchThread`, `stop`…).
- Views never call the API (except Settings, Chats and the file viewer, which call `api.*` directly for their own pages).

Key pieces of `state`:

| field | what |
|---|---|
| `projects` | one per chat: `{id: "workspace" or folder name, chatId, kind, routing, pin}` |
| `threads` | normalised threads: title, state, checklist (parsed from `status_md`), card, busy, asks, messages |
| `timeline[project]` | that chat's top-level messages, sorted by `seq` |
| `threadMsgs[ts]` | one thread's messages |
| `sessions[id]` | agent sessions (state `running`/`warm`/`cold`…), used for "Working" vs "Idle" and "Replying…" |
| `review` | open review items (approvals/questions) → the "Needs you" asks |
| `turns` | live blocks of running turns (tool calls, text) from `blocks.js` |
| `runs`, `hops`, `pools`, `router`, `runtimes` | sub-agents, message routing trail, account limits, model routing |

### Boot (storm.js `boot`)

1. Open the SSE stream first, wait for its first `snapshot` frame (≤4 s), and **hold** incoming frames.
2. Load everything with GETs: chats → threads of each project (6 in parallel) + sessions + open review items + hops + runtimes/router; plus `status`.
3. Apply the held frames in order, so nothing that changed during the load is lost.
4. From then on the stream is the only source of change. On a drop it reconnects with `Last-Event-ID` and the server replays what was missed; a `reset` frame (retention/store replaced) triggers a full reload.

Messages for a chat are only loaded when it's opened (`act.watch` / `act.watchThread`), 40 at a time, older pages on scroll.

### Rendering (app.js)

- `world.subscribe(() => schedule())` → one `requestAnimationFrame` → `render()`.
- `render()` rebuilds HTML strings per region (sidebar, Home, header, messages, dock, composer) and `reconcile()`s the message list by key so only new rows are added and scroll position is kept.
- The "view" is a string: `home`, `ws` (Workspace), `p:<project>`, `t:<thread ts>`, `c:<chat>`, `chats`. `go(v)` switches it; Back restores scroll.

### The flows

- **Send to Workspace / a project**: `act.ask(project, text)` → `POST messages` with a `client_id`. The returned row is shown at once; `awaiting[project]` is set so "Replying…" shows until a coordinator message arrives or its session goes idle. A failed turn shows as a plain error with Retry/Edit.
- **Reply in a thread**: `act.reply(ts, text)` → same POST with `thread_ts`. Goes straight to that thread's agent.
- **Needs you**: threads in `needs_reply`/`needs_approval`/`paused` plus open review items. A review item is answered with `POST /review/{id}/decision` using the item's own `options` (the UI owns no decision logic); a question is answered by replying in the thread.
- **Live activity**: `block.*` / `turn.*` frames build the "what it's doing now" blocks under a running thread and the typing line ("Writing", "Running tests"…).
- **Files**: each file uploads immediately to `POST /chats/{chat}/attachments` (raw bytes, XHR for progress); Send carries the returned ids.

## 3. The backend contract

All paths are under `/api`. JSON in and out. Errors are `{detail: {code, message, …}}` (also FastAPI 422 lists and plain-string `detail`).

### Auth

The XO API itself has **no auth** on localhost. The only auth is Coder's: when opened as `?coder_session_token=…`, `api.js` moves the token to `sessionStorage` and sends `Coder-Session-Token` on every request (in the query string for `<img>`/attachment URLs). `serve.py` strips it before forwarding.

### What a minimal client needs

| Method & path | Used for | Shape |
|---|---|---|
| `GET /chat/status` | health, account pools, review counts | `{sessions, queue, pools:[{id,state,resets_at}], review:{open}}` |
| `GET /chat/chats` | sidebar | `{chats:[{id, kind:"workspace"\|"project", project, retired_at, routing, pin}]}` |
| `GET /chat/chats/{chat}/threads` | a project's threads | `{threads:[{ts, chat_id, title, label, state, status_md, card:{headline,happened,needs_you}, session_id, branch, updated_at, …}]}` |
| `GET /chat/chats/{chat}/threads/{ts}` | one thread | same row |
| `GET /chat/chats/{chat}/messages?before_seq=&limit=&thread=` | history (newest page: `before_seq=2^53-1`) | `{messages:[{id, seq, chat_id, thread_ts, author_kind:"owner"\|"agent"\|"system", author_id, text, extra, created_at}], next_before_seq}` |
| `POST /chat/chats/{chat}/messages` | send | body `{text, client_id, thread_ts?, attachments?}` → the stored row |
| `GET /chat/stream` (SSE) | everything live | see below |

Thread `state` values: `working`, `needs_reply`, `needs_approval`, `paused`, `failed`, `done`, `resolved`.

### Nice to have

| Method & path | Used for |
|---|---|
| `GET /chat/review?state=open` · `GET /chat/review/{id}` · `POST /chat/review/{id}/decision` `{decision, scope?, option?, note?, idempotency_key}` | approvals and questions |
| `PATCH /chat/chats/{chat}/threads/{ts}` `{resolved?, title?, label?}` | resolve/reopen, rename |
| `POST /chat/abort` `{session_id}` | Stop |
| `GET /chat/sessions` | who's busy at boot |
| `GET /chat/events?session=&before_seq=` | a finished turn's blocks |
| `POST /chat/chats/{chat}/attachments?name=` (raw body) · `GET …/attachments/{id}` | files |

### Used only by the full UI

`/chat/runtimes[/{rt}/models]`, `/chat/router[/models]`, `/chat/hops`, `/chat/chats/{chat}/memory`, `/chat/sessions/{id}/runs`, `/chat/runs/{id}[/transcript|/stop]`, `/chat/rules`, `/chat/worktrees`, `/chat/prompt` and `/messages/{native_id}` (plain Chats), `/schedules`, `/xo-projects/{p}/file|image`, `/config/workspace`, `/files/mkdir` (Create Project), `PATCH /chat/chats/{id}`, `PATCH /chat/sessions/{id}`.

### The stream: `GET /chat/stream`

One connection for the whole Space. Each frame is `event: <type>` + `data: <envelope>` (+ `id:` for stored events):

```json
{"type":"message","id":"7309","seq":7309,"ts":"…","chat_id":"chat_…","session_id":null,"thread_ts":null,"turn_id":null,"run_id":null,"data":{ …the row… }}
```

| event | data | the lite UI needs it? |
|---|---|---|
| `snapshot` | `{seq, turns:[…]}`, first frame, resume point | yes (resume) |
| `message` | a message row | **yes** |
| `thread` | a (partial) thread row | **yes** |
| `card` | `{ts, card}` | yes |
| `session` | `{status, reason, role, …}` | yes ("Working", "Replying…") |
| `review.opened` / `.decided` / `.withdrawn` / `.expired` / `.parked` / `.annotated` | item | if we keep approvals |
| `turn.started` / `turn.finished`, `block.started` / `.updated` / `.finished` | live tool activity | optional |
| `run.started` / `run.state` / `run.finished` / `runs` | sub-agents | no |
| `hop`, `chat`, `settings`, `pool` | routing trail, new chats, router, limits | `chat` only |
| `reset` | `{reason, from_seq}` | yes (reload) |
| `heartbeat` / comments | every ~15 s of silence | ignore |

Resume: send the last `id:` back as `Last-Event-ID`. `400 bad_last_event_id` means start over from now.

### serve.py

Stdlib only, ~290 lines. It: serves files (no directory listing, no-cache); proxies `/api/*`; refuses requests from pages it didn't serve (Sec-Fetch-Site / Origin check, reads included, since some backend GETs write); never forwards secret/raw-file routes (`/api/secrets/*`, `/api/files/content|save|upload|list-directory`, agent secrets) in any spelling; rejects `#` and dot-segment paths; caps bodies at 1 MiB (25 MiB for uploads); drops Origin/Referer/Sec-Fetch-*; relays SSE chunk by chunk with `TCP_NODELAY`. The backend refuses browser writes with an Origin it doesn't know, which is why the proxy exists at all.

---

## 4. A lightweight version: what to keep and what to drop

### Proposal: "lite" (recommended)

A single page, ~1,000–1,300 lines total (one `app.js` ~700, a slim `sse.js`, one CSS ~300), reusing `serve.py` as is.

**Keep**
- Sidebar: Workspace + projects, with a dot on any project that needs you.
- Conversation view for Workspace / a project: messages (safe markdown), paging older on scroll, "Replying…".
- Project header: its threads as a list with state + checklist progress.
- Thread view: title, state, checklist (from `status_md`), card "what happened / needs you", messages, reply box.
- Composer: text, Enter to send, `@project` optional; optimistic row; Retry on failure.
- One SSE stream with `Last-Event-ID` resume and backoff (the 190-line `sse.js` is already small and well tested; keep it nearly as is).
- A "Needs you" list: threads waiting on you, and open review items answered with **plain buttons** from the item's `options` (no hold, no Undo window, no Teach).
- Connection/backend-down line. Dark theme following `prefers-color-scheme`.

**Drop**
- Home ranking, pacing, heralds, sounds, the decision panel's motion/Undo/hold/Teach (`decide.js`, `kit.js`, `pacing.js`, `content.js`: ~1,400 lines).
- Live turn blocks and sub-agent runs (`blocks.js`, `turnview.js`, `runsview.js`, `highlight.js`).
- Plain Chats, Settings (router, models, rules, worktrees), model chip (`chats.js`, `settings.js`, `intel.js`).
- Hops / "routed to" receipts, file viewer, attachments, Create XO Project, ⌘K jump, keys sheet, phone drawer polish.

### Two other sizes, if lite is the wrong cut

- **Lite+**: lite plus live activity under a running thread (keep `blocks.js` + a small renderer), Stop, Resolve/Reopen, and file attachments. ~1,800–2,200 lines.
- **Bare**: no SSE at all, poll `threads` and `messages` every few seconds; Workspace + threads + reply only. ~500 lines; slower and heavier on the backend, but trivially simple.

### Chosen: Lite+

Built in `lite/` (see `lite/README.md`): about 1,800 lines in all, of which about 690 are the copied pure modules (`sse.js`, `blocks.js`, `markdown.js`).
