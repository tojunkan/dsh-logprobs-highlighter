/**
 * logprobs-highlighter — turnTail 面板组件（M3）
 *
 * 挂载点：conversation.chat.turnTail（chain 槽，scope session）。
 * 契约（dsh-client-ui-conversation 源码 + slots.d.ts 已核实）：
 *   owner props = { turn: TurnLocation, seq: number, openFile };
 *   session 标准 kit = { sessionId, useSession, useProjection, useSessions }（运行时合并注入）。
 * 数据来源：turn.steps[].data.get("assistant-step").finalNode 携带数值型
 *   { turn, step, messageId }（与 ui-conversation tailData 同款读取）→
 *   GET /plugins/logprobs-highlighter/tokens?session&turn&step。
 *
 * 面板内容（README §6/§7）：
 * - 热力条：全文 text token 红→蓝色阶总览（hue=240°×clamp(1+logprob/10,0,1)），
 *   hover 显示 token 原文/logprob/置信度；第一版不做点击跳转。
 * - 可疑 token 列表：M2 前最小标记（confidence<0.10 或 Top1-Top2 差距<0.1），
 *   每条含 token 原文、置信度、logprob、Top-N 备选条形图（宽度=概率相对占比，
 *   hover 显示数值）。
 * - 状态：captured:false 显示原因枚举；assoc-pending 退避重试 3 次（I4，500ms/1s/2s）；
 *   reasoningState 提示（思考段有概率数据但不标记）。
 * - 面板默认折叠；无 logprobs 数据一律灰色（README §7.1）。
 *
 * 说明：hover 用原生 title 属性（避免对 dsh-client-ui-primitives Tooltip 的
 * 未验证 API 依赖），M3.5 若需要再换 HoverCard。
 *
 * @module logprobs-highlighter/client/panel
 */

import React, { useEffect, useMemo, useState } from "react";
import {
  tokenHue,
  formatConfidence,
  formatLogprob,
  isSuspiciousToken,
  topBarData,
  capturedReasonText,
  reasoningStateText,
  findClosingAssistantStep,
} from "../../lib/client-utils.js";

/** I4：assoc-pending 退避重试延迟（首次 + 3 次）。 */
const RETRY_DELAYS = [500, 1000, 2000];
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;

const GRAY = "#9ca3af";
const styles = {
  root: {
    fontSize: "12px",
    lineHeight: 1.5,
    color: "var(--dsh-text-secondary, #6b7280)",
    padding: "2px 0",
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
    gap: "6px",
  },
  body: {
    marginTop: "6px",
    border: "1px solid var(--dsh-border, #e5e7eb)",
    borderRadius: "8px",
    padding: "8px 10px",
    background: "var(--dsh-bg-soft, rgba(127,127,127,0.05))",
  },
  heatBar: {
    display: "flex",
    height: "12px",
    borderRadius: "6px",
    overflow: "hidden",
    gap: "1px",
  },
  sectionTitle: {
    fontWeight: 600,
    margin: "8px 0 4px",
  },
  row: {
    padding: "4px 0",
    borderTop: "1px solid var(--dsh-border, #e5e7eb)",
  },
  rowTop: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
  },
  tokenText: {
    fontFamily: "var(--dsh-font-mono, ui-monospace, monospace)",
    fontWeight: 600,
    background: "var(--dsh-bg-soft, rgba(127,127,127,0.1))",
    borderRadius: "4px",
    padding: "0 4px",
  },
  topBar: {
    display: "flex",
    height: "8px",
    borderRadius: "4px",
    overflow: "hidden",
    marginTop: "3px",
  },
  hint: { color: GRAY, fontStyle: "italic" },
};

function hueColor(hue) {
  return hue === null ? GRAY : `hsl(${hue}, 75%, 55%)`;
}

/** 折叠态摘要文案。 */
function summaryText(phase, data, suspiciousCount, tokenCount) {
  switch (phase) {
    case "idle":
      return "logprobs 面板（待数据）";
    case "loading":
      return "logprobs 加载中…";
    case "ok":
      return `logprobs：${suspiciousCount} 个可疑 / 共 ${tokenCount} token（展开看热力条）`;
    case "empty":
      return `logprobs：${capturedReasonText(data?.reason) ?? "无数据"}`;
    case "error":
      return `logprobs：${data?.message ?? "数据通道异常"}`;
    default:
      return "logprobs 面板";
  }
}

/** 热力条：每个 text token 一个色段，宽度 ∝ 文本长度。 */
function HeatBar({ tokens }) {
  if (!tokens || tokens.length === 0) {
    return <div style={{ ...styles.heatBar, background: GRAY }} title="无 text token 数据" />;
  }
  return (
    <div style={styles.heatBar}>
      {tokens.map((t) => (
        <div
          key={t.index}
          title={`${t.text}  logprob=${formatLogprob(t.logprob)}  conf=${formatConfidence(t.confidence)}`}
          style={{
            background: hueColor(tokenHue(t)),
            flexGrow: Math.max(1, (t.text || "").length),
            minWidth: "2px",
          }}
        />
      ))}
    </div>
  );
}

/** 可疑 token 行：原文 + 置信度 + logprob + Top-N 备选条形图。 */
function SuspiciousRow({ token, reasons }) {
  const bars = topBarData(token.top);
  return (
    <div style={styles.row}>
      <div style={styles.rowTop}>
        <code style={styles.tokenText}>{token.text || " "}</code>
        <span>
          conf {formatConfidence(token.confidence)} · logprob {formatLogprob(token.logprob)}
        </span>
        <span style={{ color: "#dc2626" }}>
          {[reasons.lowConfidence ? "低置信" : null, reasons.hesitation ? "犹豫" : null].filter(Boolean).join(" / ")}
        </span>
      </div>
      {bars.length > 0 && (
        <div style={styles.topBar}>
          {bars.map((alt) => (
            <div
              key={alt.token}
              title={`${alt.token}  conf=${formatConfidence(alt.confidence)}  logprob=${formatLogprob(alt.logprob)}`}
              style={{ width: `${Math.max(2, alt.widthPct)}%`, background: hueColor(tokenHue(alt)) }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function LogprobsTurnTail(props) {
  const { turn, sessionId } = props;
  const key = useMemo(() => findClosingAssistantStep(turn), [turn]);
  const [state, setState] = useState({ phase: "idle", data: null });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!key || key.turn === null || key.step === null) {
      setState({ phase: "empty", data: { reason: "no-step" } });
      return () => { cancelled = true; };
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
          setState({ phase: "error", data: { message: `数据通道异常（HTTP ${res.status}）` } });
          return;
        }
        if (body.captured === true) {
          setState({ phase: "ok", data: body });
          return;
        }
        // captured:false —— assoc-pending 退避重试（I4）；其余直接显示原因
        if (body.notCapturedReason === "assoc-pending" && attempt < MAX_ATTEMPTS) {
          timer = setTimeout(tryFetch, RETRY_DELAYS[attempt - 1]);
          return;
        }
        setState({ phase: "empty", data: { reason: body.notCapturedReason ?? "not-found", retried: attempt - 1 } });
      } catch {
        if (cancelled) return;
        setState({ phase: "error", data: { message: "无法连接数据通道（/tokens fetch 失败）" } });
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
  const suspicious = tokens
    .map((t) => ({ token: t, reasons: isSuspiciousToken(t) }))
    .filter((x) => x.reasons.lowConfidence || x.reasons.hesitation);

  return (
    <div style={styles.root} data-logprobs-panel>
      <button
        type="button"
        style={styles.headerBtn}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title="logprobs 置信度面板（展开/折叠）"
      >
        <span aria-hidden>{expanded ? "▾" : "▸"}</span>
        <span>{summaryText(phase, data, suspicious.length, tokens.length)}</span>
      </button>
      {expanded && (
        <div style={styles.body}>
          {phase === "ok" && data && (
            <>
              <HeatBar tokens={tokens} />
              <div style={styles.sectionTitle}>可疑 token（M2 前最小标记：低置信 / 犹豫）</div>
              {suspicious.length === 0 ? (
                <div style={styles.hint}>无可疑 token</div>
              ) : (
                suspicious.map(({ token, reasons }) => <SuspiciousRow key={token.index} token={token} reasons={reasons} />)
              )}
              {data.reasoningState && (
                <div style={{ ...styles.hint, marginTop: "6px" }}>
                  思考段：{reasoningStateText(data.reasoningState)}
                </div>
              )}
              {data.usage && (
                <div style={styles.hint}>
                  usage：in {data.usage.inputTokens ?? "?"} / out {data.usage.outputTokens ?? "?"}
                  {data.usage.reasoningTokens != null ? `（思考 ${data.usage.reasoningTokens}）` : ""}
                </div>
              )}
            </>
          )}
          {phase === "empty" && (
            <div style={styles.hint}>
              {capturedReasonText(data?.reason) ?? "无 logprobs 数据"}
              {data?.retried ? `（已重试 ${data.retried} 次）` : ""}
            </div>
          )}
          {phase === "error" && <div style={{ color: "#dc2626" }}>{data?.message}</div>}
        </div>
      )}
    </div>
  );
}
