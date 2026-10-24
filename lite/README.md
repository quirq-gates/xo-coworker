# xo-coworker lite

A lightweight web UI for XO Space: about 1,800 lines in all, against the full UI's 11,000. It talks to the same backend through the same proxy (`../serve.py`). There's no build step and nothing to install.

```sh
python3 lite/serve.py                      # http://127.0.0.1:5181
PORT=5182 XO_API=http://127.0.0.1:5002 python3 lite/serve.py
```

**Sending a message starts real agents**, as in the full UI.

## What it does

- **Needs you** (`#/`): every open review item, answered with the item's own buttons, plus threads waiting for your reply, answered inline. Then the threads working now.
  - A question item shows its options and also takes an answer in words.
  - A "no" that takes a note gets a note field.
  - Saying yes to a destructive item asks you to confirm.
- **Workspace / a project** (`#/c/<chat>`): the project's threads, with their state and checklist progress (finished ones are folded), then its timeline.
  - Older messages load as you scroll up.
  - "Replying…" shows while the coordinator answers.
  - Live activity and Stop appear while the coordinator works.
- **Thread** (`#/t/<ts>`): its state, branch, Resolve or Reopen, the checklist, "Needs you", "What happened", its review items, messages and a reply box.
- **Live activity**: the running turn's newest blocks (thinking, tool steps, streaming text), how long it has run, and **Stop**.
- **Files**: use ＋, paste or drop. Each file uploads at once with progress, Retry and Remove; you can't send until uploads finish. Images in messages show as thumbnails, and other files open in a new tab.
- **Sending**: your message shows at once. On failure it says why, with Retry and Edit.
- **Live updates**: one SSE stream. It resumes with `Last-Event-ID`, and a `reset` reloads everything. A line shows when XO or the stream is down.
- Light and dark follow the OS. On phones the sidebar becomes a drawer.

Left out on purpose: Home ranking, pacing, sounds, and the decision panel's Undo, hold and Teach. Also sub-agent runs, plain Chats, Settings (router, models, rules, worktrees), the model chip, hops, the file viewer, Create Project, ⌘K and syntax colours. See `../LIGHTWEIGHT.md`.

## Code

| File | Lines | Role |
|---|---:|---|
| `js/app.js` | 420 | views, render, composer, files, clicks |
| `js/store.js` | 310 | the only network user: boot, the stream, state, writes |
| `js/api.js` | 120 | HTTP endpoints, Coder token, upload with progress |
| `js/activity.js` | 50 | the live activity panel |
| `js/sse.js` | 190 | copied from `../js/sse.js` (resumable SSE) |
| `js/blocks.js` | 220 | copied from `../js/blocks.js` (turn blocks from frames) |
| `js/markdown.js` | 280 | `../js/markdown.js` with its own `esc` and no syntax colours |
| `css/lite.css` | 170 | all styles; XO palette |
| `serve.py` | 20 | runs `../serve.py` with this folder as the web root |

The three copied modules are pure and covered by the full UI's tests. Re-copy them when they change upstream.

Endpoints used: `chat/status`, `chat/chats`, `chat/chats/{chat}/threads[/{ts}]`, `chat/chats/{chat}/messages` (GET, POST), `PATCH chat/chats/{chat}/threads/{ts}`, `chat/chats/{chat}/attachments[/{id}]`, `chat/sessions`, `chat/review`, `POST chat/review/{id}/decision`, `chat/events`, `POST chat/abort`, `chat/stream`.
