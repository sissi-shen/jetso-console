# Makes all annotations lazy, so `X | None` and `tuple[...]` don't need to be
# evaluated at import time. Vercel's Python runtime version isn't pinned by this
# project, and without this the module would fail to import on anything < 3.10.
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import requests

# Load .env when running locally — no-op on Vercel (no .env file present there)
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / '.env')
except ImportError:
    pass
from functools import wraps

from flask import Flask, request, jsonify, g
from flask_cors import CORS
from supabase import create_client, Client

# ─── CONFIG (all from environment variables — set these in Vercel Project Settings) ──
# GA4 Admin → Data Streams → [your web stream] → Measurement Protocol API secrets
GA4_MEASUREMENT_ID = os.environ.get('GA4_MEASUREMENT_ID', '')
GA4_API_SECRET     = os.environ.get('GA4_API_SECRET', '')

# Supabase → Project Settings → API
SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', '')  # use the "service_role" key (server-side only)

# Comma-separated list of allowed origins for CORS, e.g. "https://jetso-tracker.vercel.app"
# Defaults to "*" for convenience during MVP — tighten this once you have a fixed frontend domain.
FRONTEND_ORIGINS = os.environ.get('FRONTEND_ORIGINS', '*')

# Invite-only auth (Supabase Auth / GoTrue). 'false' keeps local dev friction-free;
# MUST be 'true' in Vercel env before the console goes public — every data
# endpoint is then gated behind a Supabase-issued JWT.
AUTH_REQUIRED = os.environ.get('AUTH_REQUIRED', 'false').lower() == 'true'

GA4_ENDPOINT = (
    'https://www.google-analytics.com/mp/collect'
    f'?measurement_id={GA4_MEASUREMENT_ID}&api_secret={GA4_API_SECRET}'
)

# ─── Module 2: WordPress + OpenRouter ────────────────────────────────────────
# Single-tenant for now. Per Context §4 these WP creds eventually live in the
# tenant_wp_credentials table; env vars are the pragmatic MVP choice while
# there's one client. TENANT_ID ties Module-2 rows to the seeded tenant.
WP_BASE_URL      = os.environ.get('WP_BASE_URL', '').rstrip('/')
WP_USERNAME      = os.environ.get('WP_USERNAME', '')
WP_APP_PASSWORD  = os.environ.get('WP_APP_PASSWORD', '')
TENANT_ID        = os.environ.get('TENANT_ID', '')

# LLM gateway (Context §3.6): OpenRouter, OpenAI-compatible. One key, one bill;
# the `model` field selects the provider. Model ids verified 2026-07-22.
OPENROUTER_API_KEY      = os.environ.get('OPENROUTER_API_KEY', '')
OPENROUTER_BASE_URL     = os.environ.get('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1')
OPENROUTER_DEFAULT_MODEL = os.environ.get('OPENROUTER_DEFAULT_MODEL', 'deepseek/deepseek-v4-flash')

# Curated, user-visible model menu — exactly three tiers (cheap → expensive,
# USD per 1M in/out, verified on openrouter.ai 2026-07-23). Requests naming a
# model outside this menu are rejected — the menu is the spend-control surface,
# not just a UI nicety. Default = the cheap tier, users escalate deliberately.
# typical_cost = measured cost of one real draft on a ~2.4k-character page
# (2026-07-24). Shown in the UI so staff see what a model choice actually costs.
MODEL_MENU = [
    {'id': 'deepseek/deepseek-v4-flash', 'label': 'DeepSeek V4 Flash · 快速便宜', 'tier': 'cheap', 'typical_cost': 0.0004},
    {'id': 'openai/gpt-5.6-luna',        'label': 'GPT-5.6 Luna · 均衡',          'tier': 'mid',   'typical_cost': 0.011},
    {'id': 'anthropic/claude-sonnet-5',  'label': 'Claude Sonnet 5 · 最强排版',    'tier': 'high',  'typical_cost': 0.023},
]

# ─── AI spend caps (USD, per calendar month) ─────────────────────────────────
# Measured reality: a normal draft costs $0.0004 (cheap) to $0.023 (Sonnet 5),
# so realistic staff usage lands under $1/month. These caps are deliberately far
# above normal use — they exist to bound runaway loops, abuse, and enthusiastic
# testing, not to ration ordinary work.
# Tenant cap sits BELOW the OpenRouter key's own credit limit ($10) so our
# friendly 429 always fires before OpenRouter returns a raw payment error.
# Per-user cap must stay below the tenant cap, or it can never trigger — it
# exists so one person can't burn the whole team's budget alone.
AI_MONTHLY_CAP_USER   = float(os.environ.get('AI_MONTHLY_CAP_USER', '5'))
AI_MONTHLY_CAP_TENANT = float(os.environ.get('AI_MONTHLY_CAP_TENANT', '8'))
# One page this large would cost ~$0.25 on the priciest model; refuse instead.
AI_MAX_PAGE_CHARS     = int(os.environ.get('AI_MAX_PAGE_CHARS', '60000'))


class SpendCapReached(Exception):
    """Monthly AI budget exhausted — surfaced to the user as a 429."""
# ──────────────────────────────────────────────────────────────────────────────

app = Flask(__name__)
CORS(app, origins=FRONTEND_ORIGINS.split(',') if FRONTEND_ORIGINS != '*' else '*')

# Supabase client is created lazily so a missing env var doesn't crash cold start /health checks
_supabase_client: Client | None = None


def get_supabase() -> Client:
    global _supabase_client
    if _supabase_client is None:
        if not SUPABASE_URL or not SUPABASE_KEY:
            raise RuntimeError('SUPABASE_URL / SUPABASE_KEY are not set')
        _supabase_client = create_client(SUPABASE_URL, SUPABASE_KEY)
    return _supabase_client


# ─── AUTH (Supabase GoTrue via REST) ─────────────────────────────────────────
# Deliberately NOT via the supabase-py client: calling sign_in on that client
# would replace its service_role credentials with the user's JWT, and every
# later table query would silently run under RLS (no policies → zero rows).
# Plain REST keeps auth stateless and the DB client untouched.

def _gotrue(path: str, payload: dict | None = None, jwt: str | None = None, method: str = 'POST'):
    headers = {'apikey': SUPABASE_KEY, 'Content-Type': 'application/json'}
    if jwt:
        headers['Authorization'] = f'Bearer {jwt}'
    r = requests.request(method, f'{SUPABASE_URL}/auth/v1/{path}',
                         json=payload, headers=headers, timeout=10)
    return r


def require_auth(fn):
    """Gate an endpoint behind a Supabase JWT when AUTH_REQUIRED is on."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        g.user_email = None
        if not AUTH_REQUIRED:
            return fn(*args, **kwargs)
        auth_header = request.headers.get('Authorization', '')
        token = auth_header.removeprefix('Bearer ').strip()
        if not token:
            return jsonify({'ok': False, 'error': 'auth required'}), 401
        try:
            r = _gotrue('user', jwt=token, method='GET')
            if not r.ok:
                return jsonify({'ok': False, 'error': 'invalid or expired token'}), 401
            g.user_email = r.json().get('email')
        except requests.RequestException:
            return jsonify({'ok': False, 'error': 'auth service unreachable'}), 503
        return fn(*args, **kwargs)
    return wrapper


@app.post('/api/auth/login')
def auth_login():
    """Email+password sign-in. Accounts are created invite-only in the
    Supabase dashboard — there is deliberately no signup endpoint."""
    data = request.get_json(silent=True) or {}
    email, password = (data.get('email') or '').strip(), data.get('password') or ''
    if not email or not password:
        return jsonify({'ok': False, 'error': 'email and password required'}), 400
    try:
        r = _gotrue('token?grant_type=password', {'email': email, 'password': password})
    except requests.RequestException as e:
        return jsonify({'ok': False, 'error': f'auth service unreachable: {e}'}), 503
    if not r.ok:
        return jsonify({'ok': False, 'error': '邮箱或密码不正确'}), 401
    body = r.json()
    return jsonify({'ok': True,
                    'access_token': body.get('access_token'),
                    'refresh_token': body.get('refresh_token'),
                    'email': (body.get('user') or {}).get('email', email)})


@app.post('/api/auth/refresh')
def auth_refresh():
    data = request.get_json(silent=True) or {}
    refresh_token = data.get('refresh_token') or ''
    if not refresh_token:
        return jsonify({'ok': False, 'error': 'refresh_token required'}), 400
    try:
        r = _gotrue('token?grant_type=refresh_token', {'refresh_token': refresh_token})
    except requests.RequestException as e:
        return jsonify({'ok': False, 'error': f'auth service unreachable: {e}'}), 503
    if not r.ok:
        return jsonify({'ok': False, 'error': 'session expired'}), 401
    body = r.json()
    return jsonify({'ok': True,
                    'access_token': body.get('access_token'),
                    'refresh_token': body.get('refresh_token'),
                    'email': (body.get('user') or {}).get('email', '')})


# ─── ROUTES ───────────────────────────────────────────────────────────────────
@app.post('/api/confirm')
@require_auth
def confirm_lead():
    """
    Called by the confirm.html frontend when a sales rep marks a lead as valid.

    Expected JSON body:
    {
        "client_id":    "1234567890.1698765432",
        "utm_source":   "google",
        "utm_medium":   "cpc",
        "utm_campaign": "summer_sale",
        "utm_content":  "",          (optional)
        "raw_message":  "...",       (full WhatsApp message text pasted by rep)
        "notes":        "..."        (rep's free-text note — future AI training data)
    }
    """
    data = request.get_json(silent=True) or {}

    client_id    = data.get('client_id', '').strip()
    utm_source   = data.get('utm_source', '').strip()
    utm_medium   = data.get('utm_medium', '').strip()
    utm_campaign = data.get('utm_campaign', '').strip()
    utm_content  = data.get('utm_content', '').strip()
    raw_message  = data.get('raw_message', '').strip()
    notes        = data.get('notes', '').strip()

    if not client_id:
        return jsonify({'ok': False, 'error': 'client_id is required'}), 400

    if not GA4_MEASUREMENT_ID or not GA4_API_SECRET:
        return jsonify({'ok': False, 'error': 'GA4_MEASUREMENT_ID / GA4_API_SECRET not configured on server'}), 500

    # ── 1. Fire valid_lead event to GA4 via Measurement Protocol ──────────────
    ga4_payload = {
        'client_id': client_id,
        'events': [{
            'name': 'valid_lead',
            'params': {
                'utm_source':   utm_source,
                'utm_medium':   utm_medium,
                'utm_campaign': utm_campaign,
                'utm_content':  utm_content,
            },
        }],
    }

    try:
        ga4_resp = requests.post(GA4_ENDPOINT, json=ga4_payload, timeout=5)
        ga4_status = ga4_resp.status_code
    except requests.RequestException as e:
        ga4_status = None
        app.logger.error('GA4 Measurement Protocol call failed: %s', e)

    # ── 2. Log to Supabase (Postgres) ──────────────────────────────────────────
    confirmed_at = datetime.now(timezone.utc).isoformat()
    db_error = None
    try:
        get_supabase().table('leads').insert({
            'client_id':    client_id,
            'utm_source':   utm_source,
            'utm_medium':   utm_medium,
            'utm_campaign': utm_campaign,
            'utm_content':  utm_content,
            'raw_message':  raw_message,
            'notes':        notes,
            'ga4_status':   ga4_status,
            'confirmed_at': confirmed_at,
        }).execute()
    except Exception as e:
        db_error = str(e)
        app.logger.error('Supabase insert failed: %s', e)

    return jsonify({
        'ok':         True,
        'client_id':  client_id,
        'ga4_status': ga4_status,  # 204 = GA4 accepted, 400 = bad payload
        'db_error':   db_error,    # None if the row was saved successfully
    })


@app.get('/api/leads')
@require_auth
def list_leads():
    """Quick diagnostic endpoint — view the 100 most recent confirmed leads."""
    try:
        resp = (
            get_supabase()
            .table('leads')
            .select('*')
            .order('confirmed_at', desc=True)
            .limit(100)
            .execute()
        )
        return jsonify(resp.data)
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.get('/api/health')
def health():
    # auth_required tells the console whether to show the login screen.
    return jsonify({'ok': True, 'auth_required': AUTH_REQUIRED})


# ═══ MODULE 2: WordPress content publish ═════════════════════════════════════

import re as _re

def _wp_auth():
    # WordPress Application Passwords authenticate via HTTP Basic. Spaces in the
    # displayed password are cosmetic — WP strips them, but we do too to be safe.
    return (WP_USERNAME, WP_APP_PASSWORD.replace(' ', ''))

def _strip_html(html: str) -> str:
    return _re.sub(r'<[^>]+>', '', html or '').strip()

def _wp_configured() -> bool:
    return bool(WP_BASE_URL and WP_USERNAME and WP_APP_PASSWORD)


def _detect_builder(rendered_html: str) -> str | None:
    """
    Detect page-builder pages from their RENDERED content (Context §3.2).
    Builder pages (Elementor/Divi…) keep their real design in plugin meta —
    post_content is empty or a stale flattened copy — so REST content edits
    are invisible at best and corrupting at worst. Confirmed on this site:
    Products & Applications have empty raw content but Elementor-rendered HTML.
    """
    low = (rendered_html or '').lower()
    if 'elementor' in low:
        return 'elementor'
    if 'et_builder' in low or 'et-boc' in low:
        return 'divi'
    return None


import json as _json


def _openrouter_chat(model: str, system: str, user: str) -> tuple[str, float]:
    """
    One OpenRouter chat completion. Returns (content, cost_usd).

    `usage: {include: True}` makes OpenRouter report the REAL charged cost for
    the call, so spend tracking uses actual billing rather than a token-price
    estimate that would drift whenever providers change pricing.
    """
    resp = requests.post(
        f'{OPENROUTER_BASE_URL}/chat/completions',
        headers={'Authorization': f'Bearer {OPENROUTER_API_KEY}',
                 'Content-Type': 'application/json'},
        json={
            'model': model,
            'messages': [{'role': 'system', 'content': system},
                         {'role': 'user', 'content': user}],
            'temperature': 0.3,
            'stream': False,
            'usage': {'include': True},
        },
        timeout=60,
    )
    resp.raise_for_status()
    body = resp.json()
    if 'choices' not in body:
        # OpenRouter reports provider errors inside a 200 body sometimes
        raise requests.RequestException(f'OpenRouter error: {body.get("error", body)}')
    cost = float((body.get('usage') or {}).get('cost') or 0.0)
    return body['choices'][0]['message']['content'].strip(), cost


# ─── AI spend control (Context §3.6) ─────────────────────────────────────────
# Three independent layers, because any single one can fail:
#   1. A hard credit limit on the OpenRouter key itself (set in their dashboard)
#      — the only ceiling a bug in THIS file cannot bypass.
#   2. The monthly caps below, enforced before every call and recorded after.
#   3. MAX_PAGE_CHARS, so one enormous page can't produce one enormous bill.

def _month_key() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m')


def _spend_this_month() -> tuple[float, dict[str, float]]:
    """(tenant total, per-user totals) for the current month, in USD."""
    rows = (get_supabase().table('ai_usage')
            .select('user_id,cost_usd')
            .eq('tenant_id', TENANT_ID).eq('month', _month_key())
            .execute().data or [])
    per_user: dict[str, float] = {}
    for r in rows:
        per_user[r['user_id']] = per_user.get(r['user_id'], 0.0) + float(r['cost_usd'] or 0)
    return sum(per_user.values()), per_user


def _check_spend_cap(user_id: str) -> None:
    """Raise SpendCapReached if this user or the tenant is out of budget."""
    try:
        tenant_total, per_user = _spend_this_month()
    except Exception as e:
        # Never let a reporting failure block work; the OpenRouter key limit
        # is still a hard backstop.
        app.logger.error('spend cap lookup failed (allowing call): %s', e)
        return
    # User-facing text never mentions dollars or usage ratios — the client is on
    # a flat subscription and must not be able to infer our token costs. The
    # real numbers go to the server log instead.
    limit_msg = ('本月 AI 生成次数已达上限。你仍可使用「手动文本」或「上传图片」模式'
                 '（不经过 AI），或联系管理员。')
    if tenant_total >= AI_MONTHLY_CAP_TENANT:
        app.logger.warning('tenant cap hit: $%.4f / $%.2f', tenant_total, AI_MONTHLY_CAP_TENANT)
        raise SpendCapReached(limit_msg)
    user_total = per_user.get(user_id, 0.0)
    if user_total >= AI_MONTHLY_CAP_USER:
        app.logger.warning('user cap hit for %s: $%.4f / $%.2f',
                           user_id, user_total, AI_MONTHLY_CAP_USER)
        raise SpendCapReached(limit_msg)


def _record_spend(user_id: str, model: str, cost_usd: float) -> None:
    """Log actual spend. Best-effort: the money is already spent either way."""
    try:
        get_supabase().table('ai_usage').insert({
            'tenant_id': TENANT_ID, 'user_id': user_id, 'month': _month_key(),
            'model': model, 'cost_usd': cost_usd,
        }).execute()
    except Exception as e:
        app.logger.error('ai_usage insert failed (cost %.6f not recorded): %s', cost_usd, e)


def _parse_placement_json(raw: str) -> dict:
    """Parse the model's {"updated_page", "snippet"} reply, tolerating fences."""
    text = raw.strip()
    if text.startswith('```'):
        text = _re.sub(r'^```[a-zA-Z]*\n?', '', text)
        text = _re.sub(r'\n?```$', '', text).strip()
    # Fall back to the outermost {...} if the model chatted around the JSON
    if not text.startswith('{'):
        m = _re.search(r'\{.*\}', text, _re.DOTALL)
        if not m:
            raise ValueError('model reply contained no JSON object')
        text = m.group(0)
    # strict=False allows literal newlines/tabs inside JSON strings. Models
    # routinely emit raw newlines inside the HTML they return instead of \n,
    # which strict JSON rejects — that failure mode is common enough that
    # rejecting it would make drafting fail at random.
    parsed = _json.loads(text, strict=False)
    if not (parsed.get('updated_page') or '').strip():
        raise ValueError('model reply missing updated_page')
    return parsed


# Placement engine (Context §3.1): content and placement are separate concerns.
# AI is optional for CONTENT, but always owns PLACEMENT — it reads the whole
# page, decides where the change goes, and returns the full updated page plus a
# standalone snippet staff can paste manually instead.
_PLACEMENT_SYSTEM = (
    'You edit WordPress page content (Gutenberg block HTML) for a cross-border '
    'B2B e-commerce site. You will receive the FULL current page content and one '
    'requested change. Decide the best place for the change and apply it.\n'
    'Rules:\n'
    '1. Preserve ALL existing content and block markup exactly — change only '
    'what the request requires. Never drop, reorder, or rewrite unrelated parts.\n'
    '2. Keep valid Gutenberg block comments (<!-- wp:... -->) if present; '
    'otherwise use clean semantic HTML. Inline styles are allowed for layout.\n'
    '3. Reply with ONLY a JSON object, no markdown fences, in this shape:\n'
    '{"updated_page": "<the FULL page content with the change applied>", '
    '"snippet": "<just the new/changed HTML/CSS block, standalone and '
    'copy-pasteable>"}'
)


def _run_placement(model: str, page_title: str, current_content: str,
                   content_mode: str, summary: str, manual_text: str,
                   media_url: str = '') -> dict:
    if content_mode == 'manual_text':
        change_desc = (
            'Insert the following EXACT text, verbatim — do not rewrite, '
            'translate, or embellish it (you may wrap it in appropriate HTML):\n'
            f'{manual_text}\n\n'
            + (f'Placement/context hint from staff: {summary}' if summary else '')
        )
    elif content_mode == 'manual_image':
        change_desc = (
            f'Insert an image block for this already-uploaded image: {media_url}\n'
            'Use a standard <figure class="wp-block-image"><img .../></figure> '
            'block with sensible sizing.\n'
            + (f'Placement/context hint from staff: {summary}' if summary else '')
        )
    else:  # ai_text — AI writes the copy AND places it
        change_desc = f'Requested change (write the copy yourself, then place it): {summary}'

    user = (f'Page title: {page_title}\n\n'
            f'FULL current page content:\n{current_content or "(empty page)"}\n\n'
            f'--- REQUESTED CHANGE ---\n{change_desc}')
    reply, cost = _openrouter_chat(model, _PLACEMENT_SYSTEM, user)
    parsed = _parse_placement_json(reply)
    parsed['_cost_usd'] = cost
    return parsed


def _wp_get_page(page_id) -> dict:
    """Read a page's raw (editable) content + status. context=edit needs auth."""
    r = requests.get(
        f'{WP_BASE_URL}/wp-json/wp/v2/pages/{page_id}',
        params={'context': 'edit', '_fields': 'id,title,status,content,link'},
        auth=_wp_auth(), timeout=10,
    )
    r.raise_for_status()
    p = r.json()
    return {
        'id': p['id'],
        'title': p.get('title', {}).get('raw') or p.get('title', {}).get('rendered', ''),
        'status': p.get('status', ''),
        'content': p.get('content', {}).get('raw', ''),
        'builder': _detect_builder(p.get('content', {}).get('rendered', '')),
        'link': p.get('link', ''),
    }


def _wp_update_page(page_id, payload: dict) -> dict:
    r = requests.post(
        f'{WP_BASE_URL}/wp-json/wp/v2/pages/{page_id}',
        auth=_wp_auth(), json=payload,
        params={'_fields': 'id,status,link'}, timeout=15,
    )
    r.raise_for_status()
    return r.json()


@app.get('/api/content/pages')
@require_auth
def content_pages():
    """Read-only: list the client's WordPress pages for the dropdown."""
    if not _wp_configured():
        return jsonify({'ok': False, 'error': 'WordPress not configured on server'}), 500
    try:
        r = requests.get(
            f'{WP_BASE_URL}/wp-json/wp/v2/pages',
            params={'_fields': 'id,title,link,status,content', 'per_page': 100, 'status': 'publish,draft'},
            auth=_wp_auth(), timeout=15,
        )
        r.raise_for_status()
        pages = [
            {'id': p['id'], 'title': p['title']['rendered'], 'link': p.get('link', ''),
             'status': p.get('status', ''),
             'builder': _detect_builder(p.get('content', {}).get('rendered', ''))}
            for p in r.json()
        ]
        return jsonify(pages)
    except requests.RequestException as e:
        return jsonify({'ok': False, 'error': str(e)}), 502


@app.get('/api/content/requests')
@require_auth
def content_requests():
    """List Module-2 content requests for this tenant."""
    try:
        q = (get_supabase().table('content_requests').select('*')
             .order('created_at', desc=True).limit(100))
        if TENANT_ID:
            q = q.eq('tenant_id', TENANT_ID)
        return jsonify(q.execute().data)
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.get('/api/content/models')
@require_auth
def content_models():
    """
    Curated model menu for the picker (Context §3.6).

    Cost figures are deliberately NOT exposed: the client pays a flat
    subscription, so per-request token costs and remaining credit are our
    business, not theirs. `typical_cost` stays server-side for our own
    planning — strip it from anything the browser can read.
    """
    public_menu = [{k: v for k, v in m.items() if k != 'typical_cost'}
                   for m in MODEL_MENU]
    return jsonify({'models': public_menu, 'default': OPENROUTER_DEFAULT_MODEL})


@app.post('/api/content/upload-media')
@require_auth
def content_upload_media():
    """
    Upload a local image to the WP Media Library (Context §3.4).
    Multipart form: file=<binary>. Returns {media_id, media_url}.
    The draft call then references media_url with content_mode='manual_image'.
    """
    if not _wp_configured():
        return jsonify({'ok': False, 'error': 'WordPress not configured on server'}), 500
    f = request.files.get('file')
    if not f or not f.filename:
        return jsonify({'ok': False, 'error': 'file is required (multipart form)'}), 400
    try:
        r = requests.post(
            f'{WP_BASE_URL}/wp-json/wp/v2/media',
            auth=_wp_auth(), timeout=30,
            headers={
                'Content-Disposition': f'attachment; filename="{f.filename}"',
                'Content-Type': f.mimetype or 'application/octet-stream',
            },
            data=f.read(),
        )
        r.raise_for_status()
        body = r.json()
        return jsonify({'ok': True, 'media_id': body.get('id'),
                        'media_url': body.get('source_url', '')})
    except requests.RequestException as e:
        return jsonify({'ok': False, 'error': f'WP media upload failed: {e}'}), 502


@app.post('/api/content/draft')
@require_auth
def content_draft():
    """
    In-place PAGE edit (Context §3.1/§3.4): AI places the change directly into
    the selected page's content, which stays a DRAFT. Never publishes.

    Body: {
      wp_page_id,                      # the PAGE to edit (required)
      page,                            # page title for display
      content_mode,                    # 'ai_text' | 'manual_text' | 'manual_image'
      summary,                         # ai_text: the request; others: placement hint
      manual_text,                     # manual_text mode: exact text to insert
      media_id, media_url,             # manual_image mode: from /upload-media
      model,                           # OpenRouter model id from MODEL_MENU
      submitted_by
    }
    """
    if not _wp_configured():
        return jsonify({'ok': False, 'error': 'WordPress not configured on server'}), 500
    if not OPENROUTER_API_KEY:
        return jsonify({'ok': False, 'error': 'OPENROUTER_API_KEY not configured'}), 500
    if not TENANT_ID:
        return jsonify({'ok': False, 'error': 'TENANT_ID not configured'}), 500

    data = request.get_json(silent=True) or {}
    wp_page_id   = data.get('wp_page_id') or data.get('wp_post_id')  # legacy field name
    page         = (data.get('page') or '').strip()
    content_mode = (data.get('content_mode') or 'ai_text').strip()
    summary      = (data.get('summary') or '').strip()
    manual_text  = (data.get('manual_text') or '').strip()
    media_id     = data.get('media_id')
    media_url    = (data.get('media_url') or '').strip()
    model        = (data.get('model') or OPENROUTER_DEFAULT_MODEL).strip()
    # Authenticated identity beats whatever the client claims (audit trail).
    submitted_by = g.get('user_email') or (data.get('submitted_by') or 'unknown').strip()

    if not wp_page_id:
        return jsonify({'ok': False, 'error': 'wp_page_id is required'}), 400
    if content_mode == 'ai_text' and not summary:
        return jsonify({'ok': False, 'error': 'summary is required for ai_text'}), 400
    if content_mode == 'manual_text' and not manual_text:
        return jsonify({'ok': False, 'error': 'manual_text is required for manual_text'}), 400
    if content_mode == 'manual_image' and not media_url:
        return jsonify({'ok': False, 'error': 'media_url is required for manual_image (call /api/content/upload-media first)'}), 400
    if content_mode not in ('ai_text', 'manual_text', 'manual_image'):
        return jsonify({'ok': False, 'error': f'unknown content_mode {content_mode!r}'}), 400
    if model not in {m['id'] for m in MODEL_MENU}:
        return jsonify({'ok': False, 'error': f'model {model!r} is not in the allowed menu'}), 400

    # 1. Read the page's RAW content — this is both the AI's context and the
    #    revert point (prior_content) if the change is rejected.
    try:
        wp_page = _wp_get_page(wp_page_id)
    except requests.RequestException as e:
        return jsonify({'ok': False, 'error': f'WP page read failed: {e}'}), 502

    # In-place editing is only safe on DRAFT pages (Context §3.4). A live page
    # would change in production the moment we write to it.
    if wp_page['status'] == 'publish':
        return jsonify({'ok': False, 'error':
                        f'页面「{wp_page["title"]}」已上线 — 上线页面暂不支持就地编辑 '
                        '(needs staging-page flow, see Context §3.4)'}), 409

    # Builder pages are out of scope (Context §3.2): their design lives in the
    # builder's own data, so editing post_content wouldn't show up on the page.
    if wp_page['builder']:
        return jsonify({'ok': False, 'error':
                        f'页面「{wp_page["title"]}」使用页面构建器（{wp_page["builder"].title()}）制作 — '
                        '内容存在构建器数据里，本工具的编辑不会生效。请在构建器内修改，'
                        '或仅对普通编辑器页面使用本工具。'}), 409

    prior_content = wp_page['content']

    # 2a. Spend guards, BEFORE any tokens are burned (Context §3.6).
    if len(prior_content) > AI_MAX_PAGE_CHARS:
        return jsonify({'ok': False, 'error':
                        f'页面内容过大（{len(prior_content):,} 字符，上限 {AI_MAX_PAGE_CHARS:,}），'
                        '暂不支持自动排版。请用「手动文本」模式并自行粘贴片段。'}), 413
    try:
        _check_spend_cap(submitted_by)
    except SpendCapReached as e:
        return jsonify({'ok': False, 'error': str(e), 'cap_reached': True}), 429

    # 2b. AI places the change: full updated page + standalone snippet
    try:
        placement = _run_placement(model, wp_page['title'] or page, prior_content,
                                   content_mode, summary, manual_text, media_url)
    except (requests.RequestException, ValueError, _json.JSONDecodeError) as e:
        return jsonify({'ok': False, 'error': f'AI placement failed: {e}'}), 502

    # Record the real charged cost immediately — it's owed whether or not the
    # steps below succeed.
    _record_spend(submitted_by, model, placement.get('_cost_usd', 0.0))

    updated_page = placement['updated_page']
    snippet      = (placement.get('snippet') or '').strip()

    # 3. Write the updated content to the page — status untouched (stays draft)
    try:
        upd = _wp_update_page(wp_page_id, {'content': updated_page})
    except requests.RequestException as e:
        return jsonify({'ok': False, 'error': f'WP page update failed: {e}'}), 502

    # Native draft preview (§3.4): needs a wp-admin browser session to view
    wp_preview_url = f'{WP_BASE_URL}/?page_id={wp_page_id}&preview=true'

    # 4. Log the request row (pending_review). If this fails, revert the WP
    #    page immediately — an untracked edit would have no revert path.
    row = {
        'tenant_id':         TENANT_ID,
        'page':              page or wp_page['title'],
        'change_type':       'copy',            # legacy column; content_mode is authoritative
        'content_mode':      content_mode,
        'model_used':        model,
        'summary':           summary or (manual_text[:200] if manual_text else f'插入图片 {media_url}'),
        'before_value':      _strip_html(prior_content),
        'after_value':       _strip_html(updated_page),
        'prior_content':     prior_content,
        'generated_snippet': snippet,
        'status':            'pending_review',
        'wp_page_id':        wp_page_id,
        'wp_post_id':        wp_page_id,        # legacy column kept in sync
        'media_id':          media_id,
        'media_url':         media_url or None,
        'wp_preview_url':    wp_preview_url,
        'submitted_by':      submitted_by,
    }
    try:
        ins = get_supabase().table('content_requests').insert(row).execute()
        return jsonify(ins.data[0])
    except Exception as e:
        try:
            _wp_update_page(wp_page_id, {'content': prior_content})
            reverted = True
        except requests.RequestException:
            reverted = False
        return jsonify({'ok': False,
                        'error': f'DB insert failed: {e} (WP page reverted: {reverted})'}), 500


@app.post('/api/content/archive')
@require_auth
def content_archive():
    """
    Soft delete ("隐藏"): Body {id, archived: true|false}.
    Only REJECTED rows can be hidden — approvals/pending stay visible because
    the request history is the audit trail. Unhiding is always allowed.
    Rows are never hard-deleted through the API.
    """
    data = request.get_json(silent=True) or {}
    req_id   = data.get('id')
    archived = bool(data.get('archived', True))
    if req_id is None:
        return jsonify({'ok': False, 'error': 'id is required'}), 400

    try:
        found = get_supabase().table('content_requests').select('id,status,archived').eq('id', req_id).limit(1).execute()
        if not found.data:
            return jsonify({'ok': False, 'error': 'request not found'}), 404
        row = found.data[0]
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500

    if archived and row.get('status') != 'rejected':
        return jsonify({'ok': False, 'error': '只有已拒绝的记录可以隐藏'}), 409

    try:
        upd = (get_supabase().table('content_requests')
               .update({'archived': archived, 'updated_at': datetime.now(timezone.utc).isoformat()})
               .eq('id', req_id).execute())
        return jsonify(upd.data[0])
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.post('/api/content/decide')
@require_auth
def content_decide():
    """
    Body: {id, decision ('approve'|'reject')}
    approve → publish the edited PAGE; reject → restore prior_content (page
    stays draft). Draft and publish are always separate calls (Context §3.1).
    """
    data = request.get_json(silent=True) or {}
    req_id   = data.get('id')
    decision = data.get('decision')
    if req_id is None or decision not in ('approve', 'reject'):
        return jsonify({'ok': False, 'error': "id and decision ('approve'|'reject') required"}), 400
    if not _wp_configured():
        return jsonify({'ok': False, 'error': 'WordPress not configured on server'}), 500

    try:
        found = get_supabase().table('content_requests').select('*').eq('id', req_id).limit(1).execute()
        if not found.data:
            return jsonify({'ok': False, 'error': 'request not found'}), 404
        req_row = found.data[0]
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500

    if req_row.get('status') not in ('pending_review', 'drafting'):
        return jsonify({'ok': False, 'error': f'request already {req_row.get("status")}'}), 409

    page_id = req_row.get('wp_page_id') or req_row.get('wp_post_id')
    new_status = 'published' if decision == 'approve' else 'rejected'

    if decision == 'approve':
        try:
            _wp_update_page(page_id, {'status': 'publish'})
        except requests.RequestException as e:
            return jsonify({'ok': False, 'error': f'WP publish failed: {e}'}), 502
    else:
        # Reject = revert-on-reject (Context §3.4): put the prior content back.
        prior = req_row.get('prior_content')
        if prior is not None:
            try:
                _wp_update_page(page_id, {'content': prior})
            except requests.RequestException as e:
                return jsonify({'ok': False, 'error': f'WP revert failed: {e}'}), 502

    try:
        upd = (get_supabase().table('content_requests')
               .update({'status': new_status, 'updated_at': datetime.now(timezone.utc).isoformat()})
               .eq('id', req_id).execute())
        return jsonify(upd.data[0])
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


# Local dev only — Vercel imports the `app` object directly and never runs this block.
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001, debug=True)
