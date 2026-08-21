# M3 联调指引 — turnTail logprobs 高亮面板

> 状态：待浏览器联调 ｜ 日期：2026-08-20 ｜ 作者：engineer（t12）
> 前置：M1 已真实联调通过（反代 8787 运行、baseURL 已接管、真实对话已捕获，
> `/plugins/logprobs-highlighter/status` 返回 `entries:2, pendingAssoc:0`）。

## 0. 前提检查（一次性）

```bash
cd /home/unidu/dsh/logprobs_highlighter
node test/self-test.mjs        # 全绿（含 client-utils 单测）
node --check lib/client.js      # bundle 存在且语法正确
```

## 1. 构建 client bundle

安装版 dsh 没有 `pnpm run dev:web`，client bundle 必须自行构建：

```bash
npm install                     # 安装 devDependency esbuild（若尚未装）
node scripts/build-client.mjs   # 产出 lib/client.js（exports["./client"] 指向）
```

- 构建脚本把 `src/client/index.js`（含 `panel.js` 与 `lib/client-utils.js`）用 esbuild
  打成单文件，external 平台种子词（react、`@deepseek-ai/dsh-client-ui-*` 等），
  产物包在 `window.__ModuleLoader__.load({id, factory})` 里（agent-teams 同款加载方式）。
- 改动 `src/client/**` 或 `lib/client-utils.js` 后**重跑本脚本**。
- client-hmr 每 500ms 轮询 bundle 文件，检测到变化会热替换；保险起见刷新浏览器。

## 2. 浏览器联调步骤

1. 确认插件已装：`dsh plugin --profile web add "link:/home/unidu/dsh/logprobs_highlighter"`
   （M1 已装则跳过），然后 `dsh --profile web` 启动。
2. 确认数据通道：浏览器打开 `http://127.0.0.1:3080/plugins/logprobs-highlighter/status`，
   应看到 `{"ok":true,...,"proxy":{"listening":true,...},"capture":{"entries":N,...}}`。
3. 打开一个**已产生助手回复**的会话（回复过程应产生过捕获；若还没有，随便发一条
   新消息等它生成完）。
4. 在一条**已完成的助手消息**下方，应出现折叠的 **logprobs 面板**：
   - 折叠态显示摘要，如 `logprobs：2 个可疑 / 共 34 token（展开看热力条）`；
   - 点击标题展开，看到：
     - **热力条**：一条红→蓝色阶总览（高置信=蓝、低置信=红、无数据=灰），
       hover 任意色段显示 `token  logprob=…  conf=…`；
     - **可疑 token 列表**（M2 前最小标记：`conf<10%` 或 Top1-Top2 差距<0.1）：
       每行 token 原文、置信度、logprob、Top-N 备选条形图（hover 显示备选词与数值）；
     - **思考段提示**：`思考段：思考段有概率数据但不标记（灰色，折叠展示）`；
     - usage 行（输入/输出/思考 token 数）。
5. 无捕获的消息（非 DeepSeek 模型、旧消息等）：面板显示灰色提示
   `无捕获数据（not-found）…`。
6. 关联未完成时（assoc-pending）：面板自动退避重试 3 次（500ms/1s/2s）；
   仍失败则显示 `关联进行中…已重试 N 次`（可刷新页面重试）。

## 3. 验收点（对照 README §8 M3 行）

| # | 验收点 | 期望 |
| :--- | :--- | :--- |
| ① | 面板随已完成消息出现 | 折叠摘要行在消息下方，默认折叠 |
| ② | 数据链路打通 | 事件→捕获→(sessionId,turn,step) 索引→fetch /tokens→渲染（面板显示 token 数） |
| ③ | hover 备选词 | 热力条/备选条形图 hover 显示 token 与数值 |
| ④ | 无捕获灰色 | captured:false 消息显示原因枚举（not-found/assoc-pending 等）而非报错 |
| ⑤ | reasoning 提示 | reasoningState=present 时面板显示"思考段有概率数据但不标记" |
| ⑥ | assoc-pending 重取 | 渲染瞬间关联未完成时自动重试（I4 已实现退避 3 次） |

## 4. 常见问题

- **面板不出现**：确认 bundle 已重建（步骤 1）且浏览器已刷新；检查浏览器控制台
  `[logprobs-highlighter] turnTail 注册失败` 日志——若出现，说明 `ctx.slots.register`
  参数与当前 dsh 版本不符，对照 `dsh-client-ui-conversation` 的 turnTail 声明
  （`{ name: "conversation.chat.turnTail" }`，chain 槽无需 key）修正。
- **面板出现但一直"加载中"**：`/tokens` 返回异常——浏览器控制台 Network 面板看
  `/plugins/logprobs-highlighter/tokens?...` 的状态码与响应体（400=缺参数，
  500=服务端异常，检查 dsh 日志）。
- **热力条全灰**：该消息无 text token 数据（如 max_tokens 被思考段耗尽，README §6.1），
  或捕获未关联（assoc-pending 重试后仍无）。
- **修改 client 后不生效**：重跑 `node scripts/build-client.mjs`；HMR 未生效则手动刷新。
- **真实联调核对 assoc 事件形状**：`dsh` 启动前设 `DSH_LPH_DEBUG_ASSOC=1`
  （或 config `debugAssoc: true`），首次 assistant/message 会打印脱敏事件结构，
  用于核对 `(turn, step)` 解析是否与本次实测一致。

## 5. 与 M3.5 的关系

本面板验证数据链路与色阶观感；M3.5 再用 shadow `assistant-step`（key=`assistant-step`,
priority:-10）做消息正文逐 token 上色，复用 `lib/client-utils.js` 的色阶/标记函数。
