#!/usr/bin/env node
/**
 * Windows 打包增量补丁 —— 在 workflow 检出上游源码、应用品牌化之后执行。
 *
 * 上游 electron-builder 的 win.target 只有 ["nsis"]，只产出安装程序。
 * fork 需要额外产出免安装 zip（win-unpacked 打成的绿色包），因此这里把 zip 追加进 target。
 *
 * 为什么单独一个文件而不是塞进 apply.mjs：macOS 流水线也在跑 apply.mjs，
 * 若把 win 的锚点校验耦合进去，上游一改 win.target 会连带把 mac 打包打挂。
 *
 * 设计约束与 apply.mjs 一致：只用稳定锚点做替换，锚点在上游消失时立即报错中断构建，
 * 绝不静默产出一个「少了 zip」的包。
 *
 * 注意：Windows 上 checkout 出来的文件可能是 CRLF，匹配时统一按 \r?\n 处理，
 * 但写回时保留原有换行风格，避免整个文件被重写成另一种 EOL 产生噪音 diff。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const relPath = "packages/desktop/electron-builder.config.js";
const filePath = resolve(process.cwd(), relPath);
const source = readFileSync(filePath, "utf8");

// 匹配 `win: { ... target: ["nsis"], ... }` 中的 target 数组，允许任意缩进与换行风格。
const pattern = /(win:\s*\{[\s\S]*?target:\s*\[)(\s*"nsis"\s*)(\])/;

if (/win:\s*\{[\s\S]*?target:\s*\[\s*"nsis"\s*,\s*"zip"\s*\]/.test(source)) {
  console.log("win-zip: win.target 已包含 zip，跳过");
  process.exit(0);
}

const matched = source.match(pattern);
if (!matched) {
  throw new Error(
    `win-zip: 上游 win.target 锚点已变化，请更新 branding/patch-win-target.mjs -> [${relPath}]`,
  );
}

const patched = source.replace(pattern, (_all, head, _target, tail) => `${head}"nsis", "zip"${tail}`);
writeFileSync(filePath, patched);

console.log(`win-zip: 已追加 zip 目标 -> [${relPath}] win.target = ["nsis", "zip"]`);
