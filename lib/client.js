/**
 * GENERATED FILE — 由 scripts/build-client.mjs 构建，勿手改。
 * 源码：src/client/index.js（panel.js + lib/client-utils.js）。
 * 构建：node scripts/build-client.mjs
 */
window.__ModuleLoader__.load({
  id: "@logprobs/logprobs-highlighter",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var __create = Object.create;
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __getProtoOf = Object.getPrototypeOf;
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
    var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
      // If the importer is in node compatibility mode or this is not an ESM
      // file that has been converted to a CommonJS file using a Babel-
      // compatible transform (i.e. "__esModule" has not been set), then set
      // "default" to the CommonJS "module.exports" for node compatibility.
      isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
      mod
    ));
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
    
    // src/client/index.js
    var index_exports = {};
    __export(index_exports, {
      apply: () => apply,
      inject: () => inject
    });
    module.exports = __toCommonJS(index_exports);
    
    // src/client/panel.js
    var import_react = __toESM(require("react"), 1);
    
    // lib/client-utils.js
    function clamp(v, lo, hi) {
      return Math.min(hi, Math.max(lo, v));
    }
    function logprobToHue(logprob) {
      if (typeof logprob !== "number" || !Number.isFinite(logprob)) return null;
      return Math.round(240 * clamp(1 + logprob / 10, 0, 1));
    }
    function tokenHue(token) {
      return logprobToHue(token && typeof token.logprob === "number" ? token.logprob : null);
    }
    function formatConfidence(confidence) {
      if (typeof confidence !== "number" || !Number.isFinite(confidence)) return "\u2014";
      const c = clamp(confidence, 0, 1);
      if (c >= 0.01) return `${(c * 100).toFixed(1)}%`;
      if (c >= 1e-4) return `${(c * 100).toFixed(4)}%`;
      return `\u2248${c.toExponential(1)}`;
    }
    function formatLogprob(logprob) {
      if (typeof logprob !== "number" || !Number.isFinite(logprob)) return "\u2014";
      if (Math.abs(logprob) < 0.01) return logprob.toExponential(2);
      return logprob.toFixed(3);
    }
    function isSuspiciousToken(token, opts = {}) {
      const minConfidence = opts.minConfidence ?? 0.1;
      const hesitationGap = opts.hesitationGap ?? 0.1;
      const result = { lowConfidence: false, hesitation: false };
      if (!token || typeof token.logprob !== "number") return result;
      result.lowConfidence = Math.exp(Math.min(0, token.logprob)) < minConfidence;
      const top = Array.isArray(token.top) ? token.top.filter((x) => x && typeof x.logprob === "number") : [];
      if (top.length >= 2) {
        result.hesitation = Math.abs(top[0].logprob - top[1].logprob) < hesitationGap;
      }
      return result;
    }
    function topBarData(top) {
      if (!Array.isArray(top)) return [];
      const rows = top.filter((x) => x && typeof x.token === "string").map((x) => {
        const lp = typeof x.logprob === "number" && Number.isFinite(x.logprob) ? x.logprob : null;
        const p = lp === null ? 0 : Math.exp(clamp(lp, -20, 0));
        return { token: x.token, logprob: lp, confidence: p, p };
      });
      const maxP = Math.max(...rows.map((r) => r.p), 1e-12);
      return rows.map(({ token, logprob, confidence, p }) => ({
        token,
        logprob,
        confidence,
        widthPct: Math.round(p / maxP * 100)
      }));
    }
    function capturedReasonText(reason) {
      switch (reason) {
        case null:
        case void 0:
          return null;
        case "assoc-pending":
          return "\u5173\u8054\u8FDB\u884C\u4E2D\uFF08assoc-pending\uFF09\uFF0C\u5DF2\u81EA\u52A8\u91CD\u8BD5\uFF1B\u4ECD\u5931\u8D25\u5219\u7A0D\u540E\u5237\u65B0";
        case "not-found":
          return "\u65E0\u6355\u83B7\u6570\u636E\uFF08not-found\uFF09\u2014\u2014\u8BE5\u6D88\u606F\u672A\u5339\u914D\u5230 logprobs\uFF0C\u6E32\u67D3\u7070\u8272";
        case "evicted":
          return "\u6570\u636E\u5DF2\u88AB\u73AF\u5F62\u7F13\u51B2\u6DD8\u6C70\uFF08evicted\uFF09";
        case "compact-skipped":
          return "\u540E\u53F0/\u538B\u7F29\u4EFB\u52A1\uFF0C\u672A\u6355\u83B7\uFF08compact-skipped\uFF09";
        case "model-unsupported":
          return "\u8BE5\u6A21\u578B\u4E0D\u652F\u6301 logprobs\uFF08model-unsupported\uFF09";
        default:
          return `\u65E0\u6355\u83B7\u6570\u636E\uFF08${reason}\uFF09`;
      }
    }
    function reasoningStateText(state) {
      switch (state) {
        case "present":
          return "\u601D\u8003\u6BB5\u6709\u6982\u7387\u6570\u636E\u4F46\u4E0D\u6807\u8BB0\uFF08\u7070\u8272\uFF0C\u6298\u53E0\u5C55\u793A\uFF09";
        case "absent":
          return "\u672C\u6B21\u6D41\u65E0\u601D\u8003\u6BB5";
        case "unknown":
          return "\u601D\u8003\u6BB5\u72B6\u6001\u672A\u77E5";
        default:
          return null;
      }
    }
    function findClosingAssistantStep(turn) {
      const steps = turn && Array.isArray(turn.steps) ? turn.steps : null;
      if (!steps) return null;
      let best = null;
      for (const s of steps) {
        const data = s && s.data && typeof s.data.get === "function" ? s.data.get("assistant-step") : null;
        const fn = data && data.finalNode;
        if (!fn) continue;
        const blocks = Array.isArray(fn.blocks) ? fn.blocks : [];
        const hasText = blocks.some((b) => b && b.kind === "text" && typeof b.text === "string" && b.text.trim() !== "");
        if (!hasText) continue;
        if (!best || fn.seq > best.seq) best = fn;
      }
      if (!best) return null;
      return {
        turn: typeof best.turn === "number" ? best.turn : null,
        step: typeof best.step === "number" ? best.step : null,
        messageId: best.messageId ?? null,
        seq: typeof best.seq === "number" ? best.seq : null
      };
    }
    
    // src/client/panel.js
    var RETRY_DELAYS = [500, 1e3, 2e3];
    var MAX_ATTEMPTS = RETRY_DELAYS.length + 1;
    var GRAY = "#9ca3af";
    var styles = {
      root: {
        fontSize: "12px",
        lineHeight: 1.5,
        color: "var(--dsh-text-secondary, #6b7280)",
        padding: "2px 0"
      },
      headerBtn: {
        background: "none",
        border: "none",
        padding: "2px 0",
        cursor: "pointer",
        color: "inherit",
        fontSize: "12px",
        textAlign: "left",
        display: "flex",
        alignItems: "center",
        gap: "6px"
      },
      body: {
        marginTop: "6px",
        border: "1px solid var(--dsh-border, #e5e7eb)",
        borderRadius: "8px",
        padding: "8px 10px",
        background: "var(--dsh-bg-soft, rgba(127,127,127,0.05))"
      },
      heatBar: {
        display: "flex",
        height: "12px",
        borderRadius: "6px",
        overflow: "hidden",
        gap: "1px"
      },
      sectionTitle: {
        fontWeight: 600,
        margin: "8px 0 4px"
      },
      row: {
        padding: "4px 0",
        borderTop: "1px solid var(--dsh-border, #e5e7eb)"
      },
      rowTop: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap"
      },
      tokenText: {
        fontFamily: "var(--dsh-font-mono, ui-monospace, monospace)",
        fontWeight: 600,
        background: "var(--dsh-bg-soft, rgba(127,127,127,0.1))",
        borderRadius: "4px",
        padding: "0 4px"
      },
      topBar: {
        display: "flex",
        height: "8px",
        borderRadius: "4px",
        overflow: "hidden",
        marginTop: "3px"
      },
      hint: { color: GRAY, fontStyle: "italic" }
    };
    function hueColor(hue) {
      return hue === null ? GRAY : `hsl(${hue}, 75%, 55%)`;
    }
    function summaryText(phase, data, suspiciousCount, tokenCount) {
      switch (phase) {
        case "idle":
          return "logprobs \u9762\u677F\uFF08\u5F85\u6570\u636E\uFF09";
        case "loading":
          return "logprobs \u52A0\u8F7D\u4E2D\u2026";
        case "ok":
          return `logprobs\uFF1A${suspiciousCount} \u4E2A\u53EF\u7591 / \u5171 ${tokenCount} token\uFF08\u5C55\u5F00\u770B\u70ED\u529B\u6761\uFF09`;
        case "empty":
          return `logprobs\uFF1A${capturedReasonText(data?.reason) ?? "\u65E0\u6570\u636E"}`;
        case "error":
          return `logprobs\uFF1A${data?.message ?? "\u6570\u636E\u901A\u9053\u5F02\u5E38"}`;
        default:
          return "logprobs \u9762\u677F";
      }
    }
    function HeatBar({ tokens }) {
      if (!tokens || tokens.length === 0) {
        return /* @__PURE__ */ import_react.default.createElement("div", { style: { ...styles.heatBar, background: GRAY }, title: "\u65E0 text token \u6570\u636E" });
      }
      return /* @__PURE__ */ import_react.default.createElement("div", { style: styles.heatBar }, tokens.map((t) => /* @__PURE__ */ import_react.default.createElement(
        "div",
        {
          key: t.index,
          title: `${t.text}  logprob=${formatLogprob(t.logprob)}  conf=${formatConfidence(t.confidence)}`,
          style: {
            background: hueColor(tokenHue(t)),
            flexGrow: Math.max(1, (t.text || "").length),
            minWidth: "2px"
          }
        }
      )));
    }
    function SuspiciousRow({ token, reasons }) {
      const bars = topBarData(token.top);
      return /* @__PURE__ */ import_react.default.createElement("div", { style: styles.row }, /* @__PURE__ */ import_react.default.createElement("div", { style: styles.rowTop }, /* @__PURE__ */ import_react.default.createElement("code", { style: styles.tokenText }, token.text || " "), /* @__PURE__ */ import_react.default.createElement("span", null, "conf ", formatConfidence(token.confidence), " \xB7 logprob ", formatLogprob(token.logprob)), /* @__PURE__ */ import_react.default.createElement("span", { style: { color: "#dc2626" } }, [reasons.lowConfidence ? "\u4F4E\u7F6E\u4FE1" : null, reasons.hesitation ? "\u72B9\u8C6B" : null].filter(Boolean).join(" / "))), bars.length > 0 && /* @__PURE__ */ import_react.default.createElement("div", { style: styles.topBar }, bars.map((alt) => /* @__PURE__ */ import_react.default.createElement(
        "div",
        {
          key: alt.token,
          title: `${alt.token}  conf=${formatConfidence(alt.confidence)}  logprob=${formatLogprob(alt.logprob)}`,
          style: { width: `${Math.max(2, alt.widthPct)}%`, background: hueColor(tokenHue(alt)) }
        }
      ))));
    }
    function LogprobsTurnTail(props) {
      const { turn, sessionId } = props;
      const key = (0, import_react.useMemo)(() => findClosingAssistantStep(turn), [turn]);
      const [state, setState] = (0, import_react.useState)({ phase: "idle", data: null });
      const [expanded, setExpanded] = (0, import_react.useState)(false);
      (0, import_react.useEffect)(() => {
        let cancelled = false;
        if (!key || key.turn === null || key.step === null) {
          setState({ phase: "empty", data: { reason: "no-step" } });
          return () => {
            cancelled = true;
          };
        }
        let attempt = 0;
        let timer = null;
        const tryFetch = async () => {
          if (cancelled) return;
          attempt++;
          setState((s) => ({ ...s, phase: "loading" }));
          const url = `/plugins/logprobs-highlighter/tokens?session=${encodeURIComponent(sessionId)}&turn=${key.turn}&step=${key.step}`;
          try {
            const res = await fetch(url, { cache: "no-store" });
            const body = await res.json();
            if (cancelled) return;
            if (!body || body.ok !== true) {
              setState({ phase: "error", data: { message: `\u6570\u636E\u901A\u9053\u5F02\u5E38\uFF08HTTP ${res.status}\uFF09` } });
              return;
            }
            if (body.captured === true) {
              setState({ phase: "ok", data: body });
              return;
            }
            if (body.notCapturedReason === "assoc-pending" && attempt < MAX_ATTEMPTS) {
              timer = setTimeout(tryFetch, RETRY_DELAYS[attempt - 1]);
              return;
            }
            setState({ phase: "empty", data: { reason: body.notCapturedReason ?? "not-found", retried: attempt - 1 } });
          } catch {
            if (cancelled) return;
            setState({ phase: "error", data: { message: "\u65E0\u6CD5\u8FDE\u63A5\u6570\u636E\u901A\u9053\uFF08/tokens fetch \u5931\u8D25\uFF09" } });
          }
        };
        void tryFetch();
        return () => {
          cancelled = true;
          if (timer) clearTimeout(timer);
        };
      }, [key, sessionId]);
      const { phase, data } = state;
      const tokens = phase === "ok" && data ? (data.blocks || []).find((b) => b.role === "text")?.tokens ?? [] : [];
      const suspicious = tokens.map((t) => ({ token: t, reasons: isSuspiciousToken(t) })).filter((x) => x.reasons.lowConfidence || x.reasons.hesitation);
      return /* @__PURE__ */ import_react.default.createElement("div", { style: styles.root, "data-logprobs-panel": true }, /* @__PURE__ */ import_react.default.createElement(
        "button",
        {
          type: "button",
          style: styles.headerBtn,
          onClick: () => setExpanded((v) => !v),
          "aria-expanded": expanded,
          title: "logprobs \u7F6E\u4FE1\u5EA6\u9762\u677F\uFF08\u5C55\u5F00/\u6298\u53E0\uFF09"
        },
        /* @__PURE__ */ import_react.default.createElement("span", { "aria-hidden": true }, expanded ? "\u25BE" : "\u25B8"),
        /* @__PURE__ */ import_react.default.createElement("span", null, summaryText(phase, data, suspicious.length, tokens.length))
      ), expanded && /* @__PURE__ */ import_react.default.createElement("div", { style: styles.body }, phase === "ok" && data && /* @__PURE__ */ import_react.default.createElement(import_react.default.Fragment, null, /* @__PURE__ */ import_react.default.createElement(HeatBar, { tokens }), /* @__PURE__ */ import_react.default.createElement("div", { style: styles.sectionTitle }, "\u53EF\u7591 token\uFF08M2 \u524D\u6700\u5C0F\u6807\u8BB0\uFF1A\u4F4E\u7F6E\u4FE1 / \u72B9\u8C6B\uFF09"), suspicious.length === 0 ? /* @__PURE__ */ import_react.default.createElement("div", { style: styles.hint }, "\u65E0\u53EF\u7591 token") : suspicious.map(({ token, reasons }) => /* @__PURE__ */ import_react.default.createElement(SuspiciousRow, { key: token.index, token, reasons })), data.reasoningState && /* @__PURE__ */ import_react.default.createElement("div", { style: { ...styles.hint, marginTop: "6px" } }, "\u601D\u8003\u6BB5\uFF1A", reasoningStateText(data.reasoningState)), data.usage && /* @__PURE__ */ import_react.default.createElement("div", { style: styles.hint }, "usage\uFF1Ain ", data.usage.inputTokens ?? "?", " / out ", data.usage.outputTokens ?? "?", data.usage.reasoningTokens != null ? `\uFF08\u601D\u8003 ${data.usage.reasoningTokens}\uFF09` : "")), phase === "empty" && /* @__PURE__ */ import_react.default.createElement("div", { style: styles.hint }, capturedReasonText(data?.reason) ?? "\u65E0 logprobs \u6570\u636E", data?.retried ? `\uFF08\u5DF2\u91CD\u8BD5 ${data.retried} \u6B21\uFF09` : ""), phase === "error" && /* @__PURE__ */ import_react.default.createElement("div", { style: { color: "#dc2626" } }, data?.message)));
    }
    
    // src/client/index.js
    var inject = ["conversationEvents", "slots", "sessions"];
    function apply(ctx) {
      try {
        ctx.slots.inject(
          "conversation.chat.turnTail",
          () => ctx.slots.register({
            name: "conversation.chat.turnTail",
            select: ({ turn, seq }) => turn ? { turn, seq } : null,
            priority: 0
          }, LogprobsTurnTail)
        );
      } catch (err) {
        console.warn("[logprobs-highlighter] turnTail \u6CE8\u518C\u5931\u8D25\uFF08\u8054\u8C03\u65F6\u4FEE\u6B63\uFF09:", err);
      }
    }
    
    return module.exports;
  },
});
