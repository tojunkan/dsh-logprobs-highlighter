# 维护者文档

README 只讲用户怎么装、怎么用。这里放升级 dsh、改代码时会用到的东西：服务契约、数据格式、升级检查清单。

> 仓库里的 `docs/architecture-v4.md` 等是开发早期的设计/研究记录（早期方案是「反代 + baseURL 接管」），**已过时**，只作历史参考。以 `lib/`、`src/client/` 和本文件为准。

## 1. 主要模块

| 文件 | 职责 |
| :--- | :--- |
| `lib/index.js` | 插件入口、配置（Config）、provider / 路由 / 关联器装配 |
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
| `scripts/rebuild-annotations.mjs` | 基于 captures 重建 annotations/feedback（先备份旧文件） |
| `scripts/analyze-captures.mjs` | 离线分析 captures 的置信度 / 突变 / 句子统计 |

## 2. dsh 服务契约

### 2.1 host 侧

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

### 2.2 client 侧

| 依赖 | 使用位置 | 当前契约 |
| :--- | :--- | :--- |
| `slots` 服务 | `src/client/index.js` | `ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({ name, id, order }, Component))` |
| `sessions` 服务 | `src/client/index.js` | session scope 注入 `sessionId` |
| `conversation.chat.turnTail` 槽 | `src/client/index.js` | owner props 当前为 `{ turn, seq, openFile }`；本实现按 list 槽注册（不是 chain） |
| dsh Markdown DOM 锚点 | `src/client/injector.js` | `[data-chat-flow-kind="assistant-step"][data-chat-turn=N][data-chat-group-part="response"]` |
| 虚拟滚动 / 可见性 | `src/client/injector.js` | 只对 `getClientRects().length > 0` 的节点绘制 |
| `window.__ModuleLoader__.load` | `lib/client.js` | client bundle 由 `scripts/build-client.mjs` 包装，`id` 必须等于 `package.json` 的 `name` |
| `package.json dsh.client` | `package.json` | `entry`、`inject`、`platform: "web"`；当前 inject 含 `dsh-client-locale`、`dsh-client-runtime`、`dsh-client-ui-conversation` |
| `package.json dsh.bundle.patch` | `package.json` | 指向 `cordis.patch.yml` |

## 3. 架构与数据流

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

## 4. 数据文件

默认目录 `$DSH_HOME/logprobs-highlighter`：

```text
captures.jsonl      每条流一行，recordFull=true 时含正文和每个 token
summary.jsonl       每条流一行，轻量统计
annotations.jsonl   每个红句一行的 annotation（初始 verdict=unsure）
feedback.jsonl      人工 verdict 更新事件（append-only，latest revision wins）
```

- `annotations` 与 `feedback` 是标签的**真源**；`captures` 是原始数据 / 负样本 / 调试缓存。
- `/tokens` 在内存 capture 缺失时，会从 `annotations.jsonl` 按 `(sessionId, turn)` 反查，所以 dsh 重启后旧红点仍可恢复。
- `annotationStoreText: none` 时不保存 `sentence.text`，但 `sentence.plain` 和偏移仍保留，用于文本匹配定位。
- `rebuild-annotations.mjs` 会重写 annotations/feedback，并先把旧文件移到 `bak-<timestamp>-*` 目录；执行前建议停 dsh。

### 4.1 `/tokens` 关键字段

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
          "top": [ /* … */ ]
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

### 4.2 `POST /feedback` 示例

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

### 4.3 verdict 与 reason

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

- 任何 verdict 选中后，对应 reason 默认 `cannot_tell`；
- 服务端会按 verdict 清空无关 reason；
- `feedback.jsonl` append-only，读取时取同一 `markId` 的最大 `revision`。

## 5. 升级检查清单

dsh 升级后如果插件不工作，按顺序检查：

1. **provider 是否注册成功**
   - 看 `/plugins/logprobs-highlighter/status`；
   - 看模型选择器里是否出现 “DeepSeek (logprobs)”；
   - 检查 `registerAdapter` / `registerConfigurableProviders` 签名。
2. **流映射是否仍然成立**
   - `StreamChunk` 类型（block-start / text-delta / reasoning-delta / tool-call-delta / usage / finish）；
   - `GenerateOptions` 的字段名；
   - `reasoning_content` / `logprobs.content` 的返回结构。
3. **session 事件 / 关联**
   - `step/start` 是否仍能通过 `session.snapshotEvents()` 读到；
   - `assistant/message` 是否仍由 `sessions.ctx` 派发。
4. **客户端槽位**
   - `conversation.chat.turnTail` 是否仍存在；
   - owner props 是否仍为 `{ turn, seq, openFile }`；
   - `data-chat-*` DOM 锚点是否变化；
   - 重新执行 `pnpm run build:client`。
5. **client bundle 外部依赖**
   - 如果 dsh 的 client module 名称变化，需要同步 `scripts/build-client.mjs` 的 `SEEDS`。
6. **标注数据**
   - `SENTENCES_ALGO_VERSION` 是否递增；
   - token 对齐是否仍按 `bytes`；
   - 旧 annotation 是否仍在 `annotations.jsonl`，`/tokens` 是否能从文件反查。
7. **profile 配置残留**（`0.2.1` 前后的迁移事故）
   - 旧版本把 `webRuntime` 换成了 `webStartup`。如果 `~/.dsh/profiles/web/cordis.patch.yml` 里还有：
     ```yaml
     - id: connection
       inject: [ webRuntime, webServer ]
     ```
     改成 `inject: [ webStartup, webServer ]`（或直接删掉这段旧覆盖），否则必需的 `connection` 会一直 pending。

## 6. 发布

- 包名 `dsh-logprobs-highlighter`，与 `cordis.patch.yml` 的 `name` 和 `lib/client.js` 的 module id 必须一致；改名后必须重新 `pnpm run build:client`。
- `@deepseek-ai/*` 一律声明为 `peerDependencies`，并带显式预发布分支（`>=0.2.2-rc.1 <0.3.0-0`），否则 node-semver 会静默拒绝所有预发布版本。
- `files` 里必须包含运行所需的全部文件：`lib`、`cordis.patch.yml`、`locale`、`icon.svg`；`docs` 不发布（历史文档体积大）。
- 发布前：`pnpm test`、`pnpm run check`、`pnpm run build:client`，并核对 `npm pack` 的文件列表。
