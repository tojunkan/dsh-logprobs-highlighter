/**
 * logprobs-highlighter — 客户端 bundle 构建脚本（M3）
 *
 * 背景：安装版 dsh 没有 `pnpm run dev:web`，client bundle 必须自行构建
 * （t2 §3a / README §3.5）。本脚本用 esbuild 把 src/client/index.js
 * （含 panel.js 与 lib/client-utils.js）打成单文件，输出到
 * `lib/client.js`（package.json exports["./client"] 指向的路径，dsh-client-modules
 * 经 /plugins/<id>/client.js 加载）。
 *
 * 关键点：
 * 1. external 平台种子词（t2 §3a 清单）：react、react-dom/client、react/jsx-runtime、
 *    @deepseek-ai/dsh-client-ui-slots、@deepseek-ai/dsh-client-ui-primitives、
 *    @deepseek-ai/dsh-client-web-react、@deepseek-ai/dsh-client-ui-attachment、
 *    @deepseek-ai/dsh-client-schema-form——打包后这些 import 变成 require("...")，
 *    由 __ModuleLoader__.load 的 factory(require) 参数解析（agent-teams 同款）。
 * 2. 输出包装：esbuild cjs 产物 + module/exports 垫片，整体放进 factory 函数体。
 *
 * 用法：
 *   npm install          # 安装 devDependency esbuild
 *   node scripts/build-client.mjs   # 产出 lib/client.js
 * 改动 client 代码后重跑本脚本，浏览器刷新（或 client-hmr 500ms 轮询热替换）。
 */

import { build } from "esbuild";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const OUT = path.join(ROOT, "lib", "client.js");

/** 平台种子词（t2 §3a；require 只能解析这些 + shell 静态模块 + 已注册 graph 行）。 */
const SEEDS = [
  "react",
  "react-dom/client",
  "react/jsx-runtime",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-web-react",
  "@deepseek-ai/dsh-client-ui-attachment",
  "@deepseek-ai/dsh-client-schema-form",
];

const result = await build({
  entryPoints: [path.join(ROOT, "src", "client", "index.js")],
  bundle: true,
  format: "cjs",
  // neutral：decode-named-character-reference 等依赖在 browser platform 会解析到
  // DOM 版（模块初始化即 document.createElement，Node 冒烟不可用）；neutral 取
  // 同构纯 JS 版，浏览器与 Node 均可加载。本 bundle 无 node 内建依赖。
  platform: "neutral",
  target: ["es2020"],
  external: SEEDS,
  loader: { ".js": "jsx" }, // 源码为 .js 内含 JSX（src/client/panel.js）
  write: false,
  minify: false,
  sourcemap: false,
  logLevel: "warning",
});

const code = result.outputFiles[0].text;

const bundle = `/**
 * GENERATED FILE — 由 scripts/build-client.mjs 构建，勿手改。
 * 源码：src/client/index.js（panel.js + lib/client-utils.js）。
 * 构建：node scripts/build-client.mjs
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(PKG.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${code
  .split("\n")
  .map((l) => "    " + l)
  .join("\n")}
    return module.exports;
  },
});
`;

writeFileSync(OUT, bundle, "utf8");
console.log(`build-client: ${path.relative(ROOT, OUT)} 已生成（${(bundle.length / 1024).toFixed(1)} KB，id=${PKG.name}）`);
