#!/usr/bin/env node
/**
 * 把 Windows 打包产物发布到本 fork 的 GitHub Release。
 *
 * 为什么不用 gh CLI / 第三方 action：
 * - 本机 self-hosted Windows runner 没装 gh，为发一个包去装 CLI 不划算；
 * - 第三方 release action 会引入额外供应链面。
 * 这里只用 Node 24 自带的 fetch 直连 REST API，零额外依赖。
 *
 * 环境变量：
 *   GITHUB_TOKEN       必填，workflow 注入的 github.token
 *   GITHUB_REPOSITORY  必填，owner/repo（Actions 默认注入）
 *   RELEASE_TAG        必填，如 win-1a2b3c4
 *   RELEASE_TITLE      可选
 *   RELEASE_NOTES      可选，Markdown 正文
 *   DIST_DIR           可选，默认 packages/desktop/dist
 *   ASSET_PATTERN      可选，默认 *.exe,*.zip,*.blockmap,latest.yml
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { basename, resolve } from "node:path";

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const tag = process.env.RELEASE_TAG;
const title = process.env.RELEASE_TITLE || tag;
const notes = process.env.RELEASE_NOTES || "";

if (!token) throw new Error("缺少 GITHUB_TOKEN");
if (!repo) throw new Error("缺少 GITHUB_REPOSITORY");
if (!tag) throw new Error("缺少 RELEASE_TAG");

const apiBase = "https://api.github.com";
const uploadBase = "https://uploads.github.com";
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "zcode-win-build",
};

async function api(method, path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, ok: response.ok, data: parsed, text };
}

// 1) 找到或创建 release
let release = (await api("GET", `/repos/${repo}/releases/tags/${tag}`)).data;

if (!release?.id) {
  const created = await api("POST", `/repos/${repo}/releases`, {
    tag_name: tag,
    name: title,
    body: notes,
    draft: false,
    prerelease: false,
  });
  if (!created.ok) {
    throw new Error(`创建 Release 失败 ${created.status}: ${created.text}`);
  }
  release = created.data;
  console.log(`已创建 Release ${tag} (id=${release.id})`);
} else {
  console.log(`复用已存在的 Release ${tag} (id=${release.id})`);
}

// 2) 收集产物
const distDir = resolve(process.env.DIST_DIR || "packages/desktop/dist");
if (!existsSync(distDir)) throw new Error(`产物目录不存在: ${distDir}`);

const wanted = (process.env.ASSET_PATTERN || "*.exe,*.zip,*.blockmap,latest.yml")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const assets = readdirSync(distDir)
  .filter((name) => wanted.some((pattern) => matches(name, pattern)))
  .map((name) => resolve(distDir, name))
  .filter((path) => statSync(path).isFile());

if (assets.length === 0) throw new Error(`在 ${distDir} 未找到可上传产物`);

function matches(name, pattern) {
  if (!pattern.includes("*")) return name === pattern;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

// 3) 逐个上传（同名资产先删再传，保证 --clobber 语义）
const existing = (await api("GET", `/repos/${repo}/releases/${release.id}/assets?per_page=100`))
  .data;
const existingByName = new Map((existing || []).map((asset) => [asset.name, asset.id]));

for (const assetPath of assets) {
  const name = basename(assetPath);
  const sizeMb = (statSync(assetPath).size / 1024 / 1024).toFixed(1);

  const oldId = existingByName.get(name);
  if (oldId) {
    const removed = await api("DELETE", `/repos/${repo}/releases/assets/${oldId}`);
    console.log(`  删除同名旧资产 ${name}: ${removed.ok ? "ok" : removed.status}`);
  }

  console.log(`上传 ${name} (${sizeMb} MiB)...`);
  const response = await fetch(
    `${uploadBase}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/octet-stream" },
      // 大安装包不整块读进内存，直接流式上传。
      body: Readable.toWeb(createReadStream(assetPath)),
      duplex: "half",
    },
  );

  if (!response.ok) {
    throw new Error(`上传 ${name} 失败 ${response.status}: ${await response.text()}`);
  }
  console.log(`  ✓ ${name}`);
}

console.log(`Release ${tag} 发布完成：https://github.com/${repo}/releases/tag/${tag}`);
