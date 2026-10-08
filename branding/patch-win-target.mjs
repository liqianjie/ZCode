#!/usr/bin/env node
/**
 * Windows 打包增量补丁 —— 在 workflow 检出上游源码、应用品牌化之后执行。
 *
 * 干两件事：
 *
 * 1) 追加免安装 zip。
 *    上游 electron-builder 的 win.target 只有 ["nsis"]，只产出安装程序。
 *    fork 需要额外产出 win-unpacked 打成的绿色包，因此把 zip 追加进 target。
 *
 * 2) 把 Windows 产物文件名改成纯 ASCII。
 *    上游 artifactName 模板是 `${productName}-${version}-win-${arch}${suffix}.${ext}`，
 *    而 fork 的 productName 是「千寻」。GitHub Release 会剥离资产名里的非 ASCII 字符
 *    （千寻-3.14.3-win-x64.exe -> -3.14.3-win-x64.exe），既让 latest.yml 里的 url
 *    与实际上传的资产名失配，也让命令行 / 脚本引用变得别扭。
 *    这里固定成 `Qianxun-<version>-win-<arch>[_TEST].<ext>`，只影响文件名，
 *    安装目录与窗口标题仍取 productName（千寻），用户侧观感不变。
 *
 * 为什么单独一个文件而不是塞进 apply.mjs：macOS 流水线也在跑 apply.mjs，
 * 若把 win 的锚点校验耦合进去，上游一改 win 配置会连带把 mac 打包打挂。
 *
 * 设计约束与 apply.mjs 一致：只用稳定锚点做替换，锚点在上游消失时立即报错中断构建，
 * 绝不静默产出一个「少了 zip」或「文件名没转 ASCII」的包。
 *
 * 注意：Windows 上 checkout 出来的文件可能是 CRLF，因此所有匹配都用 \s 而非字面空格，
 * 且写回时不做整体 EOL 归一化，避免把整个文件重写成另一种换行风格产生噪音 diff。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const relPath = "packages/desktop/electron-builder.config.js";
const filePath = resolve(process.cwd(), relPath);
let source = readFileSync(filePath, "utf8");

function fail(message) {
  throw new Error(`win-patch: ${message}`);
}

// ---------- 1) win.target: 追加 zip ----------
// 已经含 zip 时直接跳过，保证补丁可重复执行。
// WIN_PATCH_ADD_ZIP=0 时只做 ASCII 改名（用于"不要免安装 zip"的手动构建）——
// 但 ASCII 改名任何情况下都必须做，否则 Release 资产名会被 GitHub 剥离成 -3.14.3-win-x64.exe。
const addZip = process.env.WIN_PATCH_ADD_ZIP !== "0";
const ZIP_DONE = /win:\s*\{[\s\S]*?target:\s*\[\s*"nsis"\s*,\s*"zip"\s*\]/;
if (!addZip) {
  console.log("win-patch: WIN_PATCH_ADD_ZIP=0，跳过 zip 目标追加（仍执行 ASCII 改名）");
} else if (ZIP_DONE.test(source)) {
  console.log("win-patch: win.target 已包含 zip，跳过");
} else {
  // 匹配 `win: { ... target: ["nsis"], ... }` 中的 target 数组，允许任意缩进与换行风格。
  const targetPattern = /(win:\s*\{[\s\S]*?target:\s*\[)(\s*"nsis"\s*)(\])/;
  if (!targetPattern.test(source)) {
    fail(`上游 win.target 锚点已变化，请更新本补丁 -> [${relPath}]`);
  }
  source = source.replace(targetPattern, (_all, head, _target, tail) => `${head}"nsis", "zip"${tail}`);
  console.log('win-patch: 已追加 zip 目标 -> win.target = ["nsis", "zip"]');
}

// ---------- 2) win.artifactName: 转 ASCII ----------
// 目标源码（写入 electron-builder.config.js 的字面量，模板占位符必须原样保留给 electron-builder 求值）：
//   artifactName: `Qianxun-${version}-win-${arch}${desktopArtifactEnvSuffix}.${ext}`,
// 其中 desktopArtifactEnvSuffix 是上游 config 顶层的 const（test 后端为 "_TEST"，production 为空）。
// `\${version}` / `\${arch}` / `\${ext}` 是留给 electron-builder 的模板宏（Node 侧必须不插值），
// `${desktopArtifactEnvSuffix}` 则由 Node 侧求值（test 后端 "_TEST"，production 为空串）。
const ASCII_ARTIFACT_NAME =
  "`Qianxun-\\${version}-win-\\${arch}${desktopArtifactEnvSuffix}.\\${ext}`";

if (/win:\s*\{[\s\S]*?artifactName:\s*`?Qianxun-/.test(source)) {
  console.log("win-patch: win.artifactName 已是 ASCII，跳过");
} else {
  const artifactPattern = /(win:\s*\{[\s\S]*?artifactName:\s*)buildDesktopArtifactName\(\s*"win"\s*\)/;
  if (!artifactPattern.test(source)) {
    fail(`上游 win.artifactName 锚点已变化，请更新本补丁 -> [${relPath}]`);
  }
  source = source.replace(artifactPattern, (_all, head) => `${head}${ASCII_ARTIFACT_NAME}`);
  console.log("win-patch: 已把 win.artifactName 改为 ASCII -> Qianxun-${version}-win-${arch}${suffix}.${ext}");
}

writeFileSync(filePath, source);
console.log(`win-patch: 完成 -> [${relPath}]`);
