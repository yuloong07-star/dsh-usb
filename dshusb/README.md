# DSH USB — 壳源码

便携版 Electron 壳（`DSH USB.exe` 的应用层），对应 Release 里的 `DSH-USB-portable-x64.exe`。

## 目录

```
dshusb/                # Electron 主进程源码（部署时放到 resources/app）
  main.js              # 启动、托盘、spawn dsh web、旧布局迁移、临时清扫
  preload.js           # 渲染进程桥
  updater.js           # dsh agent 检查/更新（含 exFAT 补丁与备份清扫）
  session-watcher.js
  update-preload.js
  package.json         # version = 壳版本
  assets/              # 图标、loading 页、内置插件
scripts/
  update-dsh.ps1       # 宿主机 npm install + exFAT 补丁更新 agent
  hide-sidebar-buttons.*
```

## 与运行时布局的关系

部署后的便携目录：

```
DSH USB.exe
resources/app/         ← 本仓库 dshusb/ 的内容 + node_modules
resources/node/        # 内置 Node 24
resources/npm/
dshusb/                # userData（不入库；1.3.0 起，旧名 dsh/ 启动时自动迁移）
  deepseek-ai/         # agent overlay（旧名 agent/）
  .dsh/                # DSH_HOME：设置、会话、记忆、插件 profile（旧名 dsh-home/）
```

## 升级

- **Agent 更新**（应用内「检查更新」）：npm 装到 `deepseek-ai-staging` → 打 exFAT 补丁 → 原子交换为 `deepseek-ai`；备份保留最新 1 份。
- **壳更新**：已移除。新壳请从 Releases 手动下载替换。
- 旧布局（`dsh/agent`、`dsh/dsh-home`）首次启动自动重命名迁移。

## 版本

当前壳版本：**1.3.0**（见 `dshusb/package.json` 与 `main.js` 的 `APP_VERSION`）。

v1.3.0 相对 v1.2.0：
- 移除壳自更新，仅保留 agent 更新
- 目录布局：`dshusb/deepseek-ai` + `dshusb/.dsh`
- exFAT 补丁多锚点加固 + `node --check`
- 更新/启动自动清扫 staging 与过期备份

v1.2.0：
- 壳源码开源入库
- 配套维护脚本入库
- 发布说明见 GitHub Release
