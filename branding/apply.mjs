#!/usr/bin/env node
/**
 * 千寻（qianxun.io）品牌化补丁 —— 在 workflow 检出上游源码后执行。
 *
 * 作用：
 * 1. 改写 Preview 产品身份（productName / appId / linux 名称）→ 千寻
 * 2. 覆盖 macOS 安装图标、应用内与 Web logo
 * 3. 修改 Web 页面标题
 *
 * 设计约束：
 * - 只用稳定的字符串锚点做替换，锚点在上游消失时立即报错（构建失败，提示维护），
 *   绝不静默跳过，避免产出半品牌化的包。
 * - 不改 runtimeApplicationName（数据目录沿用 ZCode Preview，无缝升级）。
 */
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const brandingDir = dirname(fileURLToPath(import.meta.url));
// 仓库根 = 执行时的工作目录（workflow 中从工作区根运行 node .branding-src/branding/apply.mjs）
const root = process.cwd();
const product = JSON.parse(readFileSync(join(brandingDir, "product.json"), "utf8"));

function patchFile(relPath, replacements) {
  const filePath = join(root, relPath);
  let source = readFileSync(filePath, "utf8");
  for (const [from, to] of replacements) {
    if (!source.includes(from)) {
      throw new Error(`branding: 锚点在上游已变化，请更新补丁 -> [${relPath}] ${from}`);
    }
    source = source.split(from).join(to);
  }
  writeFileSync(filePath, source);
  console.log(`branding: 已补丁 ${relPath}`);
}

// 1) 产品身份：Preview flavor → 千寻（appId 独立，可与官方版并存）
patchFile("packages/desktop/scripts/desktop-product-identity.mjs", [
  ['appId: "dev.zcode.app.preview"', `appId: "${product.appId}"`],
  ['productName: "ZCode Preview"', `productName: "${product.productName}"`],
  ['linuxExecutableName: "zcode-preview"', `linuxExecutableName: "${product.linuxExecutableName}"`],
  ['linuxPackageName: "zcode-preview"', `linuxPackageName: "${product.linuxPackageName}"`],
]);

// 2) 图标资产
const assets = join(brandingDir, "assets");
const buildDir = join(root, "packages/desktop/build");
cpSync(join(assets, "icon.icns"), join(buildDir, "icon.icns"));
cpSync(join(assets, "icon.png"), join(buildDir, "icon.png"));
cpSync(join(assets, "icon_windows.png"), join(buildDir, "icon_windows.png"));
cpSync(join(assets, "icon.png"), join(buildDir, "icon_installer.png"));
cpSync(join(assets, "icon.icns"), join(buildDir, "icon_installer.icns"));
console.log("branding: 已覆盖 desktop build 图标");

// 3) 应用内 / Web logo（同尺寸覆盖，不引入新文件）
const logoSrc = join(assets, "logo");
for (const target of [
  join(root, "public/logo/icons"),
  join(buildDir, "icons"),
]) {
  if (!existsSync(target)) continue;
  for (const file of readdirSync(logoSrc)) {
    const dest = join(target, file);
    if (existsSync(dest)) cpSync(join(logoSrc, file), dest);
  }
  console.log(`branding: 已覆盖 logo -> ${target}`);
}

// 4) Web 标题
patchFile("packages/web/index.html", [
  ["<title>ZCode</title>", `<title>${product.productName}</title>`],
]);

console.log(`branding: 完成 -> ${product.productName} (${product.appId})`);
