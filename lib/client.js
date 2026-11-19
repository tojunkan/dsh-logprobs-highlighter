/**
 * GENERATED FILE — 由 scripts/build-client.mjs 构建，勿手改。
 * 源码：src/client/index.js（+ injector.js）。
 */
window.__ModuleLoader__.load({
  id: "@logprobs/logprobs-highlighter",
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
    var state = /* @__PURE__ */ new Map();
    var nodeState = /* @__PURE__ */ new WeakMap();
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
          if (p && p.closest("pre, code, .katex, style, script, svg")) return NodeFilter.FILTER_REJECT;
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
        "word-break:break-word"
      ].join(";");
      document.body.appendChild(el);
      return el;
    }
    function hideTooltip() {
      const el = document.getElementById(TOOLTIP_ID);
      if (el) el.style.display = "none";
    }
    function showTooltip(x, y, sentence) {
      const el = tooltipEl();
      const triggers = Array.isArray(sentence.triggers) && sentence.triggers.length > 0 ? sentence.triggers : sentence.reason ? [{ ...sentence.reason, top: Array.isArray(sentence.reason.top) ? sentence.reason.top : [] }] : [];
      el.textContent = "";
      if (sentence.text) {
        const line = document.createElement("div");
        line.style.opacity = "0.78";
        line.style.marginBottom = "5px";
        line.style.fontFamily = "inherit";
        line.textContent = String(sentence.text).replace(/\*\*/g, "").replace(/^[#>\-\s]+/, "").slice(0, 90);
        el.appendChild(line);
      }
      for (const t of triggers.slice(0, 3)) {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "baseline";
        row.style.gap = "8px";
        const actual = typeof t.token === "string" ? t.token : "";
        const top = Array.isArray(t.top) ? t.top : [];
        const alt = top.find((c) => c && typeof c.token === "string" && c.token !== actual)?.token ?? "";
        const head = document.createElement("span");
        head.style.fontWeight = "600";
        head.textContent = alt ? `${actual}\uFF08${alt}\uFF09` : actual;
        const tail = document.createElement("span");
        tail.style.opacity = "0.7";
        tail.textContent = `${(Number(t.confidence ?? 0) * 100).toFixed(1)}%${t.category ? ` \xB7 ${t.category}` : ""}`;
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
    function paint(turn, sentences) {
      if (typeof window === "undefined") return false;
      if (!window.CSS || !window.CSS.highlights || typeof window.Highlight === "undefined") return false;
      const name = `lph-red-${turn}`;
      const target = findTarget(turn);
      if (!target) return false;
      if (target.getClientRects().length === 0) return false;
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
    function clear(turn) {
      state.delete(turn);
      hideTooltip();
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
            dataRef.current = data.sentences;
            paint(turnNo, data.sentences);
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
