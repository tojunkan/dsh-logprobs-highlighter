/**
 * logprobs-highlighter — 服务端插件入口（provider 模式）
 *
 * 架构（替代旧的"反代 + baseURL 接管"）：
 *   ① 向 dsh 的 llm 服务注册 provider 路由 `deepseek-logprobs`
 *      （`ctx.llm.registerAdapter`），由 adapter 直连 DeepSeek Chat Completions
 *   ② adapter 在映射流的同时采集 token 级 logprobs → 内存环形缓冲
 *   ③ 同一份数据落盘 JSONL（供离线分析）
 *   ④ `/plugins/logprobs-highlighter/tokens|debug|status` 暴露数据
 *   ⑤ 关联器监听 `assistant/message` 补 (turn, step)
 *
 * 不再有：8787 反代、baseURL 接管/自愈、SSE 剥皮、模型 glob 匹配。
 *
 * @module logprobs-highlighter
 */

import z from "@deepseek-ai/schemastery";
import { LlmAdapter, LlmError, attributionHeaders } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { createCaptureStore } from "./capture.js";
import { createRecorder } from "./recorder.js";
import { createAnnotationStore } from "./annotations.js";
import { createAdapter, PROVIDER } from "./provider.js";
import { createAssociator } from "./assoc.js";
import { registerRoutes } from "./routes.js";
import { PLUGIN_VERSION } from "./shared.js";

export const name = "logprobs-highlighter";

/** 依赖的 dsh 服务：llm（注册 provider）+ sessions（读 step/start 做关联）。 */
export const inject = ["llm", "sessions"];

/** provider 默认显示名（设置界面与 /status 用）。 */
const DISPLAY_NAME = "DeepSeek (logprobs)";

/** 默认模型目录（与 dsh 官方 DeepSeek 适配器的现行模型一致）。 */
const DEFAULT_MODELS = [
  { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", description: "logprobs 采集路由（图片降级为文本）" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", description: "logprobs 采集路由（text only）" },
];

/**
 * 插件配置。
 * 全部声明为 `.volatile()`：与 dsh 官方适配器一致，apply 收到的是带 `.get()`
 * 的配置值（由 `unwrapConfig` 统一解包）。
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  /** DeepSeek OpenAI 兼容根地址（默认 api.deepseek.com）。 */
  baseUrl: z.string().default("https://api.deepseek.com").volatile(),
  /** 凭证引用名（默认 DEEPSEEK_API_KEY）。 */
  apiKeyEnv: z.string().default("DEEPSEEK_API_KEY").volatile(),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
  })).default(DEFAULT_MODELS).volatile(),
  /** logprobs:top_logprobs 的 N（0 / 2 / 5 / 20）。 */
  topLogprobs: z.number().default(5).volatile(),
  /** 是否显式开启思考模式（thinking.type=enabled）。 */
  thinking: z.boolean().default(true).volatile(),
  /** 默认 reasoning effort（low / high / max）。 */
  reasoningEffort: z.string().default("high").volatile(),
  /** 单次请求输出上限（未显式指定 maxTokens 时的默认值）。 */
  maxTokens: z.number().default(8192).volatile(),
  /** 声称的上下文窗口（用于 dsh 的容量判断）。 */
  defaultContextWindow: z.number().default(1_000_000).volatile(),
  /** 内存环形缓冲：条数 / TTL。 */
  ringSize: z.number().default(20).volatile(),
  ringTtlMs: z.number().default(3_600_000).volatile(),
  /** 关联器调试（首次 assistant/message 打印脱敏事件形状）。 */
  debugAssoc: z.boolean().default(false).volatile(),
  /** 是否生成红句 annotation 并接受人工反馈。 */
  annotationEnabled: z.boolean().default(true).volatile(),
  /** annotation 是否保存句子原文：sentence | none。 */
  annotationStoreText: z.string().default("sentence").volatile(),
  /** annotation 句子原文最大字符数（超出截断）。 */
  annotationMaxSentenceChars: z.number().default(500).volatile(),
  /** annotation/feedback 单文件大小与保留数量。 */
  annotationMaxFileBytes: z.number().default(10 * 1024 * 1024).volatile(),
  annotationKeepFiles: z.number().default(20).volatile(),
  /** 落盘：是否写全量（含正文与每个 token）；false 只写摘要。 */
  recordFull: z.boolean().default(true).volatile(),
  /** 句子级红色阈值（句内实词最低置信度低于此值 → red）。 */
  redThreshold: z.number().default(0.05).volatile(),
  /** 落盘目录（空 = $DSH_HOME/logprobs-highlighter）。 */
  outputDir: z.string().default("").volatile(),
  maxFileBytes: z.number().default(50 * 1024 * 1024).volatile(),
  keepFiles: z.number().default(5).volatile(),
});

/** 解包 cordis 的 volatile 配置值（可能带 .get()）。 */
function unwrap(v) {
  return v && typeof v === "object" && typeof v.get === "function" ? v.get() : v;
}

/** raw config → 普通对象（并补齐默认值，防止 cordis 版本差异导致缺字段）。 */
function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const key of Object.keys(src)) out[key] = unwrap(src[key]);
  const defaults = {
    enabled: true,
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: DEFAULT_MODELS,
    topLogprobs: 5,
    thinking: true,
    reasoningEffort: "high",
    maxTokens: 8192,
    defaultContextWindow: 1_000_000,
    ringSize: 20,
    ringTtlMs: 3_600_000,
    debugAssoc: false,
    annotationEnabled: true,
    annotationStoreText: "sentence",
    annotationMaxSentenceChars: 500,
    annotationMaxFileBytes: 10 * 1024 * 1024,
    annotationKeepFiles: 20,
    recordFull: true,
    redThreshold: 0.05,
    outputDir: "",
    maxFileBytes: 50 * 1024 * 1024,
    keepFiles: 5,
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (out[k] === undefined || out[k] === null || out[k] === "") out[k] = v;
  }
  return out;
}

export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const logger = ctx.logger ?? console;

  logger.info?.(
    `logprobs-highlighter v${PLUGIN_VERSION} apply（provider=${PROVIDER} baseUrl=${config.baseUrl} ` +
    `topLogprobs=${config.topLogprobs} thinking=${config.thinking} enabled=${config.enabled}）`,
  );

  if (!config.enabled) {
    logger.warn?.("logprobs-highlighter: enabled=false，不注册 provider、不采集");
    return;
  }

  // —— 捕获存储 + 落盘 ——
  const capture = createCaptureStore(config, logger);
  const recorder = createRecorder(
    {
      outputDir: config.outputDir,
      recordFull: config.recordFull,
      maxFileBytes: config.maxFileBytes,
      keepFiles: config.keepFiles,
    },
    logger,
  );
  const annotations = createAnnotationStore({
    outputDir: recorder.stats().outputDir,
    config,
    logger,
  });

  // —— provider 路由 ——
  const adapter = createAdapter({
    ctx,
    config,
    capture,
    recorder,
    annotations,
    logger,
    platform: { LlmAdapter, LlmError, attributionHeaders, credentialRef },
  });
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), "logprobs-highlighter: provider adapter");

  // 让设置界面把这条 provider 与它的开关一起列出来（官方 api-key 包同款做法）。
  // settingsNs 取本插件的 profile entry id；取不到时退化为插件名。
  const settingsNs = ctx.fiber?.entry?.options?.id ?? name;
  try {
    ctx.effect(
      () => ctx.llm.registerConfigurableProviders([{
        provider: PROVIDER,
        displayName: DISPLAY_NAME,
        settingsNs,
        settingsPath: [],
      }]),
      "logprobs-highlighter: configurable provider",
    );
  } catch (err) {
    logger.warn?.(`logprobs-highlighter: registerConfigurableProviders 失败（不影响采集）：${err.message}`);
  }

  // —— 关联器：assistant/message → (turn, step) ——
  createAssociator(ctx, capture, logger, { debug: config.debugAssoc });

  // —— HTTP 路由（/status /tokens /feedback /debug /captures）——
  registerRoutes(ctx, { capture, recorder, config, provider: PROVIDER, annotations }, logger);

  // —— dispose ——
  ctx.on("dispose", async () => {
    logger.info?.("logprobs-highlighter: dispose（关闭落盘队列 / 清空捕获）");
    try { await recorder.close(); } catch (err) { logger.warn?.(`dispose 落盘收尾异常：${err.message}`); }
    try { annotations.close(); } catch { /* ignore */ }
    capture.clear();
  });

  logger.info?.(`logprobs-highlighter: provider 路由 ${PROVIDER} 已注册（模型：${config.models.map((m) => m.id).join(", ")}）`);
}