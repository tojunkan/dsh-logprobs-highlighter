# 置信度透视 · Logprobs Highlighter

> 把 DeepSeek 回答里**模型自己最没把握的句子**标红，并把每个 token 的概率留在本地供你复核。
>
> *A DeepSeek Harness preview plugin that highlights the sentences where the model was least sure of its next token, using token-level logprobs.*

| | |
| :--- | :--- |
| 状态 | Preview（预览版，功能会变） |
| 适用 | dsh `0.2.2` 系列，实测 `0.2.2-rc.5`（peer 声明 `>=0.2.2-rc.1 <0.3.0`；更早版本未验证） |
| profile | `web`（有浏览器界面才看得到红色标注） |
| 凭证 | **你自己的 `DEEPSEEK_API_KEY`**，直连 `api.deepseek.com` |

<!-- TODO(截图)：上线前补一张「红句 + hover 浮窗」的 PNG/GIF，放在 docs/assets/ 下并在下方引用。
     另外 dsh 0.2.2 的插件详情页读 locale/*.json 的 meta.detail（单张 640×300 SVG），与 README 图片是两回事。 -->

## 为什么会有这个插件

模型输出读起来总是很确定，但 token 级概率会暴露另一种事实：有的句子它在猜。这个插件把那部分**显式标出来**，让你决定要不要复核——它不是判错器，红句只表示「这里发生了分支」。

## 安装

```bash
# 从 npm
dsh plugin --profile web add dsh-logprobs-highlighter

# 或直接从 GitHub
dsh plugin --profile web add github:tojunkan/dsh-logprobs-highlighter
```

然后：

1. 给 dsh 一个可用的 DeepSeek key —— 在启动 dsh 的环境里设置 `DEEPSEEK_API_KEY`，或写入 dsh 凭证服务（`apiKeyEnv` 改的是引用名）。
2. 启动 `dsh --profile web`，在 **Plugins** 页确认 bundle 是开启状态（安装默认会启用）。
3. 在模型选择器里选 **DeepSeek (logprobs)**。**只有选中这条 provider，采集和标红才会发生**；用普通 DeepSeek 账号通道时插件不参与。

> 这条 provider 用的是你的 `DEEPSEEK_API_KEY` 直连 `api.deepseek.com`，**不会**复用 dsh 已登录的 DeepSeek 账号或订阅。

本地源码开发（改完 client 侧要重新构建）：

```bash
pnpm install
dsh plugin --profile web add "link:<本仓库绝对路径>"
pnpm run build:client     # 改了 src/client/* 之后必须执行
dsh --profile web
```

## 用法

- **红句**：回答结束后，句内实词的最低置信度低于 `redThreshold`（默认 `0.05`）的句子会加红色底；不改动正文 DOM，只叠 `CSS.highlights`。
- **悬停**：浮窗显示原文片段、实写 token 的精确位置、实写 / 备选 / 置信度 / 类别，以及四个标注按钮。
- **标注**：`highlighter_correct`（确实有错）、`reasonable_ambiguity`（合理歧义，不是错）、`highlighter_misjudge`（纯误报）、`unsure`（不确定）。当前 UI 一律按红显示，黄色层还没做，但数据已按语义记录。
- **开关**：正文右下角「标注: 开/关」，或按 `Alt+L`。它只关前端绘制，不影响服务端采集。
- **自检**：浏览器打开 `/plugins/logprobs-highlighter/status`，能看到版本、配置和采集统计就说明 host 侧已就绪。

## 配置

默认值写在 `cordis.patch.yml`；也可以在 profile 的 patch 或 dsh 设置界面覆盖。

| 配置 | 默认 | 说明 |
| :--- | :--- | :--- |
| `enabled` | `true` | 是否注册 provider / 采集 |
| `baseUrl` | `https://api.deepseek.com` | OpenAI 兼容根地址 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 凭证引用名 |
| `topLogprobs` | `5` | 0 / 2 / 5 / 20 |
| `thinking` | `true` | `thinking.type=enabled` |
| `reasoningEffort` | `high` | low / high / max |
| `maxTokens` | `8192` | 默认输出上限 |
| `defaultContextWindow` | `1000000` | dsh 容量判断使用的声称值 |
| `ringSize` | `20` | 内存捕获条数 |
| `ringTtlMs` | `3600000` | 内存捕获 TTL |
| `redThreshold` | `0.05` | 句子红色阈值（`exp(logprob)` 低于它即候选） |
| `annotationEnabled` | `true` | 生成红句 annotation / 接受反馈 |
| `annotationStoreText` | `sentence` | `sentence` 存句子原文；`none` 只存 hash/偏移 |
| `annotationMaxSentenceChars` | `500` | 句子文本截断长度 |
| `annotationMaxFileBytes` | `10485760` | annotations / feedback 轮转大小 |
| `annotationKeepFiles` | `20` | annotations / feedback 保留份数 |
| `recordFull` | `true` | captures 是否写完整正文与每个 token |
| `outputDir` | 空 | 空 = `$DSH_HOME/logprobs-highlighter` |

`redThreshold`、`annotationMaxSentenceChars` 等未列在 `cordis.patch.yml` 里的项按 Config 默认值生效，需要时自己加进 patch。

## 数据与隐私

- 全部写入本地 `$DSH_HOME/logprobs-highlighter`（Windows 一般是 `C:\Users\<user>\.dsh\logprobs-highlighter`），**不上传**。
- `recordFull: true` 时 `captures.jsonl` 含**完整回答正文和每个 token**；`annotationStoreText: sentence` 时 `annotations.jsonl` 含句子原文。介意的话分别改成 `false` / `none`。
- 除 `api.deepseek.com` 外不发起任何外部请求；服务端只有本机 `/plugins/logprobs-highlighter/*` 这些读取和反馈接口。
- 关联只用到 session / turn / step 标识，不读取会话之外的任何内容。
- 想彻底停机：Plugins 页关掉 bundle，或把 `enabled` 设为 `false`。

## 已知限制

- **红句偏多**：函数词、句首、格式 token 会产生误报，阈值仍偏宽松。
- **tool-call 参数没有 logprobs**：只采集 `logprobs.content` 与 `logprobs.reasoning_content`。
- **代码块不标红**：代码更适合交给编译 / lint / 测试判断。
- **没有漏报度量**：只能看标出来的，看不到没标出来的。
- **没有历史浏览页**：重启后能从 `annotations.jsonl` 恢复红点，但打不开旧会话的标注界面。
- **黄色层未绘制**：`reasonable_ambiguity` 已进标签 schema，UI 仍按红显示。
- **focus 未 UI 化**：服务端支持字符区间，客户端目前主要传单 token 索引。
- **人工 verdict 不是金标准**：它记录的是你的判断。

## HTTP 接口

前缀 `/plugins/logprobs-highlighter`：

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| GET | `/status` | 版本、配置、采集 / 落盘 / annotation 统计 |
| GET | `/tokens?session=&turn=&step=` | 取某轮的红句 annotation |
| POST | `/feedback` | 提交或修改人工 verdict |
| GET | `/debug` | 最近捕获摘要 |
| GET | `/captures` | 最近原始捕获 |

字段与 verdict / reason 枚举见 [docs/MAINTAINER.md](https://github.com/tojunkan/dsh-logprobs-highlighter/blob/main/docs/MAINTAINER.md)。

## 开发

```bash
pnpm install
pnpm test          # 后端与 annotation 自测
pnpm run check     # 语法检查
pnpm run build:client
```

- 改 `lib/*.js`（host 侧）→ 重启 dsh。
- 改 `src/client/*.js` → 必须 `pnpm run build:client` 重新生成 `lib/client.js` 再刷新页面；`lib/client.js` 是生成文件，不要手改。
- 目录：`lib/` host 侧与生成的 client；`src/client/` 客户端源码；`scripts/` 构建与分析；`test/` 自测；`docs/` 研究/历史文档（部分已过时）。

dsh 服务契约、升级检查清单、模块职责表在 [docs/MAINTAINER.md](https://github.com/tojunkan/dsh-logprobs-highlighter/blob/main/docs/MAINTAINER.md)。

## License

MIT
