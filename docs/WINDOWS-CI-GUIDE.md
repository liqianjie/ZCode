# Windows 打包 CI 与 self-hosted runner 运维手册

本 fork 的 Windows 桌面安装包不走 GitHub 托管 runner，而是跑在**本机注册的 self-hosted runner** 上。
原因：Windows 打包要下载 Electron 41 运行时与 NSIS 资源、并需要 15–25G 工作区，
放在自有机器上可以长期复用 pnpm store 与 electron 缓存，也不消耗托管 runner 额度。

- 流水线定义：[`.github/workflows/zcode-win-build.yml`](../.github/workflows/zcode-win-build.yml)
- fork 侧补丁：`branding/apply.mjs`（品牌化）、`branding/patch-win-target.mjs`（追加 zip 目标 + ASCII 产物名）、
  `branding/publish-win-release.mjs`（发布 Release + 清理历史 Release）、
  `branding/win-autoinstall.ps1`（本机静默安装代理）

---

## 1. 架构与流程

```
schedule 每天 09:30（北京）              workflow_dispatch（手动）
        │                                        │
        └────────────────┬───────────────────────┘
                         ▼
        self-hosted Windows runner（label: zcode-win）
                         │
                         ├─ 1. 解析上游 ref
                         ├─ 2. 该上游提交是否已发过 Release？（看 tag win-<sha>）
                         │        └─ 是 → 直接结束，不空跑一遍打包
                         ├─ 3. 检出上游 zai-org/ZCode
                         ├─ 4. 检出本 fork main 的 branding/ 补丁
                         ├─ 5. 应用千寻品牌化 → productName/appId/图标/Web 标题
                         ├─ 6. 追加 Windows zip 目标 + 产物名转 ASCII
                         ├─ 7. Node 24.14.0 + pnpm 10.33.2 → pnpm install
                         ├─ 8. pnpm build && pnpm bundle:desktop -- --os win --arch x64
                         ├─ 9. 上传产物 / 推 tag + 发 Release / 清理历史 Release
                         └─10. 投递到 G:\zcode-win-dist + 写 install-pending.json
                                        │
                                        ▼
                用户会话内的计划任务 ZCode-Qianxun-AutoInstall
                     （轮询待装标记 → 应用未运行 → 静默安装）
```

关键点：**打包源码来自上游 `zai-org/ZCode`，不是本 fork**。
fork 的 main 分支不合并上游、只承载 `branding/` 与 CI 定义，上游更新自动生效。
这与已有的 macOS 流水线 `zcode-autoupdate.yml` 保持同一套思路。

**为什么安装要多绕一层**：runner 以 `NETWORK SERVICE` 服务账户常驻（Session 0），
而 electron-builder 的 Windows 安装器是**按用户安装**（装到 `%LOCALAPPDATA%\Programs\千寻`）。
若由服务账户执行安装，包会被装进 `C:\Windows\ServiceProfiles\NetworkService\...`，
登录用户根本看不到。所以 workflow 只负责投递，真正的安装交给用户会话里的计划任务。
详见第 5 节。

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
  --runasservice --unattended --windowslogonaccount 'NT AUTHORITY\NETWORK SERVICE'
```

服务化后有几个必知差异（都已在 workflow 里处理）：

- **`bash` 解析不到**：机器级 `PATH` 里 Git 只暴露 `cmd` 目录，而 `bash.exe` 位于 `bin`，
  runner 程序也没有 Git 位置的兜底查找。workflow 已改用绝对路径的 shell 模板
  （`C:\PROGRA~1\Git\bin\bash.exe --noprofile --norc -eo pipefail {0}`）。
- **electron-builder 解压 `winCodeSign` 必失败**：服务账户没有创建符号链接的特权。
  必须预置共享缓存，见第 5 节。
- **electron-builder 缓存另起一份**：`%LOCALAPPDATA%` 落在
  `C:\Windows\ServiceProfiles\NetworkService\AppData\Local`。
  pnpm store 不受影响 —— 它按**项目所在盘符**定位（`G:\.pnpm-store\v10`），不跟用户走，
  服务账户照样复用同一份。
- 不继承你用户目录下的 `.npmrc` / 代理 / 用户证书。
- `G:\` 已授予 `Authenticated Users:(M)`，默认服务账户有写权限，无需额外授权。

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

### 4.1 自动：每天 09:30

`schedule: 30 1 * * *`（01:30 UTC = 北京时间 09:30，与 macOS 流水线同一时刻）。

- 上游 main 没有新提交、或该提交已发过 Release（tag `win-<short_sha>` 存在）→ **几秒内跳过**，不空跑一遍打包。
- 有新提交 → 出 **production 正式包** → 发 Release → 投递到本机安装区。
- 机器没开机时 job 会在 GitHub 侧排队（队列上限 24 小时），**开机后 runner 一上线立刻开跑**，不会丢任务。

> 去重标记用的是 Release tag `win-<short_sha>`：发布时会把上游提交对象连同 tag 一起推到 fork，
> 所以 tag 精确指向被构建的那个上游 commit（而不是 fork main 的 HEAD）。
> 清理历史 Release 时**只删 Release、保留 tag**，否则同一个提交会被反复重打包。

> 已知限制：GitHub 会在**仓库连续 60 天无活动**时自动停用定时 workflow。
> 定时构建本身会产出 Release（属于仓库活动），所以只要上游还在更新就不会触发；
> 若哪天发现定时不再触发，去 Actions 页面把 `zcode-win-build` 重新 Enable 即可。

### 4.2 手动：workflow_dispatch

1. 打开 <https://github.com/liqianjie/ZCode/actions/workflows/zcode-win-build.yml>
2. 点 **Run workflow**，按需填参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `force_build` | `false` | 即使该上游提交已发过 Release 也强制重新构建 |
| `upstream_ref` | 空 | 留空 = `zai-org/ZCode` main 最新提交；可填分支 / tag / commit sha |
| `backend_env` | `production` | `production` → 无后缀（连生产后端）；`test` → 带 `_TEST`（连测试后端） |
| `desktop_zip` | `true` | 是否额外产出免安装 zip |
| `publish_release` | `true` | 构建成功后推 tag + 创建/更新 Release |

3. 产物在 **Actions → 该次 run → Artifacts** 里下载（保留 14 天），
   同时也会发到 Releases 并投递到本机安装区。

### 4.3 产物命名规则

由 `branding/patch-win-target.mjs` 覆写上游的 `win.artifactName`，**固定为纯 ASCII**：

```
Qianxun-${version}-win-x64${_TEST}.${ext}
```

| 场景 | 安装程序 | 免安装包 |
| --- | --- | --- |
| `backend_env=production` | `Qianxun-3.14.3-win-x64.exe` | `Qianxun-3.14.3-win-x64.zip` |
| `backend_env=test` | `Qianxun-3.14.3-win-x64_TEST.exe` | `Qianxun-3.14.3-win-x64_TEST.zip` |

两个约定：

- `_TEST` 标记的是**后端环境**，不是身份；安装后的应用名始终是「千寻」。
- 文件名必须是 ASCII。上游用 `${productName}` 拼名字，而 fork 的 productName 是「千寻」，
  GitHub Release 会**剥离资产名里的非 ASCII 字符**（`千寻-3.14.3-win-x64.exe` → `-3.14.3-win-x64.exe`），
  导致 `latest.yml` 里的 url 与实际上传的资产名失配。
  workflow 的校验步骤会显式拦截含非 ASCII 的产物名，避免悄悄发出去。

### 4.4 Release 保留策略

每有一个新上游提交就发一个 Release（约 350 MB 产物），不清理会无限堆积。
发布脚本默认只保留**最近 3 个** `win-*` Release，更旧的删掉 Release 记录与资产
（可用 `KEEP_WIN_RELEASES` 环境变量调整）。`auto-*`（macOS 流水线的）一概不碰。

---

## 5. 自动安装到本机

workflow 的最后一步把安装包投递到 `G:\zcode-win-dist\`，并写一份待装标记：

```
G:\zcode-win-dist\
├── Qianxun-3.14.3-win-x64.exe      # NSIS 安装程序
├── Qianxun-3.14.3-win-x64.zip      # 免安装绿色包
├── latest.yml                      # electron-updater 清单
├── install-pending.json            # 待装标记（投递完成的唯一信号）
├── install-failed.json             # 连续失败 3 次后的归档（如有）
├── win-autoinstall.ps1             # 安装代理（脚本本体也在仓库 branding/ 下）
└── autoinstall.log                 # 代理日志
```

真正的安装由计划任务 **`ZCode-Qianxun-AutoInstall`** 在**你的用户会话**里完成：

| 项 | 值 |
| --- | --- |
| 触发器 | 登录时（延迟 1 分钟） |
| 运行身份 | 当前用户 `qianjieli`，`LogonType = Interactive`（不需要密码） |
| 动作 | `powershell.exe -File G:\zcode-win-dist\win-autoinstall.ps1`（常驻） |
| 行为 | 每 60 秒检查待装标记 → 确认应用未运行 → `安装程序.exe /S` → 校验版本 → 删除标记 |

**安装目录在哪（很容易想当然，实测纠偏）**

```powershell
# 错误假设：%LOCALAPPDATA%\Programs\千寻\千寻.exe
# 实际路径：
%LOCALAPPDATA%\Programs\@zcodedesktop\千寻.exe
```

electron-builder 的 per-user 安装目录名取自**清洗后的 `package.json` name**
（上游 `@zcode/desktop` → `@zcodedesktop`），只有目录内的**可执行文件名**才由
`productName` 决定（所以是 `千寻.exe`，卸载器是 `Uninstall 千寻.exe`）。

早先代理硬编码了错误路径，导致**安装明明成功（退出码 0）却判定失败、反复重试**。
现在改为动态探测：先读注册表卸载项（`DisplayName = "千寻 <version>"`；
注意 `InstallLocation` 实测为空，真正带路径的是 `UninstallString`）反推目录，
再兜底扫描 `%LOCALAPPDATA%\Programs\*\千寻.exe`。

代理还用全局命名互斥量 `Global\ZCodeQianxunAutoInstall` 做了**单实例保护** ——
「登录触发」与「手工 `Start-ScheduledTask`」可能同时拉起两个实例，并发静默安装会互相覆盖。

日常查看与操作：

```powershell
Get-ScheduledTask -TaskName "ZCode-Qianxun-AutoInstall" | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName "ZCode-Qianxun-AutoInstall" | Select-Object LastRunTime, LastTaskResult
Start-ScheduledTask -TaskName "ZCode-Qianxun-AutoInstall"                 # 手工拉起代理
Get-Content "G:\zcode-win-dist\autoinstall.log" -Encoding UTF8 -Tail 30   # 看代理都做了什么
```

行为约定：

- **应用运行中不覆盖安装**。NSIS 覆盖运行中的程序会失败或留下半装状态，
  代理会等到应用退出后再装 —— 也就是说你开着千寻时，新版本要等你关掉它才装上。
- **装完不自动拉起应用**，避免打断你手头的事；自己点快捷方式即可用上新版本。
- **同一版本只装一次**：代理会比对已安装 `千寻.exe` 的 `ProductVersion`（路径动态探测，见上）。
- **失败最多重试 3 次**，仍失败就把标记归档为 `install-failed.json`，等下一次投递，避免死循环。

### 时间线（每天 09:30 触发，构建约 11 分钟）

| 你的动作 | 结果 |
| --- | --- |
| 09:30 前已开机（runner 在线） | 09:30 触发 → 约 09:41 装好 |
| 09:00 才开机 | runner 09:00 上线、job 尚未触发；09:30 触发 → 约 09:41 装好 |
| 10:30 才开机 | job 在 GitHub 侧排队等着；开机 → 立刻开跑 → 约 11 分钟后装好 |

> 代理是**常驻**的（每 60 秒轮询一次，几乎不占资源），所以你几点开机都不会错过投递 ——
> 这也是为什么它不做「只轮询 N 分钟就退出」的优化。

---

## 6. 常见问题

**产物里少了 zip**
`patch-win-target.mjs` 会用锚点校验上游的 `win.target`。上游一旦改动该处，
脚本会直接抛错中断构建（而不是静默产出一个残缺包）。按报错信息更新锚点即可。

**`production` 构建出来的却是 ZCode 身份**
品牌化只改写 preview 身份。workflow 在 `backend_env=production` 时会自动设
`ZCODE_PREVIEW_IDENTITY=1` 来保住千寻身份 —— 手动本地构建时别忘了这个变量。

**NSIS / Electron 下载超时**
workflow 已设 `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR` 走 npmmirror；
上游 `bundle.mjs` 自身还有一轮 404 回退镜像与重试（`nsis-resources-`、`connection reset` 等信号）。

**打包步骤失败：`Cannot create symbolic link`（服务账户缺特权）**

现象：`打包 Windows 桌面安装包` 步骤在跑了约 10 分钟后失败，日志里是

```
⨯ cannot execute  cause=exit status 2
ERROR: Cannot create symbolic link : 客户端没有所需的特权 :
  ...\electron-builder\Cache\winCodeSign\<随机数>\darwin\10.12\lib\libcrypto.dylib
command='...\7za.exe' x -snld -bd '...\winCodeSign-2.6.0.7z' '-o...'
```

原因：`winCodeSign-2.6.0.7z` 里打包了 **macOS 的 `.dylib` 符号链接**。
在 Windows 上创建符号链接需要 `SeCreateSymbolicLinkPrivilege`，该特权默认只授予管理员令牌；
runner 以 `NETWORK SERVICE` 常驻时没有它，于是 7-Zip 解压失败并重试 4 次后整体失败。

这也解释了「本地/用户会话下能打包、服务账户下必失败」的差异 —— 前者是管理员令牌。

**解决方式：预置共享缓存，命中后完全跳过「下载 + 解压」分支。**

workflow 里已设 `ELECTRON_BUILDER_CACHE: G:/electron-builder-cache`，
该目录需预先用**管理员**会话准备好（管理员才能解压出这些符号链接）：

```powershell
# 1) 复制一份已有缓存（本地 %LOCALAPPDATA% 下通常已经有一份可用的）
$src = "$env:LOCALAPPDATA\electron-builder\Cache"
$dst = "G:\electron-builder-cache"
robocopy $src $dst /E /COPY:DAT | Out-Null

# 2) 把 darwin 下两个符号链接换成真实文件副本（消除特权依赖）
$lib = "$dst\winCodeSign\winCodeSign-2.6.0\darwin\10.12\lib"
Remove-Item "$lib\libcrypto.dylib","$lib\libssl.dylib" -Force -ErrorAction SilentlyContinue
Copy-Item "$lib\libcrypto.1.0.0.dylib" "$lib\libcrypto.dylib"
Copy-Item "$lib\libssl.1.0.0.dylib"   "$lib\libssl.dylib"

# 3) 授权服务账户（S-1-5-20 = NETWORK SERVICE）
icacls $dst /grant "*S-1-5-20:(OI)(CI)F" /T
```

验证（应为 0）：

```bash
find /g/electron-builder-cache -type l | wc -l
```

流水线里加了一步「预检 electron-builder 缓存」，缓存缺失或残留符号链接时会**立即**失败，
不再白跑十几分钟到解压阶段才报错。若将来缓存被删，按上面三步重建即可。

> 若改用你自己的账户跑 runner 服务（需要 Windows 密码），这个坑不会出现，
> 但 `ELECTRON_BUILDER_CACHE` 仍然有效，两侧共用同一份缓存。

**磁盘被吃满**
`actions/checkout` 默认执行 `git clean -ffdx`，每次会清掉 `src/` 下的 `node_modules` 与 `dist`，
所以工作区不会无限增长；pnpm store 在仓库外，长期复用。真正占空间的是 `_work` 与 pnpm store。

**想更快：保留 node_modules**
把上游 checkout 步骤加 `clean: false` 可跳过清理，重复构建时省下依赖安装时间。
代价是上游改了 `pnpm-lock.yaml` 时可能残留旧依赖 —— 排查构建异常时建议改回 `clean: true`。

**定时构建每次都「跳过构建」**
先看 run 日志前几步。`检查该上游提交是否已构建过` 命中 tag `win-<short_sha>` 时会置 `build=false`，
这是预期行为（上游没有新提交）。若上游确实有新提交却仍跳过，检查该 tag 是否被人为删除 ——
tag 就是去重标记，删掉就会重打一次。真要强制重建，手动触发时勾上 `force_build`。

**包投递了但没自动安装**
按顺序排查：
1. 计划任务是否在跑：`Get-ScheduledTask -TaskName "ZCode-Qianxun-AutoInstall"` 应为 `Running`；
   不在就跑 `Start-ScheduledTask -TaskName "ZCode-Qianxun-AutoInstall"`。
2. 千寻是否正开着：代理**不会**在应用运行时覆盖安装，关掉应用后它会自己继续。
3. 看 `G:\zcode-win-dist\autoinstall.log`，代理每一步都有日志。
4. 若目录里出现 `install-failed.json`，说明连续装失败 3 次，看日志里的退出码与版本校验结果。

**Release 资产名变成 `-3.14.3-win-x64.exe`（丢了前缀）**
这是 GitHub 剥离中文资产名的结果，说明 `patch-win-target.mjs` 的 ASCII 改名没生效。
该脚本用锚点校验上游的 `win.artifactName`，上游一改就会抛错中断构建；
如果构建是绿的却仍出现这种名字，去看 `追加 zip 目标与 ASCII 产物名` 这一步是否被跳过。

**装了新版本但界面还是旧的**
先确认实际版本：`%LOCALAPPDATA%\Programs\千寻\千寻.exe` 右键 → 属性 → 详细信息 → 产品版本。
若版本已是新的，多半还有旧实例在跑（托盘没退干净），完全退出后重新打开。

**发布 Release 失败：`fatal: detected dubious ownership in repository`**
```
'G:/actions-runner-zcode-win/_work/ZCode/ZCode/src' is owned by:
    QIANJIELI-PC2/qianjieli
but the current user is:
    NT AUTHORITY/NETWORK SERVICE
```
runner 以 `NETWORK SERVICE` 常驻，而工作区目录的属主是交互用户，git 2.35.2+ 会判定为
dubious ownership 并直接 `exit 128`。`actions/checkout` 只在自己的临时 `HOME` 里放行
`safe.directory`，后续自定义步骤不受益。

发布步骤已注入 `GIT_CONFIG_COUNT=1` / `GIT_CONFIG_KEY_0=safe.directory` /
`GIT_CONFIG_VALUE_0=*`，只对本次步骤生效、不写任何持久配置。
`apps/zcode-cli build` 里那句 `failed to get git status for dirty hash` 是同一个原因，
只是它以 warning 形式降级，不影响产物。

**投递与发布是解耦的**
`投递到本机安装区` 排在 `发布 Release` **之前**，守卫是
`!cancelled() && build == 'true' && steps.verify.conclusion == 'success'`。
所以发布环节出问题（API 限流、网络抖动、token 权限）时，
**本机照样能拿到并装上包**，只是 Releases 页面没有对应资产。
反过来如果投递失败，发布仍会继续 —— 看 run 的步骤结论区分是哪一环。

**Release 建出来了但是空的（没有任何资产）**
去重标记 `win-<short>` 必须在创建 Release **之前**推上去（否则 Release 的 tag 会被
GitHub 建在 fork main 的 HEAD，指不到本次构建的上游提交），于是存在一个窗口：
tag 推成功、但 Release 创建或资产上传失败。这时 tag 已存在，下一次定时任务会误判
「已构建过」直接跳过，该上游提交就永远发不出包。

workflow 已加 `发布失败时回滚去重标记` 步骤收口：只在本次确实新建了 tag
（`steps.check.outputs.exists == 'false'`）时回滚，发布会失败则该提交下次重试。
若看到历史上遗留的空 Release，删掉它的 tag 再手动触发一次即可。

**⚠️ 安全红线**
本仓库是 public。self-hosted runner **绝不可**对 `pull_request` / `pull_request_target` 开放，
否则任何 fork 的 PR 都能在打包机上执行任意代码（读写本机文件、借 runner 身份访问内网）。
本流水线只保留 `schedule` 与 `workflow_dispatch`，不要为了图方便加 PR 触发。

---

## 7. 更新与卸载

```powershell
# runner 会自动更新自身；如需手动更新，重跑下载解压流程覆盖即可

# 停止并卸载服务（先停服务再注销 runner）
cd G:\actions-runner-zcode-win
.\config.cmd remove --token <新令牌>

# 也可以直接走服务管理
Stop-Service 'actions.runner.liqianjie-ZCode.zcode-win-01'
```

## 8. 本地不开 CI 时的手动打包

```bash
cd <ZCode 检出目录>
pnpm install --frozen-lockfile
# 要额外产出免安装 zip、并把产物名转成 ASCII，先跑一遍 Windows 增量补丁
node branding/patch-win-target.mjs        # 只想要 zip 不要 ASCII 改名：WIN_PATCH_ADD_ZIP=0
# production 后端务必带上 ZCODE_PREVIEW_IDENTITY=1，否则产物会退回 ZCode 身份
ZCODE_SKIP_REMOTE_ASSETS=1 ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1 \
  pnpm bundle:desktop -- --os win --arch x64
# 产物在 packages/desktop/dist/
```
