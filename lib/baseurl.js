/**
 * logprobs-highlighter — baseURL 接管/还原 + 启动自愈（SettingsTakeover）
 *
 * 语义（architecture-v4 §1.1/§2.2/§5 风险 #7，README §3.6）：
 * - 接管：ctx.settings.update("llm-deepseek", {baseURL:"http://127.0.0.1:<port>"})
 *   （merge，实时生效，无需重启；dsh-settings update(ns, patch, rev?)）
 * - 必须等 llm-deepseek 命名空间就绪（internal/service 事件重试 + 定时兜底）
 * - 启动自愈（I3）：apply 时若检测到当前 baseURL == 本插件代理地址，视为自己上次
 *   写入的残留（SIGKILL/崩溃后 dispose 未执行）——先确保代理监听成功再接管；
 *   代理启动失败则回滚还原并打告警（崩溃场景下旧值不可知 → 还原为默认直连地址，
 *   并提示可手动编辑 $DSH_HOME/settings.yaml 删除该行）
 * - 反代上游 = 接管前的旧 baseURL（original）；manageBaseUrl:false 时 = 配置
 *   upstreamBaseUrl（I2）
 * - dispose：还原 baseURL（仅当当前值仍等于我们写入的值，避免覆盖用户后来改动）、
 *   关闭代理
 *
 * @module logprobs-highlighter/baseurl
 */

const NS = "llm-deepseek";
const DEFAULT_UPSTREAM = "https://api.deepseek.com";

/** llm-deepseek 有效 baseURL = config.baseURL ?? $DEEPSEEK_BASE_URL ?? 默认（dsh-llm-deepseek :705-707）。 */
function effectiveBaseUrl(settingsCfg) {
  if (settingsCfg && typeof settingsCfg.baseURL === "string" && settingsCfg.baseURL) return settingsCfg.baseURL;
  return process.env.DEEPSEEK_BASE_URL || DEFAULT_UPSTREAM;
}

export function createSettingsTakeover(ctx, config, logger = console) {
  const { manageBaseUrl = true, proxyPort = 8787, upstreamBaseUrl = DEFAULT_UPSTREAM } = config || {};
  const ourUrl = `http://127.0.0.1:${proxyPort}`;

  let original = null; // 接管前的旧 baseURL（= 反代上游）
  let managed = false; // 本次会话是否已接管
  let selfHealed = false; // 启动时发现残留并自愈
  let ready = false; // llm-deepseek 命名空间已就绪
  let done = false;
  let timers = [];

  /** 读取 llm-deepseek 命名空间解析后的配置（命名空间未就绪时抛错）。 */
  function readSettings() {
    return ctx.settings.get(NS);
  }

  function tryRestoreBaseUrl(target) {
    try {
      return ctx.settings.update(NS, { baseURL: target });
    } catch (err) {
      logger.warn(`baseurl: 还原/写入失败（${err.message}）`);
      return null;
    }
  }

  /**
   * 尝试接管（幂等）。返回是否成功。
   * 顺序：① 检测残留 → ② 记录 original → ③ update 写入 ourUrl。
   */
  async function attemptTakeover(proxy) {
    if (done) return managed;
    let current;
    try {
      current = effectiveBaseUrl(readSettings());
      ready = true;
    } catch {
      return false; // 命名空间未就绪，等重试
    }

    const isResidual = current === ourUrl;
    if (isResidual && !selfHealed) {
      // 启动自愈：上次崩溃残留。先确保代理监听成功再继续。
      selfHealed = true;
      logger.warn(`baseurl: 检测到残留 baseURL=${ourUrl}（上次未正常还原），执行启动自愈`);
      try {
        await proxy.start();
      } catch (err) {
        logger.error(`baseurl: 自愈失败——代理监听失败（${err.message}），回滚还原为默认直连并告警`);
        logger.error("baseurl: 崩溃前旧值不可知，还原为默认直连地址；亦可手动编辑 $DSH_HOME/settings.yaml 删除 baseURL 行");
        tryRestoreBaseUrl(DEFAULT_UPSTREAM);
        return false;
      }
    }

    if (!isResidual) {
      // 正常首装：记录旧值（= 反代上游），然后接管
      original = current;
    } else {
      // 残留场景：旧值不可知 → 反代上游用配置 upstreamBaseUrl 兜底
      original = upstreamBaseUrl;
    }

    try {
      await ctx.settings.update(NS, { baseURL: ourUrl });
      managed = true;
      logger.info(`baseurl: 已接管 llm-deepseek.baseURL → ${ourUrl}（original=${original}${selfHealed ? "，自愈模式" : ""}）`);
    } catch (err) {
      logger.warn(`baseurl: 接管失败（${err.message}），本次不托管 baseURL`);
      managed = false;
    }
    return managed;
  }

  /**
   * 由 index.apply 调用：确保代理监听成功 → 等命名空间就绪 → 接管。
   * 返回 { upstream, managed } 供 /status 与 proxy 使用。
   */
  async function takeover(proxy) {
    if (!manageBaseUrl) {
      managed = false;
      original = upstreamBaseUrl;
      logger.info(`baseurl: manageBaseUrl=false，不接管（反代上游 = 配置 ${upstreamBaseUrl}）`);
      return { managed, upstream: original };
    }

    // 启动自愈（I3）：检测到残留时 attemptTakeover 内部会先确保代理监听成功。
    // 正常首装也先监听成功再接管，避免 dsh 请求打到死端口。
    if (!proxy.listening()) {
      try {
        await proxy.start();
      } catch (err) {
        logger.error(`baseurl: 代理监听失败（${err.message}），不接管 baseURL（manageBaseUrl 生效但代理不可用）`);
        // I3 兜底：若 settings 恰好残留本插件地址（崩溃场景），旧值不可知 →
        // 回滚还原为默认直连地址并告警，避免 LLM 请求打到死端口。
        try {
          const current = effectiveBaseUrl(readSettings());
          if (current === ourUrl) {
            selfHealed = true;
            tryRestoreBaseUrl(DEFAULT_UPSTREAM);
            logger.error("baseurl: 残留 baseURL 已回滚为默认直连地址；亦可手动编辑 $DSH_HOME/settings.yaml 删除该行");
          }
        } catch { /* 命名空间未就绪则忽略 */ }
        return { managed: false, upstream: upstreamBaseUrl };
      }
    }

    let iv = null;
    let timeout = null;
    const stopRetry = () => {
      if (iv) { clearInterval(iv); iv = null; }
      if (timeout) { clearTimeout(timeout); timeout = null; }
    };
    const tryNow = async () => {
      if (done) { stopRetry(); return; }
      try {
        await attemptTakeover(proxy);
      } catch (err) {
        logger.warn(`baseurl: 接管尝试异常（${err.message}），稍后重试`);
      }
      if (managed || done) stopRetry(); // 成功即停，不留定时器（可测性：无悬挂 interval/timeout）
    };
    await tryNow();

    if (!managed && !done) {
      // 命名空间未就绪：internal/service 事件重试 + 定时兜底（30s 上限）
      ctx.on("internal/service", (name) => {
        if (name === NS || name === "settings") void tryNow();
      });
      iv = setInterval(() => void tryNow(), 2000);
      timers.push(iv);
      timeout = setTimeout(() => {
        if (!managed && !done) {
          logger.warn(`baseurl: 等待 llm-deepseek 命名空间超时（30s），本次不托管 baseURL（反代仍监听，可手动设 $DEEPSEEK_BASE_URL）`);
          stopRetry();
        }
      }, 30_000);
      timers.push(timeout);
    }
    return { managed, upstream: original };
  }

  /** dispose：还原 baseURL（仅当当前值仍等于我们写入的值）+ 清理定时器。 */
  async function restore() {
    done = true;
    for (const t of timers) clearInterval(t);
    timers = [];
    if (!managed) return;
    let current;
    try {
      current = effectiveBaseUrl(readSettings());
    } catch {
      current = null;
    }
    if (current !== ourUrl) {
      logger.info(`baseurl: 当前 baseURL=${current} 已不是我们写入的值（${ourUrl}），跳过还原`);
      return;
    }
    const target = original ?? DEFAULT_UPSTREAM;
    try {
      await ctx.settings.update(NS, { baseURL: target });
      logger.info(`baseurl: 已还原 llm-deepseek.baseURL → ${target}`);
    } catch (err) {
      logger.warn(`baseurl: 还原失败（${err.message}），请手动编辑 $DSH_HOME/settings.yaml`);
    }
    managed = false;
  }

  return { takeover, restore, getState: () => ({ managed, original, current: ourUrl, selfHealed }) };
}
