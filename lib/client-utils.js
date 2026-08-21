/**
 * logprobs-highlighter — 客户端纯函数工具（无 DOM / 无 React 依赖，可单测）
 *
 * 用途：turnTail 面板（src/client/panel.js）与 M3.5 shadow 共用；本模块在
 * 打包时被并入 client bundle，同时被 test/self-test.mjs Part D 直接单测。
 *
 * 色阶约定（README §7.1）：hue = 240° × clamp(1 + logprob/10, 0, 1)
 *   - logprob ≈ 0（高置信）→ 240° 蓝
 *   - logprob = -10 或更低（低置信）→ 0° 红
 *   - 中间经 120° 绿过渡
 * @module logprobs-highlighter/client-utils
 */

/** 数值钳制。 */
export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** logprob → 色相（README §7.1 公式）。logprob 缺失/非数返回 null（灰色）。 */
export function logprobToHue(logprob) {
  if (typeof logprob !== "number" || !Number.isFinite(logprob)) return null;
  return Math.round(240 * clamp(1 + logprob / 10, 0, 1));
}

/** token → 色相（用 logprob；无 logprob → null = 灰色）。 */
export function tokenHue(token) {
  return logprobToHue(token && typeof token.logprob === "number" ? token.logprob : null);
}

/** 置信度格式化：≥1% 显示百分比；极小值用指数记法。 */
export function formatConfidence(confidence) {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return "—";
  const c = clamp(confidence, 0, 1);
  if (c >= 0.01) return `${(c * 100).toFixed(1)}%`;
  if (c >= 0.0001) return `${(c * 100).toFixed(4)}%`;
  return `≈${c.toExponential(1)}`;
}

/** logprob 格式化：|x| 较小用 4 位小数，较大用 3 位。 */
export function formatLogprob(logprob) {
  if (typeof logprob !== "number" || !Number.isFinite(logprob)) return "—";
  if (Math.abs(logprob) < 0.01) return logprob.toExponential(2);
  return logprob.toFixed(3);
}

/**
 * M2 前的最小可疑判定（占位标记，M2 标记引擎接入后替换）：
 * - lowConfidence：confidence < minConfidence（默认 0.10，即 exp(logprob) < 10%）；
 * - hesitation：Top1-Top2 logprob 绝对差 < hesitationGap（默认 0.1，模型几乎平分）。
 * 无 logprob 数据的 token 一律不算可疑（渲染灰色）。
 * @returns {{lowConfidence:boolean, hesitation:boolean}} reasons（全 false = 不标）
 */
export function isSuspiciousToken(token, opts = {}) {
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

/**
 * Top-N 备选词条形图数据：每个备选 { token, logprob, confidence, widthPct }。
 * 概率用 exp(clamp(logprob, -20, 0)) 防止下溢（-9999 哨兵 → 0）；
 * 宽度 = 该备选概率 / 最高概率 × 100（相对占比，hover 显示绝对置信度）。
 * @param {Array<{token:string, logprob:number}>} top
 */
export function topBarData(top) {
  if (!Array.isArray(top)) return [];
  const rows = top
    .filter((x) => x && typeof x.token === "string")
    .map((x) => {
      const lp = typeof x.logprob === "number" && Number.isFinite(x.logprob) ? x.logprob : null;
      const p = lp === null ? 0 : Math.exp(clamp(lp, -20, 0));
      return { token: x.token, logprob: lp, confidence: p, p };
    });
  const maxP = Math.max(...rows.map((r) => r.p), 1e-12);
  return rows.map(({ token, logprob, confidence, p }) => ({
    token,
    logprob,
    confidence,
    widthPct: Math.round((p / maxP) * 100),
  }));
}

/** notCapturedReason 枚举 → 面板提示文案（含 M3 未出现但协议预留的值）。 */
export function capturedReasonText(reason) {
  switch (reason) {
    case null:
    case undefined:
      return null;
    case "assoc-pending":
      return "关联进行中（assoc-pending），已自动重试；仍失败则稍后刷新";
    case "not-found":
      return "无捕获数据（not-found）——该消息未匹配到 logprobs，渲染灰色";
    case "evicted":
      return "数据已被环形缓冲淘汰（evicted）";
    case "compact-skipped":
      return "后台/压缩任务，未捕获（compact-skipped）";
    case "model-unsupported":
      return "该模型不支持 logprobs（model-unsupported）";
    default:
      return `无捕获数据（${reason}）`;
  }
}

/** reasoningState → 面板提示文案。 */
export function reasoningStateText(state) {
  switch (state) {
    case "present":
      return "思考段有概率数据但不标记（灰色，折叠展示）";
    case "absent":
      return "本次流无思考段";
    case "unknown":
      return "思考段状态未知";
    default:
      return null;
  }
}

/**
 * 从 turnTail owner 的 TurnLocation 记录里找"收尾的助手步骤"（含文本的最后
 * assistant-step finalNode）：turn.steps[].data.get("assistant-step").finalNode
 * 携带 { turn, step, messageId, seq, blocks }（ui-conversation tailData 同款读取）。
 * 返回 { turn, step, messageId, seq } 或 null（无文本步骤 / 数据形状不符）。
 */
export function findClosingAssistantStep(turn) {
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
    seq: typeof best.seq === "number" ? best.seq : null,
  };
}
