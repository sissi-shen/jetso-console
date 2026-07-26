# Jetso Console

Internal ops platform for **Reach Building** (`rubflo.com`). Two modules that
non-technical staff use daily, on one login:

1. **询盘确认 — Ad-to-CRM attribution.** Google Ads counts a "conversion" every
   time someone clicks the WhatsApp button, so most conversions are noise. A rep
   reads the actual message, confirms it's a real lead, and we send a
   `valid_lead` event back to GA4 — so Google's algorithm optimizes toward real
   buyers instead of curious clickers.
2. **内容发布 — WordPress content publish.** Staff describe a website change (or
   paste their own text / upload an image). An AI decides where it belongs on
   the page and writes the HTML. Nothing goes live without a human approving it.

The through-line: **AI drafts, a human approves.** Every publish is a recorded
decision, and every rejected change is fully reverted.

---

## Architecture

```
Browser (React SPA)
        │  same-origin /api/* calls, JWT in header
        ▼
Flask API  (api/index.py — one file, deployed as a Vercel serverless function)
        │
        ├── WordPress REST API   read/write page content, upload media, publish
        ├── Supabase (Postgres)  leads, content requests, tenants, AI spend
        ├── OpenRouter           one gateway, three selectable models
        └── GA4 Measurement Protocol   valid_lead conversion events
```

The browser holds **no secrets**. All four integrations are server-side, behind
the auth gate.

### How each module flows

**Module 1** — `Leadong/tracking.js` runs on the client's landing page. It reads
the GA4 `client_id` plus the ad's UTM parameters and rewrites every `wa.me` and
`mailto:` link so the customer's own message arrives pre-tagged:

```
Hello, I'd like a quote. [REF:1453537044.1784932573] [SRC:google|cpc|summer_sale]
```

The rep pastes that message into 询盘确认; the console parses the tags, and the
backend fires the GA4 conversion and logs the lead.

**Module 2** — the console lists the client's WordPress pages. Staff pick a
target page and a content source (AI copy / verbatim text / an image), and the
selected model receives the **entire current page** plus the requested change,
returning the full updated page with the change placed, plus a standalone
HTML/CSS snippet for manual use. The edit is written to the real page while it
**stays a draft**, and the page's prior content is saved first. Approve →
publish. Reject → the saved content is restored exactly.

---

## Local development

Requires Python 3.11+, Node 18+, and a `.env` (copy `.env.example`).

```bash
# backend — http://localhost:5001
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python api/index.py

# frontend — http://localhost:5173
cd console && npm install && npm run dev
```

The frontend ships with a **mock backend** so it's demoable with zero
credentials. To hit the real API locally, create `console/.env.local`:

```
VITE_USE_MOCK=false
VITE_API_BASE=http://localhost:5001
```

### Before every deploy

```bash
.venv/bin/python scripts/smoke_test.py        # add --deep to include a live AI call
```

24 checks, none destructive: no WordPress writes, no GA4 events, no database
rows. It verifies every credential, confirms the database schema matches what
the code expects, checks the three OpenRouter model IDs still exist, and proves
all eight safety guards and the auth gate still refuse what they should.
Exit code 0 means safe to deploy.

---

## Deployment (Vercel)

One Vercel project serves both halves: `vercel.json` builds the Vite app to
static files and runs `api/index.py` as a Python function, routing `/api/*` to it.

Two things in that file are load-bearing and easy to break:

- **`"framework": null`** — Vercel auto-detects this repo as Flask (it sees
  `requirements.txt`), and the Flask preset routes *every* request to the Python
  function, so the console 404s at `/`. `null` means "no preset": static files
  from `outputDirectory` are served at the root, while `api/*.py` is still
  auto-detected as a Serverless Function.
- **No comments.** `vercel.json` is validated with `additionalProperties: false`,
  so even a `"//"` key fails the build. Explanations go here instead.

Set these in **Vercel → Settings → Environment Variables** (names match
`.env.example`):

| Variable | Notes |
| --- | --- |
One row = one variable. Values are literal: no quotes, no `$`, no units.

| Variable | Value to set | Where it comes from |
| --- | --- | --- |
| `GA4_MEASUREMENT_ID` | `G-XXXXXXXXXX` | GA4 Admin → Data Streams → your web stream |
| `GA4_API_SECRET` | the secret string | same screen → Measurement Protocol API secrets |
| `SUPABASE_URL` | `https://<project-id>.supabase.co` | Supabase → Project Settings → API |
| `SUPABASE_KEY` | the **service_role** key | same screen — never the anon/public key |
| `WP_BASE_URL` | `https://rubflo.com` | no trailing slash |
| `WP_USERNAME` | the Editor account's login | a dedicated Editor account, not the admin |
| `WP_APP_PASSWORD` | the 24-char application password | WP → Users → Application Passwords |
| `TENANT_ID` | `00000000-0000-0000-0000-000000000001` | the seeded row in `tenants` |
| `OPENROUTER_API_KEY` | your key (`sk-or-v1-…`) | openrouter.ai → Keys |
| `OPENROUTER_DEFAULT_MODEL` | `deepseek/deepseek-v4-flash` | must be one of the three IDs in `MODEL_MENU` |
| `AUTH_REQUIRED` | `true` | **the most important one** — without it the console is public |
| `FRONTEND_ORIGINS` | `*` at first, then your Vercel URL | tighten once the URL is known |
| `AI_MONTHLY_CAP_USER` | `5` | USD per user per month |
| `AI_MONTHLY_CAP_TENANT` | `8` | USD for the whole client per month |

### Controlling AI cost

Measured cost of one draft on a typical (~2.4k character) page:

| Model | Per draft | Notes |
| --- | --- | --- |
| DeepSeek V4 Flash | **$0.0004** | the default |
| GPT-5.6 Luna | $0.011 | 30× the default |
| Claude Sonnet 5 | $0.023 | 61× the default — best at structured HTML |

Realistic staff usage lands well under $1/month. The caps exist to bound
runaway loops, abuse, and enthusiastic testing — not to ration normal work.

**These figures are internal.** The client pays a flat subscription, so nothing
cost-related is exposed to them: the API strips `typical_cost` from the model
menu, there is no usage endpoint, and a user who hits a cap sees only
"本月 AI 生成次数已达上限" with a pointer to the non-AI modes. Actual spend goes
to the server log and the `ai_usage` table, which only you can read.

Three independent layers:

1. **A credit limit on the OpenRouter key itself** (openrouter.ai → Keys → edit).
   Set this — it is the only ceiling a bug in this codebase cannot bypass.
   ~$30/month is generous for one client.
2. **Monthly caps in the backend** — checked before every AI call, with the real
   charged cost (reported by OpenRouter per response) recorded in `ai_usage`.
   Hitting a cap returns `429` and a message pointing at the non-AI modes.
3. **`AI_MAX_PAGE_CHARS`** — refuses pages so large that a single call would be
   expensive.

To review spend yourself: query `ai_usage` in Supabase, or check the OpenRouter
dashboard.

Database setup is a one-time paste of [`db/schema.sql`](db/schema.sql) into the
Supabase SQL editor — every statement is idempotent, so re-running it is safe.

### CI/CD

Two GitHub Actions workflows guard every deploy; each check exists because the
failure it catches has actually happened here:

- **`ci.yml`** (pre-deploy, on every push/PR): validates `vercel.json` against
  Vercel's published schema (unknown keys fail their build), imports the Flask
  app with zero env vars set (import-time crashes would 500 every request),
  builds the console and asserts the bundle has no mock mode / no localhost /
  real API paths, and scans every tracked file for live-credential patterns.
- **`verify-deployment.yml`** (post-deploy): Vercel reports each deployment to
  GitHub; this probes the live URL — console served at `/`, the referenced JS
  bundle resolves, `/api/health` is ok, and `AUTH_REQUIRED` is on in
  production. A red X on the commit within a minute means the live site is
  wrong even though the build "succeeded" — the class of failure that is
  otherwise only found by clicking around.

No secrets are needed by either workflow. The full `scripts/smoke_test.py`
(which needs live credentials) stays a local pre-push step by choice.

Accounts are **invite-only**: in Supabase → Authentication, turn off public
signups, then add each staff account by hand under Users.

---

## Repository layout

| Path | What it is |
| --- | --- |
| `api/index.py` | The entire backend — every endpoint, guard, and integration |
| `console/src/JetsoConsole.jsx` | The entire UI — sidebar, login, both module views |
| `console/src/api.js` | The only place the UI talks to the backend (mock + real behind one contract) |
| `db/schema.sql` | Source of truth for all five tables; safe to re-run |
| `Leadong/tracking.js` | The snippet installed on the client's landing page |
| `scripts/smoke_test.py` | Pre-deploy verification |
| `Context.md` | Project decision log — read this first when picking work back up |

### Database tables

| Table | Purpose |
| --- | --- |
| `tenants` | One row per client. Every table carries `tenant_id`, so a second client is a data change, not a rewrite |
| `leads` | Module 1: each confirmed inquiry, its attribution, the GA4 result, the rep's note |
| `content_requests` | Module 2: every change's full lifecycle — before/after, the revert snapshot, model used, who submitted, approval status |
| `tenant_wp_credentials` | Future home of per-client WordPress credentials (env vars while single-client) |
| `ai_usage` | Per-call AI spend ledger — one row per AI call, with the real cost OpenRouter charged. Backs the monthly caps |

Row Level Security is enabled on every table with no permissive policies, so
anything other than the server's service-role key reads zero rows.

---

## Known limitations

- **Page-builder pages can't be edited.** Elementor and similar builders store
  their design in plugin data that the REST content field can't reach, so an
  edit there would be silently invisible. Those pages are detected and disabled
  in the UI, and the backend refuses them.
- **Published pages can't be edited in place.** Editing a live page would change
  production instantly, with no preview step. Only drafts are editable until a
  staging-page flow exists.
- **Draft previews need a WordPress login.** WordPress treats draft previews as
  private, so staff must sign in to `wp-admin` once in their browser.
- **AI image generation is out of scope** — staff upload their own images.
- **Spend caps are per calendar month and reset on the 1st.** A user who exhausts
  their budget can still work using 手动文本 / 上传图片 (neither calls the AI).
