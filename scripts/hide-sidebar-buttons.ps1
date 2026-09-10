<#
.SYNOPSIS
    一键隐藏 DSH 左下角「记忆」/「Lark」/「自动化」侧边栏按钮与顶部「壁纸仓库」按钮。

.DESCRIPTION
    插件更新（daily-plugin-update 等）会用新构建覆盖 web profile 的 node_modules，
    被隐藏的按钮会重新出现。本脚本用于一键再次去除：

      1. 定位真实 DSH_HOME（默认 <脚本所在目录>\dshusb\.dsh，可用 -Root 覆盖）
      2. 对四个 client 包：

            dsh-automation（lib/client.js）：
              若 sidebar.footer.action 注入仍处于激活状态 →
              ① 先备份原文件到 .dsh\backups\sidebar-buttons-hide-<时间戳>\
              ② 在注入调用前加 `if (false) ` 前缀，使其成为死代码（语法保持合法）
            dsh-plugin-wallpaper-engine（lib/client.js）：
              若顶部「壁纸仓库」RopeDock 挂载仍处于激活状态 →
              ① 先备份原文件到 .dsh\backups\sidebar-buttons-hide-<时间戳>\
              ② 在挂载条件前加 `if (false && ` 前缀并插标记注释，使整块挂载成为死代码
            ③ 有 node 时对每个改动文件执行 node --check 校验语法
      每个目标维护候选路径列表（如 dsh-mneme 0.7.6+ 起为
      @modusensus\dsh-mneme\dsh-mneme\lib\client.js，旧布局 lib\client.js 兜底），
      取第一个存在的文件；全部缺失才告警跳过。
      3. 幂等：已隐藏的文件直接跳过，可重复运行。

.NOTES
    文件：hide-sidebar-buttons.ps1（配套 hide-sidebar-buttons.cmd 可双击运行）
    改动可逆：备份在 .dsh\backups\ 下，手动替换回去即可恢复。
    生效：若 DSH 正在运行，需重启应用或 Ctrl+F5 刷新浏览器。

.EXAMPLE
    .\hide-sidebar-buttons.ps1

.EXAMPLE
    .\hide-sidebar-buttons.ps1 -Root D:\Portable\DSH-USB
#>
param(
    [string]$Root
)

$ErrorActionPreference = 'Stop'

# 默认根目录 = 本脚本所在目录
if (-not $Root) { $Root = $PSScriptRoot }
# 与 update-dsh.ps1 一致：从脚本目录向上找到含 DSH USB.exe 的根
if (-not $Root -or -not (Test-Path (Join-Path $Root 'DSH USB.exe'))) {
    $walk = $PSScriptRoot
    while ($walk) {
        if (Test-Path (Join-Path $walk 'DSH USB.exe')) { $Root = $walk; break }
        $parent = Split-Path -Parent $walk
        if ($parent -eq $walk) { break }
        $walk = $parent
    }
}
$DshHome = Join-Path $Root 'dshusb\.dsh'
if (-not (Test-Path $DshHome)) {
    # 旧布局回退
    $legacy = Join-Path $Root 'dsh\dsh-home'
    if (Test-Path $legacy) { $DshHome = $legacy }
}
if (-not (Test-Path $DshHome)) {
    throw "找不到 DSH_HOME：$DshHome`n请用 -Root 指定 DSH 根目录，例如：.\hide-sidebar-buttons.ps1 -Root D:\Portable\DSH-USB"
}

# ── sidebar.footer.action 注入：激活态/已隐藏态/历史注释态 ──
$patActionActive   = '(?m)^[ \t]*ctx\.slots\.inject\s*\(\s*["'']sidebar\.footer\.action["'']'
$patActionHidden   = '(?m)^[ \t]*if\s*\(\s*false\s*\)\s*ctx\.slots\.inject\s*\(\s*["'']sidebar\.footer\.action["'']'
$patActionCommented = '(?m)^[ \t]*//[ \t]*ctx\.slots\.inject\s*\(\s*["'']sidebar\.footer\.action["'']'
# ── 壁纸仓库 RopeDock 挂载（apply step 3）：激活态/已隐藏态 ──
$patRopeActive = '(?m)^(?<ind>[ \t]*)if\s*\(\s*ctx\.effect\s*&&\s*typeof\s+document'
$patRopeHidden = '(?m)^[ \t]*//\s*\[dsh-wallpaper-rope-disabled\]'

$targets = @(
    @{
        Name = 'Lark 按钮';
        Files = @( Join-Path $DshHome 'profiles\web\node_modules\dsh-lark-link\dist\client.js' );
        Kind = 'sidebar-action'
    },
    @{
        # dsh-mneme 0.7.6+ 改为仓库根布局，client.js 嵌套在包内 dsh-mneme\ 子目录
        # （package.json exports["./client"] -> ./dsh-mneme/lib/client.js）；旧布局作兜底。
        Name = '记忆按钮';
        Files = @(
            (Join-Path $DshHome 'profiles\web\node_modules\@modusensus\dsh-mneme\dsh-mneme\lib\client.js')
            (Join-Path $DshHome 'profiles\web\node_modules\@modusensus\dsh-mneme\lib\client.js')
        );
        Kind = 'sidebar-action'
    },
    @{
        Name = '自动化按钮';
        Files = @( Join-Path $DshHome 'profiles\web\node_modules\@dsh-external\dsh-automation\lib\client.js' );
        Kind = 'sidebar-action'
    },
    @{
        Name = '壁纸仓库顶部按钮';
        Files = @( Join-Path $DshHome 'profiles\web\node_modules\dsh-plugin-wallpaper-engine\lib\client.js' );
        Kind = 'rope-dock'
    }
)

$changed = 0
$skipped = 0
$failed  = 0

foreach ($t in $targets) {
    # 候选路径中取第一个存在的（插件升级可能改包内布局）
    $path = $t.Files | Where-Object { Test-Path $_ } | Select-Object -First 1
    Write-Host "== $($t.Name)：$path" -ForegroundColor Cyan

    if (-not $path) {
        Write-Warning "所有候选路径均不存在，跳过（插件可能未安装或路径已变）：$($t.Files -join ' | ')"
        $failed++
        continue
    }

    $text = [System.IO.File]::ReadAllText($path)

    # 已隐藏判断：脚本死代码标记 / 历史手工注释标记 / 注释态
    if ($t.Kind -eq 'rope-dock') {
        $already = $text -match $patRopeHidden
    } else {
        $already = ($text -match $patActionHidden) -or ($text -match '\[Disabled 2026-08-23\]') -or ($text -match $patActionCommented)
    }
    if ($already) {
        Write-Host "  已隐藏，跳过。" -ForegroundColor Green
        $skipped++
        continue
    }

    # 激活态检查
    if ($t.Kind -eq 'rope-dock') {
        if ($text -notmatch $patRopeActive) {
            Write-Warning "未找到 RopeDock 挂载（插件可能已改版），请人工检查。"
            $failed++
            continue
        }
    } else {
        if ($text -notmatch $patActionActive) {
            Write-Warning "未找到 sidebar.footer.action 注入（插件可能已改版），请人工检查。"
            $failed++
            continue
        }
    }

    # ① 备份（§1.5：统一放 .dsh\backups\<主题>-<时间戳>）
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bkDir = Join-Path $DshHome ("backups\sidebar-buttons-hide-{0}" -f $ts)
    New-Item -ItemType Directory -Path $bkDir -Force | Out-Null
    Copy-Item $path (Join-Path $bkDir ([System.IO.Path]::GetFileName($path)))
    Write-Host "  已备份 -> $bkDir" -ForegroundColor DarkGray

    # ② 隐藏：按类型插入死代码
    if ($t.Kind -eq 'rope-dock') {
        # 壁纸仓库：RopeDock 挂载整体禁用 → if (false && …) + 标记注释
        $newText = [regex]::Replace($text, $patRopeActive, {
            param($m)
            $ind = $m.Groups['ind'].Value
            $nl = "`n"
            return ($ind + '// [dsh-wallpaper-rope-disabled] 壁纸仓库顶部拉绳/面板不挂载（设置页 Wallpaper Engine 仍可用）' + $nl + $ind + 'if (false && ctx.effect && typeof document')
        })
    } else {
        # sidebar.footer.action：在 ctx.slots.inject(...) 前插 if (false) 使整条调用成为死代码
        $newText = [regex]::Replace($text, $patActionActive, {
            param($m)
            $idx = $m.Value.IndexOf('ctx.')
            $m.Value.Insert($idx, 'if (false) ')
        })
    }
    [System.IO.File]::WriteAllText($path, $newText, (New-Object System.Text.UTF8Encoding($false)))

    # ③ 语法校验（node 存在时）
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        & node --check $path 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  已隐藏，node --check 通过。" -ForegroundColor Green
        } else {
            Write-Host "  node --check 失败！请人工检查该文件。" -ForegroundColor Red
            $failed++
        }
    } else {
        Write-Host "  已隐藏（未找到 node，跳过语法校验）。" -ForegroundColor Green
    }
    $changed++
}

Write-Host ""
Write-Host "完成：$changed 个已隐藏，$skipped 个跳过，$failed 个异常" -ForegroundColor Yellow
if ($changed -gt 0) {
    Write-Host "提示：若 DSH 正在运行，请重启应用或 Ctrl+F5 刷新浏览器后生效。" -ForegroundColor DarkYellow
}