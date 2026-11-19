# AI 置信度透视插件（Logprobs Highlighter）

> **状态：预览版（preview）。**  
> 当前实现是 dsh **provider 模式**，已在 dsh `0.2.2-rc.5` 上验证启动。
>
> 注意：`docs/architecture-v4.md` 等文档描述的是早期的“反代 + baseURL 接管”方案，**已经过时**；本 README 与 `lib/`、`src/client/` 代码为准。

## 1. 这是什么

这是一个 dsh 插件。它在 dsh 的模型选择器里注册一条独立的 provider：

```text
deepseek-logprobs
```

使用这条 provider 时，插件会：

1. 调用 DeepSeek Chat Completions，并请求 token 级 `logprobs` / `top_logprobs`；
2. 在把流映射回 dsh 的同时，把每个 token 的置信度、候选词捕获到内存和 JSONL；
3. 在回答结束后，按句子生成“红色候选”；
4. 在 dsh 的回答正文上用红色底标出候选句子；
5. 鼠标悬停时展示：
   - 实写 token 和它的模型备选；
   - 实写 token 在原文中的精确位置；
   - 人工标注入口。

它**不负责证明模型一定错了**。红色只是“模型在这里犹豫 / 发生了分支”，是否真的有问题由人判断。

## 2. 核心概念

### 2.1 logprob 与 confidence

上游返回每个 token 的：

```json
{
  "token": "…",
  "logprob": -0.03,
  "bytes": [ … ],
  "top_logprobs": [ … ]
}
```

插件把它们归一化为：

```text
confidence = exp(logprob)
```

- `confidence` 高：模型对这个 token 比较确定；
- `confidence` 低：模型在这里有候选分支；
- `top[]`：模型考虑过的其他 token；
- `bytes`：token 的真实 UTF-8 字节。DeepSeek 在半个 UTF-8 字符处可能返回 `\xe5\x95` 这类转义 token，插件会按 `bytes` / 转义还原后重新对齐，避免偏移漂移。

### 2.2 句子级红色候选

回答结束后，插件按句切开正文，并做保守过滤：

- 跳过代码块、表格行、过短句子；
- 跳过纯标点/空白/格式 token；
- 跳过句首少量字的热身区；
- 只统计“实词”token；
- 句内实词的最低置信度低于 `redThreshold`（默认 `0.05`）时，生成一个红色候选。

红色候选只是**审查候选**，不是事实判断。当前阈值仍偏宽松，真实数据里会出现大量“虚词/格式/同义改写”误报。

### 2.3 标注结论（verdict）

每个红色候选在落盘时初始为：

```text
verdict = "unsure"
```

人工可以改成四类：

| verdict | 含义 | 未来颜色 |
| :--- | :--- | :--- |
| `highlighter_correct` | 确实有错/风险，高亮命中 | 红 |
| `reasonable_ambiguity` | 句子本身可接受，但存在多个合理选择；不是错误 | 黄（当前仍按红显示） |
| `highlighter_misjudge` | 纯误报/噪声 | 不标 |
| `unsure` | 无法判断 | 灰 |

UI 文案对应：

```text
确实有错  → highlighter_correct
合理歧义  → reasonable_ambiguity
纯误报    → highlighter_misjudge
不确定    → unsure
```

`reasonable_ambiguity` 包含：

- 多种合理接续；
- 措辞/语气斟酌；
- 句首开场方式；
- 其他“不是错误但值得知道”的分支。

**当前 UI 还没有实现黄色层**：`reasonable_ambiguity` 仍会显示在红色候选里，但标注数据已经按黄色语义记录，供下一步判据升级使用。

### 2.4 标注粒度

- **判定单位是句子**：`verdict` + reason 描述“这个红色候选是否有效、为什么”。
- **归因单位是 trigger**：用户可以点选一个实写 token，作为“最主要的问题词”。
- 服务端已支持 `focus` 字符区间（`{start,end,text}`）；当前 UI 仍主要使用 trigger 索引，连续多 token 的 span 选择是后续增强。

## 3. 功能清单

### 服务端

- 注册 dsh provider `deepseek-logprobs`；
- 模型目录与设置界面条目；
- DeepSeek `/chat/completions` 请求构造；
- SSE 流解析并映射回 dsh 的 `StreamChunk`；
- reasoning / text / tool-call 三类块映射；
- 双字段 logprobs 采集：
  - `logprobs.content` → text；
  - `logprobs.reasoning_content` → reasoning；
- token 字节对齐（半个 UTF-8 字符）；
- 400/422 logprobs 不支持时去注入重试并记录模型黑名单；
- 内存环形缓冲 + JSONL 全量/摘要落盘；
- 按 `(sessionId, turn, step)` 关联捕获；
- 红句 annotation 生成与持久化；
- 人工 verdict 反馈接口；
- `/status`、`/tokens`、`/feedback`、`/debug`、`/captures` 路由；
- 重启后从 `annotations.jsonl` 恢复历史红句。

### 客户端

- 在 `conversation.chat.turnTail` 槽挂载轻量注入器；
- 通过 `CSS.highlights` 给句子区间贴红色底，不修改正文 DOM；
- 悬停浮窗：
  - 原文片段；
  - 实写 token 在原文中的红色位置；
  - `实写 … · 备选 … · 置信度 · 类别`；
  - 四个 verdict 按钮；
  - 按 verdict 展示对应的 reason chips；
  - 默认 reason 为 `cannot_tell`；
- 右下角“标注: 开/关”开关，快捷键 `Alt+L`；
- 标注提交失败可见，不静默成功。

### 明确未做

- tool-call 参数 token 的 logprobs 采集；
- 代码块的红色高亮；
- 黄色层实际绘制；
- replay / 历史标注页面；
- audit 模式（未标红句子的漏报抽样）；
- 多 token 的 `focus` 可视化选择；
- 分类器/模型自动判错。

## 4. 架构与数据流

```text
dsh / browser
  │
  ├─ dsh llm service
  │    └─ registerAdapter(["deepseek-logprobs"], adapter)
  │         ├─ 请求 DeepSeek /chat/completions
  │         ├─ 解析 SSE → StreamChunk
  │         ├─ 采集 logprobs → capture store
  │         └─ 流结束后 → annotation store（红句，初始 unsure）
  │
  ├─ sessions service
  │    ├─ step/start → 请求前读取 (turn, step)
  │    └─ session/event → assistant/message 兜底关联
  │
  ├─ webServer
  │    ├─ GET  /plugins/logprobs-highlighter/tokens
  │    ├─ POST /plugins/logprobs-highlighter/feedback
  │    ├─ GET  /status /debug /captures
  │    └─ 重启后 /tokens 可从 annotations.jsonl 反查
  │
  └─ 浏览器客户端
       ├─ conversation.chat.turnTail
       ├─ fetch /tokens
       ├─ CSS.highlights 红底
       └─ hover → POST /feedback
```

### 主要模块

| 文件 | 职责 |
| :--- | :--- |
| `lib/index.js` | 插件入口、配置、provider/路由/关联器装配 |
| `lib/provider.js` | dsh provider adapter、DeepSeek 请求与 SSE 流映射 |
| `lib/wire.js` | dsh `GenerateOptions` ↔ OpenAI Chat Completions body |
| `lib/capture.js` | 捕获条目、环形缓冲、sessionId FIFO、turn/step 索引 |
| `lib/assoc.js` | `assistant/message` → `(turn, step)` 兜底关联 |
| `lib/sentences.js` | token 字节对齐、归一化、切句、红句判定 |
| `lib/annotations.js` | 红句 annotation、持久化、verdict/reason 校验 |
| `lib/recorder.js` | `captures.jsonl` / `summary.jsonl` 异步落盘 |
| `lib/routes.js` | `/tokens`、`/feedback`、`/status` 等 HTTP 接口 |
| `src/client/index.js` | 客户端插件入口、turnTail 注册、拉取数据 |
| `src/client/injector.js` | CSS Highlight、hover 浮窗、标注交互、开关 |
| `scripts/build-client.mjs` | 用 esbuild 生成 `lib/client.js` |
| `scripts/rebuild-annotations.mjs` | 基于 captures 重建 annotations/feedback（会备份旧文件） |
| `scripts/analyze-captures.mjs` | 离线分析 captures 的置信度/突变/句子统计 |

## 5. 数据文件

默认目录：

```text
$DSH_HOME/logprobs-highlighter
```

Windows 默认是：

```text
C:\Users\<user>\.dsh\logprobs-highlighter
```

文件：

```text
captures.jsonl      每条流一行，recordFull=true 时含正文和每个 token
summary.jsonl       每条流一行，轻量统计
annotations.jsonl   每个红句一行的 annotation（初始 verdict=unsure）
feedback.jsonl      人工 verdict 更新事件（append-only，latest revision wins）
```

说明：

- `annotations` 与 `feedback` 是标签的**真源**；`captures` 是原始数据/负样本/调试缓存。
- `/tokens` 在内存 capture 缺失时，会从 `annotations.jsonl` 按 `(sessionId, turn)` 反查；因此 dsh 重启后旧红点仍可恢复。
- `annotationStoreText` 设为 `none` 时不保存 `sentence.text`；`sentence.plain` 和偏移仍保留，用于文本匹配定位。
- `rebuild-annotations.mjs` 会重写 annotations/feedback，并先把旧文件移到 `bak-<timestamp>-*` 目录；执行前建议停 dsh。

## 6. 安装与开发

### 安装到 profile

```bash
dsh plugin --profile web add "link:E:/Dujia/DuRunHan/Programs/dsh-logprobs-highlighter"
dsh --profile web
```

然后在 dsh 模型选择器里选择：

```text
DeepSeek (logprobs)
```

### 依赖与构建

```bash
npm install
npm test
npm run build:client
```

- 修改 host 侧（`lib/*.js`）后需要重启 dsh；
- 修改 client 侧（`src/client/*.js`）后必须重新运行 `npm run build:client`，再刷新页面；
- `lib/client.js` 是生成文件，不要手改。

### 配置

常用配置（`cordis.patch.yml` 或 dsh 设置界面）：

| 配置 | 默认 | 说明 |
| :--- | :--- | :--- |
| `enabled` | `true` | 是否注册 provider/采集 |
| `baseUrl` | `https://api.deepseek.com` | OpenAI 兼容根地址 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 凭证引用名 |
| `topLogprobs` | `5` | 0 / 2 / 5 / 20 |
| `thinking` | `true` | `thinking.type=enabled` |
| `reasoningEffort` | `high` | low / high / max |
| `maxTokens` | `8192` | 默认输出上限 |
| `defaultContextWindow` | `1000000` | dsh 容量判断 |
| `ringSize` | `20` | 内存捕获条数 |
| `ringTtlMs` | `3600000` | 内存捕获 TTL |
| `redThreshold` | `0.05` | 句子红色阈值 |
| `annotationEnabled` | `true` | 生成 annotation / 接受反馈 |
| `annotationStoreText` | `sentence` | `sentence` / `none` |
| `annotationMaxSentenceChars` | `500` | 句子文本截断 |
| `annotationMaxFileBytes` | `10485760` | annotations/feedback 轮转大小 |
| `annotationKeepFiles` | `20` | annotations/feedback 保留份数 |
| `recordFull` | `true` | captures 是否写正文/token |
| `outputDir` | 空 | 空 = `$DSH_HOME/logprobs-highlighter` |

## 7. HTTP API

所有路径前缀：

```text
/plugins/logprobs-highlighter
```

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| GET | `/tokens?session=&turn=&step=` | 取某个 turn/step 的红句 annotation |
| POST | `/feedback` | 提交/修改人工 verdict |
| GET | `/status` | 版本、配置、capture/recorder/annotation 统计 |
| GET | `/debug` | 最近捕获摘要 |
| GET | `/captures` | 最近原始捕获 |

`/tokens` 的关键字段：

```jsonc
{
  "captureId": "req-...",
  "captured": true,
  "annotation": { "enabled": true, "algoVersion": "red-v2.1" },
  "sentences": [
    {
      "markId": "mk-...",
      "sentenceKey": "sk-...",
      "start": 426,
      "end": 502,
      "level": "red",
      "plain": "……",
      "text": "……原文……",
      "triggers": [
        {
          "token": "8",
          "confidence": 0.047,
          "category": "digit",
          "start": 8,
          "end": 9,
          "top": [ … ]
        }
      ],
      "verdict": "unsure",
      "error_type": null,
      "ambiguity_kind": null,
      "misjudge_reason": null,
      "focus": null
    }
  ]
}
```

`triggers[].start/end` 是**相对句子 `text` 的偏移**，客户端用来在原文里标出实写 token 的位置。

`POST /feedback` 示例：

```jsonc
{
  "markId": "mk-...",
  "sentenceKey": "sk-...",
  "captureId": "req-...",
  "verdict": "highlighter_correct",
  "error_type": "conflicting_sources",
  "ambiguity_kind": null,
  "misjudge_reason": null,
  "focus": { "start": 8, "end": 9, "text": "8" },
  "triggerIndex": 0,
  "uiMode": "inline"
}
```

### verdict 与 reason

```text
highlighter_correct
  error_type:
    factual_error / fabrication / self_contradiction / user_contradiction /
    logic_gap / conflicting_sources / other / cannot_tell

reasonable_ambiguity
  ambiguity_kind:
    continuation / wording / opening / other / cannot_tell

highlighter_misjudge
  misjudge_reason:
    paraphrase / format / function_word / correct_entity /
    code_or_math / other / cannot_tell

unsure
  两个 reason 均为 null
```

规则：

- 任何 verdict 选中后，对应 reason 默认 `cannot_tell`；
- 服务端会按 verdict 清空无关 reason；
- `feedback.jsonl` append-only，读取时取同一 `markId` 的最大 `revision`。

## 8. dsh 服务依赖

这一节是升级/改造时最先看的地方。

### 8.1 host 侧

| 依赖 | 使用位置 | 当前契约 |
| :--- | :--- | :--- |
| `llm` 服务 | `lib/index.js`、`lib/provider.js` | `ctx.llm.registerAdapter([PROVIDER], adapter)`；`ctx.llm.registerConfigurableProviders([...])`；`LlmAdapter` / `LlmError` / `attributionHeaders` 从 `@deepseek-ai/dsh-llm` 导入 |
| `credentials` 服务 | `lib/provider.js` | `credentialRef(name)`；`ctx.get("credentials").resolve(ref)` |
| `sessions` 服务 | `lib/provider.js`、`lib/assoc.js` | `ctx.get("sessions").get(sessionId)`；`session.snapshotEvents()`；`sessions.ctx.on("session/event", cb)` |
| `webServer` / `httpServer` | `lib/routes.js` | `ctx.get("webServer") ?? ctx.get("httpServer")`；`register({ kind: "exact", path, handler })`；通过 `ctx.on("internal/service", ...)` 晚绑定 |
| cordis context | 全插件 | `ctx.effect` / `ctx.on` / `ctx.get` / `ctx.logger` / `ctx.fiber?.entry?.options?.id` |
| `@deepseek-ai/schemastery` | `lib/index.js` | `z.object(...)` 配置 |
| `@deepseek-ai/dsh-credentials` | `lib/index.js` | `credentialRef` |
| `@deepseek-ai/dsh-llm` | `lib/index.js`、`lib/provider.js` | adapter 基类、错误、归属 header |

### 8.2 client 侧

| 依赖 | 使用位置 | 当前契约 |
| :--- | :--- | :--- |
| `slots` 服务 | `src/client/index.js` | `ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({ name, id, order }, Component))` |
| `sessions` 服务 | `src/client/index.js` | session scope 注入 `sessionId` |
| `conversation.chat.turnTail` 槽 | `src/client/index.js` | owner props 当前为 `{ turn, seq, openFile }`；本次实现按 list 槽注册（不是 chain） |
| dsh Markdown DOM 锚点 | `src/client/injector.js` | `[data-chat-flow-kind="assistant-step"][data-chat-turn=N][data-chat-group-part="response"]` |
| 虚拟滚动/可见性 | `src/client/injector.js` | 只对 `getClientRects().length > 0` 的节点绘制 |
| `window.__ModuleLoader__.load` | `lib/client.js` | client bundle 由 `scripts/build-client.mjs` 包装 |
| `package.json dsh.client` | `package.json` | `entry`、`inject`、`platform: "web"`；当前 inject 含 `dsh-client-locale`、`dsh-client-runtime`、`dsh-client-ui-conversation` |
| `package.json dsh.bundle.patch` | `package.json` | 指向 `cordis.patch.yml` |

### 8.3 升级检查清单

dsh 升级后，如果插件不工作，按顺序检查：

1. **profile 配置是否残留旧服务名**
   - dsh `0.2.1+` 用 `webStartup` 取代 `webRuntime`；
   - 如果 `~/.dsh/profiles/web/cordis.patch.yml` 还有：
     ```yaml
     - id: connection
       inject: [ webRuntime, webServer ]
     ```
     改成：
     ```yaml
     - id: connection
       inject: [ webStartup, webServer ]
     ```
     或直接删除这段旧覆盖。否则必需的 `connection` 会一直 pending。
2. **provider 是否注册成功**
   - 看 `/plugins/logprobs-highlighter/status`；
   - 看模型选择器里是否出现 “DeepSeek (logprobs)”；
   - 检查 `registerAdapter` / `registerConfigurableProviders` 签名。
3. **流映射是否仍然成立**
   - `StreamChunk` 类型（block-start / text-delta / reasoning-delta / tool-call-delta / usage / finish）；
   - `GenerateOptions` 的字段名；
   - `reasoning_content` / `logprobs.content` 的返回结构。
4. **session 事件/关联**
   - `step/start` 是否仍能通过 `session.snapshotEvents()` 读到；
   - `assistant/message` 是否仍由 `sessions.ctx` 派发。
5. **客户端槽位**
   - `conversation.chat.turnTail` 是否仍存在；
   - owner props 是否仍为 `{ turn, seq, openFile }`；
   - `data-chat-*` DOM 锚点是否变化；
   - 重新执行 `npm run build:client`。
6. **client bundle 外部依赖**
   - 如果 dsh 的 client module 名称变化，需要同步 `scripts/build-client.mjs` 的 `SEEDS`。
7. **标注数据**
   - `SENTENCES_ALGO_VERSION` 是否递增；
   - token 对齐是否仍按 `bytes`；
   - 旧 annotation 是否仍在 `annotations.jsonl`，`/tokens` 是否能从文件反查。

## 9. 已知限制与下一步

- **红色仍偏多**：当前 `redThreshold=0.05` + 单句最低置信度，函数词、句首、格式会产生误报；下一步应把 `reasonable_ambiguity` 升级为黄色层，并收紧红判据。
- **tool-call 参数无 logprobs**：当前只采集 `logprobs.content` 与 `logprobs.reasoning_content`；tool-call 参数不在概率数据里。
- **代码块不标红**：代码 token 平均置信度很高，且代码错误更适合编译/lint/测试/路径校验。
- **只有红点标注**：无法估计漏报；后续需要 audit 抽样。
- **无 replay UI**：重启后能恢复红句，但没有历史会话浏览/标注页面。
- **无黄色绘制**：`reasonable_ambiguity` 已进入标签 schema，但 UI 仍按红显示。
- **focus 尚未 UI 化**：服务端支持 `focus` 字符区间，客户端当前主要传单 trigger 索引。
- **无真实 ground truth**：人工 verdict 是用户判断，不是事实金标准；后续需要专家标注/抽样复核。

## 10. 目录

```text
.
├── lib/                     host 侧插件与生成后的 client。
├── src/client/             客户端源码（React + DOM injector）。
├── scripts/                构建、分析、重建 annotation。
├── test/                   后端/annotation 自测。
├── docs/                   研究/历史设计/审查记录（部分已过时）。
├── cordis.patch.yml        插件默认配置。
└── package.json            dsh bundle/client 清单。
```

## 11. 测试

```bash
npm test
npm run check
npm run build:client
```

当前自测覆盖：

- wire 映射；
- 请求体构造；
- capture 存储/淘汰/黑名单；
- recorder 摘要与落盘；
- adapter 流映射/错误路径；
- inline code / math / image 归一化；
- 半个 UTF-8 token 的字节对齐；
- 红句 annotation、verdict/reason 分支、重启恢复。

客户端交互（hover、CSS Highlight、按钮）目前仍以真实 dsh 页面联调为准。

## 12. 许可证

MIT。