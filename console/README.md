# Jetso Console — frontend

React + Vite single-page app. See the [root README](../README.md) for the
platform overview, deployment, and environment variables.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

By default it runs against an in-memory **mock backend** — fully clickable with
zero credentials, useful for demos and UI work. A `演示数据 · MOCK` badge shows
in the sidebar whenever the mock is active.

To run against the real backend (started separately on port 5001), create
`console/.env.local`:

```
VITE_USE_MOCK=false
VITE_API_BASE=http://localhost:5001
```

Production builds read `.env.production` instead, which points at the same
origin. Don't delete that file — without it `VITE_USE_MOCK` is undefined, which
`api.js` treats as *mock on*, and the deployed app would show fake data.

## Structure

| File | What it holds |
| --- | --- |
| `src/JetsoConsole.jsx` | Every view: login, sidebar, 询盘确认, 内容发布, and the locked analytics placeholder. Styling is one inline `<style>` block with day/night CSS variables. |
| `src/api.js` | The single seam to the backend — mock and real implementations behind an identical contract, plus token storage and silent JWT refresh on 401. |
| `src/index.css` | Global reset only. |

Swapping mock ↔ real is a one-line env change because the UI never calls `fetch`
directly; it only calls `api.*`.

## Backend contract

Implemented in `api/index.py`. All calls are same-origin in production and carry
the Supabase JWT when auth is enabled.

| Function | Method + path |
| --- | --- |
| `listPages()` | `GET /api/content/pages` — includes `status` + `builder` so unsupported pages can be disabled |
| `listModels()` | `GET /api/content/models` |
| `listContentRequests()` | `GET /api/content/requests` |
| `createContentRequest()` | `POST /api/content/draft` — `{wp_page_id, content_mode, summary, manual_text?, media_id?, media_url?, model}` |
| `decideContentRequest()` | `POST /api/content/decide` — `{id, decision: 'approve'\|'reject'}` |
| `setArchivedContentRequest()` | `POST /api/content/archive` — `{id, archived}` (rejected rows only) |
| `uploadMedia(file)` | `POST /api/content/upload-media` — multipart |
| `listLeads()` / `confirmLead()` | `GET /api/leads` · `POST /api/confirm` |
| `login()` | `POST /api/auth/login` (+ `/api/auth/refresh`) |

`content_mode` is `ai_text | manual_text | manual_image`; status enum matches
`content_requests.status` in `db/schema.sql`:
`drafting | pending_review | published | rejected`.
