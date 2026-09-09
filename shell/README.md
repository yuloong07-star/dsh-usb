# DSH USB — 壳源码

便携版 Electron 壳（`DSH USB.exe` 的应用层），对应 Release 里的 `DSH-USB-portable-x64.exe`。

## 目录

```
shell/                 # Electron 主进程源码（部署时放到 resources/app）
  main.js              # 启动、托盘、spawn dsh web
  preload.js           # 渲染进程桥
  updater.js           # dsh agent 检查/安装
  client-updater.js    # 壳自更新（本仓库 Release）
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
resources/app/         ← 本仓库 shell/ 的内容 + node_modules
resources/node/        # 内置 Node 24
resources/npm/
dsh/                   # userData / DSH_HOME（不入库）
  agent/               # @deepseek-ai/dsh
  dsh-home/            # 设置、会话、记忆、插件 profile
```

## 版本

当前壳版本：**1.2.0**（见 `shell/package.json` 与 `main.js` 的 `APP_VERSION`）。

v1.2.0 相对 v1.1.0：
- 壳源码开源入库
- 配套维护脚本入库
- 发布说明见 GitHub Release
