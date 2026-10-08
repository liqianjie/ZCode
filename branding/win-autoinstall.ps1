<#
  千寻（qianxun.io）Windows 自动安装代理

  背景：
    GitHub Actions 的 Windows 打包 runner 以 NETWORK SERVICE 服务账户常驻（Session 0），
    而 electron-builder 产出的 Windows 安装器是「按用户安装」。若由服务账户执行安装，
    包会被装进 C:\Windows\ServiceProfiles\NetworkService\...，登录用户根本看不到。
    因此 workflow 只负责「投递」，真正的安装由本脚本在用户会话里完成。

  安装目录（实测，别想当然）：
    electron-builder 的 per-user 安装目录名**不是 productName**，而是清洗后的
    package.json name。上游包名 @zcode/desktop -> %LOCALAPPDATA%\Programs\@zcodedesktop\
    目录内的可执行文件才由 productName 决定，即 千寻.exe。
    所以本脚本用「注册表卸载项反推 + 扫描 Programs\*」定位，绝不硬编码目录名。

  工作方式：
    - 由计划任务在你登录时启动，常驻运行（默认每 60 秒检查一次）。
    - workflow 打包成功后会往投递目录写 install-pending.json（待装标记），
      该文件是「投递已完成」的唯一信号，由 workflow 最后一步写入，避免读到半截产物。
    - 本脚本发现标记后：确认应用未运行 -> 执行 安装包.exe /S 静默安装 -> 校验版本
      -> 删除标记。安装成功不自动拉起应用，避免打断你手头的事。

  日志：<投递目录>\autoinstall.log
#>
[CmdletBinding()]
param(
  [string]$DeliveryDir = "G:\zcode-win-dist",
  [int]$PollSeconds = 60,
  [string]$AppProductName = "千寻",
  [int]$MaxAttempts = 3
)

$ErrorActionPreference = "Stop"

# 单实例保护：这个任务同时挂着「登录触发」和「手动启动」两条路径，
# 两个实例并发静默安装会互相覆盖。用全局命名互斥量把后来者直接挡掉。
$mutex = New-Object System.Threading.Mutex($false, "Global\ZCodeQianxunAutoInstall")
$ownsMutex = $false
try { $ownsMutex = $mutex.WaitOne(0) } catch { $ownsMutex = $true }
if (-not $ownsMutex) {
  Write-Host "已有安装代理实例在运行，本次退出"
  exit 0
}

$logFile = Join-Path $DeliveryDir "autoinstall.log"
$pendingFile = Join-Path $DeliveryDir "install-pending.json"

function Write-Log {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Write-Host $line
  try {
    # 日志超过 1 MiB 时轮转一次，避免长期常驻把日志写成大文件
    if ((Test-Path -LiteralPath $logFile) -and ((Get-Item -LiteralPath $logFile).Length -gt 1MB)) {
      Move-Item -LiteralPath $logFile -Destination "${logFile}.1" -Force
    }
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
  } catch {
    # 日志写失败不影响安装主流程
  }
}

# ---------- 定位「已安装的千寻」 ----------
#
# 这里曾经踩过一个很隐蔽的坑：早先直接硬编码了
#   $env:LOCALAPPDATA\Programs\千寻\千寻.exe
# 结果安装明明成功（退出码 0），版本校验却永远失败，代理反复重试 3 次后放弃。
# 原因是 electron-builder 的 per-user 安装目录名取自清洗后的 package.json name
# （上游 @zcode/desktop -> @zcodedesktop），只有目录内的 exe 才用 productName。
#
# 解析顺序：
#   1) 注册表卸载项反推 —— electron-builder 会写
#      DisplayName = "千寻 <version>"，而 InstallLocation 实测为空，
#      真正带路径的是 UninstallString：
#        "C:\...\Programs\@zcodedesktop\Uninstall 千寻.exe" /currentuser
#   2) 兜底：扫描 %LOCALAPPDATA%\Programs\*\千寻.exe
function Resolve-InstalledExe {
  $roots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  foreach ($root in $roots) {
    $entries = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like "$AppProductName*" }
    foreach ($entry in $entries) {
      foreach ($raw in @($entry.InstallLocation, $entry.UninstallString)) {
        if ([string]::IsNullOrWhiteSpace($raw)) { continue }
        $m = [regex]::Match($raw, '"([^"]+\.exe)"')
        if (-not $m.Success) { $m = [regex]::Match($raw, '([A-Za-z]:\\[^"]*?\.exe)') }
        if (-not $m.Success) { continue }
        $dir = Split-Path -Parent $m.Groups[1].Value
        if ([string]::IsNullOrWhiteSpace($dir)) { continue }
        $candidate = Join-Path $dir "$AppProductName.exe"
        if (Test-Path -LiteralPath $candidate) { return $candidate }
      }
    }
  }

  $programsRoot = Join-Path $env:LOCALAPPDATA "Programs"
  if (Test-Path -LiteralPath $programsRoot) {
    $candidate = Get-ChildItem -LiteralPath $programsRoot -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName "$AppProductName.exe" } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Select-Object -First 1
    if ($candidate) { return $candidate }
  }
  return $null
}

# 解析结果缓存到脚本作用域：安装前后都会调用，避免每次轮询都翻注册表。
$script:installedExe = $null
function Get-InstalledVersion {
  if (-not $script:installedExe -or -not (Test-Path -LiteralPath $script:installedExe)) {
    $script:installedExe = Resolve-InstalledExe
  }
  if (-not $script:installedExe) { return $null }
  try {
    $v = (Get-Item -LiteralPath $script:installedExe).VersionInfo.ProductVersion
    if ([string]::IsNullOrWhiteSpace($v)) { return $null }
    return $v.Trim()
  } catch {
    return $null
  }
}

# 3.14.3 与 3.14.3.0 视为同一版本
function Test-SameVersion {
  param([string]$A, [string]$B)
  if ([string]::IsNullOrWhiteSpace($A) -or [string]::IsNullOrWhiteSpace($B)) { return $false }
  $a = $A.Trim(); $b = $B.Trim()
  if ($a -eq $b) { return $true }
  if ($a.StartsWith("$b.") -or $b.StartsWith("$a.")) { return $true }
  return $false
}

if (-not (Test-Path -LiteralPath $DeliveryDir)) {
  New-Item -ItemType Directory -Path $DeliveryDir -Force | Out-Null
}

$current = Get-InstalledVersion
Write-Log "安装代理启动：投递目录 $DeliveryDir，当前已装版本 $(if ($current) { "v$current" } else { '未安装' })"

while ($true) {
  try {
    if (-not (Test-Path -LiteralPath $pendingFile)) {
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    try {
      $pending = Get-Content -LiteralPath $pendingFile -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      Write-Log "待装标记解析失败（可能正被写入），稍后重试：$($_.Exception.Message)"
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    $installer = "$($pending.installer)"
    $wantVersion = "$($pending.version)"

    if ([string]::IsNullOrWhiteSpace($installer) -or -not (Test-Path -LiteralPath $installer)) {
      Write-Log "待装标记指向的安装包不存在（$installer），清理标记"
      Remove-Item -LiteralPath $pendingFile -Force -ErrorAction SilentlyContinue
      continue
    }

    # 应用运行中不覆盖安装：NSIS 覆盖运行中的程序会失败或留下半装状态
    $running = @(Get-Process -Name $AppProductName -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
      Write-Log "$AppProductName 正在运行（PID $($running.Id -join ',')），等应用退出后再装"
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    # 已经是目标版本就不用重装（例如上一次装完但标记没来得及删）
    $installed = Get-InstalledVersion
    if (Test-SameVersion -A $installed -B $wantVersion) {
      Write-Log "本机已是 v$installed，无需安装，清理标记"
      Remove-Item -LiteralPath $pendingFile -Force -ErrorAction SilentlyContinue
      continue
    }

    $attempts = 0
    if ($null -ne $pending.attempts) { $attempts = [int]$pending.attempts }

    Write-Log "开始静默安装 v$wantVersion（上游 $($pending.upstreamSha) / 后端 $($pending.backendEnv)）：$installer"
    $proc = Start-Process -FilePath $installer -ArgumentList "/S" -PassThru -Wait
    Write-Log "安装进程退出码：$($proc.ExitCode)"

    $after = Get-InstalledVersion
    $ok = ($proc.ExitCode -eq 0) -and (Test-SameVersion -A $after -B $wantVersion)

    if ($ok) {
      Write-Log "安装成功：本机版本 v$after（目标 v$wantVersion）"
      Remove-Item -LiteralPath $pendingFile -Force -ErrorAction SilentlyContinue
      continue
    }

    # 失败：记录重试次数，超过上限就放弃本轮，避免同一个坏包无限重试
    $attempts++
    if ($attempts -ge $MaxAttempts) {
      $failed = Join-Path $DeliveryDir "install-failed.json"
      Write-Log "连续 $attempts 次安装失败（退出码 $($proc.ExitCode)，当前版本 $(if ($after) { "v$after" } else { '未安装' })），放弃本轮，标记改名为 install-failed.json 等待下次投递"
      Move-Item -LiteralPath $pendingFile -Destination $failed -Force -ErrorAction SilentlyContinue
      continue
    }

    $pending | Add-Member -NotePropertyName attempts -NotePropertyValue $attempts -Force
    ($pending | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $pendingFile -Encoding UTF8
    Write-Log "安装未成功，已记录第 $attempts/$MaxAttempts 次尝试，稍后重试"
    Start-Sleep -Seconds $PollSeconds
  } catch {
    # 常驻脚本不能被单次异常打断
    Write-Log "轮询出错：$($_.Exception.Message)"
    Start-Sleep -Seconds $PollSeconds
  }
}
