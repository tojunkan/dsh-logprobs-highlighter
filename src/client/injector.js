/**
 * logprobs-highlighter — 正文高亮注入器（Range + CSS Custom Highlight）
 *
 * 设计验证结论（真机实验）：
 * - 官方正文容器锚点：`[data-chat-flow-kind="assistant-step"][data-chat-turn=N][data-chat-group-part="response"]`
 * - 只有进入渲染树的节点（getClientRects().length > 0）才能渲染高亮（dsh 用
 *   content-visibility / 虚拟滚动，屏幕外的节点没有布局）
 * - 跨块 Range 可能不渲染 → 按文本节点切分成多个单节点 Range
 * - 后端字符偏移基于 markdown 源码，DOM 是渲染后文本 → 两边归一化（去空白）
 *   后用 `plain` 做 indexOf 定位，再映射回原始偏移
 *
 * 注入器是幂等的：每次从零重算、整体替换同名 Highlight。
 *
 * @module logprobs-highlighter/client/injector
 */

const STYLE_ID = "lph-highlight-style";
const TOOLTIP_ID = "lph-tooltip";

/** turn → { norm, segs, metas }（clear 用）。 */
const state = new Map();
/** 节点 → { norm, segs, metas }（hover 用；按节点存，避免同 turn 多 step 互相覆盖）。 */
const nodeState = new WeakMap();

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

/**
 * 建立「归一化文本（去空白）→ 文本节点」映射。
 */
function buildNormMap(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (p && p.closest("pre, code, .katex, style, script, svg")) return NodeFilter.FILTER_REJECT;
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
    // hover 用几何命中（鼠标坐标落在 Range 的矩形内），不依赖字符偏移。
    metas.push({ start: idx, end, sentence: s, ranges: local });
  }
  return { ranges, metas };
}

/* ------------------------------------------------------------------ *
 * Hover tooltip
 * ------------------------------------------------------------------ */

function tooltipEl() {
  let el = document.getElementById(TOOLTIP_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = TOOLTIP_ID;
  el.style.cssText = [
    "position:fixed",
    "z-index:2147483000",
    "pointer-events:none",
    "display:none",
    "max-width:360px",
    "padding:6px 9px",
    "border-radius:6px",
    "background:rgba(18,18,20,.94)",
    "color:#fff",
    "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
    "box-shadow:0 4px 16px rgba(0,0,0,.28)",
    "white-space:pre-wrap",
    "word-break:break-word",
  ].join(";");
  document.body.appendChild(el);
  return el;
}

function hideTooltip() {
  const el = document.getElementById(TOOLTIP_ID);
  if (el) el.style.display = "none";
}

/**
 * 显示：整句 + 句内每个可疑词“实际写的（模型更想写的）· 置信”。
 * @param {number} x 鼠标 clientX
 * @param {number} y 鼠标 clientY
 * @param {object} sentence 句子数据（text/triggers/reason）
 */
function showTooltip(x, y, sentence) {
  const el = tooltipEl();
  const triggers = Array.isArray(sentence.triggers) && sentence.triggers.length > 0
    ? sentence.triggers
    : (sentence.reason ? [{ ...sentence.reason, top: Array.isArray(sentence.reason.top) ? sentence.reason.top : [] }] : []);

  el.textContent = "";

  // 第一行：整句（去掉 markdown 强调符号，截断 90 字）。
  if (sentence.text) {
    const line = document.createElement("div");
    line.style.opacity = "0.78";
    line.style.marginBottom = "5px";
    line.style.fontFamily = "inherit";
    line.textContent = String(sentence.text).replace(/\*\*/g, "").replace(/^[#>\-\s]+/, "").slice(0, 90);
    el.appendChild(line);
  }

  // 每个可疑词：实际写的词（模型更想写的词）· 置信
  for (const t of triggers.slice(0, 3)) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "baseline";
    row.style.gap = "8px";

    const actual = typeof t.token === "string" ? t.token : "";
    const top = Array.isArray(t.top) ? t.top : [];
    // top_logprobs 是“模型最想写的词”，实际输出不一定是 top[0]，所以先跳过与 actual 相同的候选。
    const alt = top.find((c) => c && typeof c.token === "string" && c.token !== actual)?.token ?? "";

    const head = document.createElement("span");
    head.style.fontWeight = "600";
    head.textContent = alt ? `${actual}（${alt}）` : actual;

    const tail = document.createElement("span");
    tail.style.opacity = "0.7";
    tail.textContent = `${(Number(t.confidence ?? 0) * 100).toFixed(1)}%${t.category ? ` · ${t.category}` : ""}`;

    row.append(head, tail);
    el.appendChild(row);
  }

  el.style.display = "block";
  const pad = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect = el.getBoundingClientRect();
  const left = x + pad + rect.width > vw ? x - rect.width - pad : x + pad;
  const topPos = y + pad + rect.height > vh ? y - rect.height - pad : y + pad;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, topPos)}px`;
}

/** 鼠标坐标是否落在某个句子 Range 的矩形内（几何命中）。 */
function hitAtPoint(st, x, y) {
  for (const m of st.metas) {
    for (const r of m.ranges) {
      const rects = r.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const rect = rects[i];
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return m.sentence;
        }
      }
    }
  }
  return null;
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
      if (hit) showTooltip(x, y, hit);
      else hideTooltip();
    });
  });
  target.addEventListener("mouseleave", hideTooltip);
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * 全量重绘一个 turn 的红色高亮。
 * @returns {boolean} 是否成功（false = 节点不可见/尚未挂载，交给调用方重试）
 */
export function paint(turn, sentences) {
  if (typeof window === "undefined") return false;
  if (!window.CSS || !window.CSS.highlights || typeof window.Highlight === "undefined") return false;
  const name = `lph-red-${turn}`;
  const target = findTarget(turn);
  if (!target) return false;
  if (target.getClientRects().length === 0) return false; // 不在渲染树
  const map = buildNormMap(target);
  if (map.segs.length === 0) return false;
  const reds = (sentences || []).filter((s) => s && s.level === "red");
  if (reds.length === 0) {
    window.CSS.highlights.delete(name);
    state.delete(turn);
    return true;
  }
  const { ranges, metas } = rangesFor(reds, map.norm, map.segs);
  state.set(turn, { norm: map.norm, segs: map.segs, metas });
  nodeState.set(target, { norm: map.norm, segs: map.segs, metas });
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
  hideTooltip();
  if (typeof window === "undefined" || !window.CSS || !window.CSS.highlights) return;
  window.CSS.highlights.delete(`lph-red-${turn}`);
}