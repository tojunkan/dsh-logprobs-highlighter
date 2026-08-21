/**
 * logprobs-highlighter — 客户端共享数据 hook：按 (sessionId, turn, step) 拉取 tokens
 *
 * 面板（panel.js）与正文热力图（highlighter.js）共用；缓存/请求逻辑在
 * tokens-core.js（共享缓存 IMP-3：in-flight 去重 + 结果短缓存，assoc-pending
 * 退避重取 3 次 I4）。阶段：idle / loading / ok / empty / error。
 *
 * @module logprobs-highlighter/client/tokens
 */

import { useEffect, useState } from "react";
import { fetchTokenData, MAX_ATTEMPTS, RETRY_DELAYS } from "./tokens-core.js";

export { resetTokenCache, fetchTokenData } from "./tokens-core.js";

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
      try {
        const { status, body } = await fetchTokenData(sessionId, turn, step);
        if (cancelled) return;
        if (!body || body.ok !== true) {
          setState({ phase: "error", data: { message: `数据通道异常（HTTP ${status}）` } });
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
