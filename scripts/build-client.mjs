/**
 * logprobs-highlighter — 客户端 bundle 构建
 *
 * 安装版 dsh 没有 dev server，client bundle 必须自行构建。
 * esbuild 把 src/client/index.js（含 injector.js）打成单文件 → lib/client.js，
 * 再由 dsh 的客户端模块加载器按 package.json `dsh.client.entry` 加载。
 *
 * 用法：node scripts/build-client.mjs
 */

import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const OUT = path.join(ROOT, "lib", "client.js");

/** 平台种子词：保持 external，由 dsh 的 __ModuleLoader__ 解析。 */
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
  platform: "neutral",
  target: ["es2020"],
  external: SEEDS,
  write: false,
  minify: false,
  sourcemap: false,
  logLevel: "warning",
});

const code = result.outputFiles[0].text;

const bundle = `/**
 * GENERATED FILE — 由 scripts/build-client.mjs 构建，勿手改。
 * 源码：src/client/index.js（+ injector.js）。
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(PKG.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${code.split("\n").map((l) => "    " + l).join("\n")}
    return module.exports;
  },
});
`;

writeFileSync(OUT, bundle, "utf8");
console.log(`build-client: ${path.relative(ROOT, OUT)} 已生成（${(bundle.length / 1024).toFixed(1)} KB，id=${PKG.name}）`);