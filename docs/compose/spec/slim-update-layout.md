---
feature: slim-update-layout
status: in-progress
updated: 2026-09-09
branch: feat/slim-update-layout
commits: 36cd2c5..f1391a3
---

# 精简升级体系与目录布局重命名

## Report

## [S1] Problem

1. 壳自更新（client-updater.js）已禁用自动检查，默认还指向第三方上游仓库，代码路径冗余且易误触。
2. exFAT 补丁依赖 `dsh-app-boot` 的精确源码字符串，上游格式一变就整次更新失败，且失败信息难定位。
3. agent 更新会在 `dsh/` 下留下 `agent-staging`、`agent-old-*`、`agent-broken-*`，无人清理，U 盘空间被持续吞噬。
4. 运行时目录名 `dsh/`、`agent/`、`dsh-home/` 与 DSH agent 的习惯（`.dsh`）不一致，便携根、agent 覆盖层、数据层三层命名混乱。

## [S2] Design

### S2.1 目标运行时布局（嵌套）

```
<exe-dir>/
  DSH USB.exe
  dshusb/                 # Electron userData（原 dsh/）
    deepseek-ai/          # agent overlay（原 agent/）
    .dsh/                 # DSH_HOME（原 dsh-home/）
    logs/
    settings.json
    Cache/、GPUCache/…    # Chromium 杂项，随壳走
```

- `main.js`：`app.setPath('userData', …/dshusb)`；`DSH_HOME` 默认 `userData/.dsh`。
- `updater.js`：overlay = `userData/deepseek-ai`；staging = `userData/deepseek-ai-staging`；备份前缀 `deepseek-ai-old-*` / `deepseek-ai-broken-*`。
- 源码目录 `shell/` → `dshusb/`（含 `package.json` `name` → `dshusb`，`productName` 仍为 `DSH USB`）。
- README、`scripts/update-dsh.ps1`、`scripts/hide-sidebar-buttons.ps1` 中的路径与说明同步。

### S2.2 旧布局自动迁移

启动早期（`userData` 重定向之后、spawn dsh 之前）：

1. 若 `<exe-dir>/dsh` 存在且 `<exe-dir>/dshusb` 不存在 → `rename(dsh, dshusb)`。
2. 若两者同时存在 → 不合并，保留 `dshusb`，旧 `dsh` 原地不动并写日志警告。
3. 在 userData 根内：
   - `agent` → `deepseek-ai`（目标已存在则跳过并告警）
   - `dsh-home` → `.dsh`（同上）
4. 幂等：全部 rename 仅在源存在且目标不存在时执行；完成后不存在旧名则无需标记文件。

### S2.3 删除壳自更新

- 删除 `dshusb/client-updater.js`。
- `main.js` 移除：`clientUpdater` require、`runClientUpdateFlow`、`offerPendingClientUpdate`、IPC `check-client-update`、`pendingClientUpdate` 读写、相关菜单项与自动检查调用点。
- `settings.json` 中历史 `pendingClientUpdate` 字段忽略即可，不主动迁移。
- agent 更新链路（`updater.js`、`runUpdateFlow`、`handleBootFailure` 回退）保持不动。

### S2.4 exFAT 补丁加固

对 `patchBootForExfat` 的契约：

1. **匹配策略**：每步提供多个候选锚点（至少 2 个）；候选按顺序尝试，命中任一即替换。锚点两侧空白可容忍 `\r\n`/`\n` 与缩进差异（先做轻量规范化：统一 `\r\n`→`\n`，再匹配；写回用规范化后的文本）。
2. **已补丁判定优先**：若目标标记（`function dshCopyCurrent`、`optionalDependencies` 补丁、`.dsh-copy-ok`、`cpSync` 回退）均已存在 → 直接返回成功，不再找锚点。
3. **分步独立**：每步替换后仍可继续后续步骤；某步无锚点且对应标记缺失 → 立即失败，错误信息包含该步名称与尝试过的锚点摘要。
4. **语法校验**：补丁写回后用内置 Node 执行 `node --check <bootFile>`；失败则回滚写入（保留原内容）并报错。
5. **结构化日志**：每步记录 `applied|already|failed`，便于 `logs/update.log` 排查。

`patchMcpPath`：锚点找不到时只 warn 不失败（非致命路径修复）。

### S2.5 临时/备份文件清理

| 目录 | 更新成功后 | 启动清扫 |
|------|------------|----------|
| `deepseek-ai-staging` | 已 rename 走，若仍存在则删除 | 删除 |
| `deepseek-ai-old-*` | 仅保留最新 1 个，更旧的删除 | 同左 |
| `deepseek-ai-broken-*` | 保留最新 1 个 | 同左 |
| `updates/`（壳更新残留） | 不再产生 | 目录非空则整体删除 |

清扫函数在 `main.js` boot 与 `updater.applyUpdate` 成功路径各调用一次；删除失败仅记日志，不阻断启动/更新。

### S2.6 版本

壳 `version` / `APP_VERSION`：`1.2.0` → `1.3.0`。

## [S3] Out of Scope

- 不改变 agent 更新的 npm 源、用户确认对话框、30 分钟超时逻辑。
- 不实现壳更新的替代方案（新仓库 Releases、差量更新等）。
- 不迁移/清洗用户已有 `dsh-home` 内的插件 `node_modules` 体积。
- 不修改打包器/自解压安装包制作脚本（仓库内本就没有）。
- 不处理 Linux/macOS 路径（项目仅 Windows x64）。

## Tasks

- [ ] T1: 源码目录 `shell/` 重命名为 `dshusb/`，更新 package.json name 与 README 中的目录引用 — acceptance: git 树内无 `shell/` 路径；`dshusb/package.json` name=dshusb；README 结构图指向 dshusb/ (covers: S2.1)
- [ ] T2: `main.js` userData → `dshusb`，DSH_HOME → `.dsh`，实现旧 `dsh/`→`dshusb/`、`agent`→`deepseek-ai`、`dsh-home`→`.dsh` 启动迁移 — acceptance: 仅存在旧布局时一次启动后新布局出现且数据完整；再次启动无重复迁移日志 (covers: S2.1; S2.2; depends: T1)
- [ ] T3: `updater.js` overlay/staging/备份路径改为 `deepseek-ai*` 命名，保持原子交换与回滚语义 — acceptance: 单元级路径函数返回新路径；applyUpdate 失败不破坏现网 overlay (covers: S2.1; depends: T2)
- [ ] T4: 删除 client-updater.js 及 main.js 中全部壳更新入口/IPC/菜单/设置读写 — acceptance: 代码库无 clientUpdater 引用；手动触发 agent 更新仍可用 (covers: S2.3; depends: T2)
- [ ] T5: 加固 `patchBootForExfat`：多锚点、已补丁短路、分步日志、写回后 node --check — acceptance: 对含 CRLF 的样例能补丁成功；已补丁文件返回 already；锚点全失配时 applyUpdate 在 swap 前失败 (covers: S2.4; depends: T3)
- [ ] T6: 实现启动清扫 + 更新成功后清扫（staging/old/broken/updates） — acceptance: 手工放入多余 `deepseek-ai-old-*` 后启动仅保留 1 个；staging 残留被删 (covers: S2.5; depends: T3)
- [ ] T7: 同步 `scripts/update-dsh.ps1`、`scripts/hide-sidebar-buttons.ps1`、shell README、根 README 的路径与版本 1.3.0 — acceptance: 脚本默认路径能解析到新布局；文档无 dsh-home/agent 旧名残留（历史说明除外）(covers: S2.1; S2.6; depends: T2)
- [ ] T8: 语法/静态验证：`node --check` 所有改动的 .js；PowerShell 脚本 `Parser::ParseFile` 无错 — acceptance: 本地验证命令全部 exit 0 (covers: S2.1; S2.3; S2.4; S2.5; depends: T2,T3,T4,T5,T6,T7)
