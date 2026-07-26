import { useState, useEffect } from "react";
import {
  Inbox,
  FileEdit,
  BarChart3,
  Lock,
  CheckCircle2,
  Clock3,
  XCircle,
  Send,
  ChevronRight,
  ExternalLink,
  MessageSquarePlus,
  Sun,
  Moon,
  Eye,
  EyeOff,
  LogOut,
} from "lucide-react";
import api, { USE_MOCK } from "./api.js";

// ─── Status + type display maps ────────────────────────────────────────────
// Keyed by the real DB enum (content_requests.status, Context §3.3). The UI
// renders the Chinese label; the data layer speaks the enum.
const STATUS_META = {
  drafting:       { label: "草稿中", color: "var(--stamp-info)",    icon: Clock3 },
  pending_review: { label: "待审批", color: "var(--stamp-pending)", icon: Clock3 },
  published:      { label: "已发布", color: "var(--stamp-success)", icon: CheckCircle2 },
  rejected:       { label: "已拒绝", color: "var(--stamp-danger)",  icon: XCircle },
  sent:           { label: "已回传", color: "var(--stamp-success)", icon: CheckCircle2 }, // Module 1 leads
  ga4_failed:     { label: "回传失败", color: "var(--stamp-danger)", icon: XCircle },      // GA4 rejected / unreachable
};

const CHANGE_TYPE_LABEL = { copy: "文案", style: "样式" }; // legacy rows
// content_mode (Context §3.1): content source is user-picked; AI always places.
const CONTENT_MODE_LABEL = {
  ai_text: "AI 文案",
  manual_text: "手动文本",
  manual_image: "上传图片",
};

function Stamp({ status }) {
  const meta = STATUS_META[status] || STATUS_META["drafting"];
  const Icon = meta.icon;
  return (
    <span className="stamp" style={{ "--stamp-color": meta.color }}>
      <Icon size={12} strokeWidth={2.5} />
      {meta.label}
    </span>
  );
}

// ─── Login (invite-only — accounts are created in the Supabase dashboard) ──
function LoginView({ onLoggedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      await api.login(email.trim(), password);
      onLoggedIn();
    } catch (err) {
      setError(err?.message || "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0, marginBottom: 18 }}>
          <span className="brand-mark">J</span>
          <span className="brand-name">Jetso Console</span>
        </div>
        <p className="view-sub" style={{ marginBottom: 18 }}>
          内部平台，仅限受邀账号登录
        </p>
        <input
          type="email" autoComplete="username" placeholder="邮箱"
          value={email} onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password" autoComplete="current-password" placeholder="密码"
          value={password} onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="hint-text hint-text--danger">{error}</p>}
        <button className="btn btn--primary login-btn" type="submit" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
        <p className="form-note" style={{ marginTop: 14 }}>
          没有账号？请联系管理员开通 — 本平台不提供自助注册。
        </p>
      </form>
    </div>
  );
}

// ─── Nav ──────────────────────────────────────────────────────────────────
function Sidebar({ active, setActive, theme, setTheme, userEmail, onLogout }) {
  const items = [
    { key: "leads", label: "询盘确认", icon: Inbox },
    { key: "publish", label: "内容发布", icon: FileEdit },
    { key: "analytics", label: "数据看板", icon: BarChart3, locked: true },
  ];
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">J</span>
        <span className="brand-name">Jetso Console</span>
      </div>
      <nav>
        {items.map((it) => {
          const Icon = it.icon;
          const isActive = active === it.key;
          return (
            <button
              key={it.key}
              className={"nav-item" + (isActive ? " nav-item--active" : "")}
              onClick={() => setActive(it.key)}
            >
              <Icon size={17} strokeWidth={2} />
              <span>{it.label}</span>
              {it.locked && <Lock size={13} className="nav-lock" />}
            </button>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <button
          className="theme-toggle"
          onClick={() => setTheme(theme === "day" ? "night" : "day")}
        >
          {theme === "day" ? <Moon size={14} /> : <Sun size={14} />}
          {theme === "day" ? "夜间模式" : "日间模式"}
        </button>
        {USE_MOCK && <div className="mock-badge">演示数据 · MOCK</div>}
        {userEmail && (
          <button className="user-row" onClick={onLogout} title="退出登录">
            <span className="user-email">{userEmail}</span>
            <LogOut size={13} />
          </button>
        )}
        <div className="workspace-tag">Reach Building</div>
      </div>
    </aside>
  );
}

// ─── Leads view (Module 1 — ported from confirm.html) ──────────────────────
// Flow (Context §2): rep pastes the customer's message → regex extracts the
// [REF:client_id] and [SRC:source|medium|campaign] tags the landing snippet
// injected → POST /api/confirm → backend fires GA4 valid_lead + logs the row.
// The snippet tags BOTH wa.me and mailto: links, so the message can arrive by
// WhatsApp or email — the copy here must stay channel-neutral.

// Same regexes as confirm.html / tracking.js — keep in sync (Context §5:
// REF/SRC stays simple and regex-parseable).
function parseLeadMessage(msg) {
  const refMatch = msg.match(/\[REF:([^\]]+)\]/);
  if (!refMatch) return null;
  const srcMatch = msg.match(/\[SRC:([^\]]+)\]/);
  const srcParts = srcMatch ? srcMatch[1].trim().split("|") : [];
  return {
    client_id:    refMatch[1].trim(),
    utm_source:   srcParts[0] || "",
    utm_medium:   srcParts[1] || "",
    utm_campaign: srcParts[2] || "",
    utm_content:  srcParts[3] || "",
  };
}

// Real rows from /api/leads carry ga4_status (204 = GA4 accepted), not a
// status enum; mock rows carry status. Normalize for the Stamp.
const leadStatus = (l) =>
  l.status || (l.ga4_status === 204 ? "sent" : "ga4_failed");

const fmtTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? iso : `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function LeadsView() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [rawMessage, setRawMessage] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // {ok, text}

  const parsed = parseLeadMessage(rawMessage);

  useEffect(() => {
    let alive = true;
    api.listLeads().then((data) => {
      if (alive) { setLeads(data); setLoading(false); }
    }).catch((e) => {
      if (alive) {
        setLoading(false);
        setLoadError("无法连接后端服务（" + (e?.message || e) +
          "）。请确认后端已启动： .venv/bin/python api/index.py");
      }
    });
    return () => { alive = false; };
  }, []);

  async function submitLead() {
    if (!parsed || submitting) return;
    setSubmitting(true);
    setResult(null);
    try {
      const resp = await api.confirmLead({
        ...parsed,
        raw_message: rawMessage.trim(),
        notes: notes.trim(),
      });
      if (!resp.ok) throw new Error(resp.error || "未知错误");
      setResult({
        ok: true,
        text: `已回传 GA4（状态码 ${resp.ga4_status}，204 = 成功）· client_id ${resp.client_id}` +
          (resp.db_error ? ` · 注意：数据库记录失败（${resp.db_error}）` : ""),
      });
      setRawMessage("");
      setNotes("");
      // Refresh the table so the new lead shows up with server-side fields
      api.listLeads().then(setLeads).catch(() => {});
    } catch (e) {
      setResult({ ok: false, text: "回传失败：" + (e?.message || e) });
    } finally {
      setSubmitting(false);
    }
  }

  const parsedRows = parsed && [
    ["REF (client_id)", parsed.client_id],
    ["utm_source", parsed.utm_source],
    ["utm_medium", parsed.utm_medium],
    ["utm_campaign", parsed.utm_campaign],
  ];

  return (
    <div className="view">
      <header className="view-header">
        <div>
          <h1>询盘确认</h1>
          <p className="view-sub">将客户消息粘贴进来（WhatsApp、邮件均可），提取追踪标签并回传 GA4</p>
        </div>
      </header>

      {loadError && <div className="load-error">{loadError}</div>}

      <div className="lead-form">
        <label className="field-label" htmlFor="lead-raw">
          客户原始消息 <span className="field-req">必填</span>
        </label>
        <textarea
          id="lead-raw"
          className="lead-raw"
          placeholder={"完整粘贴客户发来的消息（WhatsApp 或邮件，需包含 [REF:...] 标签）\n例如：你好，我想咨询产品\n[REF:1234567890.1698765432] [SRC:google|cpc|summer_sale]"}
          value={rawMessage}
          onChange={(e) => { setRawMessage(e.target.value); setResult(null); }}
          rows={4}
        />

        {/* Pasting the message into the notes box is an easy mistake — catch it
            explicitly instead of leaving the button mysteriously disabled. */}
        {!parsed && /\[REF:/.test(notes) && (
          <p className="hint-text hint-text--danger">
            消息似乎粘贴到了下面的「备注」框。
            <button className="link-btn" onClick={() => { setRawMessage(notes); setNotes(""); }}>
              移到上方消息框 →
            </button>
          </p>
        )}

        {rawMessage.trim() && !parsed && (
          <p className="hint-text hint-text--danger">
            未找到 [REF:...] 标签。请确认消息包含追踪标签，或检查落地页脚本是否已正确安装。
          </p>
        )}

        {parsed && (
          <div className="parsed-box parsed-box--ok">
            {parsedRows.map(([k, v]) => (
              <div className="parsed-row" key={k}>
                <span className="parsed-key">{k}</span>
                <span className={"mono" + (v ? "" : " dim")}>{v || "（缺失）"}</span>
              </div>
            ))}
          </div>
        )}

        <label className="field-label" htmlFor="lead-notes">
          备注 <span className="dim">选填 · 为什么判断为有效询盘</span>
        </label>
        <input
          id="lead-notes"
          type="text"
          className="lead-notes"
          placeholder="例如：客户询问了具体型号和 MOQ，有明确采购意向"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submitLead(); }}
        />

        <div className="lead-form-row">
          {result ? (
            <p className={"hint-text " + (result.ok ? "hint-text--success" : "hint-text--danger")}>
              {result.text}
            </p>
          ) : !parsed ? (
            <p className="hint-text">识别到 [REF:...] 标签后即可提交</p>
          ) : null}
          <button
            className="btn btn--primary"
            onClick={submitLead}
            disabled={!parsed || submitting}
          >
            <MessageSquarePlus size={15} /> {submitting ? "回传中…" : "确认有效询盘"}
          </button>
        </div>
      </div>

      <div className="table">
        <div className="table-row table-row--leads table-row--head">
          <span>Client ID</span>
          <span>来源</span>
          <span>备注</span>
          <span>状态</span>
          <span>时间</span>
        </div>
        {loading ? (
          <div className="table-row"><span className="dim">加载中…</span></div>
        ) : leads.length === 0 ? (
          <div className="table-row"><span className="dim">还没有确认过的询盘</span></div>
        ) : (
          leads.map((l, i) => (
            <div className="table-row table-row--leads" key={l.id || l.client_id + i}>
              <span className="mono">{l.client_id}</span>
              <span className="mono dim">
                {[l.utm_source, l.utm_medium, l.utm_campaign].filter(Boolean).join(" · ")}
              </span>
              <span className="dim lead-note-cell" title={l.notes || ""}>{l.notes || "—"}</span>
              <span><Stamp status={leadStatus(l)} /></span>
              <span className="dim">{fmtTime(l.confirmed_at)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Publish view (Module 2) ───────────────────────────────────────────────
function PublishView() {
  const [requests, setRequests] = useState([]);
  const [pages, setPages] = useState([]);
  const [models, setModels] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [desc, setDesc] = useState("");
  const [manualText, setManualText] = useState("");
  const [imageFile, setImageFile] = useState(null);
  const [targetPageId, setTargetPageId] = useState("");
  const [contentMode, setContentMode] = useState("ai_text");
  const [model, setModel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [decideError, setDecideError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    let alive = true;
    const onErr = (e) => {
      if (alive) setLoadError("无法连接后端服务（" + (e?.message || e) +
        "）。请确认后端已启动： .venv/bin/python api/index.py");
    };
    api.listContentRequests().then((data) => {
      if (!alive) return;
      setRequests(data);
      if (data.length) setSelectedId(data[0].id);
    }).catch(onErr);
    // Pages are sourced live from the client's WordPress site (read-only).
    // Default to the first editable page — live pages can't be edited in place
    // (§3.4) and builder pages (Elementor/Divi) are out of scope (§3.2).
    api.listPages().then((data) => {
      if (!alive) return;
      setPages(data);
      const firstEditable = data.find((p) => p.status !== "publish" && !p.builder) || data[0];
      if (firstEditable) setTargetPageId(String(firstEditable.id));
    }).catch(onErr);
    api.listModels().then((data) => {
      if (!alive) return;
      setModels(data.models || []);
      setModel(data.default || (data.models?.[0]?.id ?? ""));
    }).catch(onErr);
    return () => { alive = false; };
  }, []);

  // Soft-hidden ("隐藏") rows stay in the data; the list just filters them.
  const visibleRequests = requests.filter((r) => showArchived || !r.archived);
  const archivedCount = requests.filter((r) => r.archived).length;
  const selected = requests.find((r) => r.id === selectedId);

  async function setArchivedForSelected(archived) {
    if (!selected || deciding) return;
    setDeciding(true);
    setDecideError("");
    try {
      const updated = await api.setArchivedContentRequest({ id: selected.id, archived });
      setRequests((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      // Hiding while the archived section is collapsed removes the card —
      // move selection to the first still-visible row.
      if (archived && !showArchived) {
        const next = requests.find((r) => r.id !== selected.id && !r.archived);
        setSelectedId(next ? next.id : null);
      }
    } catch (e) {
      setDecideError("操作失败：" + (e?.message || e));
    } finally {
      setDeciding(false);
    }
  }

  const canSubmit =
    !submitting && targetPageId &&
    (contentMode === "ai_text" ? desc.trim()
      : contentMode === "manual_text" ? manualText.trim()
      : imageFile);

  async function submitRequest() {
    if (!canSubmit) return;
    setSubmitting(true);

    const page = pages.find((p) => String(p.id) === String(targetPageId));
    const pageTitle = page ? page.title : "";
    const summary = desc.trim();

    // Optimistic placeholder card while the backend drafts (AI placement →
    // in-place page update → row)
    const tempId = "temp-" + Date.now();
    const placeholder = {
      id: tempId, page: pageTitle, content_mode: contentMode,
      status: "drafting",
      summary: summary || (contentMode === "manual_text" ? manualText.trim().slice(0, 60) : "插入图片"),
      before_value: "生成中…", after_value: "生成中…",
      submitted_by: "你", created_at: "刚刚",
    };
    setRequests((prev) => [placeholder, ...prev]);
    setSelectedId(tempId);
    setDesc("");

    try {
      let media = {};
      if (contentMode === "manual_image") {
        const up = await api.uploadMedia(imageFile);
        media = { media_id: up.media_id, media_url: up.media_url };
      }
      const row = await api.createContentRequest({
        wp_page_id: page ? page.id : null,
        page: pageTitle, content_mode: contentMode, summary,
        manual_text: contentMode === "manual_text" ? manualText.trim() : "",
        ...media, model, submitted_by: "你",
      });
      // Replace the placeholder with the real, review-ready row
      setRequests((prev) => prev.map((r) => (r.id === tempId ? row : r)));
      setSelectedId(row.id);
      setManualText("");
      setImageFile(null);
    } catch (e) {
      setRequests((prev) =>
        prev.map((r) =>
          r.id === tempId
            ? { ...r, status: "rejected", after_value: "生成失败：" + e.message }
            : r
        )
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function decide(decision) {
    if (!selected || deciding) return;
    setDeciding(true);
    setDecideError("");
    try {
      const updated = await api.decideContentRequest({ id: selected.id, decision });
      setRequests((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    } catch (e) {
      setDecideError((decision === "approve" ? "发布失败：" : "退回失败：") + (e?.message || e));
    } finally {
      setDeciding(false);
    }
  }

  return (
    <div className="view view--split">
      <div className="pane pane--list">
        <header className="view-header view-header--tight">
          <div>
            <h1>内容发布</h1>
            <p className="view-sub">描述你想改的地方，AI 生成草稿，你确认后一键发布到 WordPress</p>
          </div>
        </header>

        {loadError && <div className="load-error">{loadError}</div>}

        <div className="request-form">
          <div className="mode-tabs">
            {Object.entries(CONTENT_MODE_LABEL).map(([key, label]) => (
              <button
                key={key}
                className={"mode-tab" + (contentMode === key ? " mode-tab--active" : "")}
                onClick={() => setContentMode(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {contentMode === "manual_text" && (
            <textarea
              placeholder="粘贴要放上页面的原文——AI 不会改写，只负责排版和放置位置"
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              rows={3}
            />
          )}
          {contentMode === "manual_image" && (
            <label className="file-row">
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setImageFile(e.target.files?.[0] || null)}
              />
              {imageFile ? imageFile.name : "选择本地图片（上传到 WordPress 媒体库）"}
            </label>
          )}
          <textarea
            placeholder={
              contentMode === "ai_text"
                ? "例如：把首页 banner 的文案改成强调「7天内回复」的承诺"
                : "（可选）放置提示：例如「放在团队介绍下方」"
            }
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            rows={contentMode === "ai_text" ? 3 : 2}
          />
          <div className="request-form-row">
            <select value={targetPageId} onChange={(e) => setTargetPageId(e.target.value)}>
              {pages.length === 0 && <option value="">{loadError ? "后端未连接" : "加载页面中…"}</option>}
              {pages.map((p) => (
                <option key={p.id} value={p.id} disabled={p.status === "publish" || !!p.builder}>
                  {p.title}
                  {p.builder ? `（${p.builder === "elementor" ? "Elementor" : "页面构建器"} · 不支持）`
                    : p.status === "publish" ? "（已上线 · 暂不支持）" : ""}
                </option>
              ))}
            </select>
            <select value={model} onChange={(e) => setModel(e.target.value)} title="AI 模型">
              {models.length === 0 && <option value="">模型…</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <button className="btn btn--primary" onClick={submitRequest} disabled={!canSubmit}>
              <Send size={14} /> {submitting ? "生成中…" : "生成草稿"}
            </button>
          </div>
          <p className="form-note">
            仅支持用 WordPress 普通编辑器制作的页面。用页面构建器（如 Elementor）制作的页面，
            内容存在构建器里，本工具的修改不会生效，已在列表中标灰。
          </p>
        </div>

        {archivedCount > 0 && (
          <button className="archived-toggle" onClick={() => {
            // Collapsing while an archived row is selected would orphan the
            // detail pane — move selection back to a visible row.
            if (showArchived && selected?.archived) {
              const next = requests.find((r) => !r.archived);
              setSelectedId(next ? next.id : null);
            }
            setShowArchived((v) => !v);
          }}>
            {showArchived ? <EyeOff size={13} /> : <Eye size={13} />}
            {showArchived ? "收起已隐藏的记录" : `显示已隐藏的记录（${archivedCount}）`}
          </button>
        )}

        <div className="request-list">
          {visibleRequests.map((r) => (
            <button
              key={r.id}
              className={
                "request-card" +
                (r.id === selectedId ? " request-card--active" : "") +
                (r.archived ? " request-card--archived" : "")
              }
              onClick={() => { setSelectedId(r.id); setDecideError(""); }}
            >
              <div className="request-card-top">
                <span className="request-page">{r.page}</span>
                <Stamp status={r.status} />
              </div>
              <p className="request-summary">{r.summary}</p>
              <div className="request-card-bottom">
                <span className="dim">{r.submitted_by}</span>
                <span className="dim">{r.created_at}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="pane pane--detail">
        {selected ? (
          <>
            <header className="detail-header">
              <div>
                <span className="eyebrow">
                  {selected.page}
                  {" · "}
                  {CONTENT_MODE_LABEL[selected.content_mode] ||
                    CHANGE_TYPE_LABEL[selected.change_type] || selected.change_type}
                  {selected.model_used ? " · " + selected.model_used : ""}
                </span>
                <h2>{selected.summary}</h2>
              </div>
              <Stamp status={selected.status} />
            </header>

            <div className="diff">
              <div className="diff-col">
                <span className="diff-label">变更前</span>
                <p className="diff-text diff-text--before">{selected.before_value}</p>
              </div>
              <div className="diff-col">
                <span className="diff-label">变更后</span>
                <p className="diff-text diff-text--after">{selected.after_value}</p>
              </div>
            </div>

            {selected.generated_snippet && (
              <div className="snippet-box">
                <div className="snippet-head">
                  <span className="diff-label">HTML/CSS 片段（可手动复制粘贴）</span>
                  <button
                    className="btn btn--ghost"
                    onClick={() => {
                      navigator.clipboard?.writeText(selected.generated_snippet);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {copied ? "已复制" : "复制"}
                  </button>
                </div>
                <pre className="snippet-code">{selected.generated_snippet}</pre>
              </div>
            )}

            <button
              className="preview-link"
              onClick={() => selected.wp_preview_url && window.open(selected.wp_preview_url, "_blank")}
              disabled={!selected.wp_preview_url}
            >
              <ExternalLink size={14} /> 在 WordPress 草稿预览中查看真实效果（需先登录 wp-admin）
              <ChevronRight size={14} />
            </button>

            {decideError && <p className="hint-text hint-text--danger">{decideError}</p>}
            {selected.status === "pending_review" && (
              <div className="decision-row">
                <button className="btn btn--danger" onClick={() => decide("reject")} disabled={deciding}>
                  退回修改
                </button>
                <button className="btn btn--success" onClick={() => decide("approve")} disabled={deciding}>
                  <CheckCircle2 size={15} /> {deciding ? "发布中…" : "批准并发布"}
                </button>
              </div>
            )}
            {selected.status === "drafting" && (
              <p className="hint-text">AI 正在生成草稿，完成后会自动进入待审批状态…</p>
            )}
            {selected.status === "published" && (
              <p className="hint-text hint-text--success">已发布到线上站点。</p>
            )}
            {selected.status === "rejected" && (
              <div className="rejected-row">
                <p className="hint-text hint-text--danger">
                  {selected.archived
                    ? "此记录已隐藏，不会出现在默认列表中。"
                    : "已退回，页面已还原到修改前的内容，可以重新描述需求再生成。"}
                </p>
                <button
                  className="btn btn--ghost"
                  onClick={() => setArchivedForSelected(!selected.archived)}
                  disabled={deciding}
                >
                  {selected.archived ? <Eye size={13} /> : <EyeOff size={13} />}
                  {selected.archived ? "取消隐藏" : "隐藏此记录"}
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="dim">选择左侧的请求查看详情</p>
        )}
      </div>
    </div>
  );
}

// ─── Analytics view (placeholder, invites action) ──────────────────────────
function AnalyticsView() {
  return (
    <div className="view">
      <header className="view-header">
        <div>
          <h1>数据看板</h1>
          <p className="view-sub">整合 GA4 与领动的询盘数据，还在规划中</p>
        </div>
      </header>
      <div className="locked-panel">
        <div className="locked-chart">
          {[40, 65, 30, 80, 55, 90, 45].map((h, i) => (
            <div key={i} className="locked-bar" style={{ height: h + "%" }} />
          ))}
        </div>
        <p className="locked-title">这里会是你的询盘转化全景图</p>
        <p className="dim locked-sub">
          告诉我们你最想每天看到哪几个指标——有效询盘数？转化率？渠道对比？
          我们会优先把这些做出来。
        </p>
        <button className="btn btn--primary">
          <MessageSquarePlus size={15} /> 提交你的看板需求
        </button>
      </div>
    </div>
  );
}

// ─── App shell ──────────────────────────────────────────────────────────────
export default function JetsoConsole() {
  const [active, setActive] = useState("publish");
  const [theme, setTheme] = useState("day");
  // auth: 'checking' | 'login' | 'in'
  const [authState, setAuthState] = useState("checking");
  const [userEmail, setUserEmail] = useState(api.currentUser());

  useEffect(() => {
    let alive = true;
    api.authStatus()
      .then(({ auth_required }) => {
        if (!alive) return;
        setAuthState(!auth_required || api.hasSession() ? "in" : "login");
      })
      // Backend unreachable → let the views render their own error banners
      .catch(() => alive && setAuthState("in"));
    const onForcedLogout = () => { setAuthState("login"); setUserEmail(""); };
    window.addEventListener("jetso:logout", onForcedLogout);
    return () => { alive = false; window.removeEventListener("jetso:logout", onForcedLogout); };
  }, []);

  function handleLogout() {
    api.logout();
    setUserEmail("");
    setAuthState("login");
  }

  return (
    <div className={"app theme-" + theme}>
      <style>{`
        .theme-day {
          --bg: #FAFAF8;
          --surface: #FFFFFF;
          --surface-2: #F1EFEB;
          --border: #E1DED7;
          --accent: #21324C;
          --accent-soft: rgba(33,50,76,0.07);
          --accent-contrast: #FFFFFF;
          --text: #17171A;
          --text-dim: #6F6D67;
          --stamp-pending: #96690E;
          --stamp-success: #1F8A55;
          --stamp-danger: #B23A34;
          --stamp-info: #21324C;
        }
        .theme-night {
          --bg: #121114;
          --surface: #1B1A1D;
          --surface-2: #242226;
          --border: #322F33;
          --accent: #8FADD9;
          --accent-soft: rgba(143,173,217,0.14);
          --accent-contrast: #101114;
          --text: #F1F0EC;
          --text-dim: #918E88;
          --stamp-pending: #E8A33D;
          --stamp-success: #3FCB8C;
          --stamp-danger: #E8615D;
          --stamp-info: #8FADD9;
        }

        .app {
          display: flex;
          min-height: 100vh;
          background: var(--bg);
          color: var(--text);
          font-family: 'Inter', -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
          overflow: hidden;
          transition: background 0.2s ease, color 0.2s ease;
        }

        .sidebar {
          width: 220px;
          flex-shrink: 0;
          background: var(--surface);
          border-right: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          padding: 20px 14px;
        }
        .brand { display: flex; align-items: center; gap: 10px; padding: 0 8px 22px 8px; }
        .brand-mark {
          width: 26px; height: 26px; border-radius: 7px;
          background: var(--accent); color: var(--accent-contrast);
          display: flex; align-items: center; justify-content: center;
          font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: 13px;
        }
        .brand-name { font-family: 'IBM Plex Mono', monospace; font-size: 13px; letter-spacing: 0.02em; color: var(--text); }

        nav { display: flex; flex-direction: column; gap: 2px; }
        .nav-item {
          display: flex; align-items: center; gap: 10px;
          background: none; border: none; color: var(--text-dim);
          font-size: 13.5px; padding: 10px 10px; border-radius: 8px;
          cursor: pointer; text-align: left; font-family: inherit;
        }
        .nav-item:hover { background: var(--surface-2); color: var(--text); }
        .nav-item--active { background: var(--accent-soft); color: var(--text); }
        .nav-item--active svg:first-child { color: var(--accent); }
        .nav-lock { margin-left: auto; color: var(--text-dim); }

        .sidebar-footer { margin-top: auto; padding: 8px; display: flex; flex-direction: column; }
        .mock-badge {
          font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.06em;
          color: var(--stamp-pending); border: 1px solid var(--stamp-pending);
          border-radius: 4px; padding: 3px 7px; margin-bottom: 12px; align-self: flex-start;
        }
        .workspace-tag {
          font-family: 'IBM Plex Mono', monospace; font-size: 11px;
          color: var(--text-dim); border-top: 1px solid var(--border); padding-top: 14px;
        }

        .view { flex: 1; padding: 28px 32px; overflow-y: auto; }
        .view-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 22px; }
        .view-header--tight { margin-bottom: 16px; }
        .view h1 { font-size: 19px; font-weight: 700; margin: 0 0 4px 0; letter-spacing: -0.01em; }
        .view-sub { font-size: 13px; color: var(--text-dim); margin: 0; }
        .dim { color: var(--text-dim); }
        .mono { font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; }

        .btn {
          display: inline-flex; align-items: center; gap: 6px;
          font-family: inherit; font-size: 13px; font-weight: 600;
          padding: 9px 14px; border-radius: 8px; border: none; cursor: pointer;
          white-space: nowrap;
        }
        .btn:disabled { opacity: 0.5; cursor: default; }
        .btn--primary { background: var(--accent); color: var(--accent-contrast); }
        .btn--success { background: var(--stamp-success); color: #0B2A1E; }
        .btn--danger { background: transparent; color: var(--text-dim); border: 1px solid var(--border); }

        .theme-toggle {
          display: flex; align-items: center; gap: 7px; width: 100%;
          background: var(--surface-2); border: 1px solid var(--border); color: var(--text-dim);
          font-family: inherit; font-size: 12px; padding: 8px 10px; border-radius: 7px;
          cursor: pointer; margin-bottom: 12px;
        }
        .theme-toggle:hover { color: var(--text); }

        .stamp {
          display: inline-flex; align-items: center; gap: 5px;
          font-family: 'IBM Plex Mono', monospace; font-size: 11px; font-weight: 600;
          color: var(--stamp-color); border: 1px solid var(--stamp-color);
          padding: 3px 8px; border-radius: 4px; transform: rotate(-1.5deg);
          background: color-mix(in srgb, var(--stamp-color) 10%, transparent);
          white-space: nowrap;
        }

        .lead-form {
          background: var(--surface); border: 1px solid var(--border);
          border-radius: 10px; padding: 14px; margin-bottom: 20px; max-width: 720px;
        }
        /* The message box is the primary input — it must LOOK like a field.
           (It used to be borderless, so staff typed into the notes box below.) */
        .lead-raw {
          width: 100%; background: var(--surface-2); border: 1px solid var(--border);
          border-radius: 8px; padding: 10px 12px; color: var(--text);
          font-family: inherit; font-size: 13px; resize: vertical; outline: none;
          line-height: 1.6;
        }
        .lead-raw:focus { border-color: var(--accent); }
        .field-label {
          display: block; font-size: 12px; font-weight: 600; color: var(--text);
          margin: 0 2px 6px;
        }
        .field-req {
          font-weight: 400; font-size: 11px; color: var(--stamp-pending);
          border: 1px solid var(--stamp-pending); border-radius: 3px; padding: 1px 5px;
          margin-left: 4px;
        }
        .field-label .dim { font-weight: 400; font-size: 11.5px; }
        .link-btn {
          background: none; border: none; padding: 0 0 0 6px; cursor: pointer;
          font-family: inherit; font-size: inherit; color: var(--accent);
          text-decoration: underline;
        }
        .parsed-box {
          background: var(--surface-2); border: 1px solid var(--border);
          border-radius: 8px; padding: 10px 12px; margin: 10px 0;
        }
        /* Green edge = tags found, this lead is submittable */
        .parsed-box--ok { border-color: var(--stamp-success); }
        .parsed-row { display: flex; gap: 10px; font-size: 12.5px; padding: 2px 0; }
        .parsed-key { color: var(--text-dim); min-width: 120px; flex-shrink: 0; }
        .lead-notes {
          width: 100%; background: var(--surface); border: 1px solid var(--border);
          color: var(--text); font-family: inherit; font-size: 12.5px;
          border-radius: 7px; padding: 8px 10px; margin: 0 0 12px; outline: none;
        }
        .lead-notes:focus { border-color: var(--accent); }
        .lead-form-row { display: flex; align-items: center; gap: 12px; }
        .lead-form-row .hint-text { margin: 0; flex: 1; }
        .lead-form-row .btn { margin-left: auto; flex-shrink: 0; }

        .table { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
        .table-row {
          display: grid; grid-template-columns: 1.4fr 1.6fr 1fr 1fr;
          padding: 12px 16px; align-items: center; font-size: 13px;
          border-bottom: 1px solid var(--border);
        }
        .table-row:last-child { border-bottom: none; }
        .table-row--head { color: var(--text-dim); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; background: var(--surface); }
        .table-row--leads { grid-template-columns: 1.3fr 1.3fr 1.5fr 0.8fr 0.7fr; }
        .lead-note-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 10px; }

        .view--split { display: flex; gap: 0; padding: 0; }
        .pane { padding: 26px 28px; overflow-y: auto; }
        .pane--list { width: 380px; flex-shrink: 0; border-right: 1px solid var(--border); }
        .pane--detail { flex: 1; }

        .load-error {
          background: #fff3f3; border: 1px solid #fca5a5; color: #b23a34;
          font-size: 12.5px; line-height: 1.5; padding: 10px 12px;
          border-radius: 8px; margin-bottom: 16px;
        }

        .request-form { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px; margin-bottom: 18px; }
        .request-form textarea {
          width: 100%; background: transparent; border: none; color: var(--text);
          font-family: inherit; font-size: 13px; resize: none; outline: none;
        }
        .mode-tabs { display: flex; gap: 4px; margin-bottom: 10px; }
        .mode-tab {
          font-family: inherit; font-size: 12px; font-weight: 600;
          background: var(--surface-2); color: var(--text-dim);
          border: 1px solid var(--border); border-radius: 6px;
          padding: 5px 10px; cursor: pointer;
        }
        .mode-tab--active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
        .file-row {
          display: block; font-size: 12.5px; color: var(--text-dim);
          border: 1px dashed var(--border); border-radius: 7px;
          padding: 9px 10px; margin-bottom: 8px; cursor: pointer;
        }
        .file-row input[type="file"] { display: none; }
        .form-note { font-size: 11px; color: var(--text-dim); line-height: 1.5; margin: 8px 2px 0; }
        .request-form-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
        .request-form-row select {
          background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
          font-family: inherit; font-size: 12.5px; border-radius: 6px; padding: 6px 8px;
          flex: 1 1 120px; min-width: 0; max-width: 100%;
        }
        .request-form-row .btn { margin-left: auto; }

        .archived-toggle {
          display: inline-flex; align-items: center; gap: 6px;
          background: none; border: none; color: var(--text-dim);
          font-family: inherit; font-size: 12px; padding: 0 2px 10px;
          cursor: pointer;
        }
        .archived-toggle:hover { color: var(--text); }
        .request-card--archived { opacity: 0.55; }

        .rejected-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .rejected-row .hint-text { margin: 0; }
        .rejected-row .btn { flex-shrink: 0; display: inline-flex; align-items: center; gap: 5px; }

        .request-list { display: flex; flex-direction: column; gap: 8px; }
        .request-card {
          text-align: left; background: var(--surface); border: 1px solid var(--border);
          border-radius: 10px; padding: 12px 14px; cursor: pointer; font-family: inherit;
        }
        .request-card--active { border-color: var(--accent); background: var(--accent-soft); }
        .request-card-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .request-page { font-size: 12px; color: var(--text-dim); font-family: 'IBM Plex Mono', monospace; }
        .request-summary { font-size: 13px; margin: 0 0 8px 0; line-height: 1.5; }
        .request-card-bottom { display: flex; justify-content: space-between; font-size: 11px; }

        .detail-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
        .eyebrow { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
        .detail-header h2 { font-size: 16px; margin: 6px 0 0 0; font-weight: 700; max-width: 420px; }

        .diff { display: flex; gap: 14px; margin-bottom: 18px; }
        .diff-col { flex: 1; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
        .diff-label { font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
        .diff-text { font-size: 13px; margin: 8px 0 0 0; line-height: 1.6; }
        .diff-text--after { color: var(--text); }
        .diff-text--before { color: var(--text-dim); }

        .snippet-box { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 18px; }
        .snippet-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .snippet-code {
          font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; line-height: 1.55;
          background: var(--surface-2); border-radius: 7px; padding: 10px 12px;
          margin: 0; overflow-x: auto; max-height: 220px; white-space: pre-wrap; word-break: break-all;
        }
        .btn--ghost {
          background: transparent; color: var(--text-dim); border: 1px solid var(--border);
          font-size: 11.5px; padding: 4px 10px;
        }
        .btn--ghost:hover { color: var(--text); }

        .preview-link {
          display: flex; align-items: center; gap: 8px; width: 100%;
          background: var(--surface); border: 1px dashed var(--border); color: var(--text-dim);
          font-family: inherit; font-size: 12.5px; padding: 10px 14px; border-radius: 8px;
          cursor: pointer; margin-bottom: 20px;
        }
        .preview-link:disabled { cursor: default; opacity: 0.6; }
        .preview-link svg:last-child { margin-left: auto; }

        .decision-row { display: flex; gap: 10px; }
        .hint-text { font-size: 12.5px; color: var(--text-dim); }
        .hint-text--success { color: var(--stamp-success); }
        .hint-text--danger { color: var(--stamp-danger); }

        .login-wrap {
          flex: 1; display: flex; align-items: center; justify-content: center;
          min-height: 100vh;
        }
        .login-card {
          background: var(--surface); border: 1px solid var(--border);
          border-radius: 12px; padding: 30px 28px; width: 340px;
          display: flex; flex-direction: column;
        }
        .login-card input {
          background: var(--surface-2); border: 1px solid var(--border);
          color: var(--text); font-family: inherit; font-size: 13.5px;
          border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; outline: none;
        }
        .login-card input:focus { border-color: var(--accent); }
        .login-btn { justify-content: center; margin-top: 4px; }

        .user-row {
          display: flex; align-items: center; gap: 6px; width: 100%;
          background: none; border: none; color: var(--text-dim);
          font-family: 'IBM Plex Mono', monospace; font-size: 11px;
          padding: 0 2px 12px; cursor: pointer;
        }
        .user-row:hover { color: var(--stamp-danger); }
        .user-email { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        .locked-panel {
          display: flex; flex-direction: column; align-items: center; text-align: center;
          background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
          padding: 40px 30px; max-width: 480px; margin: 20px auto 0;
        }
        .locked-chart { display: flex; align-items: flex-end; gap: 8px; height: 90px; margin-bottom: 22px; opacity: 0.35; }
        .locked-bar { width: 20px; background: var(--accent); border-radius: 3px 3px 0 0; }
        .locked-title { font-size: 14.5px; font-weight: 600; margin: 0 0 8px 0; }
        .locked-sub { font-size: 12.5px; margin: 0 0 20px 0; max-width: 360px; line-height: 1.6; }
      `}</style>

      {authState === "checking" ? (
        <div className="login-wrap"><p className="dim">加载中…</p></div>
      ) : authState === "login" ? (
        <LoginView onLoggedIn={() => { setUserEmail(api.currentUser()); setAuthState("in"); }} />
      ) : (
        <>
          <Sidebar
            active={active} setActive={setActive} theme={theme} setTheme={setTheme}
            userEmail={userEmail} onLogout={handleLogout}
          />
          {active === "leads" && <LeadsView />}
          {active === "publish" && <PublishView />}
          {active === "analytics" && <AnalyticsView />}
        </>
      )}
    </div>
  );
}
