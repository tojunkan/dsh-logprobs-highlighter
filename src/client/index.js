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
import { AssistantStepView } from "./highlighter.js";

export const inject = ["conversationEvents", "slots", "sessions"];

export function apply(ctx) {
  // 注册 turnTail chain 槽（M3 面板）；select 为 chain 专属纯函数，只收 owner
  // props {turn, seq, openFile}（t14 §5：ChainSelect = (owner) => M | null；
  // ui-conversation client.js:9283-9287 实证），返回 {turn, seq} 成为组件 matched。
  try {
    ctx.slots.inject("conversation.chat.turnTail", () =>
      ctx.slots.register({
        name: "conversation.chat.turnTail",
        select: ({ turn, seq }) => (turn ? { turn, seq } : null),
        priority: 0,
      }, LogprobsTurnTail)
    );
  } catch (err) {
    console.warn("[logprobs-highlighter] turnTail 注册失败（联调时修正）:", err);
  }

  // M3.5：shadow assistant-step 正文逐 token 热力图。keyed 槽无 select（t14 §5.4），
  // 分发靠 entryKey；priority:-10 严格低于默认 0（同 key 同 priority 会 throw）。
  try {
    ctx.slots.inject("conversation.chat.node", () =>
      ctx.slots.register({
        name: "conversation.chat.node",
        key: "assistant-step",
        priority: -10,
      }, AssistantStepView)
    );
  } catch (err) {
    console.warn("[logprobs-highlighter] assistant-step shadow 注册失败（联调时修正）:", err);
  }
}
