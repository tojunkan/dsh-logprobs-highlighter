# AI 置信度透视插件（Logprobs Highlighter）

> **文档状态：v4 — dsh 插件内嵌架构（sidecar 插件自动管理）的工程设计文档（精简版）。**
> 项目处于 **M0 收尾 → M1**（M0 已用真实 API key 实测，结论已回填本文）；本文是实施依据。完整架构规格见 [docs/architecture-v4.md](docs/architecture-v4.md)。
> v3 → v4 勘误与变更见 [§0.1](#01-勘误v3--v4)。

---

## 0. 状态与决策摘要

- **路线**：dsh **sidecar 插件**（服务端插件 + 客户端插件），不再有独立进程、独立 viewer。服务端插件在 dsh 进程内 `createServer` 监听 `127.0.0.1:8787` 做 DeepSeek 反代（注入 `logprobs`、旁路捕获概率数据、剥皮转发给 dsh），并通过 `ctx.settings.update("llm-deepseek", …)` 接管 baseURL，随 dsh 自动启动/卸载。
- **范围**：**只专注 DeepSeek 模型**。其他 provider 请求（非 `/chat/completions` 或非 `deepseek-*` 模型）一律**原样透传**：不注入、不捕获、不剥皮、不标记。
- **问卷决策（已定，不得更改）**：
  - 渲染载体：**dsh 客户端插件内嵌**（不做独立 viewer）；
  - 部署形态：**dsh sidecar 插件自动管理**（不做独立进程）；
  - 默认视图：**全文热力图**——红（低置信）→ 蓝（高置信）连续色阶；**无 logprobs 数据的 token 一律灰色**；
  - **reasoning 段**：折叠显示，展开后灰色（不参与标记）；
  - 一期**不做上文一致性检查**（v3 §6.5 移除，列为二期候选）；
  - **代码块**：单独更保守规则——只标数字/标识符的强突变，语法符号永不；
  - **`top_logprobs` 默认 2**（可配 0 / 2 / 5 / 20）；
  - 捕获数据保留：**内存（环形缓冲）**，后续可手动导出 JSONL。
- **一期不做**：修改 dsh 核心、TLS MITM、本地小模型打分、独立 viewer、磁盘持久化（默认）。

### 0.1 勘误（v3 → v4）

| # | 项 | v3（错/旧） | v4（修正） | 依据 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | 带宽 | "放大 4–6 倍；2000 字 ≈ 500 token ≈ 15 KB" | **真实实测（Run A/B，top2）**：x1.804（Run A，200，纯思考流）/ x1.797（Run B thinking）/ x1.884（Run B no-thinking）。t1 桌面序列化估算（**非实测**，供参考）：x1.68（top2）/x2.29（top5）、每 token ≈204B/387B；中文约 **1 字 ≈ 1 token** | t1 §6.4 + M0 实测 |
| 2 | 非流式对齐 | "`logprobs.content` 带 `index` 字段" | 官方 schema **无 `index`**，对齐靠**数组顺序**（`token` 字符串 + `bytes` 双重校验） | t1 §3.1 |
| 3 | 模型 | 未区分官方模型与停用别名，未考虑思考模式覆盖 | `deepseek-v4-flash/pro` 为当前官方模型（非思考模式 logprobs 确定支持）；`deepseek-chat/deepseek-reasoner` 为 **2026-07-24 停用的旧别名**；v4 思考模式（默认）下 `reasoning_content` 是否伴随 logprobs **无公开证据 → M0 必测**，架构按 **有/无/未知三态** 设计（**M0 已实测：存在**，字段为 `logprobs.reasoning_content`，见 §3.1） | t1 §4 |
| 4 | M1 形态 | 独立进程手动启动（`DEEPSEEK_BASE_URL=… dsh`） | **dsh sidecar 插件自动管理**：`dsh plugin --profile web add "link:<项目根>"`，随 dsh 启停 | t2 §4–§6 |
| 5 | 渲染路线 | 一期独立 viewer + 二期客户端插件 | **直接客户端插件**：M3 先做 `turnTail` 面板，M3.5 再做 shadow `assistant-step` 逐 token 高亮 | t2 §5–§6 |

---

## 1. 核心理念

利用模型 API 返回的 `logprobs`，把生成文本中"不确定"的 Token 可视化，帮助用户定位潜在的幻觉或逻辑薄弱点。

### 1.1 黄金法则

- 高概率 ≠ 正确；低概率 ≠ 错误。
- **核心策略：只看"突变点"**——前后均高置信、中间骤降的 token，必查。

### 1.2 场景价值

| 场景 | 策略 |
| :--- | :--- |
| 长文（总结、报告） | 热力图跳过"蓝海"（高置信区），只审核红点（突变点）。 |
| 短文（事实查询、代码、参数） | 数字、年份、人名、API 函数名的任一红点都是致命错误的第一信号。 |

---

## 2. 为什么是 dsh 插件内嵌

| 方案 | 结论 |
| :--- | :--- |
| 修改 dsh 核心（请求参数+流解析+插件 API 三层改造） | 放弃：维护 fork，升级即碎 |
| TLS MITM 抓流量 | 放弃：Node fetch 默认不读代理环境变量；证书信任是持续痛点 |
| 独立进程反代（v3 方案） | 放弃：多一个常驻进程、手动启动、无生命周期管理 |
| **dsh sidecar 插件内嵌** | **选定**：服务端插件在 dsh 进程内起反代（`createServer :8787`），`ctx.settings.update` 接管 baseURL，随 dsh 自动启停；捕获层与 dsh 解耦，dsh 升级不坏 |
| 独立 viewer（v3 一期渲染） | 放弃：改为客户端插件内嵌（turnTail 面板 → shadow 逐 token 高亮） |

**核心原则：捕获什么 ≠ 标记什么 ≠ 转发什么。** 三层独立控制带宽、存储、眼球占用。

---

## 3. 与 dsh 的对接（已核实，dsh v0.1.0-rc.6）

来源：`@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`（t2 报告 §2b）。

- dsh 走 **OpenAI 兼容 Chat Completions**：`POST {baseURL}/chat/completions`。
- baseURL 解析优先级：`llm-deepseek.baseURL` 配置 → **`$DEEPSEEK_BASE_URL` 环境变量** → `https://api.deepseek.com`。
- API Key：凭证服务或 `DEEPSEEK_API_KEY`（反代只透传 `Authorization` 头，不落盘）。

### 3.1 模型与 logprobs 支持（修正版）

| 模型 ID | 状态 | logprobs |
| :--- | :--- | :--- |
| `deepseek-v4-flash` / `deepseek-v4-pro`（**非思考**） | 当前官方模型 | ✅ 确定支持（官方 create-chat-completion 文档含参数与响应 schema） |
| `deepseek-v4-*`（**思考模式，v4 默认**） | 当前官方模型 | ✅ **已实测（top2）**：思考段携带 logprobs，字段为 `logprobs.reasoning_content[]`（**非** `content`）；content 段同样带 logprobs（`logprobs.content[]`，max_tokens=800 时实测 24 tokens，1 token/chunk，对齐 24/24）。⚠️ 注意：`max_tokens` 过小时思考段会耗尽额度导致 content 段为空（200 时实测 content 0 chunk）。标记层对 reasoning 一律不标 |
| `deepseek-chat` / `deepseek-reasoner` | **旧别名，2026-07-24 停用** | 停用后请求会失败；反代目录匹配同时兼容新旧名或透传让上游报错（400/422 降级兜底） |

### 3.2 请求体注入

dsh 原始请求（无 logprobs 字段）：

```jsonc
{
  "model": "deepseek-v4-pro",
  "messages": [/* ... */],
  "stream": true,
  "stream_options": { "include_usage": true },
  "thinking": { "type": "enabled" },      // 可选
  "reasoning_effort": "high",             // 可选
  "tools": [/* ... */],                    // 可选
  "temperature": 0.3, "max_tokens": 8192,  "stop": ["..."]
}
```

反代注入（仅命中 DeepSeek 目录且非黑名单模型时）：

```jsonc
  "logprobs": true,       // 必须
  "top_logprobs": 2       // 问卷默认 2；可配 0/2/5/20
```

### 3.3 响应流结构

每个 SSE `data` 载荷解析 `choices[]`，按 `delta` 分三类块：

| delta 字段 | 块类型 | 是否参与标记 |
| :--- | :--- | :--- |
| `delta.reasoning_content` | reasoning（思考） | ❌ 永不（折叠、展开后灰色） |
| `delta.content` | text（答案） | ✅ 唯一参与 |
| `delta.tool_calls[]` | tool-call（工具调用 JSON） | ❌ 捕获不标记 |

- logprobs 位于 **choice 级**（与 `delta` 平级），**双字段**（真实 M0 实测确认）：`choices[i].logprobs.content[]`（text 段）与 `choices[i].logprobs.reasoning_content[]`（思考段，**已实测存在**）；条目 `{ token, logprob, bytes, top_logprobs }`（OpenAI 兼容；`-9999.0` 为概率极小哨兵值；`bytes` 为 UTF-8 字节数组）。**捕获解析必须同时处理两字段**（t4 实测踩坑：只解析 content 会漏掉思考段全部概率数据）。
- **对齐**：`delta.content` 与 `logprobs.content` **按数组顺序 1:1**；用 `token` 字符串 + `bytes` 双重校验兜底（M0 已用 mock 验证多 token chunk 拼接对齐：`join(tokens) === delta.content`）。
- 首 chunk（角色宣告）`logprobs` 为 `null`（**实测确认**）；finish 块不带概率数据，`usage` 附着在最后一个 chunk；流以 `[DONE]` 结束。
- **角色分类规则（与 `m0-probe.mjs classifySegment` 一致，M1 必须照此实现）**：① **非空 `content` 优先**——content 与 reasoning 同 chunk 时按 text 算；② `reasoning_content` 键存在但为 `null` **不算 reasoning**——思考模式下 content chunk 的 delta 形如 `{"content":"202","reasoning_content":null}`，若按"键存在即 reasoning"会把 24 个 content chunk 吞进 reasoning 段（t4 已修复的 bug，M1 不得复现）；③ 空内容角色宣告/过渡块**按键存在性兜底**（thinking 首 chunk 宣告 reasoning、no-thinking 宣告 content）。
- **非流式**：`choices[0].logprobs.content[]` 与 `message` 平级，条目同构；**无 `index` 字段**，对齐同样靠数组顺序 + 双重校验。

### 3.4 dsh 请求头（透传注意）

```http
authorization: Bearer <key>
x-deepseek-harness-user-id: <匿名用户ID>
x-deepseek-harness-session-id: <会话ID>    # 捕获关联键
x-deepseek-harness-compact: 1              # 压缩/后台任务：透传但不捕获
```

### 3.5 启动方式（v4 修正：sidecar 插件自动管理）

```bash
# 项目根目录即插件包（package.json 带 dsh.bundle.patch / dsh.client / exports["./client"]）
dsh plugin --profile web add "link:/home/unidu/dsh/logprobs_highlighter"
# 随 dsh 启动自动装载；卸载插件自动还原 baseURL、关闭 8787
dsh --profile web
```

- 不再需要 `DEEPSEEK_BASE_URL=… dsh` 手动启动独立进程。
- **开发工作流**：host 侧改动重启 dsh；client 侧改动自行重建 bundle（安装版无 `pnpm run dev:web`，用 tsdown 之类 watch），client-hmr 500ms 轮询热替换。
- **客户端构建（M3 起）**：`npm install`（devDependency esbuild）→ `node scripts/build-client.mjs` 产出 `lib/client.js`（源码在 `src/client/`，纯函数在 `lib/client-utils.js`）；改动 client 代码后重跑并刷新浏览器。联调步骤见 [docs/verify-m3.md](docs/verify-m3.md)。

### 3.6 baseURL 接管与兼容路径

- 接管：`ctx.settings.update("llm-deepseek", { baseURL: "http://127.0.0.1:8787" })`（merge，实时生效，无需重启）；**必须等 `llm-deepseek` 命名空间就绪**（`ctx.on('internal/service', …)` 重试）；插件卸载/禁用时 `ctx.on('dispose', …)` **还原旧值**。
- **启动自愈（崩溃恢复）**：apply 时若检测到当前 baseURL == 本插件代理地址，视为"自己上次写入的残留"——**先确保代理监听成功再接管**；代理启动失败则**回滚还原并打告警**。崩溃恢复步骤：dsh 被 SIGKILL/崩溃后 dispose 不执行，`$DSH_HOME/settings.yaml` 可能残留 `baseURL: http://127.0.0.1:8787`；下次启动由自愈逻辑自动还原；手动排查时可直接编辑 settings.yaml 删除该行恢复直连。
- 兼容路径：插件提供 `manageBaseUrl` 开关（默认 true）；置 false 时**不接管**，依赖 `$DEEPSEEK_BASE_URL=http://127.0.0.1:8787` 环境变量（用户自管理，插件只起反代）。
- **反代上游**：接管模式下 = 接管前的**旧 baseURL**（baseurl.ts 记录的 original，默认 `https://api.deepseek.com`）；`manageBaseUrl:false` 模式下 = 配置项 `upstreamBaseUrl`（默认 `https://api.deepseek.com`）。

---

## 4. 系统架构（插件内嵌形态）

```
                        ┌────────────────────────────────────────────────┐
                        │            dsh 进程（单个 Node 进程）            │
  浏览器 GUI              │                                                │
  ┌─────────────────┐    │  ┌──────────────────────────────────────────┐  │
  │ 客户端插件         │    │  │ 服务端插件 logprobs-highlighter           │  │
  │ · M3 turnTail 面板│    │  │  ① 反代 createServer :8787               │  │
  │ · M3.5 shadow    │    │  │     注入→分流→剥皮→转发（仅 DeepSeek）      │  │
  │   逐token 高亮    │    │  │  ② 捕获存储（内存环形缓冲）                │  │
  │ · DataClient     │    │  │  ③ 关联器 session/event→(sess,turn,step)  │  │
  │   (s,turn,step)  │    │  │  ④ baseURL 接管/还原（settings.update）    │  │
  └────────┬─────────┘    │  │  ⑤ webServer 路由 /plugins/lph/*          │  │
           │ 同源 fetch   │  └───────────────┬──────────────────────────┘  │
           ▼              │                  │ baseURL 指向                │
  ┌────────────────┐      │                  ▼                            │
  │ dsh 核心        │      │         https://api.deepseek.com              │
  │ llm-deepseek   │──────┘                                                │
  │ (:8787)        │   POST /chat/completions（注入后胖流）                  │
  └────────────────┘                                                       │
                        └────────────────────────────────────────────────┘
```

| 层 | 位置 | 职责 | 关键决策 |
| :--- | :--- | :--- | :--- |
| 服务端插件（捕获层） | dsh 进程内 | 反代 8787、注入/分流/剥皮、捕获存储、400/422 降级、baseURL 接管、关联器、webServer 路由 | 独立端口绕开 3080 路由表；只处理 DeepSeek 请求；带宽只花在 DS↔反代段且对 dsh 不可见 |
| 客户端插件（渲染层） | 浏览器 | M3 turnTail 面板 → M3.5 shadow `assistant-step` 逐 token 上色 | 复用 `MarkdownText`；无数据=灰色；reasoning 折叠灰 |
| 共享数据接口 | 服务端↔客户端 | `(sessionId, turn, step)` 查询捕获/标记数据 | 从一开始按此键设计，两种渲染共用 |

---

## 5. 服务端插件设计（捕获层）

### 5.1 处理范围（多 provider 安全）

- **只处理**：`POST /chat/completions` 且 `model` 命中 DeepSeek 目录（默认 `deepseek-*`，兼容 `deepseek-v4-*` 与旧别名，目录可配置）。
- **其余一律原样透传**：其他路径、其他模型、其他 provider——不注入、不捕获、不剥皮、不记录。
- `x-deepseek-harness-compact: 1` 的请求：透传但不捕获（后台任务，避免噪声与存储）。
- 若 DeepSeek 对某模型返回 **400/422** 且错误含 `logprobs`/`top_logprobs`/`not supported`/`unsupported`/`not allowed` 等关键字：**去掉注入参数重试一次**，成功后记录该模型为"不支持"（模型级记忆，后续直接透传）；错误响应体原样透传给 dsh。

### 5.2 流处理（分流 + 剥皮转发）

- 胖流（含 logprobs）→ 解析**双字段**（`logprobs.content` 与 `logprobs.reasoning_content`）条目、按角色（reasoning/text/tool-call）累积捕获；
- 剥皮流（删除 `logprobs` 字段后重序列化）→ 转发 dsh；`[DONE]`、`finish_reason`、`usage`、其余字段原样保留；
- 效果：dsh 侧字节与直连几乎一致，行为零变化。
- 非流式响应同样支持（`choices[0].logprobs.content[]` 按数组顺序对齐，无 `index`）。

### 5.3 捕获存储（内存环形缓冲）

每请求一条，环形缓冲 **20 条 / 1 小时**（先到先淘汰），后续可手动导出 JSONL：

```jsonc
{
  "id": "req-<x-request-id 或自生成>",
  "sessionId": "sess-…",                 // 来自 x-deepseek-harness-session-id
  "compact": false,
  "model": "deepseek-v4-pro",
  "createdAt": 1724000000000,
  "reasoningState": "present",           // present（思考段带 logprobs，已实测）| absent（无 reasoning 段）| unknown（异常/旧数据）
  "complete": true,                      // [DONE]/finish_reason/usage 到达 = true；流中止/上游错误 = false（aborted，不参与关联）
  "blocks": [
    { "role": "reasoning", "tokens": [ /* 已实测：思考段携带 reasoning_content logprobs；标记层永不标 */ ] },
    { "role": "text",      "tokens": [ { "text": "深", "logprob": -0.03, "top": […] } ] },
    { "role": "tool-call", "tokens": [ /* 捕获但不标记 */ ] }
  ],
  "usage": { "inputTokens": 1200, "outputTokens": 300, "reasoningTokens": 180 },
  "assoc": { "turn": 3, "step": 0, "messageId": "msg-…", "at": 1724000001234 }   // 关联前为 null
}
```

### 5.4 带宽（真实 M0 实测）

- **真实 M0 实测（deepseek-v4-flash，top2）**：
  - Run A（max_tokens=200，纯思考流，content 0 chunk）：原始 107038 B / 剥皮 59347 B = **x1.804**；
  - Run B（max_tokens=800）：**x1.797**（thinking）/ **x1.884**（no-thinking）。
- t1 桌面序列化估算（**非实测**，供参考）：top2 每 token ≈204–213 B、top5 ≈387–397 B；1 token/chunk 流放大 x1.68（top2）/ x2.29（top5）；中文约 1 字 ≈ 1 token。top5 尚无真实实测。
- **分块粒度实测**：thinking content 24 tokens、no-thinking 61 tokens，**均 1 token/chunk**、对齐 24/24 与 61/61、bytes 0 不一致；未观测项仅剩**多 token chunk**（>1/chunk，真实样本全 1/chunk；多 token 拼接仍只有 mock 验证）。
- 对策：默认 `top_logprobs=2`；剥皮转发（胖流只在 DS→反代段，dsh 侧始终 lean）；跳过 compact 请求；思考段 logprobs 照常捕获（已实测存在）但标记层不标。

### 5.5 捕获-消息关联模型（sessionId FIFO）

- wire 请求体**不带 turn/step**，headers 只有 `x-deepseek-harness-session-id` 与 `x-deepseek-harness-compact`；同会话流式请求**串行**（agent-loop 每次 await 一个流）。
- 反代侧：按 `x-deepseek-harness-session-id` 把捕获条目压入 **FIFO 待关联队列**（compact 请求不入队）；条目带 **`complete` 标记**——`[DONE]`/`finish_reason`/`usage` 到达 = `complete`；流中止/超时/上游错误 = `aborted`。
- 插件侧：`ctx.on('session/event', …)` 监听 `assistant/message` 事件（载荷带 `turn`/`step`/`message.id`/`usage`），按 sessionId **出队**一条捕获——**跳过 aborted 条目并 GC**（失败尝试不会顺移错位），写入内存索引 `(sessionId, turn, step) → probeId`。
- **中止/重试语义（宁可无数据不错位）**：失败尝试的捕获标记 aborted 后不参与关联，下一条真实消息只会关联到完整完成的流；客户端查询统一走该索引，关联失败/过期 → 返回"无捕获"（渲染为灰色）。

---

## 6. 客户端插件设计（标记层 + 渲染层）

原则：**宁可少标，不可多标**。服务端输出给渲染层的不是"该标谁"，而是**每个 token 的置信度数据 + 异常标记**，颜色由渲染层映射。

### 6.1 角色过滤

| 流角色 | 处理 |
| :--- | :--- |
| `answer`（text） | ✅ 唯一参与标记与配色 |
| `reasoning`（思考） | ❌ 不标记；**折叠显示，展开后灰色**（hover 提示："思考段，有概率数据但不标记"） |
| `tool-call` | ❌ 不标记；展示为灰色或弱化 |

> **content 缺失容错（真实 M0 实测）**：`max_tokens` 过小时思考模式可能耗尽额度导致 content 段为空（实测：200 时 content 0 chunk；800 时正常出 24 tokens）。标记层/渲染层按"无答案内容"处理：不报错、不上色，面板提示"思考段耗尽 max_tokens，无答案内容"；dsh 侧 `max_tokens` 建议调大（如 ≥2048）。

### 6.2 信号

- **突变点（主）**：对 answer token 的 logprob 序列取滑动窗口（±20），用稳健统计（median+MAD）算 z 分；`z < -2.5` 且前后邻居均高置信 → 突变点。相对比较自带校正（句首/标题后/代码块开头的天然低概率区不误报）。
- **辅助**：绝对置信度 `exp(logprob) < 1%` 且不在热身区。
- **补充**：Top1-Top2 差距极小（如 30% vs 25%）→ 模型犹豫，hover 展示备选词。

### 6.3 token 分类与异常等级

| 类别 | 判定示例 | 异常权重 |
| :--- | :--- | :--- |
| 数字、年份、百分比、版本号 | `2024`、`3.2.1`、`98%` | 最高（命中即强提示） |
| 人名、机构名、API/函数名、路径 | `getUserById`、`/etc/x` | 最高 |
| 一般实词 | 普通名词/动词/形容词 | 中 |
| 虚词、标点、语法符号 | `的`、`，`、`{`、`)` | 永不标记 |

**代码块单独规则（问卷决策）**：代码块内**只标数字/标识符的强突变**（`z < -3` 且为数字/标识符 token），**语法符号永不**；代码块整体不参与全文热力图配色（按代码配色）。

### 6.4 抑制规则

- **热身区**：每个块前几个 token 自动降权。
- （v3 的"与上文一致性检查"一期不做，列为二期候选——移除原因：零成本但实体抽取/匹配的误报风险高，先验证纯 logprobs 信号。）

### 6.5 标记输出（服务端接口，客户端按此渲染）

```jsonc
{
  "key": { "sessionId": "sess-…", "turn": 3, "step": 0 },
  "captured": true,
  "reasoningState": "present",
  "blocks": [ /* 按角色分组，text 块每个 token 一条 */ ],
  "marks": [ /* 异常标记（突变/低置信），供"只看红点"切换 */ ]
}
```

（完整 JSON schema 见 [docs/architecture-v4.md §3](docs/architecture-v4.md#3-接口约定)。）

### 6.6 渲染分期（t2 §6.4 决策）

1. **M3 — turnTail 面板**（低风险，先验证数据链路）：`conversation.chat.turnTail` chain 槽，在每条消息下方追加"logprobs 面板"（热力条 + token 级 hover 备选词，不碰消息本体渲染）。
   > **M3 前落实客户端重取策略**：节点渲染时若服务端返回 `assoc-pending`（assoc 未完成），客户端需重取——三选一（收到 `assistant/message`/`turn/end` 事件后重查一次 / assoc-pending 退避重试 N 次 / 服务端 assoc 完成后推送事件），否则该节点永久灰色。具体方案 M3 设计时定，此处不展开。
2. **M3.5 — shadow `assistant-step` 逐 token 高亮**：注册 `{ name: 'conversation.chat.node', key: 'assistant-step', priority: -10 }` 替换默认渲染，复用 `MarkdownText` 渲染 markdown、按 token 切片包 `<span data-token>` 上色 + hover；reasoning 块折叠灰色、图片引 `ImageGallery`；**只对 settled 节点上色**（流式期间 logprobs 不完整）。

### 6.7 色阶方案（红 → 蓝 + 灰）

- **有数据的 answer token**：按置信度映射连续色阶——**蓝（高置信）→ 红（低置信）**，中间经黄绿过渡；异常标记（突变）用加深/加粗/描边突出。
- **无数据 token**：**一律灰色**（#9ca3af 类），包括：非 DeepSeek 模型的输出、模型不支持 logprobs 的请求、**reasoning 段（有概率数据但不标记）**、tool-call 段、剥皮失败、关联失败等。灰色不参与统计与配色，hover 显示"无概率数据"及原因。
- 色板映射公式（M4 视觉验收时微调）：`hue = 240° × clamp(1 + logprob / 10, 0, 1)`（logprob 越接近 0 越蓝，越负越红）。

---

## 7. 安全与隐私（插件形态）

| 项 | 措施 |
| :--- | :--- |
| 监听 | 反代只绑 `127.0.0.1:8787`，不提供公网/LAN 监听；客户端数据走 dsh 同源 3080 的 `/plugins/logprobs-highlighter/*` 路由 |
| API Key | **仍只在 `Authorization` 头中透传**（反代原样转发，不落盘、不打日志、不写入捕获存储） |
| 信任边界 | 反代与 dsh **同进程**，能看到对话明文——插件形态的固有前提（与 v3 独立进程相同，且不再有跨进程暴露面） |
| 对话内容 | 默认仅内存（20 条/1 小时环形缓冲），不写磁盘；JSONL 导出需显式触发 |
| 设置污染 | baseURL 接管写入 settings 后会持久化——**卸载/禁用时必须还原旧值**；**启动自愈**兜底 SIGKILL/崩溃残留（见 §3.6）；`manageBaseUrl:false` 可完全交给 `$DEEPSEEK_BASE_URL` |
| 上游 | 强制 HTTPS（`https://api.deepseek.com`） |
| 剥皮转发 | logprobs 不扩散到 dsh 进程之外（除捕获存储与客户端查询） |

---

## 8. 实施步骤（里程碑重排）

| 里程碑 | 内容 | 验收 |
| :--- | :--- | :--- |
| **M0 数据验证** | `scripts/m0-probe.mjs` 直连 DS 注入 `logprobs:true, top_logprobs:2`（**已真实实测**：Run A 200 + Run B 800；样本 `docs/m0-sample-thinking.json`（231 chunks，thinking）、`docs/m0-sample-nothinking.json`（63 chunks，no-thinking；`m0-sample.json` 为最近一次运行输出，自动覆盖）；旧 mock 假数据已废弃） | 已确认：思考段携带 `logprobs.reasoning_content[]`、content 段携带 `logprobs.content[]`（thinking 24 / no-thinking 61 tokens，均 1 token/chunk，对齐 24/24、61/61，bytes 0 不一致）、首 chunk role-only（logprobs:null）、带宽 x1.804 / x1.797 / x1.884（top2）；未观测项仅剩：多 token chunk（>1/chunk）、top5 带宽、非流式无 index 实证、400/422 真实错误体、top_logprobs=0 |
| **M1 服务端插件骨架** | 插件包骨架（package.json/exports/cordis.patch.yml）；反代 8787（注入→分流→剥皮→转发，**角色分类按 §3.3 三规则**，双字段解析 content + reasoning_content）；捕获存储（**complete/aborted 标记**）；400/422 降级 + 模型黑名单；baseURL 接管/还原（**启动自愈**）；webServer 路由骨架；**非 DeepSeek 请求透传** | `dsh plugin --profile web add "link:<根>"` 后正常对话，`/plugins/logprobs-highlighter/*` 可查询捕获；dsh 行为与直连一致；卸载还原 baseURL；其他 provider 不受影响；**思考模式 content chunk 分类正确（24/24 不被吞入 reasoning）** |
| **M2 标记引擎** | 角色过滤、突变点 z 分、分类（数字/实体/实词/虚词）、**代码块保守规则**、热身抑制；合成序列单测 | ≥10 条真实消息人工比对，红点无漏网、无明显噪声 |
| **M3 客户端 turnTail 面板** | `conversation.chat.turnTail` chain 槽；数据接口 `(sessionId, turn, step)`；面板内热力条 + hover 备选词 | 面板出现、数据链路打通（事件→捕获→查询→渲染）、hover 正确 |
| **M3.5 shadow 逐 token 高亮** | shadow `assistant-step`（key=`assistant-step`, priority:-10），复用 `MarkdownText`，逐 token 上色 + hover；reasoning 折叠灰；图片引 `ImageGallery`；只对 settled 上色 | 消息正文热力图正确、无数据灰色、reasoning 折叠灰、与 M3 面板数据一致 |
| **M4 验证调参** | 事实查询/代码/长文三组用例；误报率统计；验证 `top_logprobs=2` 默认档是否需调整 | 调参报告；决定是否启动二期（一致性检查、JSONL 导出等） |

---

## 9. 风险与开放问题

| # | 问题 | 应对 |
| :--- | :--- | :--- |
| 1 | 思考段 logprobs 字段结构（`reasoning_content` 而非 `content`）？ | **已实测存在**；捕获解析必须支持双字段 `logprobs.content` + `logprobs.reasoning_content`（t4 已踩坑）；标记层永不标 reasoning |
| 2 | 思考模式消耗 `max_tokens` 导致答案截断/不出 content？ | **已实测**：200 时 content 0 chunk（思考段耗尽额度）；800 时正常出 24 tokens。反代/标记层按"content 缺失/为空"容错（渲染灰 + 面板提示）；dsh 侧 `max_tokens` 建议调大（≥2048） |
| 3 | content 段真实分块粒度（1 token/chunk 或批量）？ | **已实测：1 token/chunk**（thinking 24 / no-thinking 61，对齐 24/24、61/61）；未观测项仅剩**多 token chunk**（>1/chunk，真实样本全 1/chunk；拼接对齐仍只有 mock 验证） |
| 4 | 剥皮重序列化是否影响 dsh 解析？ | M1 对比直连与反代行为差异（reserialized ≠ raw 字节数不影响语义） |
| 5 | shadow `assistant-step` 需自渲染 reasoning/图片/流式态 chrome？ | 先 M3 turnTail 面板（不碰消息本体）验证链路；M3.5 复用 `MarkdownText`/`ImageGallery`，reasoning 简单折叠 |
| 6 | 安装版无 `pnpm run dev:web`，client bundle 如何迭代？ | 自行 watch/rebuild bundle（tsdown），client-hmr 500ms 热替换；host 改动重启 dsh |
| 7 | baseURL 接管竞态（命名空间未就绪 / 卸载还原失败 / SIGKILL 崩溃残留）？ | `ctx.on('internal/service')` 重试；`dispose` 还原；**启动自愈**（检测到残留 baseURL 先确保代理监听成功再接管，失败回滚并告警）；`manageBaseUrl:false` 兼容路径 |
| 8 | 关联错位（同会话并发、compact 跳过、失败重试）？ | 同会话流串行 + sessionId FIFO 出队；捕获条目带 **complete/aborted** 标记，出队**跳过 aborted 并 GC**（失败重试不产生顺移错位）；compact 不入队；关联失败返回"无捕获"=灰 |
| 9 | 中文实词/虚词分类准确率？ | 保守规则起步（只排除标点/空格/符号/语法符号），M4 调参 |
| 10 | 旧别名 `deepseek-chat/reasoner` 停用后的行为？ | 400/422 降级兜底或透传让上游报错；目录匹配兼容新旧名 |
| 11 | 环形缓冲容量/保留策略是否够用？ | 默认 20 条/1h 可配；后续 JSONL 手动导出 |

---

## 参考文档

- [DeepSeek Chat Completions API](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)（注入参数的目标接口）
- [DeepSeek 模型 & 价格 / 错误码 / 思考模式](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)（模型矩阵、400/422 语义）
- [OpenAI openapi.yaml（ChatCompletionTokenLogprob 规范对照）](https://github.com/openai/openai-openapi)
- 调研报告：[docs/research-api-logprobs.md](docs/research-api-logprobs.md)（t1）｜ [docs/research-dsh-plugin.md](docs/research-dsh-plugin.md)（t2）
- 架构规格：[docs/architecture-v4.md](docs/architecture-v4.md)
