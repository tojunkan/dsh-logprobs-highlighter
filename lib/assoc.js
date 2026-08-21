/**
 * logprobs-highlighter — 捕获-消息关联器（Association）
 *
 * 模型（architecture-v4 §2.1/§3.4，README §5.5）：
 * - wire 请求体不带 turn/step，headers 只有 x-deepseek-harness-session-id；
 *   同会话流式请求串行（agent-loop 每次 await 一个流）→ 按 sessionId FIFO 关联
 * - ctx.on("session/event", (session, event))：assistant/message 事件载荷含
 *   {turn, step, message:{id}, usage?}（dsh-session append 派发 (session, event)）
 * - attach 出队跳过 aborted（complete:false）条目并 GC → 索引
 *   Map<sessionId, Map<"turn:step", probeId>>（宁可无数据不错位）
 * - compact 请求不入队（capture.store 已处理）；关联失败 → 客户端查询得
 *   captured:false（渲染灰色）
 *
 * IMP-3：事件载荷形状未获权威证实（t2 证据只证实包含 {turn,step,message,usage}，
 * 未证实是事件根字段还是 event.data 子字段）——本实现同时兼容两种形状：
 *   event.data.turn ?? event.turn（同理 step/message/usage）
 * 并支持 debug 开关（Config.debugAssoc 或环境变量 DSH_LPH_DEBUG_ASSOC=1，默认关）：
 * 首次收到 assistant/message 时打印脱敏后的原始事件 JSON 前 2KB（去掉
 * message.content 正文，不泄露对话内容），供真实联调核对事件形状。
 *
 * @module logprobs-highlighter/assoc
 */

const DEBUG_ENV = "DSH_LPH_DEBUG_ASSOC";

/** 脱敏：剔除 message.content（含 reasoning 等正文块），仅保留结构字段。 */
function sanitizeEventShape(event) {
  if (!event || typeof event !== "object") return event;
  const out = { ...event };
  const data = event.data && typeof event.data === "object" ? { ...event.data } : event.data;
  if (data && typeof data === "object") {
    if (data.message && typeof data.message === "object") {
      const msg = { ...data.message };
      if (msg.content !== undefined) {
        msg.content = Array.isArray(msg.content)
          ? `[${msg.content.length} blocks]`
          : `[content ${String(msg.content).length} chars]`;
      }
      data.message = msg;
    }
    out.data = data;
  }
  return out;
}

/**
 * 创建关联器。
 * @param {object} ctx cordis ctx（需支持 ctx.on）
 * @param {object} capture capture store
 * @param {object} logger
 * @param {{debug?: boolean}} options debugAssoc 开关（默认 false；亦可用环境变量）
 */
export function createAssociator(ctx, capture, logger = console, options = {}) {
  const debug = options.debug === true || process.env[DEBUG_ENV] === "1";
  let printedFirst = false;

  const onAssistantMessage = (session, event) => {
    if (!event || event.type !== "assistant/message") return;

    // IMP-3：事件载荷可能是 event.data 子字段或事件根字段，双形状兼容
    const data = event.data && typeof event.data === "object" ? event.data : event;
    const sessionId = (session && (session.id ?? session.sessionId)) ?? data.sessionId ?? null;
    if (!sessionId) return;

    if (debug && !printedFirst) {
      printedFirst = true;
      try {
        const snippet = JSON.stringify(sanitizeEventShape(event)).slice(0, 2048);
        logger.info(`assoc[debug] 首次 assistant/message 事件形状（已脱敏，前 2KB）：${snippet}`);
      } catch { /* 打印失败不影响关联 */ }
    }

    const turn = typeof data.turn === "number" ? data.turn : null;
    const step = typeof data.step === "number" ? data.step : null;
    if (turn === null || step === null) {
      logger.warn(`assoc: assistant/message 缺 turn/step（seq=${event.seq}），跳过关联`);
      return;
    }
    const message = data.message && typeof data.message === "object" ? data.message : null;
    const entry = capture.attach(sessionId, {
      turn,
      step,
      messageId: message && typeof message.id === "string" ? message.id : null,
      // usage 仅作信息传递：捕获条目的 usage 以流内解析为准（attach 不覆盖）——SUG-4
      usage: data.usage ?? null,
    });
    if (entry) {
      logger.debug(`assoc: session=${sessionId} turn=${turn} step=${step} → probe ${entry.id}（model=${entry.model}）`);
    } else {
      logger.debug(`assoc: session=${sessionId} turn=${turn} step=${step} 无匹配捕获（FIFO 空或全是 aborted）`);
    }
  };

  ctx.on("session/event", onAssistantMessage);
  logger.debug(`assoc: session/event 监听已注册（assistant/message → FIFO 出队关联）${debug ? "，debug 开关已开" : ""}`);
}
