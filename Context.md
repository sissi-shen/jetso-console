# Project Context: Jetso Ops Console

> **Handoff note (2026-07-22):** Build-order steps 1–3 of the Module 2 redesign
> are now IMPLEMENTED and locally verified: OpenRouter multi-model, in-place
> PAGE editing with revert-on-reject, manual text, and manual image upload.
> **The only blocker to going end-to-end is the §3.3 Supabase migration — run
> the new block in `db/schema.sql` in the Supabase SQL editor.** See §7 for
> what was verified and §8 for what remains.

## 1. Business Background

We match e-commerce clients with influencers (KOL/affiliate marketing). One client — Reach Building, an e-commerce/cross-border trade business (sites `rubflo.com`, GA4 property also on `reachbuilding.com`) — has two related problems solved on **one internal platform** ("Jetso Console"):

1. **Ad attribution** — Google Ads counts a "conversion" on WhatsApp-button click, not on a real sales lead. Most clicks are noise. We feed human-confirmed leads back into GA4 so Google's algorithm optimizes toward real buyers.
2. **Content publish** — non-technical staff describe a website change (or paste their own text / upload an image), optionally let AI draft/place it, preview it, and one-click publish to WordPress.

One platform across daily-use functions raises switching cost and supports a recurring fee, not a one-off.

## 2. Module 1 — Ad-to-CRM Attribution Tracker

**STATUS: SHIPPED & VERIFIED end-to-end** (GA4 `valid_lead` event received, marked as a Key Event in GA4).

Flow: Google Ads (UTM) → landing page (领动/Leadong, closed platform, only a `<head>` script tag) → GA4 assigns `client_id` → WhatsApp/email deep-link auto-tagged `[REF:client_id] [SRC:utm_source|medium|campaign]` → sales rep judges the message → rep confirms via our tool → backend fires a GA4 Measurement Protocol `valid_lead` event.

Built and working:
- **Landing snippet** (`Leadong/tracking.js`): reads UTMs + GA4 `client_id`; rewrites WhatsApp `wa.me` `text=` AND `mailto:` links with REF/SRC tags on click; fires `whatsapp_click`/`email_click` GA4 events. English greeting copy. Test harness: `Leadong/test_landing.html`.
- **Confirm tool** (`confirm.html`): rep pastes the message, regex extracts REF/SRC, POSTs to `/api/confirm`. Still standalone — NOT yet ported into the console; Leads view there is display-only (open loose end).
- **Backend** (`api/index.py`): `/api/confirm` → GA4 Measurement Protocol + Supabase `leads`; `/api/leads`; `/api/health`.

Deferred by design: Xiaoman CRM sync (no API), AI lead qualification, multi-tenant self-serve.

## 3. Module 2 — WordPress Content Publish

**STATUS: ACTIVE BUILD (redesign in progress)**

Client is moving their main site from Leadong to **WordPress** (`rubflo.com`); we have an Application Password on an Editor account. All pages are currently **drafts** under construction (Home is published; Products/Solutions/Applications/Guides/Projects/About Us/Contact Us are drafts).

### 3.1 Flow (current direction)

Core purpose: let non-technical staff put a change onto a real page without figuring out layout — either AI places it, or they get exact HTML/CSS to drop in themselves. Content and placement are **two separate concerns**:

- **Content** (pick one source): AI text (describe it, AI writes copy) / Manual text (paste exact text, no AI) / Manual image (upload local image → WP Media Library)
- **Placement** (always AI-assisted): AI reads the target page's current content + the new content, decides WHERE it goes, and emits the exact HTML/CSS with the change placed
- Written as a **draft edit to the actual target page** on WordPress (safe because the page is already a draft — see §3.4)
- Staff preview via WP's native preview link (needs WP browser login — §3.4). Also returned: the standalone HTML/CSS snippet, so staff can copy-paste it manually if they prefer over auto-placement.
- Approve → flip the page draft → publish. Reject → revert to prior content.

Same "humans decide" principle: AI drafts/places, a human approves, nothing goes live without a recorded approval. Draft and publish are always separate calls.

**Achievability note:** for the client's current simple draft pages this is very achievable via "feed AI the whole page + the change → get the full updated page back, placement included." Risk = model altering unrelated parts; mitigate with strict prompting + human preview + revert-on-reject. Gets risky only on complex/page-builder pages (§3.2).

### 3.2 Scope boundary

**IN scope:** AI-generated HTML/CSS and layout placement injected into standard WordPress (Gutenberg/HTML) content pages — this is the whole point of the feature now. Also: post/page content edits (`wp/v2/pages`, `wp/v2/posts`), manual image uploads (`wp/v2/media`).

**OUT of scope:** page-builder (Elementor/Divi/etc.) structural edits, theme/PHP template edits — anything not reachable via the standard content REST surface. Pages built with a page builder must be excluded per-page, not edited via REST. **AI image generation is explicitly deferred** (token-heavy, poor fit for web pages).

### 3.3 Database schema (Supabase/Postgres)

Current live schema is in `db/schema.sql` (already run on Supabase): `tenants`, `leads`+`tenant_id`, `content_requests`, `tenant_wp_credentials`; RLS enabled on all four; Reach Building tenant seeded with fixed UUID `00000000-0000-0000-0000-000000000001`.

**Schema changes for the new direction — now in `db/schema.sql` ("Module 2 redesign" block), NOT yet run on Supabase (§8 step 1):**
```sql
-- content_requests: reflect content source + model + in-place PAGE target + revert
alter table content_requests add column if not exists content_mode text default 'ai_text';
       -- 'ai_text' | 'manual_text' | 'manual_image'
alter table content_requests add column if not exists model_used text;        -- OpenRouter model id
alter table content_requests add column if not exists wp_page_id integer;      -- the PAGE being edited (not a new post)
alter table content_requests add column if not exists prior_content text;      -- for revert-on-reject
alter table content_requests add column if not exists generated_snippet text;  -- copy-paste HTML/CSS
alter table content_requests add column if not exists media_id integer;        -- WP media id for manual_image
alter table content_requests add column if not exists media_url text;
-- change_type stays but is now less central than content_mode

-- Per-user monthly AI spend cap (see §3.6)
create table if not exists ai_usage (
    id          bigint generated by default as identity primary key,
    tenant_id   uuid not null references tenants(id),
    user_id     text not null,          -- who spent it
    month       text not null,          -- 'YYYY-MM'
    model       text,
    cost_usd    numeric not null default 0,
    created_at  timestamptz not null default now()
);
create index if not exists ai_usage_cap_idx on ai_usage (tenant_id, user_id, month);
```

### 3.4 WordPress integration details

- **Auth:** WordPress Application Passwords on a dedicated Editor account (`Rubflo-Sissi`). API/Basic-auth only.
- **In-place PAGE editing:** the draft flow updates the target page's content (`POST /wp-json/wp/v2/pages/<id>`, `status` stays `draft`) instead of creating a standalone post. Save the page's prior content into `content_requests.prior_content` first, so reject restores it. Safe because the pages are drafts, not live. (Once a page is LIVE, in-place editing is unsafe — will need a duplicate/staging-page approach or a preview plugin. Future problem.)
- **Manual image upload:** `POST /wp-json/wp/v2/media` (binary body + `Content-Disposition: attachment; filename=...`), returns `{id, source_url}`; insert into the page as an image block.
- **Preview needs a WP browser session:** draft previews are private. The Application Password does not authenticate browser page views — staff must log into `wp-admin` once in their browser (with "Remember Me", ~14-day cookie), then preview links work. Preview URL format (default permalinks): `https://rubflo.com/?page_id=<id>&preview=true`. Native preview kept deliberately (production-accurate) — don't build a custom renderer.
- **Publish:** `POST /wp-json/wp/v2/pages/<id>`, `status: "publish"`.
- **Additional CSS via REST:** still unconfirmed — but layout CSS is now injected inline/as page content rather than site-wide Additional CSS, so this is less of a blocker than before.

### 3.5 Design reference

Live UI is the Vite React app in `console/` (built from the original `jetso-console.jsx` prototype, since deleted as redundant). Tokens: ink-navy accent (`#21324C` day / `#8FADD9` night), day/night toggle, monospace rotated "stamp" status tags driven by the real `content_requests` state machine (`drafting|pending_review|published|rejected`). All data flows through `console/src/api.js`, which has a mock impl and a real impl behind one contract (`VITE_USE_MOCK` toggle). Error states surface a "后端未连接" banner instead of an infinite spinner.

### 3.6 LLM access via OpenRouter (replaces DeepSeek-only)

- **Gateway:** OpenRouter, OpenAI-compatible. Text: `POST https://openrouter.ai/api/v1/chat/completions`, `model` field selects the provider (`anthropic/claude-sonnet-4`, `openai/gpt-4o`, `google/gemini-2.5-pro`, `deepseek/deepseek-chat`, `moonshotai/kimi-k3`, …). One key, one bill. Key is in `.env` as `OPENROUTER_API_KEY`.
- **Model menu:** curated set ranging cheap→expensive. **Default = Kimi K3** (`moonshotai/kimi-k3` — confirm exact id on openrouter.ai/models). Model picker is user-visible; users can switch models.
- **Per-user monthly spend cap** (e.g. $15/user/month): track spend in `ai_usage`. When a user hits the cap: (a) fall back to no-AI manual submission (paste text / upload image + copy-paste the snippet), or (b) use the cheapest/free model. Enforce the cap in the backend before calling OpenRouter.
- **Image generation:** deferred (§3.2). If ever added, it's a separate endpoint: `POST https://openrouter.ai/api/v1/images` (`{model, prompt, n, resolution}` → base64), not chat completions.

## 4. Platform Architecture (shared)

- One Vercel + Supabase deployment; Supabase Auth login. Roles: `submitter` / `approver` (Module 2), sales rep (Module 1); one person can hold multiple.
- `tenant_id` on every table — cheap now, expensive later. RLS on; backend uses `service_role` (bypasses RLS).
- Per-tenant WP creds belong in `tenant_wp_credentials`; currently in env vars for the single-client MVP (fine for now).
- AI via OpenRouter (§3.6) with per-user spend caps. Keep calls fast to stay under Vercel's function limit (10s Hobby / 60s Pro) — prefer fast models for copy; heavier coding models only for the HTML/CSS layout step.

## 5. Design Principles

- Ship fast over architectural purity — prove the pipeline, iterate.
- No manual edits on client infra beyond API surface (script tag for M1; Application-Password REST for M2).
- Human-in-the-loop is a feature: rep judgment (M1), approval-before-publish (M2).
- Content and placement are separate concerns (§3.1). AI is optional for content, but owns placement.
- Keep REF/SRC tagging simple/regex-parseable (M1, shipped — don't change).

## 6. Open Questions / TBD

- ~~Confirm exact OpenRouter model id for "Kimi K3"~~ CONFIRMED 2026-07-22: `moonshotai/kimi-k3` exists. **Pricing surprise: it's $3/$15 per 1M tokens — same tier as Claude Sonnet, NOT a budget model.** Curated menu now lives in `MODEL_MENU` in `api/index.py` (DeepSeek V3.1 / Gemini 2.5 Flash / Kimi K2.5 / Kimi K3 / Claude Sonnet 5); revisit whether the default should stay Kimi K3 given its price.
- ~~Exact per-user cap value and the enforcement UX~~ DONE 2026-07-24: caps are
  `AI_MONTHLY_CAP_USER` ($10) and `AI_MONTHLY_CAP_TENANT` ($25), enforced before
  every AI call; exceeding either returns 429 with `cap_reached` and points the
  user at the non-AI modes. Real charged cost comes from OpenRouter's own
  `usage.cost` field (pass `usage:{include:true}`) — no token-price estimation —
  and is written to `ai_usage`. Measured cost/draft on a 2.4k-char page:
  DeepSeek V4 Flash $0.0004, GPT-5.6 Luna $0.011, Claude Sonnet 5 $0.023 (61×).
  Also added `AI_MAX_PAGE_CHARS` (60k).
  **Cost is invisible to the client by design** (flat subscription — showing
  per-request token cost would undercut the pricing): `typical_cost` is stripped
  from the `/api/content/models` response, there is no usage endpoint, and the
  cap message says only 「本月 AI 生成次数已达上限」 with no figures. Real numbers
  go to the server log + `ai_usage`. A budget bar was built and then deliberately
  removed — don't re-add it.
  **Still open: set a hard credit limit on the OpenRouter key itself** — it is
  currently `null` (unlimited); the smoke test warns until it's set.
- How is `user_id` established? (Supabase Auth not wired yet — currently submissions are hardcoded "你"/"e2e-test".)
- Per-page: is any target page built with a page builder? Those must be excluded (§3.2). (Client pages seen 2026-07-22 are plain content pages; most drafts are still EMPTY — only About Us has content.)
- ~~Whole-page-rewrite placement: confirm the AI preserves untouched content~~ First real test PASSED (About Us, Kimi K3, manual_text): change was purely additive, original content byte-preserved. Keep spot-checking on richer pages.
- Additional CSS via REST — only needed if we do site-wide styles vs inline page CSS.
- Concurrent edits to the same page: two pending requests on one page share a revert point — second reject restores the FIRST request's prior_content, clobbering the other edit. Fine single-user; needs a per-page lock or chained revert later.

## 7. Current Progress (as of 2026-07-22)

**Build-order steps 1–3 implemented this session** (OpenRouter + in-place PAGE
editing + manual text + manual image), replacing the old DeepSeek/standalone-post
flow entirely:

- **Backend** (`api/index.py`):
  - `_openrouter_chat()` — OpenRouter gateway; `MODEL_MENU` is the curated,
    enforced allowlist (requests naming other models get 400). Default
    `moonshotai/kimi-k3` via `OPENROUTER_DEFAULT_MODEL` env. DeepSeek code removed.
  - `_run_placement()` — the placement engine (§3.1): full page + change → strict
    JSON `{updated_page, snippet}`; fence-tolerant parser; verbatim rule for
    manual text; `<figure class="wp-block-image">` rule for images.
  - `/api/content/draft` — reads the page RAW (`context=edit`), saves
    `prior_content`, AI places the change, updates the PAGE in place (status
    untouched = stays draft). **Guards:** 409 on `publish` pages (live pages
    unsupported, §3.4); if the DB insert fails the WP page is auto-reverted.
  - `/api/content/decide` — approve → publish the page; reject → restore
    `prior_content` (page stays draft). 409 if already decided.
  - New: `GET /api/content/models` (menu for the picker), `POST
    /api/content/upload-media` (multipart → `wp/v2/media` → `{media_id, media_url}`).
  - `/api/content/pages` now returns `status` so the UI can disable live pages.
- **Frontend** (`console/`): PublishView has content-mode tabs (AI 文案 / 手动文本 /
  上传图片), a model picker (fed from `/api/content/models`), per-mode inputs +
  validation, live pages disabled in the dropdown, and a copyable
  `generated_snippet` block in the detail pane. Mock impl updated to the same
  contract. Builds clean.
- **Verified locally (2026-07-22):** OpenRouter reachable (`kimi-k3` responds);
  WP raw page read OK; placement dry-run on the real About Us draft preserved
  all original content and inserted the manual text verbatim; full draft
  endpoint exercised via Flask test client — WP page updated then
  **auto-reverted byte-identical** when the DB insert failed (migration not yet
  applied); published-page guard and model allowlist both return correct errors.
- **NOT yet done:** Supabase migration (blocker, see §8); `ai_usage` writes +
  spend cap (blocked on `user_id`/Auth); approve/reject re-verify after
  migration; Vercel env still has DeepSeek vars (harmless, can be removed) and
  needs `OPENROUTER_*` added on deploy.
- **Client site observation:** most WP draft pages are EMPTY (only About Us has
  content, len ~2.3k; Home is the only published page). Placement testing on
  richer pages pending until the client fills them in.

## 8. Next Steps / Build Order

1. **Run the §3.3 migration** [BLOCKER, 1 minute]: paste the "Module 2 redesign"
   block of `db/schema.sql` into the Supabase SQL editor (whole file is
   idempotent — rerunning everything is also fine). Everything below §7's
   "verified" list is coded and waiting on this.
2. **End-to-end test with real DB**: draft (manual_text on About Us) →
   pending_review row with `prior_content`/`generated_snippet` → reject →
   confirm WP page restored → repeat → approve → confirm page publishes; then
   flip it back to draft and clean up test rows.
3. **Step 4 of the original order — harden the placement engine**: test ai_text
   mode on real pages as the client fills them in; iterate on the placement
   prompt (hybrid: AI proposes, human previews, re-describe if wrong).
4. **Cross-cutting**: wire Supabase Auth → real `user_id` → write `ai_usage`
   rows per call and enforce the monthly cap pre-call (fallback: manual mode or
   cheapest model). Decide whether default stays Kimi K3 given its Sonnet-tier
   pricing (§6).
5. **Deploy**: add `OPENROUTER_API_KEY` / `OPENROUTER_DEFAULT_MODEL` /
   **`AUTH_REQUIRED=true`** to Vercel env; remove dead `DEEPSEEK_*` /
   `WP_DRAFT_POST_TYPE` vars; delete `confirm.html`; tighten `FRONTEND_ORIGINS`.

**Invite flow (added 2026-07-26):** real invitation onboarding now works.
Supabase invite/recovery emails land on the console with a token in the URL
fragment; the app shows a set-password screen (`SetPasswordView`), posts to
`POST /api/auth/set-password` (GoTrue `PUT /user` with the invite token — no
admin key in the browser), then adopts the token pair as a session so the user
lands logged-in. Handles `type=invite|recovery|signup` and the
`#error_description` expired-link case (返回登录 fallback). E2E-verified against
real Supabase: admin `generate_link` → verify redirect → set-password → login
with new password → test user deleted. Prereq: Site URL fixed to the Vercel
domain (was localhost:3000 — the original bug). Invited-but-stuck users must be
deleted and re-invited.

**Auth (added 2026-07-24):** invite-only Supabase Auth scaffolded end-to-end.
Backend: `/api/auth/login` + `/api/auth/refresh` (GoTrue REST directly — NOT via
supabase-py, whose sign-in would swap the service_role client onto the user JWT
and silently hit RLS); `@require_auth` on all 8 data endpoints (only /api/health
and /api/auth/* open); gate is env-toggled `AUTH_REQUIRED` (default false for
local dev, MUST be true on Vercel); authenticated email overrides submitted_by.
Frontend: login screen, tokens in localStorage, silent refresh-and-retry on 401,
logout in sidebar. Verified with AUTH_REQUIRED=true: all endpoints 401 without
token. Supabase dashboard prerequisites (user must do): disable public signups
(Authentication → Sign In / Providers → turn off "Allow new users to sign up"),
then Authentication → Users → Add user (auto-confirm) for each staff account.

~~Loose end: port `confirm.html` into the console~~ DONE 2026-07-24: Module 1's
confirm flow now lives in the console's 询盘确认 view (paste → live regex parse
of REF/SRC → POST `/api/confirm` → GA4 + Supabase → table refresh). Verified
end-to-end (GA4 204, test row cleaned up). `confirm.html` is now redundant —
delete it at deploy time (its hardcoded localhost URL never worked deployed anyway).