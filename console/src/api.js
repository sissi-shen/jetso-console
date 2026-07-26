// ─── Jetso Console API layer ─────────────────────────────────────────────────
// One contract, two implementations. The UI only ever calls these exported
// functions — it never knows whether it's talking to the mock or the real
// backend. When Module 2's backend lands, flip VITE_USE_MOCK=false and point
// VITE_API_BASE at the Vercel deployment; no UI code changes.
//
// Status enum matches the Supabase content_requests.status column (Context §3.3):
//   'drafting' | 'pending_review' | 'published' | 'rejected'
// content_mode matches content_requests.content_mode:
//   'ai_text' | 'manual_text' | 'manual_image'  (Context §3.1 redesign)
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_API_BASE || ''
// Mock is ON by default. Set VITE_USE_MOCK=false in .env.local to hit the real API.
const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// ═══ MOCK BACKEND ════════════════════════════════════════════════════════════
// In-memory store so the whole console is demoable with zero credentials.

let _seq = 106
const nextId = () => 'req-' + (++_seq)

let _requests = [
  {
    id: 'req-104', page: '首页', change_type: 'copy', status: 'published',
    summary: '首页 banner 文案改成强调「7 天内回复」承诺',
    before_value: '专业玻璃制品出口，品质保证',
    after_value: '7 天内回复询盘 · 专业玻璃制品出口，品质保证',
    wp_preview_url: 'https://example.com/?page_id=104&preview=true',
    submitted_by: '王经理', created_at: '07/14 14:20',
  },
  {
    id: 'req-105', page: '关于我们', change_type: 'style', status: 'pending_review',
    summary: '团队介绍卡片间距太挤，加大间距 + 圆角',
    before_value: '卡片间距 8px，直角边框',
    after_value: '卡片间距 24px，圆角 12px',
    wp_preview_url: 'https://example.com/?page_id=105&preview=true',
    submitted_by: 'Lily', created_at: '07/15 09:03',
  },
]

let _leads = [
  { client_id: '1698765432.1088', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'summer_sale', status: 'sent', confirmed_at: '07/15 16:40' },
  { client_id: '1698761190.7733', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'glass_export', status: 'sent', confirmed_at: '07/15 11:02' },
  { client_id: '1698750221.4471', utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'retarget', status: 'sent', confirmed_at: '07/14 19:15' },
]

// Fake "AI placement" so the demo shows a plausible result per content mode.
function mockDraft({ page, content_mode, summary, manual_text, media_url }) {
  if (content_mode === 'manual_text') {
    return {
      before_value: '（' + page + ' 当前页面内容）',
      after_value: '已将你提供的原文放入页面：「' + (manual_text || '').slice(0, 60) + '…」',
      generated_snippet: '<section class="jetso-insert">\n  <p>' + (manual_text || '') + '</p>\n</section>',
    }
  }
  if (content_mode === 'manual_image') {
    return {
      before_value: '（' + page + ' 当前页面内容）',
      after_value: '已将上传的图片插入页面合适位置。',
      generated_snippet: '<figure class="wp-block-image"><img src="' + (media_url || 'https://example.com/demo.jpg') + '" alt="" /></figure>',
    }
  }
  return {
    before_value: '（' + page + ' 当前页面内容）',
    after_value: 'AI 改写并已放入页面：' + summary + '——请在 WordPress 预览中确认。',
    generated_snippet: '<section class="jetso-insert">\n  <h2>示例标题</h2>\n  <p>根据「' + summary + '」生成的示例文案。</p>\n</section>',
  }
}

// Mirrors GET /api/content/models — curated menu, cheap → expensive.
const _models = {
  models: [
    // No cost fields — the client is on a flat subscription and must not see
    // per-request token costs. Mirrors what the real endpoint returns.
    { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash · 快速便宜', tier: 'cheap' },
    { id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna · 均衡', tier: 'mid' },
    { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5 · 最强排版', tier: 'high' },
  ],
  default: 'deepseek/deepseek-v4-flash',
}

// Mirrors what GET /api/content/pages returns (id/title/link/status/builder).
// 'publish' pages and builder pages (Elementor/Divi, §3.2) are shown but
// disabled — in-place editing is draft-only (§3.4) and plain-editor-only.
let _pages = [
  { id: 18, title: 'Home', link: 'https://rubflo.com/', status: 'publish', builder: null },
  { id: 2, title: 'About Us', link: 'https://rubflo.com/about', status: 'draft', builder: null },
  { id: 3, title: 'Products', link: 'https://rubflo.com/products', status: 'draft', builder: 'elementor' },
  { id: 4, title: 'Contact', link: 'https://rubflo.com/contact', status: 'draft', builder: null },
]

const mock = {
  async listPages() {
    await delay(100)
    return [..._pages]
  },

  async listModels() {
    await delay(80)
    return { ..._models }
  },

  async listContentRequests() {
    await delay(120)
    return [..._requests]
  },

  async uploadMedia(/* file */) {
    await delay(600)
    return { ok: true, media_id: Math.floor(1000 + Math.random() * 9000), media_url: 'https://example.com/demo-upload.jpg' }
  },

  // Real backend does this in ONE request: AI places the change → update the
  // PAGE in place (stays draft) → insert content_requests row as
  // 'pending_review'. The mock returns the finished, review-ready row (the UI
  // shows an optimistic 'drafting' placeholder while this promise is in flight).
  async createContentRequest({ wp_page_id, page, content_mode, summary, manual_text, media_id, media_url, model, submitted_by }) {
    await delay(1200)
    const draft = mockDraft({ page, content_mode, summary, manual_text, media_url })
    const row = {
      id: nextId(), page, content_mode, summary: summary || (manual_text || '').slice(0, 60),
      change_type: 'copy',
      model_used: model || _models.default,
      status: 'pending_review',
      before_value: draft.before_value,
      after_value: draft.after_value,
      generated_snippet: draft.generated_snippet,
      wp_page_id, wp_post_id: wp_page_id,
      media_id, media_url,
      wp_preview_url: 'https://example.com/?page_id=' + wp_page_id + '&preview=true',
      submitted_by: submitted_by || '你',
      created_at: '刚刚',
    }
    _requests = [row, ..._requests]
    return row
  },

  // decision: 'approve' → publish via WP REST; 'reject' → revert page, mark rejected
  async decideContentRequest({ id, decision }) {
    await delay(600)
    const status = decision === 'approve' ? 'published' : 'rejected'
    _requests = _requests.map((r) => (r.id === id ? { ...r, status } : r))
    return _requests.find((r) => r.id === id)
  },

  // Soft delete ("隐藏") — only rejected rows; history is never hard-deleted.
  async setArchivedContentRequest({ id, archived }) {
    await delay(300)
    _requests = _requests.map((r) => (r.id === id ? { ...r, archived } : r))
    return _requests.find((r) => r.id === id)
  },

  async listLeads() {
    await delay(120)
    return [..._leads]
  },

  // ── auth (mock: never required, demo stays zero-credential) ──
  async authStatus() { return { ok: true, auth_required: false } },
  async login() { return { ok: true, email: 'demo@jetso.dev' } },
  logout() {},
  currentUser: () => '',
  hasSession: () => true,

  // Module 1: rep confirms a lead → backend fires GA4 valid_lead + logs row.
  async confirmLead({ client_id, utm_source, utm_medium, utm_campaign, utm_content, raw_message, notes }) {
    await delay(700)
    const row = {
      client_id, utm_source, utm_medium, utm_campaign, utm_content,
      raw_message, notes, ga4_status: 204, status: 'sent',
      confirmed_at: new Date().toISOString(),
    }
    _leads = [row, ..._leads]
    return { ok: true, client_id, ga4_status: 204, db_error: null }
  },
}

// ═══ REAL BACKEND ════════════════════════════════════════════════════════════
// Contract the Module 2 backend (api/index.py) will implement. Kept in sync with
// the mock signatures so swapping is a one-line env change.

// ─── Auth session (invite-only Supabase Auth, tokens via our backend) ────────
const TOKEN_KEY = 'jetso_access_token'
const REFRESH_KEY = 'jetso_refresh_token'
const EMAIL_KEY = 'jetso_user_email'

const session = {
  get token() { return localStorage.getItem(TOKEN_KEY) || '' },
  get email() { return localStorage.getItem(EMAIL_KEY) || '' },
  save({ access_token, refresh_token, email }) {
    localStorage.setItem(TOKEN_KEY, access_token || '')
    localStorage.setItem(REFRESH_KEY, refresh_token || '')
    if (email) localStorage.setItem(EMAIL_KEY, email)
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(REFRESH_KEY)
    localStorage.removeItem(EMAIL_KEY)
  },
}

async function rawFetch(method, path, body) {
  const headers = { 'Content-Type': 'application/json' }
  if (session.token) headers['Authorization'] = 'Bearer ' + session.token
  return fetch(API_BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  })
}

async function http(method, path, body) {
  let res = await rawFetch(method, path, body)
  // Access token expired → try one silent refresh, then retry the call once.
  if (res.status === 401 && localStorage.getItem(REFRESH_KEY)) {
    const rr = await fetch(API_BASE + '/api/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: localStorage.getItem(REFRESH_KEY) }),
    })
    if (rr.ok) {
      session.save(await rr.json())
      res = await rawFetch(method, path, body)
    } else {
      session.clear()
      window.dispatchEvent(new Event('jetso:logout'))
    }
  }
  if (!res.ok) throw new Error((await res.text()) || res.statusText)
  return res.json()
}

const real = {
  listPages: () => http('GET', '/api/content/pages'),
  listModels: () => http('GET', '/api/content/models'),
  listContentRequests: () => http('GET', '/api/content/requests'),
  createContentRequest: (input) => http('POST', '/api/content/draft', input),
  decideContentRequest: (input) => http('POST', '/api/content/decide', input),
  setArchivedContentRequest: (input) => http('POST', '/api/content/archive', input),
  listLeads: () => http('GET', '/api/leads'),
  confirmLead: (input) => http('POST', '/api/confirm', input),

  // ── auth ──
  authStatus: async () => {
    const r = await fetch(API_BASE + '/api/health')
    if (!r.ok) throw new Error('后端未连接')
    return r.json() // {ok, auth_required}
  },
  login: async (email, password) => {
    const r = await fetch(API_BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok || !body.ok) throw new Error(body.error || '登录失败')
    session.save(body)
    return body
  },
  logout: () => session.clear(),
  currentUser: () => session.email,
  hasSession: () => !!session.token,
  async uploadMedia(file) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(API_BASE + '/api/content/upload-media', { method: 'POST', body: fd })
    if (!res.ok) throw new Error((await res.text()) || res.statusText)
    return res.json()
  },
}

// ═══ EXPORT ══════════════════════════════════════════════════════════════════
const api = USE_MOCK ? mock : real
export default api
export { USE_MOCK }
