# Windows 打包 CI 与 self-hosted runner 运维手册

本 fork 的 Windows 桌面安装包不走 GitHub 托管 runner，而是跑在**本机注册的 self-hosted runner** 上。
原因：Windows 打包要下载 Electron 41 运行时与 NSIS 资源、并需要 15–25G 工作区，
放在自有机器上可以长期复用 pnpm store 与 electron 缓存，也不消耗托管 runner 额度。

- 流水线定义：[`.github/workflows/zcode-win-build.yml`](../.github/workflows/zcode-win-build.yml)
- fork 侧补丁：`branding/apply.mjs`（品牌化）、`branding/patch-win-target.mjs`（追加 zip 目标）、
  `branding/publish-win-release.mjs`（发布 Release）

---

## 1. 架构与流程

```
workflow_dispatch（手动触发）
        │
        ▼
self-hosted Windows runner（label: zcode-win）
        │
        ├─ 1. 检出上游 zai-org/ZCode（指定 ref，默认 main 最新提交）
        ├─ 2. 检出本 fork main 的 branding/ 补丁
        ├─ 3. 应用千寻品牌化 → productName/appId/图标/Web 标题
        ├─ 4. 追加 Windows zip 目标 → win.target = ["nsis", "zip"]
        ├─ 5. Node 24.14.0 + pnpm 10.33.2
        ├─ 6. pnpm install --frozen-lockfile
        ├─ 7. pnpm bundle:desktop -- --os win --arch x64
        └─ 8. 上传产物（可选：创建 GitHub Release）
```

关键点：**打包源码来自上游 `zai-org/ZCode`，不是本 fork**。
fork 的 main 分支不合并上游、只承载 `branding/` 与 CI 定义，上游更新自动生效。
这与已有的 macOS 流水线 `zcode-autoupdate.yml` 保持同一套思路。

---

## 2. 前置条件（本机已核对）

| 项目 | 现状 | 是否阻塞 |
| --- | --- | --- |
| Windows | 11 (build 22631)，24 逻辑核 | — |
| 长路径支持 | `LongPathsEnabled = 1` | 必须，已满足 |
| 磁盘 | C: 263G 空闲 / G: 174G 空闲 | 建议留 ≥ 30G |
| Git | `C:\Program Files\Git`（2.54），已在系统 PATH | 必须，已满足 |
| MSVC | VS2019 BuildTools 14.29 + Win SDK 10.0.19041 / 26100 | 满足 |
| NSIS | `C:\Program Files (x86)\NSIS`（用户 PATH） | 非必须（electron-builder 自带） |
| 管理员权限 | 有 | 注册服务需要 |

> 打包阶段 `npmRebuild: false`，node-pty 复用自带 win32-x64 预编译产物，
> 所以 MSVC 属于"备用"而非硬依赖；装上是为了 `prepare:native-search` 等步骤兜底。

---

## 3. 注册 self-hosted runner

### 3.1 取注册令牌

打开 <https://github.com/liqianjie/ZCode/settings/actions/runners/new>，
页面里的 `./config.cmd --url ... --token XXXX` 中那串 `XXXX` 就是注册令牌。
**令牌 1 小时过期**，过期后重新打开该页面取新的即可。

runner 安装包已下载并解压到 `G:\actions-runner-zcode-win`（v2.338.0，SHA256 已核对官方校验值）。

> 版本说明：v2.338.0 的 Windows 包**没有 `svc.cmd`**，只有 `config.cmd` / `run.cmd`。
> 服务安装必须通过 `config.cmd --runasservice`，不要再照抄老教程里的 `.\svc.cmd install`。

### 3.2 配置 —— 方式 A：以当前用户账户运行（推荐）

与 macOS runner 行为一致，复用已有的 pnpm / electron 缓存、代理与证书配置。
需要输入 Windows 登录密码（会存进 Windows LSA，改密码后需重装服务）。

```powershell
cd G:\actions-runner-zcode-win
.\config.cmd --url https://github.com/liqianjie/ZCode --token <TOKEN> `
  --name zcode-win-01 --labels zcode-win --work _work --replace `
  --runasservice --windowslogonaccount "QIANJIELI-PC2\qianjieli"
```

密码用交互方式输入更安全：去掉 `--windowslogonpassword`，`config.cmd` 会提示你输入。

### 3.3 配置 —— 方式 B：以默认服务账户运行（免密码）

```powershell
cd G:\actions-runner-zcode-win
.\config.cmd --url https://github.com/liqianjie/ZCode --token <TOKEN> `
  --name zcode-win-01 --labels zcode-win --work _work --replace `
  --runasservice --unattended
```

代价：服务账户有自己的用户配置文件，pnpm store 与 electron 缓存会和你的登录账户**各存一份**
（多占约 8–15G），且不会继承你用户目录下的 `.npmrc` / 代理 / 用户证书。
`G:\` 已授予 `Authenticated Users:(M)`，默认服务账户有写权限，无需额外授权。

### 3.4 验证注册结果

```powershell
# runner 是否在线
cd G:\actions-runner-zcode-win
.\run.cmd --check
# 或直接看 GitHub 页面：Settings -> Actions -> Runners
```

服务状态与实际运行账户：

```powershell
Get-Service 'actions.runner.*' | Format-List Name, Status, StartType
Get-CimInstance Win32_Service | Where-Object { $_.Name -like 'actions.runner*' } |
  Format-List Name, StartName, State, PathName
```

必要时应能看到 `runs-on` 匹配的 label：`self-hosted`、`windows`、`x64`、`zcode-win`。

---

## 4. 跑流水线

1. 打开 <https://github.com/liqianjie/ZCode/actions/workflows/zcode-win-build.yml>
2. 点 **Run workflow**，按需填参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `upstream_ref` | 空 | 留空 = `zai-org/ZCode` main 最新提交；可填分支/tag/commit sha |
| `backend_env` | `test` | `test` → 千寻 + `_TEST` 后缀；`production` → 千寻 + 无后缀（连生产后端） |
| `desktop_zip` | `true` | 是否额外产出免安装 zip |
| `publish_release` | `false` | 构建成功后创建/更新 Release（tag: `win-<short_sha>`） |

3. 产物在 **Actions → 该次 run → Artifacts** 里下载（保留 14 天）。

### 产物命名规则

由 `packages/desktop/electron-builder.config.js` 的 `buildDesktopArtifactName` 决定：

```
${productName}-${version}-win-x64${_TEST}.{ext}
```

| 场景 | 安装程序 | 免安装包 |
| --- | --- | --- |
| `backend_env=test`（默认） | `千寻-3.14.3-win-x64_TEST.exe` | `千寻-3.14.3-win-x64_TEST.zip` |
| `backend_env=production` | `千寻-3.14.3-win-x64.exe` | `千寻-3.14.3-win-x64.zip` |

`_TEST` 标记的是**后端环境**，不是身份；身份始终是「千寻」。
两个环境产物文件名不同，便于人工验收时区分。

---

## 5. 常见问题

**产物里少了 zip**
`patch-win-target.mjs` 会用锚点校验上游的 `win.target`。上游一旦改动该处，
脚本会直接抛错中断构建（而不是静默产出一个残缺包）。按报错信息更新锚点即可。

**`production` 构建出来的却是 ZCode 身份**
品牌化只改写 preview 身份。workflow 在 `backend_env=production` 时会自动设
`ZCODE_PREVIEW_IDENTITY=1` 来保住千寻身份 —— 手动本地构建时别忘了这个变量。

**NSIS / Electron 下载超时**
workflow 已设 `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR` 走 npmmirror；
上游 `bundle.mjs` 自身还有一轮 404 回退镜像与重试（`nsis-resources-`、`connection reset` 等信号）。

**磁盘被吃满**
`actions/checkout` 默认执行 `git clean -ffdx`，每次会清掉 `src/` 下的 `node_modules` 与 `dist`，
所以工作区不会无限增长；pnpm store 在仓库外，长期复用。真正占空间的是 `_work` 与 pnpm store。

**想更快：保留 node_modules**
把上游 checkout 步骤加 `clean: false` 可跳过清理，重复构建时省下依赖安装时间。
代价是上游改了 `pnpm-lock.yaml` 时可能残留旧依赖 —— 排查构建异常时建议改回 `clean: true`。

**⚠️ 安全红线**
本仓库是 public。self-hosted runner **绝不可**对 `pull_request` / `pull_request_target` 开放，
否则任何 fork 的 PR 都能在打包机上执行任意代码（读写本机文件、借 runner 身份访问内网）。
本流水线只保留 `workflow_dispatch`，不要为了图方便加 PR 触发。

---

## 6. 更新与卸载

```powershell
# runner 会自动更新自身；如需手动更新，重跑下载解压流程覆盖即可

# 停止并卸载服务（先停服务再注销 runner）
cd G:\actions-runner-zcode-win
.\config.cmd remove --token <新令牌>

# 也可以直接走服务管理
Stop-Service 'actions.runner.liqianjie-ZCode.zcode-win-01'
```

## 7. 本地不开 CI 时的手动打包

```bash
cd <ZCode 检出目录>
pnpm install --frozen-lockfile
ZCODE_SKIP_REMOTE_ASSETS=1 pnpm bundle:desktop -- --os win --arch x64
# 产物在 packages/desktop/dist/（NSIS 默认只有一个 .exe；要 zip 先跑 branding/patch-win-target.mjs）
```
