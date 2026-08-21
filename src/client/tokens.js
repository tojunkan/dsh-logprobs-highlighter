/**
 * logprobs-highlighter — 客户端共享数据 hook：按 (sessionId, turn, step) 拉取 tokens
 *
 * 面板（panel.js）与正文热力图（highlighter.js）共用；assoc-pending 退避重取
 * （I4：首次 + 3 次退避 500ms/1s/2s）。阶段：
 *   idle    — 未启用（缺 key / 流式未结算）
 *   loading — 请求中
 *   ok      — captured:true，data 为 /tokens 响应
 *   empty   — captured:false，data.reason 为 notCapturedReason 枚举（或 no-key）
 *   error   — 数据通道异常
 *
 * @module logprobs-highlighter/client/tokens
 */

import { useEffect, useState } from "react";

const RETRY_DELAYS = [500, 1000, 2000];
const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;

export function useTokens(sessionId, turn, step, enabled = true) {
  const [state, setState] = useState({ phase: "idle", data: null });

  useEffect(() => {
    if (!enabled || !sessionId || turn === null || turn === undefined || step === null || step === undefined) {
      setState({ phase: "idle", data: null });
      return;
    }
    let cancelled = false;
    let timer = null;
    let attempt = 0;
    const tryFetch = async () => {
      if (cancelled) return;
      attempt++;
      setState((s) => ({ ...s, phase: "loading" }));
      const url =
        `/plugins/logprobs-highlighter/tokens?session=${encodeURIComponent(sessionId)}` +
        `&turn=${encodeURIComponent(turn)}&step=${encodeURIComponent(step)}`;
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
        if (body.notCapturedReason === "assoc-pending" && attempt < MAX_ATTEMPTS) {
          timer = setTimeout(tryFetch, RETRY_DELAYS[attempt - 1]);
          return;
        }
        setState({ phase: "empty", data: { reason: body.notCapturedReason ?? "not-found", retried: attempt - 1 } });
      } catch {
        if (!cancelled) setState({ phase: "error", data: { message: "无法连接数据通道（/tokens fetch 失败）" } });
      }
    };
    void tryFetch();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, sessionId, turn, step]);

  return state;
}
