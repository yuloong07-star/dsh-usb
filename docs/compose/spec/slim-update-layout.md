---
feature: slim-update-layout
status: delivered
updated: 2026-09-09
branch: feat/slim-update-layout
commits: 36cd2c5..HEAD
---

# 精简升级体系与目录布局重命名

## Report

**What was built** — 移除了壳自更新，仅保留 agent 更新链路。运行时布局改为嵌套的 `dshusb/deepseek-ai` + `dshusb/.dsh`，源码目录 `shell/` 同步更名 `dshusb/`；模块加载阶段（早于 `app.setPath`）完成旧 `dsh/` 布局迁移，空的新目录可被替换。exFAT 补丁改为多锚点 + loose 回退 + ESM 感知的 `node --check`，失败回滚。启动与更新成功后自动清扫 staging、过期备份（保留最新 1）与 `updates/` 残留。exFAT 上改为 ESM proxy 模块链接（不再整包复制），启动探测 junction 并注入 `DSH_USB_PROXY_MODULES`，每次 dsh 启动自动 heal。壳版本 1.3.0。

**Verification** — `node --check` main.js/updater.js/preload.js/session-watcher.js/update-preload.js 全部 PASS；`Parser::ParseFile` 对 update-dsh.ps1 与 hide-sidebar-buttons.ps1 PASS；独立 review 对 36cd2c5..a58b95a 报出迁移竞态与 PS1 交换路径 2 个 critical，修复提交 2e24bef 后复审全部 RESOLVED、无新 critical、总体 PASS。

**Journey log** —
- 沙箱拦截 `git worktree add`，改由用户在终端创建 worktree。
- Review 发现模块级 `setPath` 会抢先物化空 `dshusb/`，迁移必须提前到模块加载，并把「空目录」视为可替换。
- PS1 里 legacy `$AgentDir` 回退在 swap 后仍指向旧路径，必须用 `$script:AgentDir` 写回。
- `node --check` 对 ESM boot 文件可能按 CJS 解析失败，增加 `.mjs` 临时副本重试。
- git 身份用环境变量对齐仓库既有作者，未改 git config。

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

迁移在**模块加载阶段、`app.setPath` 之前**执行（并在 boot 再跑一次，幂等），避免 Chromium/单实例锁抢先创建空目录：

1. 若 `<exe-dir>/dsh` 存在且 `<exe-dir>/dshusb` 不存在 → `rename(dsh, dshusb)`。
2. 若两者同时存在且 `dshusb` 仅含 lock/Singleton* → 删除空新目录后 rename。
3. 若两者同时存在且 `dshusb` 有实质内容 → 不合并，保留 `dshusb`，旧 `dsh` 原地不动并写日志警告。
4. 在 userData 根内：`agent` → `deepseek-ai`，`dsh-home` → `.dsh`（目标已存在则跳过）。
5. 幂等：全部 rename 仅在源存在且目标不存在时执行。

### S2.3 删除壳自更新

- 删除 `dshusb/client-updater.js`。
- `main.js` 移除：`clientUpdater` require、`runClientUpdateFlow`、`offerPendingClientUpdate`、IPC `check-client-update`、`pendingClientUpdate` 读写、相关菜单项与自动检查调用点。
- `settings.json` 中历史 `pendingClientUpdate` 字段忽略即可，不主动迁移。
- agent 更新链路（`updater.js`、`runUpdateFlow`、`handleBootFailure` 回退）保持不动。

### S2.4 exFAT 补丁加固

对 `patchBootForExfat` 的契约：

1. **匹配策略**：每步提供多个候选锚点（至少 2 个）+ 空白宽松的 regex 回退；候选按顺序尝试，命中任一即替换。先做 EOL 规范化（`\r\n`→`\n`）。
2. **已补丁判定优先**：若目标标记（`function dshCopyCurrent`、`optionalDependencies` 补丁、`.dsh-copy-ok`、`cpSync` 回退）均已存在 → 直接返回成功。
3. **分步独立**：某步无锚点且对应标记缺失 → 立即失败，错误信息包含该步名称。
4. **语法校验**：写回后 `node --check`；若因 ESM `import` 失败则以 `.mjs` 临时副本重试；仍失败则回滚原内容并报错。
5. **结构化日志**：每步记录 `applied|already|failed`。

`patchMcpPath`：锚点找不到时只 warn 不失败。

### S2.5 临时/备份文件清理

| 目录 | 更新成功后 | 启动清扫 |
|------|------------|----------|
| `deepseek-ai-staging` | 已 rename 走，若仍存在则删除 | 删除 |
| `deepseek-ai-old-*` | 仅保留最新 1 个，更旧的删除 | 同左 |
| `deepseek-ai-broken-*` | 保留最新 1 个 | 同左 |
| `updates/`（壳更新残留） | 不再产生 | 整体删除 |

清扫在 boot 与 `applyUpdate` 成功路径各调用一次；删除失败仅记日志。

### S2.6 版本

壳 `version` / `APP_VERSION`：`1.2.0` → `1.3.0`。

### S2.7 exFAT ESM proxy 模块模式（增补）

exFAT/FAT32 无法创建 junction。原先失败后整包 `cpSync` 复制（体积大、换盘符需重拷）。改为：

1. **proxy 补丁**：`isPackagedExecutable()` 在 `process.env.DSH_USB_PROXY_MODULES === '1'` 时也为真，使 `resolveModuleFallbackEntries` 产出 `kind: "proxy"`（小体积 ESM re-export 包），不再走 symlink/整包复制。补丁含多锚点 + 已补丁短路 + `node --check`；旧补丁可单独补齐 proxy-step。
2. **启动探测**：在 userData 下探测 junction；失败则 `proxyModules=true`，子进程环境注入 `DSH_USB_PROXY_MODULES=1`。
3. **残留清理**：proxy 模式下删除 `profiles/**/node_modules` 中「无 `dsh.moduleFallback` 的真实目录」与失效 symlink，保留合法 proxy，供 heal 重建。
4. **每次启动 heal**：`profile-boot` 每次 dsh 启动都会调用 `healProfilesModuleFallback`（幂等；路径变化时 targets 不匹配会重建 proxy）。壳侧不重复调用。
5. **update-dsh.ps1**：`Invoke-ProfileHeal` 同样探测 junction 并注入环境变量；`Set-AppBootCompatibility` 同步打 proxy 补丁。

## [S3] Out of Scope

- 不改变 agent 更新的 npm 源、用户确认对话框、30 分钟超时逻辑。
- 不实现壳更新的替代方案（新仓库 Releases、差量更新等）。
- 不迁移/清洗用户已有数据层内的插件 `node_modules` 体积。
- 不修改打包器/自解压安装包制作脚本（仓库内本就没有）。
- 不处理 Linux/macOS 路径（项目仅 Windows x64）。

## Tasks

- [x] T1: 源码目录 `shell/` 重命名为 `dshusb/`，更新 package.json name 与 README 中的目录引用 — acceptance: git 树内无 `shell/` 路径；`dshusb/package.json` name=dshusb；README 结构图指向 dshusb/ (covers: S2.1)
- [x] T2: `main.js` userData → `dshusb`，DSH_HOME → `.dsh`，实现旧布局启动迁移 — acceptance: 仅存在旧布局时一次启动后新布局出现且数据完整；空新目录可替换 (covers: S2.1; S2.2; depends: T1)
- [x] T3: `updater.js` overlay/staging/备份路径改为 `deepseek-ai*` 命名，保持原子交换与回滚语义 — acceptance: 路径函数返回新命名；applyUpdate 失败不破坏现网 overlay (covers: S2.1; depends: T2)
- [x] T4: 删除 client-updater.js 及 main.js 中全部壳更新入口/IPC/菜单/设置读写 — acceptance: 代码库无 clientUpdater 引用；手动触发 agent 更新仍可用 (covers: S2.3; depends: T2)
- [x] T5: 加固 `patchBootForExfat`：多锚点、已补丁短路、分步日志、写回后 ESM 感知 node --check — acceptance: 已补丁文件返回 already；锚点全失配时 applyUpdate 在 swap 前失败；语法失败回滚 (covers: S2.4; depends: T3)
- [x] T6: 实现启动清扫 + 更新成功后清扫（staging/old/broken/updates） — acceptance: 多余 old 备份启动仅保留 1 个；staging 残留被删 (covers: S2.5; depends: T3)
- [x] T7: 同步脚本与 README 路径、版本 1.3.0 — acceptance: 脚本默认路径解析到新布局（含 legacy 回退与向上找 exe）(covers: S2.1; S2.6; depends: T2)
- [x] T8: 语法/静态验证：`node --check` 改动 .js；PowerShell `Parser::ParseFile` — acceptance: 验证命令全部 PASS (covers: S2.1; S2.3; S2.4; S2.5; depends: T2,T3,T4,T5,T6,T7)
- [x] T9: exFAT 改用 ESM proxy 模块：boot 补丁 + 启动探测注入 env + 清理残留 + 脚本同步 — acceptance: 对已打过 copy 补丁的真实 boot 文件可增量补 proxy 且二次调用 already；PS1 解析通过 (covers: S2.7)

