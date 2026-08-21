/**
 * logprobs-highlighter — 客户端插件入口（M3）
 *
 * 打包：scripts/build-client.mjs 用 esbuild 把本文件（含 panel.js 与
 * lib/client-utils.js）打成单文件 bundle → lib/client.js，external 平台种子词
 * （react 等，require 由 __ModuleLoader__.load 的 factory 参数解析）。
 * 入口导出 { inject, apply }（agent-teams 先例，t2 §3a）。
 *
 * inject：声明依赖的 client 服务（slots 注册 turnTail；sessions/conversationEvents
 * 供后续 M3.5 使用）。
 */

import { LogprobsTurnTail } from "./panel.js";

export const inject = ["conversationEvents", "slots", "sessions"];

export function apply(ctx) {
  // 注册 turnTail chain 槽（M3 面板）；try/catch 兜底：槽 API 细节联调时修正。
  try {
    ctx.slots.inject("conversation.chat.turnTail", () =>
      ctx.slots.register({ name: "conversation.chat.turnTail",
        select: (session, turn) => {
	  return {
	    turn: turn,
	    sessionId: session?.id
	  };
	}
      }, LogprobsTurnTail)
    );
  } catch (err) {
    console.warn("[logprobs-highlighter] turnTail 注册失败（联调时修正）:", err);
  }
}
