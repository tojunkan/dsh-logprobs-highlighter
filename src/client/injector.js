/**
 * logprobs-highlighter — 正文高亮注入器 + hover 标注（P0）
 *
 * 设计验证结论（真机实验）：
 * - 官方正文容器锚点：`[data-chat-flow-kind="assistant-step"][data-chat-turn=N][data-chat-group-part="response"]`
 * - 只有进入渲染树的节点（getClientRects().length > 0）才能渲染高亮（dsh 用
 *   content-visibility / 虚拟滚动，屏幕外的节点没有布局）
 * - 跨块 Range 可能不渲染 → 按文本节点切分成多个单节点 Range
 * - 后端字符偏移基于 markdown 源码，DOM 是渲染后文本 → 两边归一化（去空白、
 *   丢弃 inline code/math/image）后用 `plain` 做 indexOf 定位
 *
 * 注入器是幂等的：每次从零重算、整体替换同名 Highlight。
 *
 * @module logprobs-highlighter/client/injector
 */

const STYLE_ID = "lph-highlight-style";
const TOOLTIP_ID = "lph-tooltip";
const PILL_ID = "lph-annotation-pill";

const VERDICT_LABELS = {
  highlighter_correct: "确实有错",
  reasonable_ambiguity: "合理歧义",
  highlighter_misjudge: "纯误报",
  unsure: "不确定",
};

const ERROR_OPTIONS = [
  ["factual_error", "事实错误"],
  ["fabrication", "事实捏造"],
  ["self_contradiction", "上下文矛盾"],
  ["user_contradiction", "与输入矛盾"],
  ["logic_gap", "逻辑跳跃"],
  ["conflicting_sources", "来源冲突"],
  ["other", "其他"],
  ["cannot_tell", "说不清"],
];

const AMBIGUITY_OPTIONS = [
  ["continuation", "多种接续"],
  ["wording", "措辞斟酌"],
  ["opening", "句首开场"],
  ["other", "其他"],
  ["cannot_tell", "说不清"],
];

const MISJUDGE_OPTIONS = [
  ["paraphrase", "同义改写"],
  ["format", "格式/符号"],
  ["function_word", "虚词/连接"],
  ["correct_entity", "实体正确"],
  ["code_or_math", "代码/公式"],
  ["other", "其他"],
  ["cannot_tell", "说不清"],
];

/** turn → { norm, segs, metas, ctx }（clear 用）。 */
const state = new Map();
/** 节点 → { norm, segs, metas, ctx }（hover 用）。 */
const nodeState = new WeakMap();

let annotationEnabled = false;
let pillBound = false;
let hideTimer = 0;
let lastX = 0;
let lastY = 0;

let activeKey = null;
let activeSentence = null;
let activeCtx = null;
let selectedTrigger = null;
let submitting = false;
let statusText = null;
let errorText = null;

/** 为一个 turn 注册一次 `::highlight(lph-red-<turn>)` 规则。 */
function ensureRule(name) {
  if (typeof document === "undefined") return;
  let st = document.getElementById(STYLE_ID);
  if (!st) {
    st = document.createElement("style");
    st.id = STYLE_ID;
    document.head.appendChild(st);
  }
  const rule = `::highlight(${name}){background-color:rgba(239,68,68,.18);}`;
  if (!st.textContent.includes(rule)) st.textContent += rule;
}

/** 找该 turn 的正文容器：取最后一个可见且有文本的 response 节点。 */
function findTarget(turn) {
  const sel = `[data-chat-turn="${turn}"][data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]`;
  const nodes = [...document.querySelectorAll(sel)];
  for (let i = nodes.length - 1; i >= 0; i--) {
    if ((nodes[i].innerText || "").trim().length > 0) return nodes[i];
  }
  return null;
}

/** 建立「归一化文本（去空白）→ 文本节点」映射。 */
function buildNormMap(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (p && p.closest("pre, code, .katex, .katex-display, mjx-container, math, style, script, svg")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const segs = [];
  let norm = "";
  let n;
  while ((n = walker.nextNode())) {
    const raw = n.nodeValue;
    let kept = "";
    for (let i = 0; i < raw.length; i++) {
      if (!/\s/.test(raw[i])) kept += raw[i];
    }
    if (kept.length === 0) continue;
    segs.push({ node: n, raw, start: norm.length, end: norm.length + kept.length });
    norm += kept;
  }
  return { norm, segs };
}

/** 段内第 k 个非空白字符对应的原始偏移。 */
function normToRaw(seg, k) {
  let count = 0;
  for (let i = 0; i < seg.raw.length; i++) {
    if (/\s/.test(seg.raw[i])) continue;
    if (count === k) return i;
    count++;
  }
  return seg.raw.length;
}

/** 句子（`plain` 归一化文本）→ Range 数组 + 句子区间（hover 用）。 */
function rangesFor(sentences, norm, segs) {
  const ranges = [];
  const metas = [];
  let from = 0;
  for (const s of sentences) {
    const needle = s && s.plain;
    if (!needle) continue;
    const idx = norm.indexOf(needle, from);
    if (idx < 0) continue;
    from = idx + needle.length;
    const end = idx + needle.length;
    const local = [];
    for (const seg of segs) {
      const a = Math.max(idx, seg.start);
      const b = Math.min(end, seg.end);
      if (b <= a) continue;
      const k1 = a - seg.start;
      const k2 = b - seg.start;
      const rawStart = normToRaw(seg, k1);
      const rawEnd = k2 >= seg.end - seg.start ? seg.raw.length : normToRaw(seg, k2);
      if (rawEnd > rawStart) {
        const r = document.createRange();
        r.setStart(seg.node, rawStart);
        r.setEnd(seg.node, rawEnd);
        local.push(r);
        ranges.push(r);
      }
    }
    metas.push({ start: idx, end, sentence: s, ranges: local });
  }
  return { ranges, metas };
}

/* ------------------------------------------------------------------ *
 * 标注开关
 * ------------------------------------------------------------------ */

function annotationOn() {
  if (!annotationEnabled) return false;
  try {
    return (localStorage.getItem("lph.annotationMode") || "on") !== "off";
  } catch {
    return true;
  }
}

function ensurePill() {
  if (typeof document === "undefined") return;
  let el = document.getElementById(PILL_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = PILL_ID;
    el.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483001",
      "padding:5px 10px",
      "border-radius:999px",
      "background:rgba(18,18,20,.9)",
      "color:#fff",
      "font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      "border:1px solid rgba(255,255,255,.18)",
      "box-shadow:0 4px 16px rgba(0,0,0,.24)",
      "cursor:pointer",
      "user-select:none",
      "opacity:.86",
    ].join(";");
    el.addEventListener("click", () => {
      if (!annotationEnabled) return;
      try {
        const next = annotationOn() ? "off" : "on";
        localStorage.setItem("lph.annotationMode", next);
      } catch {
        // localStorage 不可用时忽略。
      }
      if (!annotationOn()) hidePopover();
      updatePill();
    });
    document.body.appendChild(el);
  }
  if (!pillBound) {
    pillBound = true;
    window.addEventListener("keydown", (event) => {
      if (!event.altKey || String(event.key).toLowerCase() !== "l") return;
      if (!annotationEnabled) return;
      event.preventDefault();
      try {
        const next = annotationOn() ? "off" : "on";
        localStorage.setItem("lph.annotationMode", next);
      } catch {
        // ignore
      }
      if (!annotationOn()) hidePopover();
      updatePill();
    });
  }
  updatePill();
}

function updatePill() {
  const el = document.getElementById(PILL_ID);
  if (!el) return;
  if (!annotationEnabled) {
    el.textContent = "标注: 不可用";
    el.style.opacity = ".45";
    el.title = "插件配置 annotationEnabled=false";
    return;
  }
  const on = annotationOn();
  el.textContent = on ? "标注: 开" : "标注: 关";
  el.style.opacity = on ? ".9" : ".6";
  el.title = "Alt+L 切换标注";
}

/* ------------------------------------------------------------------ *
 * Hover popover
 * ------------------------------------------------------------------ */

function popoverEl() {
  if (typeof document === "undefined") return null;
  let el = document.getElementById(TOOLTIP_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = TOOLTIP_ID;
  el.style.cssText = [
    "position:fixed",
    "z-index:2147483000",
    "display:none",
    "max-width:380px",
    "padding:8px 10px",
    "border-radius:8px",
    "background:rgba(18,18,20,.96)",
    "color:#fff",
    "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
    "box-shadow:0 4px 16px rgba(0,0,0,.28)",
    "white-space:normal",
    "word-break:break-word",
    "pointer-events:auto",
  ].join(";");
  el.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  el.addEventListener("mouseleave", () => scheduleHide());
  document.body.appendChild(el);
  return el;
}

function positionPopover(x, y) {
  lastX = x;
  lastY = y;
  const el = document.getElementById(TOOLTIP_ID);
  if (!el || el.style.display === "none") return;
  const pad = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect = el.getBoundingClientRect();
  const left = x + pad + rect.width > vw ? x - rect.width - pad : x + pad;
  const topPos = y + pad + rect.height > vh ? y - rect.height - pad : y + pad;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, topPos)}px`;
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hidePopover();
  }, 300);
}

function hidePopover() {
  const el = document.getElementById(TOOLTIP_ID);
  if (el) el.style.display = "none";
  activeKey = null;
  activeSentence = null;
  activeCtx = null;
  selectedTrigger = null;
  statusText = null;
  errorText = null;
}

function markKey(sentence) {
  return sentence?.markId || sentence?.sentenceKey || sentence?.plain || "";
}

function addLine(parent, text, style = {}) {
  const line = document.createElement("div");
  line.textContent = text;
  Object.assign(line.style, style);
  parent.appendChild(line);
  return line;
}

function button(text, onClick, { active = false, disabled = false } = {}) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.disabled = disabled;
  b.style.cssText = [
    "padding:3px 8px",
    "border-radius:4px",
    "border:1px solid rgba(255,255,255,.2)",
    "background:" + (active ? "rgba(96,165,250,.32)" : "rgba(255,255,255,.12)"),
    "color:#fff",
    "font:inherit",
    "cursor:" + (disabled ? "default" : "pointer"),
    "opacity:" + (disabled ? ".55" : "1"),
  ].join(";");
  b.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!disabled) onClick();
  });
  return b;
}

function renderExcerpt(el, sentence) {
  const text = sentence.text || sentence.plain || "";
  if (!text) return;
  const ranges = (Array.isArray(sentence.triggers) ? sentence.triggers : [])
    .map((t, i) => ({ ...t, triggerIndex: i }))
    .filter((t) => Number.isInteger(t.start)
      && Number.isInteger(t.end)
      && t.start >= 0
      && t.end <= text.length
      && t.end > t.start)
    .sort((a, b) => a.start - b.start);
  if (!sentence.markId || ranges.length === 0) {
    addLine(el, String(text).replace(/\*\*/g, "").replace(/^[#>\-\s]+/, "").slice(0, 200), {
      opacity: ".72",
      marginBottom: "6px",
    });
    return;
  }
  const box = document.createElement("div");
  box.style.cssText = "margin-bottom:6px;line-height:1.55";
  let pos = 0;
  for (const range of ranges) {
    if (range.start < pos) continue;
    if (range.start > pos) box.appendChild(document.createTextNode(text.slice(pos, range.start)));
    const span = document.createElement("span");
    span.textContent = text.slice(range.start, range.end);
    span.style.background = selectedTrigger === range.triggerIndex
      ? "rgba(239,68,68,.72)"
      : "rgba(239,68,68,.28)";
    span.style.borderRadius = "2px";
    span.style.color = "#fff";
    span.title = "实写 token 在原文中的位置";
    box.appendChild(span);
    pos = range.end;
  }
  if (pos < text.length) box.appendChild(document.createTextNode(text.slice(pos)));
  el.appendChild(box);
}

function renderPopover(sentence, ctx) {
  const el = popoverEl();
  if (!el) return;
  el.textContent = "";

  renderExcerpt(el, sentence);

  const triggers = Array.isArray(sentence.triggers) ? sentence.triggers.slice(0, 3) : [];
  triggers.forEach((t, i) => {
    const actual = typeof t.token === "string" ? t.token : "";
    const top = Array.isArray(t.top) ? t.top : [];
    const alt = top.find((c) => c && typeof c.token === "string" && c.token !== actual)?.token ?? "";
    const row = document.createElement("div");
    const parts = [`实写 ${actual || "∅"}`];
    if (alt) parts.push(`备选 ${alt}`);
    parts.push(`${(Number(t.confidence ?? 0) * 100).toFixed(1)}%`);
    if (t.category) parts.push(t.category);
    row.textContent = parts.join(" · ");
    row.title = "实写是原句中的 token；备选是模型的其他候选，不一定出现在原句。点击选中为问题词。";
    row.style.cssText = [
      "padding:3px 5px",
      "margin:2px 0",
      "border-radius:4px",
      "cursor:pointer",
      "background:" + (selectedTrigger === i ? "rgba(255,255,255,.16)" : "transparent"),
    ].join(";");
    row.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectedTrigger = selectedTrigger === i ? null : i;
      renderPopover(sentence, ctx);
    });
    el.appendChild(row);
  });

  if (!ctx.annotationEnabled || !sentence.markId) {
    addLine(el, "当前没有可标注的 annotation", { opacity: ".55", marginTop: "6px" });
    return;
  }
  if (!annotationOn()) {
    addLine(el, "标注已关闭（Alt+L 开启）", { opacity: ".55", marginTop: "6px" });
    return;
  }

  if (statusText) addLine(el, statusText, { color: "#86efac", marginTop: "6px" });
  if (errorText) addLine(el, errorText, { color: "#fca5a5", marginTop: "6px" });

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:8px";
  const current = sentence.verdict ?? "unsure";

  actions.appendChild(button("确实有错", () => {
    if (current !== "highlighter_correct") {
      submitFeedback(sentence, ctx, "highlighter_correct", { error_type: "cannot_tell" });
    }
  }, { active: current === "highlighter_correct", disabled: submitting }));

  actions.appendChild(button("合理歧义", () => {
    if (current !== "reasonable_ambiguity") {
      submitFeedback(sentence, ctx, "reasonable_ambiguity", { ambiguity_kind: "cannot_tell" });
    }
  }, { active: current === "reasonable_ambiguity", disabled: submitting }));

  actions.appendChild(button("纯误报", () => {
    if (current !== "highlighter_misjudge") {
      submitFeedback(sentence, ctx, "highlighter_misjudge", { misjudge_reason: "cannot_tell" });
    }
  }, { active: current === "highlighter_misjudge", disabled: submitting }));

  actions.appendChild(button("不确定", () => {
    if (current !== "unsure") {
      submitFeedback(sentence, ctx, "unsure", {});
    }
  }, { active: current === "unsure", disabled: submitting }));

  el.appendChild(actions);

  let options = null;
  let field = null;
  let title = "";
  if (current === "highlighter_correct") {
    options = ERROR_OPTIONS;
    field = "error_type";
    title = "错误类型：";
  } else if (current === "reasonable_ambiguity") {
    options = AMBIGUITY_OPTIONS;
    field = "ambiguity_kind";
    title = "歧义类型：";
  } else if (current === "highlighter_misjudge") {
    options = MISJUDGE_OPTIONS;
    field = "misjudge_reason";
    title = "误报原因：";
  }
  if (options) {
    addLine(el, title, { opacity: ".65", marginTop: "7px" });
    const reasons = document.createElement("div");
    reasons.style.cssText = "display:flex;gap:5px;flex-wrap:wrap;margin-top:3px";
    for (const [value, label] of options) {
      const selected = sentence[field] === value;
      reasons.appendChild(button(label, () => {
        submitFeedback(sentence, ctx, current, { [field]: value });
      }, { active: selected, disabled: submitting }));
    }
    el.appendChild(reasons);
  }

  if (current !== "unsure") {
    const reasonLabel = options
      ? options.find(([v]) => v === sentence[field])?.[1] ?? sentence[field]
      : "";
    addLine(el, `当前：${VERDICT_LABELS[current] ?? current}${reasonLabel ? ` · ${reasonLabel}` : ""}`, {
      opacity: ".55",
      marginTop: "6px",
    });
  }

  positionPopover(lastX, lastY);
}

async function submitFeedback(sentence, ctx, verdict, values = {}) {
  if (submitting || !sentence?.markId || !ctx?.captureId) return;
  submitting = true;
  statusText = null;
  errorText = null;
  renderPopover(sentence, ctx);
  const errorType = verdict === "highlighter_correct"
    ? (values.error_type ?? "cannot_tell")
    : null;
  const ambiguityKind = verdict === "reasonable_ambiguity"
    ? (values.ambiguity_kind ?? "cannot_tell")
    : null;
  const misjudgeReason = verdict === "highlighter_misjudge"
    ? (values.misjudge_reason ?? "cannot_tell")
    : null;
  const body = {
    markId: sentence.markId,
    sentenceKey: sentence.sentenceKey ?? null,
    captureId: ctx.captureId,
    sessionId: ctx.sessionId ?? null,
    turn: ctx.turn ?? null,
    step: ctx.step ?? null,
    verdict,
    error_type: errorType,
    ambiguity_kind: ambiguityKind,
    misjudge_reason: misjudgeReason,
    focus: sentence.focus ?? null,
    triggerIndex: Number.isInteger(selectedTrigger) ? selectedTrigger : null,
    uiMode: "inline",
  };
  try {
    const res = await fetch("/plugins/logprobs-highlighter/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }
    sentence.verdict = verdict;
    sentence.error_type = errorType;
    sentence.ambiguity_kind = ambiguityKind;
    sentence.misjudge_reason = misjudgeReason;
    sentence.triggerIndex = Number.isInteger(selectedTrigger) ? selectedTrigger : null;
    statusText = "已记录";
    errorText = null;
  } catch (err) {
    errorText = `记录失败：${err?.message ?? err}`;
  } finally {
    submitting = false;
    if (activeSentence === sentence) renderPopover(sentence, ctx);
  }
}

/* ------------------------------------------------------------------ *
 * Hover hit testing
 * ------------------------------------------------------------------ */

function hitAtPoint(st, x, y) {
  for (const m of st.metas) {
    for (const r of m.ranges) {
      const rects = r.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const rect = rects[i];
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return { sentence: m.sentence, ctx: st.ctx };
        }
      }
    }
  }
  return null;
}

function showPopover(sentence, ctx, x, y) {
  const key = markKey(sentence);
  const isNew = activeKey !== key;
  if (isNew) {
    activeKey = key;
    activeSentence = sentence;
    activeCtx = ctx;
    selectedTrigger = Number.isInteger(sentence.triggerIndex) ? sentence.triggerIndex : null;
    statusText = null;
    errorText = null;
    renderPopover(sentence, ctx);
  } else {
    activeSentence = sentence;
    activeCtx = ctx;
  }
  const el = document.getElementById(TOOLTIP_ID);
  if (!el) return;
  const wasHidden = el.style.display === "none";
  el.style.display = "block";
  // 出现后固定位置；只有换句子或重新出现时才重新定位。
  if (isNew || wasHidden) positionPopover(x, y);
}

/** 给正文容器绑定 hover（节点被虚拟滚动替换后由 paint 重新绑定）。 */
function bindHover(target, turn) {
  if (target.dataset.lphHover === "1") return;
  target.dataset.lphHover = "1";
  let raf = 0;
  target.addEventListener("mousemove", (e) => {
    if (raf) return;
    const x = e.clientX;
    const y = e.clientY;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const st = nodeState.get(target);
      if (!st || st.metas.length === 0) return;
      const hit = hitAtPoint(st, x, y);
      if (hit) showPopover(hit.sentence, hit.ctx, x, y);
      else scheduleHide();
    });
  });
  target.addEventListener("mouseleave", scheduleHide);
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * 全量重绘一个 turn 的红色高亮。
 * @param {number} turn
 * @param {{sentences: object[], captureId?: string, annotation?: object, key?: object}} data
 * @returns {boolean} 是否成功（false = 节点不可见/尚未挂载，交给调用方重试）
 */
export function paint(turn, data) {
  if (typeof window === "undefined") return false;
  if (!window.CSS || !window.CSS.highlights || typeof window.Highlight === "undefined") return false;
  const sentences = Array.isArray(data) ? data : (data?.sentences ?? []);
  annotationEnabled = Boolean(data && !Array.isArray(data) && data.annotation && data.annotation.enabled);
  ensurePill();
  const name = `lph-red-${turn}`;
  const target = findTarget(turn);
  if (!target) return false;
  if (target.getClientRects().length === 0) return false; // 不在渲染树
  const map = buildNormMap(target);
  if (map.segs.length === 0) return false;
  const reds = (sentences || []).filter((s) => s && s.level === "red");
  const ctx = {
    captureId: data && !Array.isArray(data) ? data.captureId ?? null : null,
    sessionId: data && !Array.isArray(data) ? data.key?.sessionId ?? null : null,
    turn: data && !Array.isArray(data) ? data.key?.turn ?? turn : turn,
    step: data && !Array.isArray(data) ? data.key?.step ?? null : null,
    annotationEnabled,
  };
  if (reds.length === 0) {
    window.CSS.highlights.delete(name);
    state.delete(turn);
    nodeState.set(target, { norm: map.norm, segs: map.segs, metas: [], ctx });
    return true;
  }
  const { ranges, metas } = rangesFor(reds, map.norm, map.segs);
  state.set(turn, { norm: map.norm, segs: map.segs, metas, ctx });
  nodeState.set(target, { norm: map.norm, segs: map.segs, metas, ctx });
  bindHover(target, turn);
  if (ranges.length === 0) {
    window.CSS.highlights.delete(name);
    return true;
  }
  ensureRule(name);
  window.CSS.highlights.set(name, new window.Highlight(...ranges));
  return true;
}

/** 清除一个 turn 的高亮与 hover 状态。 */
export function clear(turn) {
  state.delete(turn);
  hidePopover();
  if (typeof window === "undefined" || !window.CSS || !window.CSS.highlights) return;
  window.CSS.highlights.delete(`lph-red-${turn}`);
}
