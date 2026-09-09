#!/usr/bin/env pwsh
<#
.SYNOPSIS
    DSH USB 核心 agent 检查/更新脚本
.DESCRIPTION
    在宿主机 (NTFS) 完成 npm install，然后复制到 U 盘 (exFAT)，
    自动打 exFAT 补丁，原子交换到 agent overlay。
    解决 exFAT 文件系统不支持 junction 导致更新失败的问题。
    支持 -Check 纯检查模式；默认仅在有新版本时更新。
#>

param(
    [string]$PackageName = "@deepseek-ai/dsh",
    [string]$Version = "latest",
    [string]$DshRoot,
    [switch]$Force,
    [switch]$DryRun,
    [switch]$Check,
    [switch]$Yes,
    [switch]$Launch
)

if (-not $DshRoot) {
    $parent = Split-Path -Parent $PSScriptRoot
    if (Test-Path (Join-Path $PSScriptRoot 'DSH USB.exe')) { $DshRoot = $PSScriptRoot }
    elseif (Test-Path (Join-Path $parent 'DSH USB.exe')) { $DshRoot = $parent }
    else { $DshRoot = $PSScriptRoot }
}


# ----- 路径配置 -----------------------------------------------------------
$DshDataDir   = Join-Path $DshRoot "dshusb"
if (-not (Test-Path $DshDataDir)) {
    $legacyData = Join-Path $DshRoot "dsh"
    if (Test-Path $legacyData) { $DshDataDir = $legacyData }
}
$AgentDir     = Join-Path $DshDataDir "deepseek-ai"
if (-not (Test-Path $AgentDir)) {
    $legacyAgent = Join-Path $DshDataDir "agent"
    if (Test-Path $legacyAgent) { $AgentDir = $legacyAgent }
}
$StagingDir   = Join-Path $DshDataDir "deepseek-ai-staging"
$HostTempBase = "C:\dsh-temp-install"
$HostTempDir  = Join-Path $HostTempBase ("dsh-update-" + (Get-Date -Format "yyyyMMddHHmmss"))
$NodeExe      = Join-Path $DshRoot "resources\node\node.exe"
$NpmCli       = Join-Path $DshRoot "resources\npm\bin\npm-cli.js"
$AppBootFile  = Join-Path $StagingDir "node_modules\@deepseek-ai\dsh-app-boot\lib\index.js"
$SettingsFile = Join-Path $DshDataDir "settings.json"
$LogDir       = Join-Path $DshDataDir "logs"
$LogFile      = Join-Path $LogDir "update.log"
$DshHome      = Join-Path $DshDataDir ".dsh"
if (-not (Test-Path $DshHome)) {
    $legacyHome = Join-Path $DshDataDir "dsh-home"
    if (Test-Path $legacyHome) { $DshHome = $legacyHome }
}
$McpPatchFile = Join-Path $DshHome "profiles\web\node_modules\dsh-computer-use-win\cordis.patch.yml"

# ----- 颜色输出辅助 -------------------------------------------------------
function Write-Info  { Write-Host "ℹ️  $($args)" -ForegroundColor Cyan }
function Write-Ok    { Write-Host "✅ $($args)" -ForegroundColor Green }
function Write-Warn  { Write-Host "⚠️  $($args)" -ForegroundColor Yellow }
function Write-Err   { Write-Host "❌ $($args)" -ForegroundColor Red }
function Write-Step  { Write-Host "`n─── $($args) ───" -ForegroundColor Magenta }

# ----- 日志辅助 -----------------------------------------------------------
function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] $Message"
    Add-Content -Path $LogFile -Value $line -Encoding utf8
    Write-Info $Message
}

# ----- 步骤 0：检查前置条件 ------------------------------------------------
function Check-Prerequisites {
    Write-Step "0/6 检查前置条件"

    $errors = @()

    if (-not (Test-Path $NodeExe))   { $errors += "Node.js 未找到: $NodeExe" }
    if (-not (Test-Path $NpmCli))    { $errors += "npm CLI 未找到: $NpmCli" }
    if (-not (Test-Path $DshDataDir)){ $errors += "DSH 数据目录未找到: $DshDataDir" }

    $cDrive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
    if ($cDrive.FileSystem -ne "NTFS") { $errors += "C 盘不是 NTFS（当前: $($cDrive.FileSystem)），npm 可能无法正常工作" }

    $eDrive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='E:'"
    if ($eDrive.FileSystem -match "exFAT|FAT32") {
        Write-Warn "E 盘是 $($eDrive.FileSystem)，需要 exFAT 兼容补丁"
    }

    if ($errors.Count -gt 0) {
        foreach ($e in $errors) { Write-Err $e }
        if (-not $Force) { throw "前置条件检查失败，使用 -Force 跳过检查" }
    }

    Write-Ok "前置条件检查完成"
}

# ----- 步骤 1：查询最新版本 ------------------------------------------------
function Check-LatestVersion {
    Write-Step "1/6 查询最新版本"

    $url = "https://registry.npmjs.org/$PackageName/latest"
    Write-Log "查询: $url"

    try {
        $response = Invoke-RestMethod -Uri $url -TimeoutSec 15 -ErrorAction Stop
        $latestVersion = $response.version
        Write-Log "最新版本: $latestVersion"

        $currentVersion = $null
        $agentPkg = Join-Path $AgentDir "node_modules\$PackageName\package.json"
        if (Test-Path $agentPkg) {
            $agentJson = Get-Content $agentPkg -Raw | ConvertFrom-Json
            $currentVersion = $agentJson.version
        }
        if (-not $currentVersion) {
            $bundledPkg = Join-Path $DshRoot "resources\app\node_modules\$PackageName\package.json"
            if (Test-Path $bundledPkg) {
                $bundledJson = Get-Content $bundledPkg -Raw | ConvertFrom-Json
                $currentVersion = $bundledJson.version
            }
        }

        Write-Log "当前版本: $currentVersion"

        if ($latestVersion -eq $currentVersion -and -not $Force) {
            Write-Warn "当前已是最新版本 ($latestVersion)，跳过更新"
            Write-Warn "使用 -Force 强制重新安装"
            return $null
        }

        Write-Ok "发现新版本: $currentVersion → $latestVersion"
        return $latestVersion
    }
    catch {
        Write-Err "查询最新版本失败: $_"
        throw $_
    }
}

# ----- 步骤 2：在宿主机 C 盘安装 -------------------------------------------
function Install-OnHost {
    param([string]$Version)

    Write-Step "2/6 在宿主机 C 盘安装 $PackageName@$Version"

    if (Test-Path $HostTempDir) {
        Remove-Item -Path $HostTempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -Path $HostTempDir -ItemType Directory -Force | Out-Null

    $versionArg = if ($Version -eq "latest") { $PackageName } else { "$PackageName@$Version" }

    Write-Log "npm install --prefix $HostTempDir $versionArg --save-exact --omit=dev --no-audit --no-fund --no-update-notifier"

    if ($DryRun) { Write-Warn "[DryRun] 跳过 npm install"; return }

    $env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
    $env:NPM_CONFIG_FUND = 'false'
    $env:NPM_CONFIG_AUDIT = 'false'

    $proc = Start-Process -FilePath $NodeExe -ArgumentList @($NpmCli, "install", "--prefix", $HostTempDir, $versionArg, "--save-exact", "--omit=dev", "--no-audit", "--no-fund", "--no-update-notifier") -Wait -PassThru -NoNewWindow -RedirectStandardOutput "$HostTempDir\npm-stdout.log" -RedirectStandardError "$HostTempDir\npm-stderr.log"

    if ($proc.ExitCode -ne 0) {
        $stderr = Get-Content "$HostTempDir\npm-stderr.log" -Tail 10
        Write-Err "npm install 失败 (退出码 $($proc.ExitCode))"
        foreach ($line in $stderr) { Write-Err "  $line" }
        throw "npm install 失败"
    }

    $installedPkg = Join-Path $HostTempDir "node_modules\$PackageName\package.json"
    if (-not (Test-Path $installedPkg)) {
        throw "npm install 完成但未找到 $installedPkg"
    }

    $installedJson = Get-Content $installedPkg -Raw | ConvertFrom-Json
    Write-Ok "安装完成: $PackageName@$($installedJson.version)"
}

# ----- 步骤 3：复制到 U 盘 staging 目录 ------------------------------------
function Copy-ToStaging {
    Write-Step "3/6 复制到 U 盘 staging 目录"

    if ($DryRun) { Write-Warn "[DryRun] 跳过复制"; return }

    if (Test-Path $StagingDir) {
        Write-Log "清理旧 staging 目录"
        Remove-Item -Path $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Log "复制 node_modules 到 $StagingDir (这可能需要几分钟...)"

    $src = Join-Path $HostTempDir "node_modules"
    $dst = Join-Path $StagingDir "node_modules"

    $robocopyArgs = @($src, $dst, "/E", "/NP", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/R:2", "/W:2")
    $robocopy = Start-Process -FilePath "robocopy.exe" -ArgumentList $robocopyArgs -Wait -PassThru -NoNewWindow

    if ($robocopy.ExitCode -ge 8) {
        throw "robocopy 复制失败 (退出码 $($robocopy.ExitCode))"
    }

    Copy-Item -Path (Join-Path $HostTempDir "package.json") -Destination (Join-Path $StagingDir "package.json") -Force
    Copy-Item -Path (Join-Path $HostTempDir "package-lock.json") -Destination (Join-Path $StagingDir "package-lock.json") -Force -ErrorAction SilentlyContinue

    Write-Ok "复制完成"
}

# ----- 步骤 4：删除宿主机下载的安装包 ---------------------------------------
function Cleanup-Host {
    Write-Step "4/6 清理宿主机临时文件"

    if ($DryRun) { Write-Warn "[DryRun] 跳过清理"; return }

    if (Test-Path $HostTempDir) {
        Remove-Item -Path $HostTempDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Log "已删除宿主机临时目录: $HostTempDir"
    }

    $oldBackups = Get-ChildItem -Path $DshDataDir -Directory -Filter "deepseek-ai-old-*" -ErrorAction SilentlyContinue
    foreach ($bak in $oldBackups) {
        Remove-Item -Path $bak.FullName -Recurse -Force -ErrorAction SilentlyContinue
        Write-Log "已清理旧备份: $($bak.Name)"
    }

    Write-Ok "宿主机临时文件已清理"
}

# ----- 步骤 5：给 dsh-app-boot 打 exFAT 补丁 --------------------------------
function Patch-ExFat {
    Write-Step "5/6 给 dsh-app-boot 打 exFAT 兼容补丁"

    if ($DryRun) { Write-Warn "[DryRun] 跳过打补丁"; return }

    if (-not (Test-Path $AppBootFile)) {
        Write-Warn "未找到 $AppBootFile，跳过补丁"
        return $false
    }

    $content = Get-Content $AppBootFile -Raw

    if ($content -match "exFAT/FAT32 copy fallback") {
        Write-Ok "已经打过 exFAT 补丁，跳过"
        return $true
    }

    $backupFile = $AppBootFile + ".bak"
    Copy-Item -Path $AppBootFile -Destination $backupFile -Force

    # 1. 补充 imports
    $oldImport = 'import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";'
    $newImport = 'import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";'

    if ($content -match [regex]::Escape($oldImport)) {
        $content = $content -replace [regex]::Escape($oldImport), $newImport
        Write-Log "已添加 cpSync, renameSync, rmSync 导入"
    }

    # 2. 替换 ensureSymlink 函数
    $oldFunc = 'function ensureSymlink(link, target) {
	let stat;
	try {
		stat = lstatSync(link);
	} catch {
		stat = void 0;
	}
	if (stat !== void 0) {
		if (!stat.isSymbolicLink()) throw new Error(`dsh: ${link} exists and is not a symlink; remove it so dsh can manage the installation fallback`);
		if (readlinkSync(link) === target) return;
		unlinkSync(link);
	}
	try {
		symlinkSync(target, link, "junction");
	} catch (error) {
		/* v8 ignore next 4 */
		if (error.code !== "EEXIST" || !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target) throw error;
	}
}'

    $newFunc = 'function ensureSymlink(link, target) {
	let stat;
	try {
		stat = lstatSync(link);
	} catch {
		stat = void 0;
	}
	if (stat !== void 0) {
		if (stat.isSymbolicLink()) {
			if (readlinkSync(link) === target) return;
			unlinkSync(link);
		} else if (stat.isDirectory()) {
			// DSH USB: exFAT/FAT32 copy fallback. The marker file distinguishes
			// complete copies from partial ones left by an interrupted boot.
			try {
				readFileSync(link + "/.dsh-copy-ok");
				return;
			} catch {
				rmSync(link, { recursive: true, force: true });
			}
		} else {
			throw new Error(`dsh: ${link} exists and is not a symlink; remove it so dsh can manage the installation fallback`);
		}
	}
	try {
		symlinkSync(target, link, "junction");
	} catch (error) {
		if (error.code === "EEXIST" && lstatSync(link).isSymbolicLink() && readlinkSync(link) === target) return;
		// DSH USB: junctions unsupported here (exFAT/FAT32) -> copy package
		if (error.code === "EISDIR" || error.code === "EPERM" || error.code === "ENOSYS" || error.code === "EINVAL") {
			try {
				const tmp = link + ".dsh-copying";
				rmSync(tmp, { recursive: true, force: true });
				cpSync(target, tmp, { recursive: true });
				writeFileSync(tmp + "/.dsh-copy-ok", "1");
				renameSync(tmp, link);
				return;
			} catch { /* fall through to the original error below */ }
		}
		throw error;
	}
}'

    if ($content -match [regex]::Escape($oldFunc)) {
        $content = $content -replace [regex]::Escape($oldFunc), $newFunc
        Write-Log "已完成 ensureSymlink 函数替换（添加 exFAT 回退）"
    } else {
        Write-Warn "无法精确匹配旧函数，使用保守方法..."
        Write-Err "补丁失败：函数格式不匹配，请手动检查 $AppBootFile"
        return $false
    }

    $content | Out-File -FilePath $AppBootFile -Encoding utf8 -NoNewline

    $verifyContent = Get-Content $AppBootFile -Raw
    if ($verifyContent -match "exFAT/FAT32 copy fallback") {
        Write-Ok "exFAT 补丁应用成功"
        # 删除备份
        Remove-Item -Path $backupFile -Force -ErrorAction SilentlyContinue
        return $true
    } else {
        Write-Err "补丁验证失败，恢复备份"
        Copy-Item -Path $backupFile -Destination $AppBootFile -Force
        return $false
    }
}

# ----- 步骤 6：原子交换 staging → agent overlay -----------------------------
function Atomic-Swap {
    Write-Step "6/6 原子交换 staging → agent overlay"

    if ($DryRun) { Write-Warn "[DryRun] 跳过交换"; return }

    if (-not (Test-Path $StagingDir)) { throw "staging 目录不存在: $StagingDir" }

    if (Test-Path $AgentDir) {
        $backupDir = Join-Path $DshDataDir ("deepseek-ai-old-" + (Get-Date -Format "yyyyMMddHHmmss"))
        Write-Log "备份旧 overlay → $backupDir"
        Rename-Item -Path $AgentDir -NewName (Split-Path $backupDir -Leaf) -Force
    }

    Write-Log "交换: $StagingDir → $AgentDir"
    Rename-Item -Path $StagingDir -NewName "deepseek-ai" -Force

    if (Test-Path $AgentDir) {
        $agentPkg = Join-Path $AgentDir "node_modules\@deepseek-ai\dsh\package.json"
        if (Test-Path $agentPkg) {
            $json = Get-Content $agentPkg -Raw | ConvertFrom-Json
            Write-Ok "交换成功！新版本: $PackageName@$($json.version)"
        } else {
            Write-Ok "交换成功（版本信息未知）"
        }
    } else {
        throw "交换失败"
    }

    $settings = @{}
    if (Test-Path $SettingsFile) {
        try { $settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json } catch {}
    }
    $settings.skipVersion = $null
    $settings | ConvertTo-Json -Compress | Out-File -FilePath $SettingsFile -Encoding utf8
    Write-Log "已清除 skipVersion 标记"
}

# ----- 显示安装摘要 ---------------------------------------------------------
function Show-Summary {
    Write-Step "📋 安装摘要"

    $summary = @()

    $agentPkg = Join-Path $AgentDir "node_modules\@deepseek-ai\dsh\package.json"
    if (Test-Path $agentPkg) {
        $json = Get-Content $agentPkg -Raw | ConvertFrom-Json
        $summary += "版本: $($json.name)@$($json.version)"
    }

    $appBootFile = Join-Path $AgentDir "node_modules\@deepseek-ai\dsh-app-boot\lib\index.js"
    if (Test-Path $appBootFile) {
        $appBootContent = Get-Content $appBootFile -Raw
        if ($appBootContent -match "exFAT/FAT32 copy fallback") {
            $summary += "exFAT 补丁: ✅ 已应用"
        } else {
            $summary += "exFAT 补丁: ❌ 未应用"
        }
    }

    $summary += "位置: $AgentDir"
    $summary += "文件系统: $( (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='E:'").FileSystem )"

    $size = (Get-ChildItem -Path $AgentDir -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    if ($size -gt 0) {
        $sizeMB = [math]::Round($size / 1MB, 1)
        $summary += "体积: ${sizeMB} MB"
    }

    foreach ($s in $summary) {
        Write-Host "  • $s"
    }

    Write-Host ""
    Write-Ok "升级完成！请重启 DSH USB 以使用新版本"

    foreach ($s in $summary) {
        Write-Log "  $s"
    }
}

# ----- 新增：版本/进程/兼容性辅助 ------------------------------------------
function Get-InstalledVersion {
    $agentPkg = Join-Path $AgentDir "node_modules\$PackageName\package.json"
    if (Test-Path -LiteralPath $agentPkg) {
        return (Get-Content -LiteralPath $agentPkg -Raw | ConvertFrom-Json).version
    }
    $bundledPkg = Join-Path $DshRoot "resources\app\node_modules\$PackageName\package.json"
    if (Test-Path -LiteralPath $bundledPkg) {
        return (Get-Content -LiteralPath $bundledPkg -Raw | ConvertFrom-Json).version
    }
    return $null
}

function Get-RegistryLatest {
    $url = "https://registry.npmjs.org/$PackageName/latest"
    Write-Log "查询最新版本: $url"
    $response = Invoke-RestMethod -Uri $url -TimeoutSec 20 -ErrorAction Stop
    return $response.version
}

function Compare-DshVersions {
    param([string]$Left, [string]$Right)
    $a = ($Left -split '-')[0] -split '\.' | ForEach-Object { [int]$_ }
    $b = ($Right -split '-')[0] -split '\.' | ForEach-Object { [int]$_ }
    for ($i = 0; $i -lt 3; $i++) {
        if ($a[$i] -lt $b[$i]) { return -1 }
        if ($a[$i] -gt $b[$i]) { return 1 }
    }
    $apre = if ($Left -match '-') { ($Left -split '-', 2)[1] } else { '' }
    $bpre = if ($Right -match '-') { ($Right -split '-', 2)[1] } else { '' }
    if ($apre -eq $bpre) { return 0 }
    if ($apre -eq '') { return 1 }
    if ($bpre -eq '') { return -1 }
    $an = if ($apre -match '(\d+)') { [int]$Matches[1] } else { 0 }
    $bn = if ($bpre -match '(\d+)') { [int]$Matches[1] } else { 0 }
    if ($an -ne $bn) { return ($an - $bn) }
    return ([string]::Compare($apre, $bpre, $true))
}

function Stop-DshForUpdate {
    $exe = Join-Path $DshRoot "DSH USB.exe"
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq 'DSH USB.exe' -and $_.ExecutablePath -eq $exe
    })
    $allIds = @($all | ForEach-Object { $_.ProcessId })
    $roots = @($all | Where-Object { $_.ParentProcessId -notin $allIds })
    $nodeBefore = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq 'node.exe' -and $_.ExecutablePath -like "$DshRoot\resources\node*"
    })
    if ($roots.Count -eq 0 -and $nodeBefore.Count -eq 0) { return $true }
    if (-not $Yes) {
        Write-Warn "检测到 DSH USB 正在运行。更新前需要关闭它（不影响 .dsh 数据）。"
        $answer = Read-Host "输入 y 继续，其他键取消"
        if ($answer -notmatch '^[yY]$') {
            Write-Warn "已取消更新"
            return $false
        }
    }
    foreach ($proc in $roots) {
        Write-Log "关闭 DSH USB 主进程 PID=$($proc.ProcessId)"
        taskkill /PID $proc.ProcessId /T /F | Out-Null
    }
    Start-Sleep -Seconds 2
    $nodeLeft = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq 'node.exe' -and $_.ExecutablePath -like "$DshRoot\resources\node*"
    })
    foreach ($proc in $nodeLeft) {
        Write-Log "关闭残留 DSH node 进程 PID=$($proc.ProcessId)"
        taskkill /PID $proc.ProcessId /T /F | Out-Null
    }
    return $true
}

function Set-AppBootCompatibility {
    param([string]$File)
    if (-not (Test-Path -LiteralPath $File)) {
        throw "未找到 dsh-app-boot: $File"
    }
    $c = [System.IO.File]::ReadAllText($File)
    $needRewrite = $false

    $oldImport = 'import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";'
    $newImport = 'import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";'
    if ($c.Contains($oldImport)) {
        $c = $c.Replace($oldImport, $newImport)
        $needRewrite = $true
    }

    $oldOptional = 'return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];'
    $newOptional = 'return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})];'
    if ($c.Contains($oldOptional)) {
        $c = $c.Replace($oldOptional, $newOptional)
        $needRewrite = $true
    }

    if (-not $c.Contains('function dshCopyCurrent')) {
        $anchor = '/** Ensure `link` is a symlink to `target`, replacing a wrong link or a dsh-managed packaged proxy. */'
        $helper = @'
/** Return whether a real directory is a complete DSH USB copy fallback for this target. */
function dshCopyCurrent(link, target) {
	try {
		return readFileSync(join(link, ".dsh-copy-ok"), "utf8") === target;
	} catch {
		return false;
	}
}

'@
        if (-not $c.Contains($anchor)) {
            throw "dsh-app-boot ensureSymlink 锚点未找到，无法打 exFAT 补丁"
        }
        $c = $c.Replace($anchor, $helper + $anchor)
        $needRewrite = $true
    }

    $oldThrow = @'
if ((stat.isDirectory() ? readModuleProxyRecord(link) : void 0)?.dsh?.moduleFallback?.targets === void 0) throw new Error(`dsh: ${link} exists and is not a symlink or dsh-managed module proxy; remove it so dsh can manage the installation fallback`);
'@
    $newThrow = @'
if (!stat.isDirectory()) throw new Error(`dsh: ${link} exists and is not a symlink or dsh-managed module proxy; remove it so dsh can manage the installation fallback`);
// DSH USB: exFAT/FAT32 copy fallback. A marker file whose content matches
// this target identifies a complete copy; anything stale is rebuilt below.
if (dshCopyCurrent(link, target)) return;
'@
    if ($c.Contains($oldThrow)) {
        $c = $c.Replace($oldThrow, $newThrow)
        $needRewrite = $true
    }

    $oldCurrent = 'if (entry.kind === "symlink") return stat.isSymbolicLink() && readlinkSync(link) === entry.packageDir;'
    $newCurrent = @'
if (entry.kind === "symlink") {
			if (stat.isSymbolicLink()) return readlinkSync(link) === entry.packageDir;
			if (stat.isDirectory()) return dshCopyCurrent(link, entry.packageDir);
			return false;
		}
'@
    if ($c.Contains($oldCurrent)) {
        $c = $c.Replace($oldCurrent, $newCurrent)
        $needRewrite = $true
    }

    $oldCatch = 'if (error.code !== "EEXIST" || !lstatSync(link).isSymbolicLink() || !symlinkPointsTo(link, target)) throw error;'
    $newCatch = @'
if (error.code === "EEXIST" && lstatSync(link).isSymbolicLink() && symlinkPointsTo(link, target)) return;
		// DSH USB: junctions unsupported here (exFAT/FAT32) -> copy package
		if (error.code === "EISDIR" || error.code === "EPERM" || error.code === "ENOSYS" || error.code === "EINVAL") {
			try {
				const tmp = link + ".dsh-copying";
				rmSync(tmp, { recursive: true, force: true });
				cpSync(target, tmp, { recursive: true });
				writeFileSync(join(tmp, ".dsh-copy-ok"), target);
				renameSync(tmp, link);
				return;
			} catch (copyError) {
				/* fall through to the original error below */
			}
		}
		throw error;
'@
    if ($c.Contains($oldCatch)) {
        $c = $c.Replace($oldCatch, $newCatch)
        $needRewrite = $true
    }

    $patched = $c.Contains('function dshCopyCurrent') -and
               $c.Contains('optionalDependencies') -and
               $c.Contains('.dsh-copy-ok') -and
               $c.Contains('cpSync')
    if (-not $patched) {
        throw "exFAT/可选依赖补丁校验失败（代码格式可能已变化）: $File"
    }

    if ($needRewrite) {
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($File, $c, $utf8)
        & $NodeExe --check $File
        if ($LASTEXITCODE -ne 0) { throw "exFAT 补丁后语法检查失败: $File" }
        Write-Ok "exFAT/可选依赖补丁已应用: $File"
    } else {
        Write-Ok "exFAT/可选依赖补丁已存在，跳过: $File"
    }
}

function Set-McpPathCompatibility {
    if (-not (Test-Path -LiteralPath $McpPatchFile)) {
        Write-Warn "未找到 dsh-computer-use-win 补丁文件，跳过 MCP 路径修复"
        return
    }
    $c = [System.IO.File]::ReadAllText($McpPatchFile)
    $old = "new URL('mcp/server.mjs', baseUrl)"
    $new = "new URL('node_modules/dsh-computer-use-win/mcp/server.mjs', baseUrl)"
    if ($c.Contains($new)) {
        Write-Ok "MCP 路径补丁已存在，跳过"
        return
    }
    if (-not $c.Contains($old)) {
        Write-Warn "MCP 旧路径未找到，跳过（可能插件已更新格式）"
        return
    }
    $c = $c.Replace($old, $new)
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($McpPatchFile, $c, $utf8)
    Write-Ok "MCP 路径补丁已应用"
}

function Invoke-ProfileHeal {
    $agentPkg = Join-Path $AgentDir "node_modules\$PackageName\package.json"
    if (-not (Test-Path -LiteralPath $agentPkg)) {
        throw "无法离线刷新 profiles：agent 包不存在 $agentPkg"
    }
    $agentBoot = Join-Path $AgentDir "node_modules\@deepseek-ai\dsh-app-boot\lib\index.js"
    $agentPkgPath = $agentPkg.Replace('\', '/')
    $agentBootPath = $agentBoot.Replace('\', '/')
    $agentBootUrl = 'file:///' + $agentBootPath
    $homePath = $DshHome.Replace('\', '/')
    $script = @"
import { healProfilesModuleFallback } from '$agentBootUrl';
await healProfilesModuleFallback({ installAnchor: '$agentPkgPath', home: '$homePath' });
"@
    if ($DryRun) {
        Write-Warn "[DryRun] 跳过 profiles 回退副本刷新"
        return
    }
    Write-Step "离线刷新 profiles 回退副本（首次约 1-2 分钟）"
    & $NodeExe --input-type=module -e $script
    if ($LASTEXITCODE -ne 0) {
        throw "profiles 回退副本刷新失败（退出码 $LASTEXITCODE）"
    }
    Write-Ok "profiles 回退副本已刷新"
}

# ===== 主流程 ==============================================================
function Main {
    Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║     DSH USB 核心 agent 检查/更新脚本          ║" -ForegroundColor Cyan
    Write-Host "║     宿主机下载 → U 盘复制 → 自动打补丁        ║" -ForegroundColor Cyan
    Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""

    New-Item -Path $LogDir -ItemType Directory -Force | Out-Null

    try {
        $current = Get-InstalledVersion

        if ($Check) {
            $target = if ($Version -and $Version -ne 'latest') { $Version } else { Get-RegistryLatest }
            if (-not $target) { throw "无法获取目标版本" }
            Write-Host ""
            Write-Host "  当前版本: $current"
            Write-Host "  目标版本: $target"
            Write-Host ""
            if ($current -and (Compare-DshVersions $target $current) -eq 0) {
                Write-Ok "已是最新版本 ($target)"
                exit 0
            }
            Write-Warn "发现可更新版本: $current → $target"
            exit 2
        }

        Check-Prerequisites

        $target = if ($Version -and $Version -ne 'latest') { $Version } else { Get-RegistryLatest }
        if (-not $target) { throw "无法获取最新版本" }

        if ($current -and (Compare-DshVersions $target $current) -le 0) {
            if ($Force) {
                Write-Warn "当前版本 $current，-Force 强制重装 $target"
            } else {
                Write-Ok "当前已是最新版本 ($current)，无需更新"
                exit 0
            }
        } else {
            Write-Ok "发现新版本: $current → $target"
        }

        if ($DryRun) {
            Write-Warn "[DryRun] 仅演练：将安装 $target 到 C 盘临时目录并交换到 deepseek-ai"
            exit 0
        }

        if (-not (Stop-DshForUpdate)) { exit 0 }

        Install-OnHost -Version $target
        Copy-ToStaging
        Cleanup-Host
        Set-AppBootCompatibility -File $AppBootFile
        Set-McpPathCompatibility
        Atomic-Swap
        Invoke-ProfileHeal
        Show-Summary

        if ($Launch) {
            Write-Ok "重新启动 DSH USB…"
            Start-Process -FilePath (Join-Path $DshRoot "DSH USB.exe") -WorkingDirectory $DshRoot
        } else {
            Write-Warn "请重新启动 DSH USB 以使用新版本（或用 -Launch 自动启动）"
        }
    }
    catch {
        Write-Err "更新失败: $_"
        Write-Host ""
        Write-Warn "如需帮助，请查看日志: $LogFile"
        exit 1
    }
}

Main

