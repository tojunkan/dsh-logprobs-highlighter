# 架构设计 v4 — Logprobs Highlighter（dsh 插件内嵌）

> **状态：v4，M0 已真实实测（结论回填，见 §0.4）** ｜ 日期：2026-08-20 ｜ 作者：architect
> 输入：`docs/research-api-logprobs.md`（t1：DS API logprobs 字段与带宽实测）+ `docs/research-dsh-plugin.md`（t2：dsh 插件机制与可行性决策表）。
> 本文件是**完整架构规格**（模块划分 / 数据流时序 / 接口约定 / 里程碑与验收 / 风险表）；[README.md](../README.md) 是精简工程文档。本文与 README 冲突时以本文为准；问卷决策以 README §0 为准。

---

## 0. 版本与决策基线

### 0.1 问卷决策（已定，不得更改）

| 决策项 | 结论 |
| :--- | :--- |
| 渲染载体 | dsh 客户端插件内嵌（不做独立 viewer） |
| 部署形态 | dsh sidecar 插件自动管理（不做独立进程；服务端插件内 `createServer` 监听 `127.0.0.1:8787` 做反代） |
| 默认视图 | 全文热力图：红→蓝连续色阶（低置信=红、高置信=蓝）；无 logprobs 数据=灰色 |
| reasoning 段 | 折叠显示，展开后灰色（不参与标记） |
| 上文一致性检查 | 一期不做（从 v3 §6.5 移除，列为二期候选） |
| 代码块 | 单独更保守规则：只标数字/标识符强突变，语法符号永不 |
| `top_logprobs` | 默认 2（可配 0 / 2 / 5 / 20） |
| 捕获数据保留 | 内存（环形缓冲），后续可手动导出 JSONL |

### 0.2 来自 t1 的硬事实（架构必须遵守）

1. `logprobs`(boolean) + `top_logprobs`(0–20，需 `logprobs=true`)，OpenAI 兼容；流式下 logprobs 位于 **choice 级** `choices[i].logprobs.content[]`，条目 `{token, logprob, bytes, top_logprobs}`；`-9999.0` 哨兵。
2. **非流式 `logprobs.content` 无 `index` 字段** → 对齐靠数组顺序 + `token` 字符串/`bytes` 双重校验（README v3 该表述为错，已修正）。
3. 模型矩阵：`deepseek-v4-flash/pro` 官方当前模型（非思考模式 logprobs 确定支持）；`deepseek-chat/deepseek-reasoner` 旧别名 **2026-07-24 停用**；思考模式（默认）下思考段 logprobs 原为"无公开证据"设计为三态——**M0 已真实实测：存在，字段为 `logprobs.reasoning_content`（见 §0.4）**；content 段结构**已实测**（thinking 24 / no-thinking 61 tokens，1 token/chunk，对齐 24/24、61/61；未观测多 token chunk）。
4. 带宽：真实实测（top2）x1.804（Run A）/ x1.797（thinking）/ x1.884（no-thinking），见 §0.4；t1 桌面序列化估算（**非实测**，供参考）：top2 ≈204–213 B/token、top5 ≈387–397 B/token、流放大 x1.68/x2.29；中文 1 字 ≈ 1 token。
5. 400/422 且错误含 logprobs/unsupported 等关键字 → 去注入重试一次 + 模型级黑名单；错误体原样透传。

### 0.3 来自 t2 的直接启示（架构要点，M1 必须落实）

1. 反代 = 插件内 `createServer` 监听 `127.0.0.1:8787`（独立端口，绕开 3080 已占的 `/api`、`/plugins`、`/plugins/events`、fallback）。
2. baseURL 接管：`ctx.settings.update("llm-deepseek", {baseURL:"http://127.0.0.1:8787"})` 实时生效；等命名空间就绪（`ctx.on('internal/service')` 重试）；卸载时还原旧值；保留 `$DEEPSEEK_BASE_URL` 作为不接管时的兼容路径。
3. 捕获关联：反代按 `x-deepseek-harness-session-id` FIFO 暂存捕获；`ctx.on('session/event')` 收 `assistant/message`（带 turn/step/message.id/usage）出队关联；内存索引 `(sessionId, turn, step)`；`x-deepseek-harness-compact:1` 跳过捕获。
4. 客户端数据通道：服务端 `ctx.get('webServer')` + `ctx.effect` + `internal/service` 晚绑定注册 `/plugins/logprobs-highlighter/*` 路由（agent-teams 先例），客户端同源 fetch。
5. 渲染分期：M3 先 `conversation.chat.turnTail` 面板（低风险验证数据链路）→ M3.5 shadow `assistant-step`（key=`assistant-step`，priority:-10，复用 `MarkdownText`）逐 token 上色；数据接口从一开始按 `(sessionId, turn, step)` 设计共用。
6. 开发工作流：项目根目录即插件包（package.json 带 `dsh.bundle.patch` / `dsh.client` / `exports["./client"]`），`dsh plugin --profile web add "link:<项目根>"` 安装；client bundle 自行打包（安装版无 `pnpm run dev:web`）。

### 0.4 真实 M0 实测结论（2026-08-20，deepseek-v4-flash，top_logprobs=2）

（由 t4 真实 API 获得，已回填本文与 README；旧 mock 采样已废弃。样本：`docs/m0-sample-thinking.json`（231 chunks，thinking）/ `docs/m0-sample-nothinking.json`（63 chunks，no-thinking；`m0-sample.json` 为最近一次运行输出，自动覆盖）。样本内嵌 summary 由 t10 用 `--replay` 重新生成，引用以最终文件为准。）

1. **思考段 logprobs 真实存在**，字段为 `logprobs.reasoning_content[]`（**不是** `content`）。真实 chunk 样例：
   `{"delta":{"content":null,"reasoning_content":"We"},"logprobs":{"reasoning_content":[{"token":"We","logprob":-0.0005194983,"bytes":[87,101],"top_logprobs":[…]}]}}`
2. 首 chunk 为 role-only（`logprobs:null`，实测确认）；随后每个 reasoning chunk 均携带 `reasoning_content` logprobs。**角色分类规则（与 `m0-probe.mjs classifySegment` 一致，M1 必须照此实现）**：① **非空 `content` 优先**（content 与 reasoning 同 chunk 时按 text 算）；② `reasoning_content` 键存在但为 `null` **不算 reasoning**——思考模式下 content chunk 的 delta 形如 `{"content":"202","reasoning_content":null}`（实测），按"键存在即 reasoning"会把 24 个 content chunk 吞进 reasoning 段（t4 已修复的 bug，M1 不得复现）；③ 空内容角色宣告/过渡块按键存在性兜底（thinking 首 chunk 宣告 reasoning、no-thinking 宣告 content）。
3. 带宽实测（top2）：Run A（max_tokens=200，纯思考流）**x1.804**（107038/59347 B）；Run B（max_tokens=800）**x1.797**（thinking）/ **x1.884**（no-thinking）。
4. Run A 中 `max_tokens=200` 被思考段耗尽（content 0 chunk）；**Run B 已实测 content 段**：thinking 24 tokens、no-thinking 61 tokens，均 1 token/chunk、对齐 24/24 与 61/61、bytes 0 不一致。未观测项仅剩**多 token chunk**（>1/chunk，真实样本全 1/chunk；多 token 拼接仍只有 mock 验证）。
5. **解析硬要求（t4 已踩坑，工程师修复中）**：捕获解析必须同时支持 `logprobs.content` 与 `logprobs.reasoning_content` 双字段；只解析 content 会漏掉思考段全部概率数据。

---

## 1. 模块划分

```
logprobs_highlighter/                  （插件包根，即项目根）
├── package.json                       dsh.bundle.patch / dsh.client / exports["."] / exports["./client"]
├── cordis.patch.yml                   服务端配置注入（insert 自己的行）
├── src/server/                        服务端插件（host 侧，Node）
│   ├── index.ts                       name / inject / Config(z.object) / apply(ctx, config)
│   ├── proxy.ts                       ① ReverseProxy：createServer :8787
│   ├── capture.ts                     ② CaptureStore：内存环形缓冲 + 模型黑名单
│   ├── assoc.ts                       ③ Association：sessionId FIFO + session/event 关联
│   ├── baseurl.ts                     ④ SettingsTakeover：baseURL 接管/还原
│   └── routes.ts                      ⑤ WebRoutes：/plugins/logprobs-highlighter/*（晚绑定）
├── src/client/                        客户端插件（浏览器侧，单文件 bundle）
│   ├── index.ts                       __ModuleLoader__.load({id, factory}) → apply(ctx) + inject
│   ├── data.ts                        DataClient：fetch 同源路由，按 (sessionId,turn,step) 查询
│   ├── turnTail.ts                    M3：conversation.chat.turnTail 面板
│   └── highlighter.ts                 M3.5：shadow assistant-step 逐 token 上色
└── src/shared/                        共享数据格式（server 与 client 各自打包时引用同一份类型/schema）
    ├── types.ts                       CaptureEntry / TokenProbe / QueryResponse / Config
    └── routes.ts                      路由路径常量 + 请求/响应 JSON schema
```

### 1.1 服务端插件（host 侧）

| 模块 | 职责 | 关键点 |
| :--- | :--- | :--- |
| `proxy.ts` | 内嵌 HTTP 反代：监听 `127.0.0.1:8787`，转发 `POST {baseURL}/chat/completions`；注入 `logprobs`/`top_logprobs`；分流（胖流→捕获，剥皮流→dsh）；400/422 降级重试 | **反代上游 = 接管前的旧 baseURL**（baseurl.ts 记录的 original；`manageBaseUrl:false` 时 = 配置 `upstreamBaseUrl`）；非 DeepSeek 请求原样透传；只支持 DeepSeek 目录 `deepseek-*`；用 Node 原生 `fetch` 做上游客户端；SSE 逐 chunk 转发（边收边转，不缓冲整流）；**按角色解析双字段 logprobs**（content/reasoning_content） |
| `capture.ts` | 捕获存储：环形缓冲（默认 20 条 / 1 小时）；每请求一条；`reasoningState` 记录；模型黑名单（"不支持 logprobs"） | **双字段解析**：`logprobs.content` + `logprobs.reasoning_content`（M0 实测硬要求，t4 已踩坑）；捕获条目独立于关联存在（`assoc == null` 阶段可查询"未关联"）；后续 JSONL 手动导出 |
| `assoc.ts` | 关联器：`ctx.on('session/event')` 监听 `assistant/message`，按 sessionId 从 FIFO 出队捕获，写索引 `(sessionId, turn, step) → probeId` | wire 请求不带 turn/step → 只能 FIFO；同会话流串行是前提（t2 §2c）；compact 请求不入队 |
| `baseurl.ts` | 接管：`ctx.settings.update("llm-deepseek", {baseURL})`；等待命名空间就绪（`ctx.on('internal/service')` 重试）；`dispose` 还原旧值；`manageBaseUrl:false` 时不接管 | **启动自愈（I3）**：apply 时若当前 baseURL == 本插件代理地址视为自己写入的残留——**先确保代理监听成功再接管**，代理启动失败则回滚还原并打告警；记录旧值于插件内存；还原时若用户已改过则不覆盖（比对当前值再还原） |
| `routes.ts` | `ctx.get('webServer')` 注册 `/plugins/logprobs-highlighter/tokens`、`/status` 等路由 | 照抄 agent-teams：`ctx.effect(() => webServer.register({kind:'exact'|'prefix', path, handler}), …)` + `ctx.on('internal/service')` 晚绑定 |

### 1.2 客户端插件（浏览器侧）

| 模块 | 职责 | 关键点 |
| :--- | :--- | :--- |
| `data.ts` | DataClient：`fetch('/plugins/logprobs-highlighter/tokens?session=&turn=&step=')`；失败/无捕获 → `captured:false` 态（渲染灰色） | 从 M3 起统一按 `(sessionId, turn, step)` 键；缓存（LRU，按 probeId）；**M3 前落实 assoc-pending 客户端重取策略**（三选一：收到 assistant/message 或 turn/end 事件后重查一次 / assoc-pending 退避重试 N 次 / 服务端 assoc 完成推送事件） |
| `turnTail.ts` | M3 面板：`ctx.slots.inject('conversation.chat.turnTail', …)` chain 槽；每条消息下方热力条 + token hover 备选词 | 低风险：不碰消息本体渲染；scope session；面板内 hover |
| `highlighter.ts` | M3.5：shadow `assistant-step`：`ctx.slots.inject('conversation.chat.node', …)` 注册 `{name:'conversation.chat.node', key:'assistant-step', priority:-10}`；复用 `MarkdownText`；按 token 切片 `<span data-token>` 上色 + hover；reasoning 折叠灰；图片引 `ImageGallery` | 只对 `status==='settled'` 节点上色（流式期间 logprobs 不完整）；`require()` 只能解析种子词（react、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-web-react`、`dsh-client-ui-attachment`…），打包 external |

`inject`（声明依赖的 client 服务）：`["conversationEvents", "slots", "sessions"]`（agent-teams 先例；`sessions` 用于取当前 sessionId）。

### 1.3 共享数据格式（`src/shared/`）

- **CaptureEntry**：见 §3.3（服务端捕获存储的单条结构）。
- **TokenProbe**：单个 token 的 `{ index, text, logprob, confidence, top[], flags, category }`（标记引擎输出，渲染层按此配色）。
- **QueryResponse**：§3.1 tokens 路由的响应体。
- **Config**：§3.5 插件配置 schema。

---

## 2. 数据流时序

### 2.1 主链路（一次带捕获的助手回复）

```
 dsh核心 llm-deepseek        服务端插件(反代 :8787)               上游(旧baseURL,默认 api.deepseek.com)
      │ POST /chat/completions │                                     │
      │  (baseURL=127.0.0.1:8787)                                    │
      │  headers: x-deepseek-harness-session-id, [compact]           │
      │───────────────────────►│                                     │
      │                         │ ① 判定: 路径/模型命中 DeepSeek 目录?  │
      │                         │    compact=1 → 透传不捕获; 黑名单 → 不注入
      │                         │ ② 注入 logprobs:true, top_logprobs:N
      │                         │ ③ 转发（Authorization 头原样透传）      │
      │                         │────────────────────────────────────►│
      │                         │◄── SSE 胖流（含 content + reasoning_content logprobs）─│
      │                         │ ④ 边收边分流:
      │                         │    剥皮流(删logprobs重序列化) → dsh  ◄── 转发给 dsh 核心
      │◄────────────────────────│    胖 chunk → 解析累积捕获块(按角色)
      │  剥皮流(与直连行为一致)   │    流结束(usage/finish/DONE) → 捕获条目
      │                         │    压入 sessionId FIFO 待关联队列
      │                         │    400/422 → 去注入重试一次+黑名单记忆
      │                         │
      │   …… agent-loop 流结束后 append 助手消息 ……                   │
      │                         │
      │   session/event: assistant/message {turn, step, message.id, usage}
      │                         │ ⑤ assoc 模块收到 → 按 sessionId 出队一条
      │                         │    捕获 → 写入索引 (sessionId, turn, step) → probeId
      │                         │
 浏览器客户端插件                 │
      │  渲染该 (sessionId, turn, step) 节点时                        │
      │  GET /plugins/logprobs-highlighter/tokens?session=&turn=&step=
      │─────────────────────────────────────────────────────────────►│
      │◄── 200 {captured:true, blocks, marks, usage, reasoningState} ─│
      │  渲染: 红→蓝色阶 + 灰(无数据) + hover 备选词                    │
```

### 2.2 边界路径

| 场景 | 行为 |
| :--- | :--- |
| 非 `/chat/completions` 或非 `deepseek-*` 模型 | 原样透传：不注入、不捕获、不剥皮、不记录 |
| `x-deepseek-harness-compact: 1` | 透传但不捕获（不入 FIFO） |
| 上游 400/422 且错误含 logprobs 关键字 | 去注入重试一次；成功 → 该模型记"不支持"（黑名单，后续直接透传）；失败/不匹配 → 原样透传错误体 |
| 流中止/超时/上游错误（捕获条目 `complete:false` = aborted） | 条目**不参与关联**：`assoc.attach` 出队时跳过 aborted 并 GC；下一条真实 `assistant/message` 只关联到完整完成的流（宁可无数据不错位） |
| 关联时 FIFO 空（捕获丢失/过期） | 索引缺失 → 客户端查询返回 `captured:false` → 渲染灰色（"无概率数据"） |
| 思考段耗尽 `max_tokens`，content 段为空（已实测） | 捕获正常（blocks 只有 reasoning）；查询返回 `captured:true` + 空 text 块；客户端渲染灰 + 面板提示"思考段耗尽 max_tokens，无答案内容"；dsh 侧建议调大 max_tokens |
| 插件卸载/禁用 | `dispose`：关闭 8787、还原 baseURL（若当前值仍等于我们写入的值）、清空内存索引与 FIFO |
| SIGKILL/崩溃（dispose 未执行，settings.yaml 残留 baseURL=127.0.0.1:8787） | 下次启动**启动自愈**：检测到残留 baseURL 视为自己写入的——先确保代理监听成功再接管，失败回滚还原并打告警；手动排查可直接编辑 `$DSH_HOME/settings.yaml` 删除该行恢复直连 |

---

## 3. 接口约定

### 3.1 `GET /plugins/logprobs-highlighter/tokens`（客户端查询标记数据）

请求（query）：

| 参数 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `session` | string | ✅ | sessionId（`x-deepseek-harness-session-id` / 客户端 session.id） |
| `turn` | number | ✅ | assistant/message 事件的 turn |
| `step` | number | ✅ | assistant/message 事件的 step |

响应 `200`：

```jsonc
{
  "ok": true,
  "key": { "sessionId": "sess-…", "turn": 3, "step": 0 },
  "captured": true,                    // false = 无捕获（客户端渲染灰色，可带 reason）
  "notCapturedReason": null,           // "model-unsupported" | "compact-skipped" | "not-found" | "assoc-pending" | null（assoc-pending 的客户端重取策略见 §1.2 data.ts，M3 前落实）
  "message": { "id": "msg-…", "model": "deepseek-v4-pro" },
  "reasoningState": "present",         // present(思考段带 reasoning_content logprobs，已实测) | absent(流内无 reasoning 段) | unknown(异常/旧数据)
  "usage": { "inputTokens": 1200, "outputTokens": 300, "reasoningTokens": 180 },
  "blocks": [
    {
      "role": "text",                  // "text" | "reasoning" | "tool-call"
      "tokens": [
        {
          "index": 0,                  // 块内序号（text 块参与配色）
          "text": "深",
          "logprob": -0.0312,
          "confidence": 0.969,         // exp(logprob)，渲染层换算亦可
          "top": [                     // top_logprobs（≤ 配置值）
            { "token": "深", "logprob": -0.0312 },
            { "token": "圳", "logprob": -1.8921 }
          ],
          "flags": {                   // 标记引擎输出
            "mutation": false,         // 突变点 z<-2.5
            "lowConfidence": false,    // exp(logprob)<1%
            "category": "none"         // "number"|"entity"|"word"|"function-word"|"code-ident"|"code-syntax"|"none"
          }
        }
      ]
    }
  ],
  "marks": [                           // 聚合异常标记（"只看红点"切换用）
    { "blockIndex": 0, "tokenIndex": 42, "level": "high", "reasons": ["mutation"] }
  ]
}
```

错误：

| 状态码 | 条件 | 响应体 |
| :--- | :--- | :--- |
| 400 | 缺 `session`/`turn`/`step` | `{"ok":false,"error":"missing-param","param":"turn"}` |
| 200 + `captured:false` | 索引未命中 | 正常响应（客户端按灰色渲染，勿当错误） |
| 500 | 内部错误 | `{"ok":false,"error":"internal"}` |

### 3.2 `GET /plugins/logprobs-highlighter/status`（调试/健康）

```jsonc
{
  "ok": true,
  "version": "0.1.0",
  "proxy": { "port": 8787, "listening": true, "upstream": "https://api.deepseek.com" },
  "baseUrl": { "managed": true, "original": "https://api.deepseek.com", "current": "http://127.0.0.1:8787" },
  "capture": { "ringSize": 20, "entries": 5, "pendingAssoc": 1, "blockedModels": ["deepseek-reasoner"] },
  "config": { "topLogprobs": 2, "modelGlob": "deepseek-*", "ringSize": 20, "ringTtlMs": 3600000, "upstreamBaseUrl": "https://api.deepseek.com" }
}
```
- `upstream` = 实际转发目标：接管模式 = 接管前的旧 baseURL；`manageBaseUrl:false` = 配置 `upstreamBaseUrl`。

### 3.3 捕获存储结构（内存）

```jsonc
{
  "id": "req-<x-request-id|自生成>",    // probeId
  "sessionId": "sess-…",               // x-deepseek-harness-session-id
  "compact": false,
  "model": "deepseek-v4-pro",
  "createdAt": 1724000000000,
  "reasoningState": "present",         // present/absent/unknown（思考模式已实测 present）
  "complete": true,                    // [DONE]/finish_reason/usage 到达 = true；流中止/上游错误 = false（aborted）
  "blocks": [
    { "role": "reasoning", "tokens": [ { "text": "We", "logprob": -0.000519, "top": […] } ] },
    { "role": "text", "tokens": [ { "text": "深", "logprob": -0.0312, "top": […] } ] },
    { "role": "tool-call", "tokens": [] }
  ],
  "usage": { "inputTokens": 1200, "outputTokens": 300, "reasoningTokens": 180 },
  "assoc": { "turn": 3, "step": 0, "messageId": "msg-…", "at": 1724000001234 } | null
}
```

- 环形缓冲：默认 20 条 / 1 小时（先到先淘汰，`ringSize`/`ringTtlMs` 可配）。
- **tokens 条目最小字段**：`{ text, logprob, top[] }`；`top[]` 元素 `{ token, logprob }`；`bytes` 在捕获期仅做 token↔文本对齐校验，**默认不落捕获存储**（省内存；多 token 拆字场景 M2 再评估是否需要补存 `bytes`）。
- **双字段来源（M0 实测）**：text 块来自 `logprobs.content[]`，reasoning 块来自 `logprobs.reasoning_content[]`——两字段结构同构，解析层统一归一为 `{text, logprob, top}` 条目（t4 已踩坑：只解析 content 会漏掉思考段全部数据）。
- **complete 语义（I1）**：`complete:true`（`[DONE]`/`finish_reason`/`usage` 到达）可参与关联；`complete:false` = aborted（流中止/上游错误）**不参与关联**——`assoc.attach` 出队时跳过 aborted 并 GC，防 FIFO 顺移错位（宁可无数据不错位）。
- 索引：`Map<sessionId, Map<"turn:step", probeId>>` + `Map<probeId, CaptureEntry>`；关联器 FIFO：`Map<sessionId, CaptureEntry[]>`。

### 3.4 服务端内部接口

```ts
// proxy.ts → capture.ts
capture.store(entry: CaptureEntry): void;                       // 压入环形缓冲 + sessionId FIFO
capture.markUnsupported(model: string): void;                   // 模型黑名单
capture.isSupported(model: string): boolean;

// assoc.ts（ctx.on('session/event', (session, event) => …)）
//   event.type === 'assistant/message' → 取 {turn, step, message:{id}, usage}
assoc.attach(sessionId: string, meta: {turn, step, messageId, usage}): CaptureEntry | null;  // 出队（跳过 complete:false 的 aborted 条目并 GC）并写索引

// routes.ts → 查询
capture.query(sessionId: string, turn: number, step: number): QueryResult | null;
```

### 3.5 插件配置（schemastery `z.object`）

```ts
export const Config = z.object({
  enabled: z.boolean().default(true),
  proxyPort: z.number().default(8787),            // 反代监听端口（127.0.0.1）
  manageBaseUrl: z.boolean().default(true),       // false → 依赖 $DEEPSEEK_BASE_URL，不接管
  upstreamBaseUrl: z.string().default("https://api.deepseek.com"),  // 反代上游：manageBaseUrl:false 模式用此配置；接管模式 = 接管前旧 baseURL
  topLogprobs: z.number().default(2),             // 0 | 2 | 5 | 20
  modelGlob: z.string().default("deepseek-*"),    // 捕获目录（兼容 deepseek-v4-* 与旧别名）
  ringSize: z.number().default(20),
  ringTtlMs: z.number().default(3600_000),
  mutationZ: z.number().default(-2.5),            // 突变点阈值（M4 调参）
});
```

---

## 4. 里程碑与验收标准

| 里程碑 | 范围 | 验收标准（可测） |
| :--- | :--- | :--- |
| **M0 数据验证** | `scripts/m0-probe.mjs` 真实 API 运行（**Run A 200 + Run B 800 已完成**；样本 `docs/m0-sample-thinking.json`（231 chunks，thinking）、`docs/m0-sample-nothinking.json`（63 chunks，no-thinking；`m0-sample.json` 为最近一次运行输出，自动覆盖）；旧 mock 假数据已废弃） | 已确认：思考段携带 `logprobs.reasoning_content[]`（双字段解析为硬要求）、content 段携带 `logprobs.content[]`（thinking 24 / no-thinking 61 tokens，1 token/chunk，对齐 24/24、61/61，bytes 0 不一致）、首 chunk role-only（logprobs:null）、带宽 x1.804 / x1.797 / x1.884（top2）；未观测项仅剩：多 token chunk（>1/chunk）、非流式无 index 实证、400/422 真实错误体、top_logprobs=0、top5 带宽 |
| **M1 服务端插件骨架** | 插件包骨架（package.json / `exports["./client"]` / `dsh.bundle.patch` / `dsh.client` / cordis.patch.yml）；`proxy.ts`（注入→分流→剥皮→转发，**角色分类按 §0.4.2 三规则**，双字段解析 content + reasoning_content，上游 = 旧 baseURL/upstreamBaseUrl）；`capture.ts`（**complete/aborted 标记**）；400/422 降级 + 黑名单；`baseurl.ts`（接管/还原/**启动自愈**）；`routes.ts`（/status 先通） | ① `dsh plugin --profile web add "link:<根>"` 装载成功、启动日志无错 ② 反代监听 8787 且 settings 中 baseURL 被接管 ③ 与 DS 对话正常（剥皮流与直连行为一致）④ `/status` 返回监听与捕获计数（upstream 为实际值）⑤ 非 DeepSeek 模型对话原样透传 ⑥ 卸载插件后 baseURL 还原、8787 关闭 ⑦ compact 请求不产生捕获 ⑧ 思考段与 content 段概率数据均被捕获（对照 `m0-sample-thinking.json` **和** `m0-sample-nothinking.json` 双样本校验），且**思考模式 content chunk 分类正确（24/24 不被吞入 reasoning）** |
| **M2 标记引擎** | 角色过滤、突变点 z 分（median+MAD，±20 窗）、分类（数字/实体/实词/虚词）、**代码块保守规则**（只标数字/标识符强突变）、热身抑制；合成序列单测 | ① 合成序列单测通过（构造突变/平稳/代码块/句首用例）② ≥10 条真实消息人工比对：红点无漏网、无明显噪声（误报 < 15%）③ 代码块内语法符号零标记 |
| **M3 客户端 turnTail 面板** | `conversation.chat.turnTail` chain 槽面板；DataClient `(sessionId, turn, step)`；面板热力条 + hover 备选词 + "只看红点"切换 | ① 面板随消息出现 ② 数据链路打通：assistant/message 事件 → 捕获索引 → fetch → 渲染 ③ hover 显示 top 备选 ④ 无捕获消息面板显示"无概率数据（原因）" |
| **M3.5 shadow 逐 token 高亮** | shadow `assistant-step`（priority:-10）；复用 `MarkdownText`；token 切片上色 + hover；reasoning 折叠灰；图片引 `ImageGallery`；仅 settled 上色 | ① 消息正文热力图正确（红→蓝 + 灰）② 与 M3 面板数据一致 ③ reasoning 折叠且展开灰色 ④ 流式期间不上色、settled 后上色 ⑤ markdown 渲染不回归 |
| **M4 验证调参** | 事实查询/代码/长文三组用例；误报率统计；验证 `top_logprobs=2` 默认档 | ① 调参报告（mutationZ、色阶公式、top_logprobs 档位）② 决定是否启动二期（一致性检查、JSONL 导出、top_logprobs 按需升级） |

---

## 5. 风险表

| # | 风险 | 等级 | 影响 | 缓解 / 应对 | 归属里程碑 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 思考段 logprobs 字段结构（`reasoning_content` 而非 `content`） | 高 | 只解析 content 会漏掉思考段全部概率数据（t4 已踩坑） | **双字段解析硬要求**：`logprobs.content` + `logprobs.reasoning_content`；标记层永不标 reasoning | M0/M1 |
| 2 | 思考模式耗尽 `max_tokens` 导致答案截断/不出 content | 高 | 实测 200 token 全被思考吃掉，content 0 chunk；用户看不到答案且无高亮 | 反代/标记层按 content 缺失/为空容错（渲染灰 + 面板提示"思考段耗尽 max_tokens"）；建议 dsh 侧 `max_tokens` ≥2048；M0 二次实测确认 content 段结构 | M0/M1 |
| 3 | content 段真实分块粒度未知（1 token/chunk vs 批量） | 中 | 对齐错误 → 概率数据错位 | `token` 字符串 + `bytes` 双重校验（mock 已验证多 token chunk 拼接对齐）；M0 二次实测 | M0 |
| 4 | 剥皮重序列化改变 dsh 行为（字段顺序/多余字段） | 中 | dsh 解析异常 | 剥皮只删 `choices[i].logprobs`，其余原样；M1 对比直连与反代行为差异；保留 `[DONE]`/usage/finish_reason | M1 |
| 5 | shadow `assistant-step` 需自渲染 reasoning/图片/流式态 chrome（`ReasoningRow` 未导出） | 中 | M3.5 工作量与回归风险 | 分期：先 M3 turnTail（不碰消息本体）；M3.5 复用 `MarkdownText`/`ImageGallery`，reasoning 简单折叠；仅 settled 上色 | M3/M3.5 |
| 6 | 安装版无 `pnpm run dev:web`，client bundle 迭代成本 | 中 | 开发效率 | 自行 watch/rebuild bundle（tsdown）；client-hmr 500ms 热替换；host 改动重启 dsh | M3 |
| 7 | baseURL 接管竞态（命名空间未就绪 / dispose 未还原 / SIGKILL 崩溃残留） | 高 | 请求打错上游 / 残留配置指向死端口 | `ctx.on('internal/service')` 重试 + `inject` 声明依赖；dispose 比对当前值再还原；**启动自愈**（先确保代理监听成功再接管，失败回滚并告警）；`manageBaseUrl:false` 兼容路径（`$DEEPSEEK_BASE_URL`） | M1 |
| 8 | 捕获-消息关联错位（并发/重试/丢失/流中断顺移） | 中 | 高亮错位到错误消息（比缺失更糟） | 同会话流串行 + sessionId FIFO；捕获条目带 **complete 标记**，`assoc.attach` **跳过 aborted 并 GC**（失败重试不产生顺移）；compact 不入队；assoc 失败 → `captured:false` 灰色（宁可无数据不错位）；probeId 兜底查询 | M1 |
| 9 | 400/422 降级误判（关键字误匹配/重试放大错误） | 低 | 上游错误被篡改或重复请求 | 关键字白名单匹配（logprobs/top_logprobs/not supported/unsupported/not allowed）；只重试一次；错误体原样透传 | M1 |
| 10 | 中文实词/虚词分类准确率不足 | 中 | 误报/漏报 | 保守规则起步（只排除标点/空格/符号/语法符号，数字/实体命中即提示）；M4 调参 + 三组用例统计 | M2/M4 |
| 11 | 环形缓冲容量不足（长会话/多会话） | 低 | 早前消息无高亮 | 默认 20 条/1h 可配；后续 JSONL 手动导出；面板提示"数据已淘汰" | M1 |
| 12 | 旧别名 `deepseek-chat/reasoner` 停用后请求失败 | 低 | 用户配置旧模型名时对话失败 | 目录匹配兼容新旧名或透传让上游报错；400/422 降级兜底 | M1 |
| 13 | 多 provider 混用时误捕获 | 低 | 非 DeepSeek 流量被注入 | 严格路径 + 模型目录双重判定；非命中一律原样透传（t1 §5.1 语义） | M1 |

---

## 6. 附录：v3 → v4 差异摘要

| 维度 | v3 | v4 |
| :--- | :--- | :--- |
| 部署 | 独立进程反代（`DEEPSEEK_BASE_URL=… dsh` 手动启动） | dsh sidecar 插件自动管理（`dsh plugin --profile web add "link:<根>"`） |
| 渲染 | 一期独立 viewer（:8787 根路径）+ 二期插件 | 直接客户端插件：M3 turnTail 面板 → M3.5 shadow 逐 token 高亮 |
| 数据通道 | viewer 直接查反代 `/v1/probes` | 客户端 fetch 同源 `/plugins/logprobs-highlighter/*`（webServer 路由） |
| 关联模型 | 无（按请求快照） | sessionId FIFO + `assistant/message` 事件 → `(sessionId, turn, step)` 索引 |
| baseURL | 环境变量 | settings.update 接管 + internal/service 重试 + dispose 还原 + 环境变量兼容路径 |
| 非流式对齐 | 带 `index`（错） | 数组顺序 + token/bytes 双重校验（无 index） |
| 带宽 | 4–6 倍 / 15KB（错） | 真实实测 x1.797–1.884（top2）；t1 估算（非实测）x1.68/x2.29、204B/387B |
| 模型 | — | v4-flash/pro 官方；chat/reasoner 旧别名停用；思考段 logprobs **已实测存在**（字段 `logprobs.reasoning_content`，三态定论 present） |
| 一致性检查 | §6.5 一期 | 移除，二期候选 |
| 代码块 | 无专门规则 | 保守规则（只标数字/标识符强突变，语法符号永不） |
| top_logprobs | 默认 5 | 默认 2（可配 0/2/5/20） |
| reasoning 展示 | 灰色或折叠（开放问题） | 折叠显示、展开后灰色（已定） |
| 捕获保留 | 内存 20 条/1h | 同左 + 后续手动 JSONL 导出 |
