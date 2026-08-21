# DeepSeek API logprobs 字段与流式格式调研报告（任务 t1）

> 状态：**调研完成**（桌面调研，未发真实 API 请求——M0 脚本阶段再做实测）。
> 日期：2026-08-20 ｜ 调研员：researcher
> 用途：M0 验证脚本与 M1 反代实现的输入；**修正 README v3 中的两处错误假设**（见 §4.4、§7）。

---

## 0. 结论速览

- DeepSeek Chat Completions API **官方支持 `logprobs` / `top_logprobs`**，参数与响应结构为 **OpenAI 兼容**（字段名、语义、`-9999.0` 哨兵值、`bytes` 整数数组均与 OpenAI openapi 规范一致）。
- 流式 chunk 中 logprobs 位于 **`choices[i].logprobs.content[]`**（choice 级，不是 delta 级）；每个条目含 `token` / `logprob` / `bytes` / `top_logprobs`。
- 当前官方模型为 **`deepseek-v4-flash` / `deepseek-v4-pro`**（模型版本 V4-Flash-0731 / V4-Pro-0813），旧名 `deepseek-chat` / `deepseek-reasoner` 是 v4-flash 的别名，**2026-07-24 停用**。
- 关键未确认项：**思考模式下 `reasoning_content` 是否伴随 logprobs**、流式 chunk 的实际分块粒度（1 token/chunk？）、旧名/思考模式触发 400/422 的**真实错误响应体**——全部留给 M0 实测。
- 带宽（本报告按官方示例 chunk 结构实测序列化计算）：`top_logprobs=2` 流放大约 **x1.7**，`top_logprobs=5` 约 **x2.3**（1 token/chunk 时）；README 的"4–6 倍"是高估上限（多 token/chunk 批量时才可能出现）。

---

## 1. 参数规格（官方文档）

来源：[Create Chat Completion API（英文）](https://api-docs.deepseek.com/api/create-chat-completion/) ｜ [对话补全 API（中文）](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)（2026-08 抓取原文）。

### 1.1 请求参数

| 参数 | 类型 | 约束 | 官方描述（中） |
| :--- | :--- | :--- | :--- |
| `logprobs` | boolean, nullable | — | 是否返回所输出 token 的对数概率。如果为 `true`，则在 `message` 的 `content` 中返回每个输出 token 的对数概率。 |
| `top_logprobs` | integer, nullable | **0 ≤ N ≤ 20** | 介于 0 到 20 之间的整数 N，指定每个输出位置返回输出概率 top N 的 token 及这些 token 的对数概率。**指定此参数时 `logprobs` 必须为 true**。 |

要点：

- **默认行为**：两者均不传 → 响应不携带概率数据，流式示例中 `logprobs` 字段为 `null`。
- `top_logprobs` 上限 **20**（与 OpenAI 一致）；文档未明确 0 的行为（语义上"只返回选中 token 本身"，见 §7 未确认项）。
- 文档没有给出带 `logprobs: true` 的完整请求示例（M0 需要自行构造）。

### 1.2 与 OpenAI 兼容格式的差异

**无实质差异。** 对照 [OpenAI openapi.yaml 的 `ChatCompletionTokenLogprob`](https://github.com/openai/openai-openapi)：

- 请求参数名/范围：`logprobs` (bool)、`top_logprobs` (0–20) —— 一致；
- 响应条目字段：`token` (string)、`logprob` (number，`-9999.0` 表示概率极小不在 top 20)、`bytes` (integer[] | null，UTF-8 字节)、`top_logprobs` (object[]，条目同构) —— 逐字一致；
- "返回的 top_logprobs 数量可能少于请求值"（rare cases）—— 两处文档表述一致。

结论：反代注入层可以直接按 OpenAI 客户端的既有认知处理，无需特殊适配。

---

## 2. 流式响应结构（stream: true）

### 2.1 logprobs 的位置

- 位于 **choice 级**：`choices[i].logprobs`（与 `delta` 平级），内容是 `content` 数组：`choices[i].logprobs.content[]`。
- 每个条目：`{ "token", "logprob", "bytes", "top_logprobs" }`；`top_logprobs` 数组元素与条目同构（`token` / `logprob` / `bytes`，**无嵌套 top_logprobs**）。
- 官方流式响应 schema（文档原句）：`logprobs object nullable — Log probability information for the choice.`；`content object[] nullable — A list of message content tokens with log probability information.`

### 2.2 期望的流式 chunk 形态（OpenAI 兼容，M0 需实测确认）

```jsonc
// SSE data: （每 chunk 一行）
data: {"id":"1f633d8bfc032625086f14113c411638","choices":[{
  "index": 0,
  "delta": { "content": "深", "role": "assistant" },
  "finish_reason": null,
  "logprobs": {
    "content": [{
      "token": "深",
      "logprob": -0.0312,
      "bytes": [230, 183, 177],
      "top_logprobs": [
        { "token": "深", "logprob": -0.0312, "bytes": [230, 183, 177] },
        { "token": "圳", "logprob": -1.8921, "bytes": [230, 183, 183] }
        // top_logprobs=5 时最多 5 条；可能少于请求值
      ]
    }]
  }
}],"created":1718345013,"model":"deepseek-v4-pro","object":"chat.completion.chunk","system_fingerprint":"fp_a49d71b8a1","usage":null}
```

（结构与 README §3.2 期望形状一致，README 该图正确。）

### 2.3 字段细节

- `bytes`：**整数数组，UTF-8 字节表示**；文档明确用途——"当一个 UTF-8 字符被拆分成多个 token 表示时，需合并各 token 的 bytes 才能还原正确文本"；"若 token 没有字节表示则为 `null`"。
- `delta.content` 与 `logprobs.content` 的对齐：OpenAI 兼容约定为 **按数组顺序 1:1 对应**（delta 中第 k 个 token ↔ logprobs.content 中第 k 个条目）。DeepSeek 文档未显式写这句，但结构完全兼容 OpenAI；**DeepSeek 是否严格 1:1 / 是否多 token 一 chunk，需 M0 实测**（用 `token` 字符串 + `bytes` 双重对齐兜底，README 开放问题 #7 的做法正确）。
- 首 chunk（角色宣告）：官方流式示例（未请求 logprobs）为 `delta: {"content": "", "role": "assistant"}, logprobs: null`。**请求 logprobs 时首 chunk 的 `logprobs.content` 是空数组 / null / 缺失，官方未展示 → 未确认**。
- finish 块：官方示例为 `delta: {"content": "", "role": null}, finish_reason: "stop", logprobs: null`——**finish 块不带概率数据**；`usage` 附着在最后一个 chunk 上。
- 不请求 logprobs 时，每个 chunk 仍有 `logprobs: null` 字段（字段存在，值为 null），剥皮逻辑需兼容"字段缺失 / null / 空 content 数组"三种形态。

---

## 3. 非流式响应结构

- 位置：`choices[0].logprobs.content[]`，与 `choices[0].message` 平级；条目字段与流式完全同构（`token` / `logprob` / `bytes` / `top_logprobs`）。
- 官方响应示例（schema 生成）：

```jsonc
{
  "choices": [{
    "message": { "content": "string", "reasoning_content": "string", "role": "assistant" },
    "logprobs": {
      "content": [
        { "token": "string", "logprob": 0, "bytes": [0],
          "top_logprobs": [ { "token": "string", "logprob": 0, "bytes": [0] } ] }
      ]
    }
  }]
}
```

### 3.1 ⚠️ 对 README v3 的修正：非流式条目**没有 `index` 字段**

- README §5.2 写"非流式响应（`choices[0].logprobs.content` 带 `index`，对齐更简单）"——**官方 schema 中 `logprobs.content` 条目只有 `token/logprob/bytes/top_logprobs`，无 `index`**；OpenAI 规范同样无 `index`，位置由数组顺序隐含。
- 对齐方式：按数组顺序对应 message.content 的 token 序列（用 `token` 字符串 + `bytes` 双重校验）。请架构师在 v4 文档中修正此表述。

---

## 4. 模型差异矩阵

### 4.1 官方模型现状（2026-08）

来源：[模型 & 价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)（2026-08 抓取）、[获取模型列表](https://api-docs.deepseek.com/zh-cn/api/list-models/)、[V4 预览版发布新闻（2026-04-24）](https://api-docs.deepseek.com/zh-cn/news/news260424/)。

| 模型 ID | 版本 | 思考模式 | 备注 |
| :--- | :--- | :--- | :--- |
| `deepseek-v4-flash` | DeepSeek-V4-Flash-0731 | 支持非思考与思考（**思考为默认**） | 官方模型列表示例 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 同上 | 官方模型列表示例 |
| `deepseek-chat` | —（别名） | 指向 v4-flash **非思考**模式 | **2026-07-24 停用** |
| `deepseek-reasoner` | —（别名） | 指向 v4-flash **思考**模式 | **2026-07-24 停用** |

### 4.2 logprobs 支持矩阵（证据级别标注）

| 模型 / 模式 | logprobs 支持 | 证据 |
| :--- | :--- | :--- |
| `deepseek-v4-flash` / `deepseek-v4-pro`（非思考） | ✅ 支持 | 官方 create-chat-completion 文档含 `logprobs`/`top_logprobs` 参数与响应 schema（文档级证据） |
| `deepseek-v4-*` 思考模式 | ⚠️ 大概率支持，**reasoning 段覆盖未确认** | 官方[思考模式指南](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)只列 `temperature/top_p/presence_penalty/frequency_penalty` 为"设置不报错但不生效"，**未列 logprobs** → 按文档推理不报错；但 logprobs 参数描述说"在 message 的 **content** 中返回每个输出 token 的对数概率" → 暗示只覆盖 content，reasoning_content 是否伴随概率**无公开证据**（M0 必测项） |
| `deepseek-chat`（别名→v4-flash 非思考） | ✅ 同 v4-flash | 同上 |
| `deepseek-reasoner`（别名→v4-flash 思考） | ⚠️ 冲突 | 旧版 reasoner 文档（[Apifox 镜像，更新于 2026-05-28](https://deepseek.apifox.cn/%E6%8E%A8%E7%90%86%E6%A8%A1%E5%9E%8B-deepseek-reasoner-5903960m0)）明确：**logprobs / top_logprobs 不受支持，设置会报错**（而 temperature 等 4 项不报错但不生效）；第三方指南（[deepseekv4pro.com 推理模型参数规则](https://deepseekv4pro.com/guides/deepseek-reasoning-model-unsupported-parameters)）同此说法。但 v4 思考模式官方指南未禁 logprobs → **别名现实行为需 M0 实测** |
| 第三方推理（DeepInfra 上的 DeepSeek-V3 等） | ✅ 支持 | [DeepInfra Log Probabilities](https://docs.deepinfra.com/chat/log-probs)（OpenAI 兼容接口，佐证 DeepSeek 生态支持 logprobs） |

### 4.3 对反代设计的影响

- dsh 默认模型目录 `deepseek-v4-flash` / `deepseek-v4-pro` **命中官方当前模型**，非思考模式 logprobs 支持确定。
- **思考模式是 v4 的默认模式**（pricing 页："支持非思考与思考模式（默认）"），且 dsh 请求体可带 `thinking: {type: enabled}` / `reasoning_effort`（README §3.1）→ 流里会出现 `reasoning_content` 段。反代需按 README 规则：reasoning 段捕获与否待 M0 定，**默认不标**。
- 旧名别名场景（用户配置 deepseek-chat/reasoner）：可能触发"logprobs 报错"→ README §5.1 的 400 降级逻辑（去掉注入重试一次 + 记录不支持）是正确兜底，且应覆盖 **422**（见 §5）。

### 4.4 ⚠️ 对 README v3 的修正：模型名

README 说"dsh 默认模型目录为 deepseek-v4-flash / deepseek-v4-pro（可配置）"——正确且与官方模型 ID 一致；但需注意旧名 `deepseek-chat`/`deepseek-reasoner` 已于 2026-07-24 停用，**若用户模型目录仍配旧名，请求会失败（模型不存在）**，反代目录匹配应同时兼容新旧名或透传让上游报错。

---

## 5. 不支持时的错误形态

### 5.1 官方错误码语义

来源：[错误码文档](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes/)：

| 状态码 | 含义 | 处理建议 |
| :--- | :--- | :--- |
| **400** | 格式错误（请求体格式错误） | 按错误信息修改请求体 |
| **422** | 参数错误（请求体参数错误） | 按错误信息修改参数 |
| 401 / 402 / 429 / 500 / 503 | 认证 / 余额 / 限速 / 服务故障 / 繁忙 | 与 logprobs 无关 |

### 5.2 logprobs 被拒时的形态（部分未确认）

- 官方/镜像文档只说 legacy reasoner 设置 logprobs/top_logprobs **"会报错"**，未公开状态码与响应体；第三方指南同样只说 "Rejected with an error"。
- **未找到公开的真实 400/422 响应体示例**（error 字段的 code/message 原文无公开样本）。
- 参考 DeepSeek 整体遵循 OpenAI 错误风格（`{"error": {"message": ..., "type": ..., "param": ..., "code": ...}}`），但此为推断，**M0 必须实测记录真实形态**。
- 反代降级匹配建议：状态码 ∈ {400, 422} 且 `error.message`（或 `error.code`）包含 `logprobs` / `top_logprobs` / `not supported` / `unsupported` / `not allowed` 等关键字 → 判为"该模型不支持 logprobs"，去掉注入参数重试一次并记入模型黑名单；**错误响应体原样透传**给 dsh（不能让 dsh 看到被篡改的错误）。

---

## 6. 带宽估算（实测序列化计算）

方法：按官方流式示例的 chunk 结构（id/created/model/system_fingerprint/object/usage 等信封字段原样），用 Python `json.dumps(ensure_ascii=False)` 实测 UTF-8 字节数。样本：中文 token `"深"`（bytes `[230,183,177]`）与英文 token `" the"`，top_logprobs 2 与 5。

### 6.1 单 token 开销

| 项 | 字节数 |
| :--- | :--- |
| 基础 logprobs 条目（token + logprob + bytes + 空 top_logprobs） | ≈ 78–83 B |
| 每个 top 条目（token + logprob + bytes） | ≈ 60–65 B |
| **top_logprobs=2 时每生成 token 的 logprobs 开销** | **≈ 204–213 B** |
| **top_logprobs=5 时每生成 token 的 logprobs 开销** | **≈ 387–397 B** |

### 6.2 流级放大（假设 1 token/chunk，与官方流式示例一致）

| 配置 | 每 chunk 总字节（中文 token） | 相对 lean 放大 |
| :--- | :--- | :--- |
| 无 logprobs（lean） | ≈ 300 B | 1.00x |
| top_logprobs=2 | ≈ 504 B | **x1.68** |
| top_logprobs=5 | ≈ 687 B | **x2.29** |

（英文 token 结果几乎相同：x1.71 / x2.32。）

### 6.3 整流估算（中文答案，1 token/chunk）

| 输出长度 | lean | top_logprobs=2 | top_logprobs=5 |
| :--- | :--- | :--- | :--- |
| 500 token（≈500 字） | ≈ 146 KB | ≈ 246 KB | ≈ 335 KB |
| 1000 token | ≈ 293 KB | ≈ 492 KB | ≈ 671 KB |
| 2000 token（≈2000 字） | ≈ 586 KB | ≈ 984 KB | ≈ 1.34 MB |

### 6.4 ⚠️ 对 README v3 的修正：带宽数字

- README 假设"2000 字 ≈ 500 token ≈ 15 KB"**明显偏乐观**：中文约 1 字 ≈ 1 token（2000 字 ≈ 2000 token）；15 KB 只算了 content 文本字节，漏了 SSE chunk 信封（每 chunk ~300 B）。
- README 说"top_logprobs=5 时流体积放大 4–6 倍"是**高估上限**：按官方 1 token/chunk 实测放大仅 **x2.3**。4–6 倍只出现在 DeepSeek 每 chunk 批量多 token 的场景（如 5 token/chunk：logprobs 载荷线性增长、delta 相对小 → 放大比可到 x5-6）。**真实分块粒度需 M0 实测**。
- 结论不变但数字要更新：弱网建议 `top_logprobs=2`（x1.7），宽带 `top_logprobs=5`（x2.3）可接受；剥皮转发让 dsh 侧始终看到 lean 流。

---

## 7. 未确认项清单（M0 必测）

以下内容**未找到公开证据**，官方文档未覆盖，全部需要 M0 脚本用真实 API key 实测：

1. **流式 chunk 分块粒度**：DeepSeek 是否恒为 1 token/chunk？多 token chunk 时 `logprobs.content` 是否按序 1:1 对应 `delta.content`？（影响对齐逻辑与带宽放大比 x2.3 vs x5-6）
2. **思考模式 reasoning_content**：v4 思考模式下 `reasoning_content` token 是否伴随 logprobs？若伴随，`logprobs.content` 是混排（reasoning + content 同一数组）还是仅 content？（决定 README 开放问题 #1 与捕获层是否要按角色切分）
3. **首 chunk 形态**：请求 logprobs 时首 chunk（空 content 角色宣告）的 `logprobs.content` 是空数组 / null / 字段缺失？
4. **非流式条目是否真的无 index**：官方 schema 无 `index` 字段（README v3 与之冲突），实测确认。
5. **400/422 真实响应体**：legacy `deepseek-reasoner`（或旧名 alias）发 logprobs 时 error 字段的 code/message 原文（供降级匹配用）。
6. **`top_logprobs=0` 的行为**：返回空 top_logprobs 数组还是仅主 token 条目？
7. **`logprobs=true` 但不传 top_logprobs**：`top_logprobs` 字段是空数组还是缺失？（文档 schema 标 required，实际行为待测）
8. **`bytes` 为 null 的场景**：哪些 token（特殊/控制 token？）没有字节表示？
9. **多 token 字符的 bytes 呈现**：emoji / 生僻字拆 2-3 token 时各 token 的 bytes 如何拆分（文档明说此用途，需真实样例核对）。
10. **旧名停用后的行为**：2026-07-24 后 `deepseek-chat`/`deepseek-reasoner` 的报错形态（model not found？），反代目录匹配是否需要兼容。

---

## 8. 来源清单

- [Create Chat Completion API（英文官方）](https://api-docs.deepseek.com/api/create-chat-completion/)
- [对话补全 API（中文官方）](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)
- [思考模式指南（中文官方）](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/) ｜ [Thinking Mode（英文官方）](https://api-docs.deepseek.com/guides/thinking_mode/)
- [模型 & 价格（官方）](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- [获取模型列表（官方）](https://api-docs.deepseek.com/zh-cn/api/list-models/)
- [错误码（官方）](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes/)
- [V4 预览版发布新闻（官方，2026-04-24，模型命名与别名停用）](https://api-docs.deepseek.com/zh-cn/news/news260424/)
- [推理模型 deepseek-reasoner（Apifox 镜像官方文档，legacy 参数限制）](https://deepseek.apifox.cn/%E6%8E%A8%E7%90%86%E6%A8%A1%E5%9E%8B-deepseek-reasoner-5903960m0)
- [OpenAI openapi.yaml（ChatCompletionTokenLogprob 规范对照）](https://github.com/openai/openai-openapi)
- [DeepInfra Log Probabilities（OpenAI 兼容 logprobs 结构与示例）](https://docs.deepinfra.com/chat/log-probs)
- [DeepSeek Reasoning Model Parameter Rules（第三方，legacy reasoner logprobs 报错佐证）](https://deepseekv4pro.com/guides/deepseek-reasoning-model-unsupported-parameters)
- [go-deepseek SDK Response Package（第三方 SDK 对 chunk 级 Logprobs 的建模佐证）](https://deepwiki.com/go-deepseek/deepseek/4-response-package)
