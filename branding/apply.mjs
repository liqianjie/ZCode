#!/usr/bin/env node
/**
 * 千寻（qianxun.io）品牌化补丁 v2 —— 在 workflow 检出上游源码后执行。
 *
 * 覆盖范围：
 * 1. 产品身份（productName / appId / linux 名称）
 * 2. 安装图标全家桶（icns / png / DMG 背景）
 * 3. 应用内 UI 品牌资产：app logo（新增 qianxun-logo.svg）、装饰水印 Z.svg、favicon
 *    —— Z.ai 登录入口的 provider 图标（logo-zai.svg）保留原样
 * 4. 用户可见文案：i18n 两种语言、登录页 brand、macOS 菜单/托盘（约 200 处）
 *
 * 设计约束：
 * - 只替换「显示字符串」：双引号内含空格或 CJK 的字符串 + 精确值 "ZCode"/"ZCode Preview"；
 *   i18n key、类型名、import 标识符、协议名（zcode-media）、路径（~/.zcode）一概不动。
 * - 所有锚点替换失败即抛错（构建失败），绝不静默产出半品牌化产物。
 * - 不改 runtimeApplicationName（数据目录沿用 ZCode Preview，无缝升级）。
 */
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const brandingDir = dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
const product = JSON.parse(readFileSync(join(brandingDir, "product.json"), "utf8"));

function fail(message) {
  throw new Error(`branding: ${message}`);
}

function patchAnchors(relPath, replacements) {
  const filePath = join(root, relPath);
  let source = readFileSync(filePath, "utf8");
  for (const [from, to] of replacements) {
    if (!source.includes(from)) fail(`锚点在上游已变化，请更新补丁 -> [${relPath}] ${from}`);
    source = source.split(from).join(to);
  }
  writeFileSync(filePath, source);
  console.log(`branding: 已补丁 ${relPath}`);
}

/** 显示文案替换：仅动引号字符串（含空格或 CJK 的内容替换 ZCode；精确值直接替换） */
function rebrandDisplayText(relPath) {
  const filePath = join(root, relPath);
  let count = 0;
  const source = readFileSync(filePath, "utf8");
  const rebrand = (literal, quote) => {
    if (!literal.includes("ZCode")) return literal;
    const inner = literal.slice(1, -1);
    if (/[\u4e00-\u9fff]/.test(inner) || inner.includes(" ")) {
      count += inner.split("ZCode").length - 1;
      return `${quote}${inner.split("ZCode").join(product.productName)}${quote}`;
    }
    if (inner === "ZCode" || inner === "ZCode Preview") {
      count += 1;
      return `${quote}${product.productName}${quote}`;
    }
    return literal;
  };
  const next = source.replace(
    /("[^"\n]*"|'[^'\n]*')/g,
    (m) => (m.startsWith('"') ? rebrand(m, '"') : rebrand(m, "'")),
  );
  if (count === 0) fail(`文案文件未命中任何替换 -> ${relPath}`);
  writeFileSync(filePath, next);
  console.log(`branding: 文案已替换 ${relPath}（${count} 处）`);
}

// ---------- 1) 产品身份 ----------
patchAnchors("packages/desktop/scripts/desktop-product-identity.mjs", [
  ['appId: "dev.zcode.app.preview"', `appId: "${product.appId}"`],
  ['productName: "ZCode Preview"', `productName: "${product.productName}"`],
  ['linuxExecutableName: "zcode-preview"', `linuxExecutableName: "${product.linuxExecutableName}"`],
  ['linuxPackageName: "zcode-preview"', `linuxPackageName: "${product.linuxPackageName}"`],
]);

// ---------- 2) 用户可见文案 ----------
const TEXT_FILES = [
  "packages/ui/src/i18n/locales/zh-CN.ts",
  "packages/ui/src/i18n/locales/en-US.ts",
  "packages/web/src/auth/webAuthLocale.ts",
  "packages/shared/src/desktopMenu.ts",
  "packages/desktop/src/renderer/cuaPermissionPanelMessages.ts",
  "packages/desktop/src/host/browserControlMainBridge.ts",
];
for (const file of TEXT_FILES) rebrandDisplayText(file);
patchAnchors("packages/web/index.html", [
  ["<title>ZCode</title>", `<title>${product.productName}</title>`],
]);

// ---------- 3) 安装图标与 DMG 背景 ----------
const assets = join(brandingDir, "assets");
const buildDir = join(root, "packages/desktop/build");
cpSync(join(assets, "icon.icns"), join(buildDir, "icon.icns"));
cpSync(join(assets, "icon.png"), join(buildDir, "icon.png"));
cpSync(join(assets, "icon_windows.png"), join(buildDir, "icon_windows.png"));
cpSync(join(assets, "icon.png"), join(buildDir, "icon_installer.png"));
cpSync(join(assets, "icon.icns"), join(buildDir, "icon_installer.icns"));
cpSync(join(assets, "dmg_background.png"), join(buildDir, "dmg_background.png"));
cpSync(join(assets, "dmg_background@2x.png"), join(buildDir, "dmg_background@2x.png"));
console.log("branding: 已覆盖 desktop build 图标与 DMG 背景");

// ---------- 4) 应用内 logo 与 favicon ----------
cpSync(join(assets, "qianxun-logo.svg"), join(root, "packages/ui/src/assets/qianxun-logo.svg"));
cpSync(join(assets, "Z.svg"), join(root, "packages/ui/src/assets/Z.svg"));
cpSync(join(assets, "favicon.ico"), join(root, "packages/web/public/favicon.ico"));
const publicIcons = join(root, "public/logo/icons");
if (existsSync(publicIcons)) cpSync(join(assets, "favicon.ico"), join(publicIcons, "icon.ico"));

// app logo 引用切到千寻标记（App 头部 / Windows 左上角 / 折叠侧栏）；
// oauthProviderIcon.tsx 的 logo-zai.svg 是 Z.ai 登录入口图标，保留不动。
for (const relPath of [
  "packages/ui/src/App.tsx",
  "packages/ui/src/WindowsTopLeftLogo.tsx",
  "packages/ui/src/WorkspaceSidebar/WorkspaceSidebarCollapsedRail.tsx",
]) {
  patchAnchors(relPath, [
    ['from "@/assets/provider-icons/logo-zai.svg"', 'from "@/assets/qianxun-logo.svg"'],
  ]);
}
patchAnchors("packages/ui/src/WindowsTopLeftLogo.tsx", [
  ['alt="ZCode"', `alt="${product.productName}"`],
]);

// ---------- 5) 应用内 / Web logo 尺寸图 ----------
const logoSrc = join(assets, "logo");
for (const target of [join(root, "public/logo/icons"), join(buildDir, "icons")]) {
  if (!existsSync(target)) continue;
  for (const file of readdirSync(logoSrc)) {
    const dest = join(target, file);
    if (existsSync(dest) && file !== "icon.icns") cpSync(join(logoSrc, file), dest);
  }
  console.log(`branding: 已覆盖 logo -> ${target}`);
}

console.log(`branding: 完成 -> ${product.productName} (${product.appId})`);
