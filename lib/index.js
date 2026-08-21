/**
 * logprobs-highlighter — 服务端插件入口
 *
 * dsh sidecar 插件（architecture-v4 §1.1，README §3.5）：
 * - `dsh plugin --profile web add "link:<项目根>"` 安装（cordis.patch.yml 注入本行）
 * - apply 流程：① 捕获存储 ② 反代 8787（注入→分流→剥皮→转发）③ baseURL 接管
 *   （等 llm-deepseek 命名空间就绪 + 启动自愈）④ 关联器 ⑤ webServer 路由（晚绑定）
 * - dispose：还原 baseURL、关闭 8787、清空内存
 *
 * 模块划分与 architecture-v4 §1.1 一致：proxy / capture / assoc / baseurl / routes。
 *
 * @module logprobs-highlighter
 */

import z from "@deepseek-ai/schemastery";
import { createCaptureStore } from "./capture.js";
import { createProxy } from "./proxy.js";
import { createAssociator } from "./assoc.js";
import { createSettingsTakeover } from "./baseurl.js";
import { registerRoutes } from "./routes.js";
import { PLUGIN_VERSION } from "./shared.js";

export const name = "logprobs-highlighter";

/** 声明依赖的服务（agent-teams 先例：声明后 ctx.<name> 可用；webServer 晚绑定不在此声明）。 */
export const inject = ["settings"];

/** 插件配置（architecture-v4 §3.5；topLogprobs 用 z.union 约束 {0,2,5,20}——审查 R6）。 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  proxyPort: z.number().default(8787),
  manageBaseUrl: z.boolean().default(true),
  upstreamBaseUrl: z.string().default("https://api.deepseek.com"),
  topLogprobs: z.number().default(2),
  modelGlob: z.string().default("deepseek-*"),
  ringSize: z.number().default(20),
  ringTtlMs: z.number().default(3600_000),
  mutationZ: z.number().default(-2.5), // 突变点阈值（M4 调参，M2 接入标记引擎）
  debugAssoc: z.boolean().default(false), // 关联器调试：首次 assistant/message 打印脱敏事件形状（IMP-3）
});

export async function apply(ctx, rawConfig) {
  console.error('LOGPROBS PLUGIN APPLY STARTED');
  const config = {
    enabled: rawConfig?.enabled ?? true,
    proxyPort: rawConfig?.proxyPort ?? 8787,
    manageBaseUrl: rawConfig?.manageBaseUrl ?? true,
    upstreamBaseUrl: rawConfig?.upstreamBaseUrl ?? "https://api.deepseek.com",
    topLogprobs: rawConfig?.topLogprobs ?? 2,
    modelGlob: rawConfig?.modelGlob ?? "deepseek-*",
    ringSize: rawConfig?.ringSize ?? 20,
    ringTtlMs: rawConfig?.ringTtlMs ?? 3600_000,
    mutationZ: rawConfig?.mutationZ ?? -2.5,
    debugAssoc: rawConfig?.debugAssoc ?? false,
  };

  ctx.logger?.info?.(`logprobs-highlighter v${PLUGIN_VERSION} apply（proxyPort=${config.proxyPort} topLogprobs=${config.topLogprobs} manageBaseUrl=${config.manageBaseUrl} modelGlob=${config.modelGlob}）`);

  // —— 捕获存储（环形缓冲 + 黑名单 + FIFO + 索引） ——
  const capture = createCaptureStore(config, ctx.logger);

  // —— 反代（getUpstream：接管模式 = 接管前旧 baseURL；manageBaseUrl:false = 配置 upstreamBaseUrl） ——
  const proxy = createProxy({
    port: config.proxyPort,
    modelGlob: config.modelGlob,
    topLogprobs: config.topLogprobs,
    getUpstream: () => {
      const b = baseurl.getState();
      return b.managed ? (b.original ?? config.upstreamBaseUrl) : config.upstreamBaseUrl;
    },
    capture,
    logger: ctx.logger ?? console,
  });

  // —— baseURL 接管/还原 + 启动自愈 ——
  const baseurl = createSettingsTakeover(ctx, config, ctx.logger ?? console);

  if (!config.enabled) {
    ctx.logger?.warn?.("logprobs-highlighter: enabled=false，不接管/不监听；若 settings 残留本插件 baseURL 则还原为默认直连");
    const b = baseurl.getState();
    // 安全兜底：禁用时若残留我们写入的 baseURL（崩溃场景），尝试还原为默认直连
    try {
      const cfg = ctx.settings.get("llm-deepseek");
      const current = cfg && typeof cfg.baseURL === "string" && cfg.baseURL ? cfg.baseURL : process.env.DEEPSEEK_BASE_URL;
      if (current === b.current) {
        await ctx.settings.update("llm-deepseek", { baseURL: config.upstreamBaseUrl });
        ctx.logger?.warn?.(`logprobs-highlighter: 已还原残留 baseURL → ${config.upstreamBaseUrl}`);
      }
    } catch { /* 命名空间未就绪则忽略 */ }
    return;
  }

  // —— 接管（内部：先确保代理监听成功，再等命名空间就绪，最后写入 settings） ——
  const takeoverState = await baseurl.takeover(proxy);
  if (!proxy.listening()) {
    ctx.logger?.warn?.(`logprobs-highlighter: 反代未在监听（端口 ${config.proxyPort} 可能被占用），/status 将显示 listening=false`);
  }

  // —— 关联器：assistant/message → sessionId FIFO 出队（IMP-3：debugAssoc 开关） ——
  createAssociator(ctx, capture, ctx.logger ?? console, { debug: config.debugAssoc });

  // —— webServer 路由（晚绑定） ——
  registerRoutes(ctx, { capture, baseurl, proxy, config }, ctx.logger ?? console);

  // —— dispose：还原 baseURL → 关闭 8787 → 清空内存 ——
  // SUG-5：返回 Promise（cordis 若 await dispose 则可完整执行；不 await 时也尽早触发）。
  ctx.on("dispose", async () => {
    ctx.logger?.info?.("logprobs-highlighter: dispose（还原 baseURL / 关闭反代 / 清空捕获）");
    try { await baseurl.restore(); } catch (err) { ctx.logger?.warn?.(`dispose 还原 baseURL 异常：${err.message}`); }
    try { await proxy.close(); } catch (err) { ctx.logger?.warn?.(`dispose 关闭反代异常：${err.message}`); }
    capture.clear();
  });

  ctx.logger?.info?.(`logprobs-highlighter: M1 骨架就绪（takeover=${takeoverState.managed ? "managed" : "unmanaged"}）`);
}
