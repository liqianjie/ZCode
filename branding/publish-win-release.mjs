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
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
//
// 上传必须带显式 Content-Length：GitHub 的 uploads 端点会拒收
// transfer-encoding: chunked 的请求，报 400 `{"message":"Bad Content-Length"}`。
// 而 Node 原生 fetch（undici）只要 body 是流、且 headers 里没有 Content-Length，
// 就会自动改走 chunked —— 这正是本步骤早先失败的根因。
// 所以这里显式写死 Content-Length；万一 undici 与流的协作还有意外，
// 退化为整块读入内存再传（fetch 会自己算长度，最大产物约 200 MiB，代价可接受）。
const existing = (await api("GET", `/repos/${repo}/releases/${release.id}/assets?per_page=100`))
  .data;
const existingByName = new Map((existing || []).map((asset) => [asset.name, asset.id]));

async function uploadAsset(assetPath, uploadUrl, name) {
  const baseHeaders = { ...headers, "Content-Type": "application/octet-stream" };
  const size = statSync(assetPath).size;

  const streamed = await fetch(uploadUrl, {
    method: "POST",
    headers: { ...baseHeaders, "Content-Length": String(size) },
    // 大安装包不整块读进内存，直接流式上传。
    body: Readable.toWeb(createReadStream(assetPath)),
    duplex: "half",
  });
  if (streamed.ok) return streamed;

  const reason = `${streamed.status}: ${await streamed.text()}`;
  console.warn(`  流式上传失败（${reason}），改用整块上传重试 ${name}`);
  return fetch(uploadUrl, {
    method: "POST",
    headers: baseHeaders,
    body: readFileSync(assetPath),
  });
}

for (const assetPath of assets) {
  const name = basename(assetPath);
  const sizeMb = (statSync(assetPath).size / 1024 / 1024).toFixed(1);

  const oldId = existingByName.get(name);
  if (oldId) {
    const removed = await api("DELETE", `/repos/${repo}/releases/assets/${oldId}`);
    console.log(`  删除同名旧资产 ${name}: ${removed.ok ? "ok" : removed.status}`);
  }

  console.log(`上传 ${name} (${sizeMb} MiB)...`);
  const response = await uploadAsset(
    assetPath,
    `${uploadBase}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    name,
  );

  if (!response.ok) {
    throw new Error(`上传 ${name} 失败 ${response.status}: ${await response.text()}`);
  }
  console.log(`  ✓ ${name}`);
}

console.log(`Release ${tag} 发布完成：https://github.com/${repo}/releases/tag/${tag}`);

// 4) 清理历史 Release —— 保持仓库体积可控。
//
// 定时流水线每有一个新上游提交就发一个新 Release（约 350 MB 产物），不清理会无限堆积。
// 这里只保留最近 KEEP_WIN_RELEASES 个（默认 3），更旧的删除 Release 记录与其中资产。
//
// 关键：只删 Release、绝不删 tag。`win-<short_sha>` tag 是 workflow 判定
// 「该上游提交是否已构建过」的唯一标记（见 zcode-win-build.yml 的 check 步骤），
// 删掉 tag 会让同一个提交被反复重打包。Release 删掉后 tag 仍然留着，正好符合需要。
//
// 只处理 win-* 前缀，绝不触碰 macOS 流水线的 auto-* Release。
const keep = Number(process.env.KEEP_WIN_RELEASES || 3);
const allReleases = (await api("GET", `/repos/${repo}/releases?per_page=100`)).data || [];
const winReleases = allReleases
  .filter((item) => typeof item.tag_name === "string" && item.tag_name.startsWith("win-"))
  .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

const stale = winReleases.slice(keep);
if (stale.length === 0) {
  console.log(`历史 Release 清理：win-* 共 ${winReleases.length} 个，无需清理（保留最近 ${keep} 个）`);
} else {
  console.log(`历史 Release 清理：win-* 共 ${winReleases.length} 个，删除最旧 ${stale.length} 个`);
  for (const item of stale) {
    const removed = await api("DELETE", `/repos/${repo}/releases/${item.id}`);
    console.log(`  ${removed.ok ? "✓" : `×(${removed.status})`} ${item.tag_name}（tag 保留，仍作为去重标记）`);
  }
}
