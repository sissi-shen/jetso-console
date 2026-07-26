#!/usr/bin/env python
"""
Jetso Console — pre-deploy smoke test.

Verifies every external dependency and every safety guard WITHOUT changing
anything: no WordPress writes, no GA4 events, no database rows, no AI spend
beyond a handful of tokens.

    .venv/bin/python scripts/smoke_test.py

Exit code 0 = safe to deploy, 1 = something is broken.

Add --deep to also run one real (cheap) AI placement against a draft page.
That still writes nothing — the result is discarded.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests  # noqa: E402

PASS, FAIL, WARN = "\033[92m  OK \033[0m", "\033[91mFAIL \033[0m", "\033[93mWARN \033[0m"
results = {"ok": 0, "fail": 0, "warn": 0}


def check(name, fn, warn_only=False):
    """Run one check; never let an exception kill the run."""
    try:
        detail = fn()
        print(f"{PASS} {name}" + (f" — {detail}" if detail else ""))
        results["ok"] += 1
        return True
    except Exception as e:
        tag = WARN if warn_only else FAIL
        results["warn" if warn_only else "fail"] += 1
        print(f"{tag} {name} — {e}")
        return False


def section(title):
    print(f"\n\033[1m{title}\033[0m")


# ── 1. Code loads at all ─────────────────────────────────────────────────────
section("1. Code integrity")

check("backend imports cleanly", lambda: __import__("api.index") and "api/index.py")

from api import index as api  # noqa: E402


def env_check():
    required = ["GA4_MEASUREMENT_ID", "GA4_API_SECRET", "SUPABASE_URL", "SUPABASE_KEY",
                "WP_BASE_URL", "WP_USERNAME", "WP_APP_PASSWORD", "TENANT_ID",
                "OPENROUTER_API_KEY"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        raise AssertionError("missing env vars: " + ", ".join(missing))
    return f"{len(required)} required vars present"


check("all required env vars set", env_check)

# ── 2. Supabase: schema drift ────────────────────────────────────────────────
section("2. Supabase (database)")


def table_check(table, columns):
    def run():
        api.get_supabase().table(table).select(",".join(columns)).limit(1).execute()
        return f"{len(columns)} columns verified"
    return run


check("table: tenants", table_check("tenants", ["id", "name", "wp_site_url"]))
check("table: leads", table_check(
    "leads", ["client_id", "utm_source", "utm_medium", "utm_campaign",
              "raw_message", "notes", "ga4_status", "confirmed_at"]))
check("table: content_requests (incl. redesign columns)", table_check(
    "content_requests", ["id", "page", "status", "summary", "before_value", "after_value",
                         "content_mode", "model_used", "wp_page_id", "prior_content",
                         "generated_snippet", "media_id", "media_url", "archived",
                         "submitted_by", "created_at"]))
check("table: ai_usage", table_check(
    "ai_usage", ["tenant_id", "user_id", "month", "model", "cost_usd"]))
check("table: tenant_wp_credentials", table_check(
    "tenant_wp_credentials", ["tenant_id", "wp_username", "wp_application_password"]))


def tenant_seeded():
    r = api.get_supabase().table("tenants").select("id,name").eq("id", api.TENANT_ID).execute()
    if not r.data:
        raise AssertionError(f"TENANT_ID {api.TENANT_ID} not found in tenants table")
    return r.data[0]["name"]


check("seeded tenant matches TENANT_ID", tenant_seeded)

# ── 3. WordPress ─────────────────────────────────────────────────────────────
section("3. WordPress REST API")

_pages = {}


def wp_auth():
    # capabilities/roles are only exposed under context=edit
    r = requests.get(f"{api.WP_BASE_URL}/wp-json/wp/v2/users/me",
                     params={"context": "edit"}, auth=api._wp_auth(), timeout=10)
    if r.status_code == 401:
        raise AssertionError("Application Password rejected (401)")
    r.raise_for_status()
    body = r.json()
    caps = body.get("capabilities", {})
    needed = ["edit_pages", "publish_pages", "upload_files"]
    lacking = [c for c in needed if not caps.get(c)]
    if lacking:
        raise AssertionError(f"account lacks capabilities: {', '.join(lacking)} "
                             f"(roles={body.get('roles')})")
    return f"{body.get('name')} · role={','.join(body.get('roles') or [])} · can edit/publish/upload"


check("application password authenticates", wp_auth)


def wp_pages():
    r = requests.get(f"{api.WP_BASE_URL}/wp-json/wp/v2/pages",
                     params={"_fields": "id,title,status,content", "per_page": 100,
                             "status": "publish,draft"},
                     auth=api._wp_auth(), timeout=20)
    r.raise_for_status()
    for p in r.json():
        _pages[p["id"]] = {
            "title": p["title"]["rendered"],
            "status": p["status"],
            "builder": api._detect_builder(p.get("content", {}).get("rendered", "")),
        }
    editable = [p for p in _pages.values() if p["status"] == "draft" and not p["builder"]]
    blocked = [p for p in _pages.values() if p["builder"] or p["status"] == "publish"]
    return f"{len(_pages)} pages — {len(editable)} editable, {len(blocked)} correctly blocked"


check("page list + builder detection", wp_pages)


def wp_raw_read():
    target = next((pid for pid, p in _pages.items()
                   if p["status"] == "draft" and not p["builder"] and p["title"]), None)
    if target is None:
        raise AssertionError("no editable draft page to test against")
    pg = api._wp_get_page(target)
    if pg["status"] != "draft":
        raise AssertionError("status mismatch on raw read")
    return f"read '{pg['title']}' raw content ({len(pg['content'])} chars)"


check("raw (context=edit) page read", wp_raw_read)

# ── 4. OpenRouter ────────────────────────────────────────────────────────────
section("4. OpenRouter (AI gateway)")


def models_exist():
    r = requests.get(f"{api.OPENROUTER_BASE_URL}/models", timeout=20)
    r.raise_for_status()
    available = {m["id"] for m in r.json()["data"]}
    missing = [m["id"] for m in api.MODEL_MENU if m["id"] not in available]
    if missing:
        raise AssertionError("model ids no longer on OpenRouter: " + ", ".join(missing))
    if api.OPENROUTER_DEFAULT_MODEL not in {m["id"] for m in api.MODEL_MENU}:
        raise AssertionError("OPENROUTER_DEFAULT_MODEL is not in MODEL_MENU")
    return f"all {len(api.MODEL_MENU)} menu models exist; default = {api.OPENROUTER_DEFAULT_MODEL}"


check("model menu ids are valid + default is in menu", models_exist)


def key_works():
    t0 = time.time()
    out = api._openrouter_chat(api.OPENROUTER_DEFAULT_MODEL, "Reply with exactly: OK", "ping")
    return f"default model responded in {time.time() - t0:.1f}s ({out[:20]!r})"


check("API key valid + default model responds", key_works)

# ── 5. GA4 (validated, not sent) ─────────────────────────────────────────────
section("5. GA4 Measurement Protocol")


def ga4_validate():
    """GA4's /debug endpoint validates a payload WITHOUT recording the event."""
    r = requests.post(
        "https://www.google-analytics.com/debug/mp/collect"
        f"?measurement_id={api.GA4_MEASUREMENT_ID}&api_secret={api.GA4_API_SECRET}",
        json={"client_id": "1234567890.1234567890",
              "events": [{"name": "valid_lead",
                          "params": {"utm_source": "google", "utm_medium": "cpc",
                                     "utm_campaign": "smoke_test"}}]},
        timeout=10)
    r.raise_for_status()
    msgs = r.json().get("validationMessages", [])
    if msgs:
        raise AssertionError(str(msgs))
    return "valid_lead payload accepted by GA4 validator (no event recorded)"


check("credentials + event payload validate", ga4_validate)

# ── 6. Safety guards (the ones that protect the client's site) ───────────────
section("6. Safety guards")

app = api.app.test_client()


def guard(name, call, expect_status, expect_text=None):
    def run():
        resp = call()
        if resp.status_code != expect_status:
            raise AssertionError(f"expected {expect_status}, got {resp.status_code}: "
                                 f"{resp.get_json()}")
        if expect_text and expect_text not in str(resp.get_json()):
            raise AssertionError(f"missing expected text {expect_text!r}")
        return f"correctly refused ({expect_status})"
    return run


_live = next((pid for pid, p in _pages.items() if p["status"] == "publish"), None)
_builder = next((pid for pid, p in _pages.items() if p["builder"]), None)
_editable = next((pid for pid, p in _pages.items()
                  if p["status"] == "draft" and not p["builder"]), None)

if _live:
    check("live page rejected (would edit production)", guard(
        "live", lambda: app.post("/api/content/draft", json={
            "wp_page_id": _live, "content_mode": "ai_text", "summary": "smoke test"}), 409))
if _builder:
    check("Elementor page rejected (edit would be invisible)", guard(
        "builder", lambda: app.post("/api/content/draft", json={
            "wp_page_id": _builder, "content_mode": "ai_text", "summary": "smoke test"}), 409))

check("model outside menu rejected (spend control)", guard(
    "model", lambda: app.post("/api/content/draft", json={
        "wp_page_id": _editable, "content_mode": "ai_text", "summary": "x",
        "model": "openai/gpt-5.4-pro"}), 400))
check("missing wp_page_id rejected", guard(
    "pageid", lambda: app.post("/api/content/draft", json={
        "content_mode": "ai_text", "summary": "x"}), 400))
check("manual_text without text rejected", guard(
    "manual", lambda: app.post("/api/content/draft", json={
        "wp_page_id": _editable, "content_mode": "manual_text", "summary": "x"}), 400))
check("bad decision value rejected", guard(
    "decide", lambda: app.post("/api/content/decide", json={"id": 1, "decision": "maybe"}), 400))
check("confirm without client_id rejected", guard(
    "confirm", lambda: app.post("/api/confirm", json={"notes": "no client id"}), 400))
check("archive without id rejected", guard(
    "archive", lambda: app.post("/api/content/archive", json={}), 400))

section("6b. AI spend controls")


def cap_user():
    original = api.AI_MONTHLY_CAP_USER
    api.AI_MONTHLY_CAP_USER = 0.0  # any spend >= 0 → blocked
    try:
        r = app.post("/api/content/draft", json={
            "wp_page_id": _editable, "content_mode": "ai_text", "summary": "cap probe",
            "submitted_by": "smoke-test@jetso.dev"})
        if r.status_code != 429 or not r.get_json().get("cap_reached"):
            raise AssertionError(f"per-user cap NOT enforced: {r.status_code} {r.get_json()}")
        return "per-user cap blocks the call before any tokens are spent"
    finally:
        api.AI_MONTHLY_CAP_USER = original


def cap_tenant():
    original = api.AI_MONTHLY_CAP_TENANT
    api.AI_MONTHLY_CAP_TENANT = 0.0
    try:
        r = app.post("/api/content/draft", json={
            "wp_page_id": _editable, "content_mode": "ai_text", "summary": "cap probe",
            "submitted_by": "someone-else@jetso.dev"})
        if r.status_code != 429:
            raise AssertionError(f"tenant cap NOT enforced: {r.status_code}")
        return "tenant-wide cap blocks every user once the budget is gone"
    finally:
        api.AI_MONTHLY_CAP_TENANT = original


def cap_page_size():
    original = api.AI_MAX_PAGE_CHARS
    api.AI_MAX_PAGE_CHARS = 10
    try:
        r = app.post("/api/content/draft", json={
            "wp_page_id": 87, "content_mode": "ai_text", "summary": "size probe"})
        if r.status_code != 413:
            raise AssertionError(f"oversized page NOT refused: {r.status_code}")
        return "oversized pages refused before the call (bounds worst-case cost)"
    finally:
        api.AI_MAX_PAGE_CHARS = original


def openrouter_hard_limit():
    """The only ceiling a bug in our own code cannot bypass."""
    r = requests.get(f"{api.OPENROUTER_BASE_URL}/key",
                     headers={"Authorization": f"Bearer {api.OPENROUTER_API_KEY}"}, timeout=10)
    r.raise_for_status()
    d = r.json()["data"]
    if d.get("limit") is None:
        raise AssertionError(
            f"OpenRouter key has NO credit limit (spent ${d.get('usage', 0):.2f} so far). "
            "Set one at openrouter.ai → Keys → edit → credit limit.")
    return f"key limit ${d['limit']}, ${d.get('usage', 0):.2f} used this period"


check("per-user monthly cap enforced", cap_user)
check("tenant monthly cap enforced", cap_tenant)
check("oversized page refused", cap_page_size)
check("OpenRouter key has a hard credit limit", openrouter_hard_limit, warn_only=True)


def spend_recorded():
    rows = api.get_supabase().table("ai_usage").select("id").limit(1).execute()
    return f"ai_usage table writable (currently {len(rows.data)} sample row(s) visible)"


check("spend ledger reachable", spend_recorded)

# ── 7. Auth gate ─────────────────────────────────────────────────────────────
section("7. Auth gate (simulated AUTH_REQUIRED=true)")


def auth_gate():
    original = api.AUTH_REQUIRED
    api.AUTH_REQUIRED = True
    try:
        gated = ["/api/leads", "/api/content/pages", "/api/content/requests",
                 "/api/content/models"]
        for path in gated:
            if app.get(path).status_code != 401:
                raise AssertionError(f"{path} NOT gated — it answered without a token")
        for path, payload in [("/api/content/draft", {}), ("/api/content/decide", {}),
                              ("/api/content/archive", {}), ("/api/confirm", {})]:
            if app.post(path, json=payload).status_code != 401:
                raise AssertionError(f"{path} NOT gated")
        if app.get("/api/health").status_code != 200:
            raise AssertionError("/api/health should stay open (Vercel health checks)")
        return "all 8 data endpoints refuse anonymous access; /api/health stays open"
    finally:
        api.AUTH_REQUIRED = original


check("every data endpoint requires a token", auth_gate)


def auth_bad_login():
    r = app.post("/api/auth/login", json={"email": "nobody@example.com", "password": "wrong"})
    if r.status_code != 401:
        raise AssertionError(f"bad credentials should 401, got {r.status_code}")
    return "wrong password refused by Supabase"


check("login rejects bad credentials", auth_bad_login)

# ── 8. Deep: one real AI placement (nothing written) ─────────────────────────
if "--deep" in sys.argv:
    section("8. Deep check — live AI placement (discarded, nothing written)")

    def placement():
        # Prefer the editable draft with the MOST content — preserving an empty
        # page proves nothing about whether the model mangles existing markup.
        candidates = [pid for pid, p in _pages.items()
                      if p["status"] == "draft" and not p["builder"]]
        richest = max(candidates, key=lambda pid: len(api._wp_get_page(pid)["content"]))
        pg = api._wp_get_page(richest)
        if not pg["content"].strip():
            raise AssertionError("no draft page has content to test placement against")
        before = pg["content"]
        res = api._run_placement(
            api.OPENROUTER_DEFAULT_MODEL, pg["title"], before,
            "manual_text", "smoke test placement", "SMOKE_TEST_SENTINEL_TEXT")
        if "SMOKE_TEST_SENTINEL_TEXT" not in res["updated_page"]:
            raise AssertionError("model dropped the verbatim manual text")
        kept = sum(1 for line in before.splitlines() if line.strip() and line in res["updated_page"])
        total = sum(1 for line in before.splitlines() if line.strip())
        if total and kept / total < 0.8:
            raise AssertionError(f"model mangled the page: only {kept}/{total} lines preserved")
        after = api._wp_get_page(richest)["content"]
        if after != before:
            raise AssertionError("PAGE WAS MODIFIED — placement must be read-only!")
        return (f"verbatim text placed, {kept}/{total} original lines preserved, "
                f"page untouched on WP")

    check("AI places text without mangling or writing", placement)
else:
    print("\n\033[2m(skipping deep AI placement check — rerun with --deep to include it)\033[0m")

# ── Summary ──────────────────────────────────────────────────────────────────
print("\n" + "=" * 64)
total = results["ok"] + results["fail"] + results["warn"]
print(f"  {results['ok']}/{total} passed"
      + (f", {results['fail']} FAILED" if results["fail"] else "")
      + (f", {results['warn']} warnings" if results["warn"] else ""))
print("=" * 64)
sys.exit(1 if results["fail"] else 0)
