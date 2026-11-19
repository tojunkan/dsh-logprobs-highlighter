/**
 * logprobs-highlighter — 客户端插件入口
 *
 * 只做一件事：在 turnTail 槽挂一个"高亮注入器"（副作用组件，返回 null）。
 * 正文渲染完全由官方 AssistantMarkdown 负责，本插件只通过
 * `CSS.highlights` 给句子区间贴底色（见 injector.js 的验证结论）。
 *
 * 注册方式（dsh 0.2.0-rc.2 实测）：
 * - `conversation.chat.turnTail` 是 chain 槽，`select` 收 owner props
 *   `{ turn, seq, openFile }`，返回 `{ turn }` 作为组件的 matched props；
 * - session scope 会额外注入 `sessionId`。
 *
 * @module logprobs-highlighter/client
 */

import { useEffect, useRef } from "react";
import { paint, clear } from "./injector.js";

export const inject = ["slots", "sessions"];

/** TurnLocation → turn 数字（可能是数字，也可能是带 steps 的对象）。 */
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

/**
 * 注入器组件：拉取该 turn 的句子数据，交给 injector 绘制。
 * 不渲染任何内容，不影响布局。
 */
function LogprobsSentences(props) {
  const turnNo = resolveTurnNo(props.turn);
  const sessionId = props.sessionId;
  const dataRef = useRef(null);

  useEffect(() => {
    if (!turnNo || !sessionId) return undefined;
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
          { cache: "no-store" },
        );
        if (res.ok) data = await res.json();
      } catch {
        // 网络失败按"数据未就绪"处理，走重试。
      }
      if (cancelled) return;
      if (data && data.captured && Array.isArray(data.sentences)) {
        dataRef.current = data;
        paint(turnNo, data);
        return;
      }
      tries += 1;
      if (tries <= 4) timer = setTimeout(load, Math.min(8000, 1000 * 2 ** (tries - 1)));
    };
    void load();

    // 虚拟滚动/窗口化：节点重新进入渲染树时重绘（paint 幂等）。
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

// HMR 重载时同一 ctx 可能重复 apply → 模块级幂等。
let applied = false;

export function apply(ctx) {
  if (applied) {
    console.warn("[logprobs-highlighter] apply 重复调用（HMR），跳过；若高亮失效请刷新页面");
    return;
  }
  applied = true;
  try {
    // dsh 0.2.0-rc.2 实测：turnTail 是 **list** 槽（不是 chain），必须给 id；
    // 组件直接收到 owner props { turn, seq, openFile } + session kit(sessionId)。
    ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
      name: "conversation.chat.turnTail",
      id: "logprobs-highlighter",
      order: 100,
    }, LogprobsSentences));
  } catch (err) {
    console.warn("[logprobs-highlighter] turnTail 注册失败:", err);
  }
}