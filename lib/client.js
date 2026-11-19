/**
 * GENERATED FILE — 由 scripts/build-client.mjs 构建，勿手改。
 * 源码：src/client/index.js（+ injector.js）。
 */
window.__ModuleLoader__.load({
  id: "dsh-logprobs-highlighter",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __export = (target, all) => {
      for (var name in all)
        __defProp(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames(from))
          if (!__hasOwnProp.call(to, key) && key !== except)
            __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
    
    // src/client/index.js
    var index_exports = {};
    __export(index_exports, {
      apply: () => apply,
      inject: () => inject
    });
    module.exports = __toCommonJS(index_exports);
    var import_react = require("react");
    
    // src/client/injector.js
    var STYLE_ID = "lph-highlight-style";
    var TOOLTIP_ID = "lph-tooltip";
    var PILL_ID = "lph-annotation-pill";
    var VERDICT_LABELS = {
      highlighter_correct: "\u786E\u5B9E\u6709\u9519",
      reasonable_ambiguity: "\u5408\u7406\u6B67\u4E49",
      highlighter_misjudge: "\u7EAF\u8BEF\u62A5",
      unsure: "\u4E0D\u786E\u5B9A"
    };
    var ERROR_OPTIONS = [
      ["factual_error", "\u4E8B\u5B9E\u9519\u8BEF"],
      ["fabrication", "\u4E8B\u5B9E\u634F\u9020"],
      ["self_contradiction", "\u4E0A\u4E0B\u6587\u77DB\u76FE"],
      ["user_contradiction", "\u4E0E\u8F93\u5165\u77DB\u76FE"],
      ["logic_gap", "\u903B\u8F91\u8DF3\u8DC3"],
      ["conflicting_sources", "\u6765\u6E90\u51B2\u7A81"],
      ["other", "\u5176\u4ED6"],
      ["cannot_tell", "\u8BF4\u4E0D\u6E05"]
    ];
    var AMBIGUITY_OPTIONS = [
      ["continuation", "\u591A\u79CD\u63A5\u7EED"],
      ["wording", "\u63AA\u8F9E\u659F\u914C"],
      ["opening", "\u53E5\u9996\u5F00\u573A"],
      ["other", "\u5176\u4ED6"],
      ["cannot_tell", "\u8BF4\u4E0D\u6E05"]
    ];
    var MISJUDGE_OPTIONS = [
      ["paraphrase", "\u540C\u4E49\u6539\u5199"],
      ["format", "\u683C\u5F0F/\u7B26\u53F7"],
      ["function_word", "\u865A\u8BCD/\u8FDE\u63A5"],
      ["correct_entity", "\u5B9E\u4F53\u6B63\u786E"],
      ["code_or_math", "\u4EE3\u7801/\u516C\u5F0F"],
      ["other", "\u5176\u4ED6"],
      ["cannot_tell", "\u8BF4\u4E0D\u6E05"]
    ];
    var state = /* @__PURE__ */ new Map();
    var nodeState = /* @__PURE__ */ new WeakMap();
    var annotationEnabled = false;
    var pillBound = false;
    var hideTimer = 0;
    var lastX = 0;
    var lastY = 0;
    var activeKey = null;
    var activeSentence = null;
    var activeCtx = null;
    var selectedTrigger = null;
    var submitting = false;
    var statusText = null;
    var errorText = null;
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
    function findTarget(turn) {
      const sel = `[data-chat-turn="${turn}"][data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]`;
      const nodes = [...document.querySelectorAll(sel)];
      for (let i = nodes.length - 1; i >= 0; i--) {
        if ((nodes[i].innerText || "").trim().length > 0) return nodes[i];
      }
      return null;
    }
    function buildNormMap(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n2) {
          if (!n2.nodeValue || !n2.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const p = n2.parentElement;
          if (p && p.closest("pre, code, .katex, .katex-display, mjx-container, math, style, script, svg")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const segs = [];
      let norm = "";
      let n;
      while (n = walker.nextNode()) {
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
    function normToRaw(seg, k) {
      let count = 0;
      for (let i = 0; i < seg.raw.length; i++) {
        if (/\s/.test(seg.raw[i])) continue;
        if (count === k) return i;
        count++;
      }
      return seg.raw.length;
    }
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
          "opacity:.86"
        ].join(";");
        el.addEventListener("click", () => {
          if (!annotationEnabled) return;
          try {
            const next = annotationOn() ? "off" : "on";
            localStorage.setItem("lph.annotationMode", next);
          } catch {
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
        el.textContent = "\u6807\u6CE8: \u4E0D\u53EF\u7528";
        el.style.opacity = ".45";
        el.title = "\u63D2\u4EF6\u914D\u7F6E annotationEnabled=false";
        return;
      }
      const on = annotationOn();
      el.textContent = on ? "\u6807\u6CE8: \u5F00" : "\u6807\u6CE8: \u5173";
      el.style.opacity = on ? ".9" : ".6";
      el.title = "Alt+L \u5207\u6362\u6807\u6CE8";
    }
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
        "pointer-events:auto"
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
        "opacity:" + (disabled ? ".55" : "1")
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
      const ranges = (Array.isArray(sentence.triggers) ? sentence.triggers : []).map((t, i) => ({ ...t, triggerIndex: i })).filter((t) => Number.isInteger(t.start) && Number.isInteger(t.end) && t.start >= 0 && t.end <= text.length && t.end > t.start).sort((a, b) => a.start - b.start);
      if (!sentence.markId || ranges.length === 0) {
        addLine(el, String(text).replace(/\*\*/g, "").replace(/^[#>\-\s]+/, "").slice(0, 200), {
          opacity: ".72",
          marginBottom: "6px"
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
        span.style.background = selectedTrigger === range.triggerIndex ? "rgba(239,68,68,.72)" : "rgba(239,68,68,.28)";
        span.style.borderRadius = "2px";
        span.style.color = "#fff";
        span.title = "\u5B9E\u5199 token \u5728\u539F\u6587\u4E2D\u7684\u4F4D\u7F6E";
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
        const parts = [`\u5B9E\u5199 ${actual || "\u2205"}`];
        if (alt) parts.push(`\u5907\u9009 ${alt}`);
        parts.push(`${(Number(t.confidence ?? 0) * 100).toFixed(1)}%`);
        if (t.category) parts.push(t.category);
        row.textContent = parts.join(" \xB7 ");
        row.title = "\u5B9E\u5199\u662F\u539F\u53E5\u4E2D\u7684 token\uFF1B\u5907\u9009\u662F\u6A21\u578B\u7684\u5176\u4ED6\u5019\u9009\uFF0C\u4E0D\u4E00\u5B9A\u51FA\u73B0\u5728\u539F\u53E5\u3002\u70B9\u51FB\u9009\u4E2D\u4E3A\u95EE\u9898\u8BCD\u3002";
        row.style.cssText = [
          "padding:3px 5px",
          "margin:2px 0",
          "border-radius:4px",
          "cursor:pointer",
          "background:" + (selectedTrigger === i ? "rgba(255,255,255,.16)" : "transparent")
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
        addLine(el, "\u5F53\u524D\u6CA1\u6709\u53EF\u6807\u6CE8\u7684 annotation", { opacity: ".55", marginTop: "6px" });
        return;
      }
      if (!annotationOn()) {
        addLine(el, "\u6807\u6CE8\u5DF2\u5173\u95ED\uFF08Alt+L \u5F00\u542F\uFF09", { opacity: ".55", marginTop: "6px" });
        return;
      }
      if (statusText) addLine(el, statusText, { color: "#86efac", marginTop: "6px" });
      if (errorText) addLine(el, errorText, { color: "#fca5a5", marginTop: "6px" });
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:8px";
      const current = sentence.verdict ?? "unsure";
      actions.appendChild(button("\u786E\u5B9E\u6709\u9519", () => {
        if (current !== "highlighter_correct") {
          submitFeedback(sentence, ctx, "highlighter_correct", { error_type: "cannot_tell" });
        }
      }, { active: current === "highlighter_correct", disabled: submitting }));
      actions.appendChild(button("\u5408\u7406\u6B67\u4E49", () => {
        if (current !== "reasonable_ambiguity") {
          submitFeedback(sentence, ctx, "reasonable_ambiguity", { ambiguity_kind: "cannot_tell" });
        }
      }, { active: current === "reasonable_ambiguity", disabled: submitting }));
      actions.appendChild(button("\u7EAF\u8BEF\u62A5", () => {
        if (current !== "highlighter_misjudge") {
          submitFeedback(sentence, ctx, "highlighter_misjudge", { misjudge_reason: "cannot_tell" });
        }
      }, { active: current === "highlighter_misjudge", disabled: submitting }));
      actions.appendChild(button("\u4E0D\u786E\u5B9A", () => {
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
        title = "\u9519\u8BEF\u7C7B\u578B\uFF1A";
      } else if (current === "reasonable_ambiguity") {
        options = AMBIGUITY_OPTIONS;
        field = "ambiguity_kind";
        title = "\u6B67\u4E49\u7C7B\u578B\uFF1A";
      } else if (current === "highlighter_misjudge") {
        options = MISJUDGE_OPTIONS;
        field = "misjudge_reason";
        title = "\u8BEF\u62A5\u539F\u56E0\uFF1A";
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
        const reasonLabel = options ? options.find(([v]) => v === sentence[field])?.[1] ?? sentence[field] : "";
        addLine(el, `\u5F53\u524D\uFF1A${VERDICT_LABELS[current] ?? current}${reasonLabel ? ` \xB7 ${reasonLabel}` : ""}`, {
          opacity: ".55",
          marginTop: "6px"
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
      const errorType = verdict === "highlighter_correct" ? values.error_type ?? "cannot_tell" : null;
      const ambiguityKind = verdict === "reasonable_ambiguity" ? values.ambiguity_kind ?? "cannot_tell" : null;
      const misjudgeReason = verdict === "highlighter_misjudge" ? values.misjudge_reason ?? "cannot_tell" : null;
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
        uiMode: "inline"
      };
      try {
        const res = await fetch("/plugins/logprobs-highlighter/feedback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
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
        statusText = "\u5DF2\u8BB0\u5F55";
        errorText = null;
      } catch (err) {
        errorText = `\u8BB0\u5F55\u5931\u8D25\uFF1A${err?.message ?? err}`;
      } finally {
        submitting = false;
        if (activeSentence === sentence) renderPopover(sentence, ctx);
      }
    }
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
      if (isNew || wasHidden) positionPopover(x, y);
    }
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
    function paint(turn, data) {
      if (typeof window === "undefined") return false;
      if (!window.CSS || !window.CSS.highlights || typeof window.Highlight === "undefined") return false;
      const sentences = Array.isArray(data) ? data : data?.sentences ?? [];
      annotationEnabled = Boolean(data && !Array.isArray(data) && data.annotation && data.annotation.enabled);
      ensurePill();
      const name = `lph-red-${turn}`;
      const target = findTarget(turn);
      if (!target) return false;
      if (target.getClientRects().length === 0) return false;
      const map = buildNormMap(target);
      if (map.segs.length === 0) return false;
      const reds = (sentences || []).filter((s) => s && s.level === "red");
      const ctx = {
        captureId: data && !Array.isArray(data) ? data.captureId ?? null : null,
        sessionId: data && !Array.isArray(data) ? data.key?.sessionId ?? null : null,
        turn: data && !Array.isArray(data) ? data.key?.turn ?? turn : turn,
        step: data && !Array.isArray(data) ? data.key?.step ?? null : null,
        annotationEnabled
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
    function clear(turn) {
      state.delete(turn);
      hidePopover();
      if (typeof window === "undefined" || !window.CSS || !window.CSS.highlights) return;
      window.CSS.highlights.delete(`lph-red-${turn}`);
    }
    
    // src/client/index.js
    var inject = ["slots", "sessions"];
    function resolveTurnNo(turn) {
      if (typeof turn === "number") return turn;
      if (typeof turn?.turn === "number") return turn.turn;
      const steps = turn?.steps;
      if (Array.isArray(steps)) {
        for (const s of steps) {
          const d = s?.data?.get?.("assistant-step");
          const n = d?.finalNode?.turn;
          if (typeof n === "number") return n;
        }
      }
      return null;
    }
    function LogprobsSentences(props) {
      const turnNo = resolveTurnNo(props.turn);
      const sessionId = props.sessionId;
      const dataRef = (0, import_react.useRef)(null);
      (0, import_react.useEffect)(() => {
        if (!turnNo || !sessionId) return void 0;
        let cancelled = false;
        let timer = null;
        let tries = 0;
        const repaint = () => {
          if (cancelled || !dataRef.current) return;
          paint(turnNo, dataRef.current);
        };
        const load = async () => {
          let data = null;
          try {
            const res = await fetch(
              `/plugins/logprobs-highlighter/tokens?session=${encodeURIComponent(sessionId)}&turn=${turnNo}`,
              { cache: "no-store" }
            );
            if (res.ok) data = await res.json();
          } catch {
          }
          if (cancelled) return;
          if (data && data.captured && Array.isArray(data.sentences)) {
            dataRef.current = data;
            paint(turnNo, data);
            return;
          }
          tries += 1;
          if (tries <= 4) timer = setTimeout(load, Math.min(8e3, 1e3 * 2 ** (tries - 1)));
        };
        void load();
        const onScroll = () => repaint();
        window.addEventListener("scroll", onScroll, { passive: true, capture: true });
        const interval = setInterval(repaint, 600);
        return () => {
          cancelled = true;
          clearTimeout(timer);
          clearInterval(interval);
          window.removeEventListener("scroll", onScroll, { capture: true });
          clear(turnNo);
        };
      }, [turnNo, sessionId]);
      return null;
    }
    var applied = false;
    function apply(ctx) {
      if (applied) {
        console.warn("[logprobs-highlighter] apply \u91CD\u590D\u8C03\u7528\uFF08HMR\uFF09\uFF0C\u8DF3\u8FC7\uFF1B\u82E5\u9AD8\u4EAE\u5931\u6548\u8BF7\u5237\u65B0\u9875\u9762");
        return;
      }
      applied = true;
      try {
        ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
          name: "conversation.chat.turnTail",
          id: "logprobs-highlighter",
          order: 100
        }, LogprobsSentences));
      } catch (err) {
        console.warn("[logprobs-highlighter] turnTail \u6CE8\u518C\u5931\u8D25:", err);
      }
    }
    
    return module.exports;
  },
});
