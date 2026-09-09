# DSH USB — 完整指南

> 进入 DSH 目录必须先读此文件。文件增删必须同步更新此文件。
> **超过 200 行时必须压缩，压缩时优先保证目录概览的完整性；§7 修改经验每改必填，达上限压缩后精炼合并（保留日期/改动摘要/备份路径）。**

## 1. 核心原则

- **DSH = DeepSeek Harness**：本地 AI 代理框架 + Web GUI，便携 USB 版（exFAX）。
- **Cordis 插件系统**：功能通过插件加载，双端架构（Host 服务端 + Client 浏览器端）。
- **启动**：双击 `DSH USB.exe` 或 `launcher.bat`（关闭自动更新），访问 `http://127.0.0.1:3080`。
- **数据全本地**：运行数据在 exe 旁 `dsh/dsh-home`，不写 `%APPDATA%`、不写注册表。

## 1.5 运行环境约束（U盘运行，必读）

- **运行介质**：DSH 运行在 exFAX 文件系统的 U 盘（E:）上，C: 为宿主机系统盘。
- **npm/pnpm 等安装**：优先在宿主机 C 盘安装/下载，再把产物拷回 DSH，避免 U 盘频繁 IO、写放大。
  ⚠️ web profile `node_modules` 是 **pnpm 布局**（含 `.pnpm/` 硬链接目录），跨盘拷贝会破坏硬链接
  → 拷贝后必须 `pnpm install` 重建。
- **临时文件**：任务中产生的临时文件（临时目录、缓存、构建产物、附件、视觉产物等）结束后必须清理。
- **★ 备份**：所有备份统一放 `dsh-home/backups/`，命名 `<主题>-<时间戳>`（如 `balance-uninstall-20260822-153536`）；改动/删除关键文件前必须先备份到此目录，禁止散落在其它位置。存量备份已于 2026-09-03 应用户要求全部清空，下文历史记录中引用的备份路径均已失效。

## 2. 目录结构

`
./  （E:\Mobile-AI\dsh）
├── DSH USB.exe / launcher.bat       # 启动入口
├── hide-sidebar-buttons.ps1 / .cmd  # 一键隐藏左下角「记忆」/「Lark」/「自动化」与顶部「壁纸仓库」按钮（插件更新后重跑）
├── update-dsh.ps1                   # 核心 agent 检查/更新脚本（-Check 纯检查）
├── resources/app/                   # Electron 主程序
│   ├── main.js / preload.js / update-preload.js
│   ├── updater.js / client-updater.js / session-watcher.js
│   ├── assets/plugins/              # 内置插件（不可卸载）
│   │   └── dsh-file-changes/ dsh-client-file-changes/ dsh-plugin-marketplace/ dsh-terminal/
│   └── node_modules/@deepseek-ai/   # 主应用 node_modules（第3优先级）
├── dsh/                             # Electron 运行时缓存 userData（Cache 等）
│   ├── dsh-home/                    # ★ DSH_HOME 运行时数据
│   │   ├── settings.yaml  .credentials.yaml   # 用户设置 / API Key 凭据
│   │   ├── memory/                  # ★ dsh-mneme 记忆库（SQLite + Markdown 镜像）
│   │   ├── .agent-presets/          # Agent 预设（router-standard）
│   │   ├── profiles/
│   │   │   ├── node_modules/        # ★ profile 级（第2优先级）完整框架插件
│   │   │   └── web/                 # Web profile
│   │   │       ├── cordis.yml / cordis.patch.yml
│   │   │       ├── package.json / pnpm-lock.yaml / pnpm-workspace.yaml
│   │   │       ├── node_modules/    # ★ web profile 级（第1优先级，pnpm 布局）
│   │   │       ├── vendor/          # 离线安装包 (.tgz)
│   │   │       └── 遗留副本已清理（备份于 backups/legacy-plugins-cleanup-20260822-154707）
│   │   ├── sessions/ storages/ attachments/v1/ logs/ bin/ cache/
│   │   ├── lark-link/               # 飞书桥接运行数据
│   │   ├── backups/              # ★ 所有备份统一存放（改动前先备份到此）
│   │   └── super-injector/       # 超级注入器 registry
│   └── agent/node_modules/          # Agent 子进程（@deepseek-ai/dsh 0.1.1-rc.2）
├── dsh-home/dev/dsh-automation       # dsh-automation 源码开发副本（git clone）
├── locales/  *.pak / *.dll          # 语言包与 Electron 资源
└── 根级缓存：.dsh/（插件更新报告） .npm-cache/（应迁 C 盘） .dsh-vision-router/（遗留）
`

> 💡 真实 DSH_HOME 是 `E:\Mobile-AI\dsh\dsh\dsh-home`；根目录 `dsh-home/` 只是开发副本，勿混淆。

## 3. ★ node_modules 优先级（踩坑核心）

加载 Client 插件顺序：**profiles/web/node_modules → profiles/node_modules → resources/app/node_modules**

| 包名 | 位置 | 说明 |
|------|------|------|
| dsh-client-ui-settings-general | **profiles/node_modules** | ★ 设置页通用（勿改主应用版） |
| dsh-client-ui-settings-plugins / -models / -plugin-inventory | profiles/node_modules | 插件/模型/插件列表页 |
| dsh-client-ui-agent-preset | profiles/node_modules | Agent 预设 |
| dsh-vision-router / dsh-better-sidebar / dsh-plugin-wallpaper-engine / dsh-lark-link | profiles/web/node_modules | 视觉/侧边栏/壁纸/飞书 |
| @modusensus/dsh-mneme | profiles/web/node_modules/@modusensus | 记忆系统 |
| dsh-superpower | profiles/web/node_modules | superpowers 方法论技能集（obra/superpowers DSH 移植，15 技能） |
| @dsh-external/dsh-automation / dsh-super-injector | profiles/web/node_modules/@dsh-external | 自动化/热注入器 |
| @deepseek-ai/dsh-file-changes / dsh-client-file-changes / dsh-plugin-marketplace / dsh-terminal | profiles/web/node_modules/@deepseek-ai | 内置插件（web profile 版） |

> ⚠️ **改 dsh-client-ui-settings-general 必须改 profiles/node_modules 里的，不是 resources/app 里的！**

## 4. Profile 配置

### cordis.patch.yml（`profiles/web/cordis.patch.yml`，插件装配补丁）
`yaml
- insert: { id: file-changes, name: '@deepseek-ai/dsh-file-changes' }
- insert: { id: client-file-changes, name: '@deepseek-ai/dsh-client-file-changes' }
- insert: { id: terminal, name: '@deepseek-ai/dsh-terminal' }
- insert: { id: plugin-marketplace, name: '@deepseek-ai/dsh-plugin-marketplace' }
- id: attachment-local  config: { maxImageBytes: 20971520, maxImagePixels: 100000000 }
- insert: { id: dsh-super-injector, name: '@dsh-external/dsh-super-injector' }
`

### package.json（`profiles/web/package.json`，依赖 + bundles）
`json
dependencies: @dsh-external/dsh-automation(github:titanwings#v0.1.7) · @huanlin/dsh-plugin-mineru ^0.2.4 · @modusensus/dsh-mneme 0.7.6 · @omdsh-dev/dsh-genui(github) · dsh-better-sidebar 0.17.1 · dsh-computer-use-win(github:Yu-tao-Li#04f4643) · dsh-doc ^0.1.1 · dsh-lark-link 0.5.2 · dsh-plugin-install 0.3.10 · dsh-plugin-wallpaper-engine 0.6.8 · dsh-superpower 6.3.0-dsh.6 · dsh-vision-router 2.1.0 · dsh-capability-index(github:777-Zen#776ba89)
bundles: dsh-base · dsh-web-app · dsh-vision-router · dsh-better-sidebar · dsh-plugin-wallpaper-engine · dsh-mneme · dsh-automation · dsh-lark-link · dsh-plugin-install · dsh-superpower · dsh-plugin-mineru · dsh-genui · dsh-doc · dsh-computer-use-win · dsh-capability-index
`

### 设置页导航（settings.section 插槽，以实际 UI 为准）
general(0) → models(10) → plugins(15) → agent-presets(20) → better-sidebar(100)

### 定时任务（dsh-automation）修改方法
- 存储：`dsh-home/storages/dsh_automation.json`（definitions=任务、runs=运行历史）；运行中 DSH 以内存态为准。
- 改法：① 优先 Web 设置/服务更新（automation_update）即时生效并落盘；② 离线改=退出 DSH → 编辑 JSON → 重启。
- ⚠️ 运行中裸改磁盘文件会被进程下次写覆盖，且需重启才生效。
- 规范：改前按 §1.5 备份到 backups/（`<主题>-<时间戳>`）；手动编辑时 revision+1、updatedAt=now。
- 现状：daily-plugin-update（02:30，已含「升级前备份到 backups/」）、daily-plugin-skill-recommend（04:00）；2026-08-23 起两任务 provider/model 改为 xiaomi/mimo-v2.5，recommend 任务改为「基于记忆库 + @AGENTS.md 已装插件与内置 skill 基线，推荐新的插件/skill」（离线编辑 storages/dsh_automation.json，需重启 DSH 生效）。

## 5. 插件清单（当前实际装配）

### Bundle 插件（package.json `bundles`）
| 插件 | 包名/版本 | 功能 |
|------|-----------|------|
| 基础包 | @deepseek-ai/dsh-base 0.1.1-rc.2 | 所有 profile 共享基础服务 |
| Web 应用 | @deepseek-ai/dsh-web-app 0.1.1-rc.2 | Web GUI 核心 |
| 视觉路由 | dsh-vision-router 1.7.7 | 视觉模型路由（glm-4.6v 等） |
| 增强侧边栏 | dsh-better-sidebar 0.15.2 | VSCode 风格右侧边栏 |
| 壁纸引擎 | dsh-plugin-wallpaper-engine 0.6.3 | 壁纸背景 |
| 记忆系统 | @modusensus/dsh-mneme 0.7.6 | 跨会话记忆（取代 claude-mem）；0.7.6 起仓库根布局，client.js 在包内 dsh-mneme\ 子目录 |
| 自动化 | @dsh-external/dsh-automation 0.1.7 (github) | 定时/循环自动化任务 |
| 飞书桥接 | dsh-lark-link 0.4.1 | 飞书消息桥接 |
| 设置页装插件 | dsh-plugin-install 0.3.9 | 设置页按包名直装任意插件（npm/github/本地路径） |
| Windows Computer Use | dsh-computer-use-win 0.1.2 (github) | MCP stdio server + PowerShell UIA 引擎，22 工具经内置 dsh-mcp-client 桥接（前缀 mcp__wincu__），控制 Windows 界面/截图 |
| 插件库预检 | dsh-capability-index 0.2.0 (github) | 任务型请求时预检插件库并注入 Top-K 适用插件提示（触发表+语义双通道、not_for 守门、本地决策日志；权重缓存 DSH_HOME/.cache） |
| Superpowers | dsh-superpower 6.3.0-dsh.6 | obra/superpowers DSH 移植：多智能体开发方法论技能（brainstorming / subagent-driven-development / TDD / systematic-debugging / writing-plans 等 15 个） |
| 文档智能 | dsh-doc 0.1.1 | 全本地文档解析：PDF/Office/图片/离线 OCR（Xberg 引擎 + 本地 python runtime，runtime 在 DSH_HOME/runtimes/dshdoc-runtime-win32-x64） |
| 生成式 UI | @omdsh-dev/dsh-genui 0.9.1 (github) | 回答内嵌交互 UI（dsh-ui 围栏：图表/表单/测验/面板等 30+ 组件，含 genui skill；双通道渲染 registry/DOM 兜底） |

### 内置/补丁插件（cordis.patch.yml + assets/plugins）
| 插件 | 包名 | 功能 |
|------|------|------|
| 文件变更 | @deepseek-ai/dsh-file-changes | 文件变更追踪 |
| 文件变更 Client | @deepseek-ai/dsh-client-file-changes | 文件变更 UI |
| 终端 | @deepseek-ai/dsh-terminal | Web 终端 |
| 插件市场 | @deepseek-ai/dsh-plugin-marketplace | 浏览和安装插件 |
| 超级注入器 | @dsh-external/dsh-super-injector 0.3.3 | 运行时热注入插件（registry：dsh-home/super-injector/） |

### 遗留插件（已清理）
**dsh-claude-mem**（旧记忆，已被 dsh-mneme 取代）、**dsh-cmem-sidebar-tab**、**dsh-reasoning-effort-cycler**
已于 2026-08-22 清理删除（备份于 `backups/legacy-plugins-cleanup-20260822-154707`），勿再装配。

### Skill 清单（仅 E: 内置）
> 只跟踪 E: 盘 DSH 安装内置的 skill；C: 盘用户级 skill（`~/.agents/skills`，73 个）不纳入每日检查。
> 来源：`dsh/agent/node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/skills`

| Skill | 说明 |
|-------|------|
| cordis-plugin-development | 开发/调试/扩展动态 Cordis 插件（Host 服务、Client UI、动态工具等） |
| editing-cordis-compositions | 编写/校验 Cordis 组合（agent preset、插件行、host vs session 归属） |
| find-plugins | 会话内搜索/安装/验证 GitHub dsh-plugin 插件（来源：`dsh-home/skills/find-plugins/`） |

> 另有 dsh-superpower 插件自带的 15 个方法论技能（来源：`profiles/web/node_modules/dsh-superpower/skills/`，非上述内置源）：
> brainstorming、subagent-driven-development、test-driven-development、systematic-debugging、writing-plans、executing-plans、
> using-superpowers、requesting/receiving-code-review、verification-before-completion、dispatching-parallel-agents、
> using-git-worktrees、writing-skills、finishing-a-development-branch。

## 6. 修复记录

- **图片发送失败 ATTACHMENT_WRITE_FAILED**：`dsh-attachment-local` 用 `fs.link()` 发布附件，exFAT 不
  支持硬链接抛 `EISDIR` → 回退原子 `rename()`；补丁覆盖三处副本（profiles/node_modules、resources/app、
  dsh/agent 的 `@deepseek-ai/dsh-attachment-local/lib/index.js`）；⚠ DSH/agent 更新会覆盖此补丁，更新后必须复查重打。需重启生效。
- **重复"插件"设置条目**：settings-general client.js 过滤掉标签含"插件"但 id≠plugins 的条目。
- **修改不生效排查**：① 检查改的是哪个 node_modules 层级 ② Ctrl+F5 ③ 重启 DSH ④ React 错误 #130。

## 7. 修改经验（每改必填）

> ⚠️ 对 DSH 的任何修改（文件/插件/配置/脚本/本文件自身）都必须在此追加记录；达 200 行上限时压缩合并，压缩后保留精炼要点（日期、改动摘要、备份路径），优先保证目录概览与插件清单完整。

| 日期 | 修改内容 |
|------|---------|
| 2026-09-08 | router-standard 预设升级 v0.2.0→v0.3.0（经典稳定线）：上游 yjh051108/dsh-router-standard 已归档并入 dsh-routing-suite（单仓库，7.1k★，最后推送 09-04）；从 suite `preset/dsh-router-standard-0.3.0.tgz` 提取 router-standard 平铺覆盖 dsh-home\.agent-presets\router-standard。v0.3.0 关键变化=首轮路由真实生效（agent/inbox/claimed 装配前捕获首条消息，不再首轮无条件 weak）+ 近距离引导改走 agent/pre-step 同请求注入（砍掉每轮多余的第 2 次 API 调用，费用减半）+ 缺导入/YAML 引号/promoted 回归修复；7 个 .mjs node --check 通过；已用 dev_reload_preset 给 router-bootstrap.mjs 挂 ?v=1 击穿 ESM 缓存并手工给其内部 import './router-core.mjs' 补 ?v=1（防同名路径旧模块缓存残留）。**未装**主线 v1.27（注意力工程研究线：分阶段解锁工具/engram 分层/需 Git Bash/引用缺失的 we-persona.txt，行为大改不作为默认）。新会话即生效；如异常可 dev_reload_preset 再 ?v 自增，或用备份回滚。备份 backups/router-standard-upgrade-v03-20260908-202907（含 router-standard-v02 完整副本 + previous-router-standard 原目录） |
| 2026-09-06 | 飞书桥接回复失效修复（两轮）：dsh-lark-link 升级（0.4.x→0.5.2）后插件默认 agentPreset=code，而系统预设已无 code（available: standard/ptc/minimal/cordis/router-standard）→ 飞书消息「恢复旧会话失败+新建会话失败」双双崩溃、回复不发出（22:23 私聊实测，dsh-web.log 有 ERROR）。**第一轮走弯路**：cordis.patch.yml 写 agentPreset 无效——插件 createConfigStore 只从装配 config 读 groupPolicy/denyList 两键，其余键一律用内置默认或 lark-link/runtime-overrides.json（持久化覆盖层，优先级最高），dump-config 合成成功≠运行时生效（重启后复现验证）。**真正修复**=写 DSH_HOME/lark-link/runtime-overrides.json {"agentPreset":"standard"}（无 BOM，JSON.parse 拒 BOM）+ 飞书可发 /lark-config agentPreset=standard 热更（命令在会话创建前由 commandRouter 处理，不受故障影响）；patch 的 lark-link 块仅保留 groupPolicy: mention 防御性锁定。备注：旧会话 resume 因历史 preset=code 永远 WARN 回退新建，无害；conversation-overrides.json 仅存 activeSessionId 不用动。备份 backups/lark-preset-fix-20260906-223658 |
| 2026-09-06 | 图片发送失败 ATTACHMENT_WRITE_FAILED 复发修复：当日 19:35 升级 0.1.2-rc.1 离线刷新 profiles/node_modules 覆盖了 dsh-attachment-local 的 exFAT 硬链接补丁（新版 commitPreparedImageFile 结构已变，旧补丁不可整文件复制）；把 resources/app 旧版已验证补丁（hardLinkUnsupported 判定 EISDIR/EPERM/ENOSYS/EINVAL/EXDEV/ENOTSUP → 原子 rename 回退 + 成功路径 unlink 容忍 ENOENT）移植进 profiles/node_modules 与 dsh/agent 两份新版 lib/index.js（resources/app 副本补丁本就在）；node --check 通过；需重启 DSH 生效。⚠ 每次 DSH/agent 更新后必须复查此补丁。备份 backups/attachment-local-exfat-fix-20260906-202927 |
| 2026-09-06 | 修复 0.1.2-rc.1 更新后打不开：给 dsh-app-boot 0.1.2 打 exFAT 复制回退补丁（.dsh-copy-ok 内容=目标路径）并把 optionalDependencies 纳入回退闭包（koffi 等原生模块不再残留旧版）；恢复 agent=0.1.2-rc.1，离线刷新 profiles/node_modules；修 dsh-computer-use-win MCP 路径为 node_modules/dsh-computer-use-win/mcp/server.mjs；新增根目录 update-dsh.ps1（-Check/-Force/-Version/-Yes/-Launch/-DryRun），resources/app/updater.js 应用内更新同步打补丁且保留 agent-old-*。备份 backups/dsh-exfat-update-20260906-193530 |
| 2026-09-04 | 安装 dsh-capability-index 0.2.0（bundle，github:777-Zen/dsh-capability-index#776ba89，`dsh plugin --profile web add` 锁 commit）：插件库预检注入——任务型请求时按触发表+语义引擎（Xenova/bge-small-zh-v1.5 q8，首次从 hf-mirror 下载 ~24MB 权重到 DSH_HOME/.cache，失败自动降级纯规则）注入 Top-K 适用插件提示，含 not_for 守门与本地决策日志（decisions.jsonl）；安全审查通过（无 lifecycle 脚本/零 npm 依赖/无子进程/无凭据读取/仅写 DSH_HOME 缓存，MIT）；dump-config 验证 insert 已合成，需用户重启 DSH 生效；同步 §4/§5（补 computer-use-win 与本插件行，移除已不在装配中的 file-upload 行——当前 package.json/bundles/loader 均无），并压缩 08-18~23 三条旧记录保 200 行上限。备份 backups/capability-index-install-20260904-160537 |
| 2026-09-03 | 清空存量备份：应用户要求删除 dsh-home\backups\ 全部 31 个历史备份（1397 文件/63.1 MB）释放 U 盘空间；§1.5 备份规范不变，**此前各历史记录中引用的 backups/ 路径自此全部失效**；今后关键文件改动仍先备份到 backups/ |
| 2026-09-03 | 记忆按钮路径修复（mneme 0.7.6 仓库根布局，client.js 候选路径化；备份 sidebar-script-pathfix-20260903-193843、sidebar-buttons-hide-20260903-194139、agents-md-sidebar-script-fix-20260903-194224）+ settings.yaml tokenplan 增 `GLM-5.3-Flash`（大小写修正；备份 settings-tokenplan-glm53flash-20260903-184257、-namefix-20260903-185157）；均需重启 DSH 生效 |
| 2026-08-28 | 安装 dsh-computer-use-win 0.1.2（bundle，Windows Computer Use 插件：MCP stdio server + PowerShell UIA 引擎，22 工具走 DSH 内置 `@deepseek-ai/dsh-mcp-client` 桥接，工具前缀 `mcp__wincu__`）：`dsh plugin --profile web add 'github:Yu-tao-Li/dsh-computer-use-win#04f4643eba86b28ee26788dbe72e34fa87503852'`（用 dsh/agent/node_modules/.bin/dsh.cmd 0.1.1-rc.2）；安全检查通过（零网络/零凭据读取/只写 %TEMP% 的 C# 助手缓存 DLL 与截图/无 lifecycle 脚本，MIT，衍生自 cgissing/windows-computer-use）；已加入 package.json dependencies + bundles + pnpm-lock，`@deepseek-ai/dsh-mcp-client` v0.1.1-rc.2 位于 profiles/node_modules 可解析。需重启 DSH 生效，工具以 `mcp__wincu__windows_computer_use_*` 出现。备份 backups/computer-use-win-install-20260828-160928 |
| 2026-08-28 | 修复 glm-5.3-flash 识图 + 按官方文档优化配置：① settings.yaml zai 段 glm-5.3-flash 补 `input: [text, image]`（官方原生多模态，docs.bigmodel.cn 归 vlm 分类；根因=pi-ai 模态解析链 entry.input→内置目录→default ["text"]，该模型无目录条目且未声明→被判纯文本拒图）；② 同条目 maxTokens 256000→131072（官方最大输出 128K）；③ 经查 pi-ai schema 不可配置项（按官方建议跳过）：temperature/top_p（模型/provider 字段均无，supportsTemperature 仅 anthropic 协议提供）、thinking.clear_thinking、tool_stream（zaiToolStream=withhold 不可配）、视频/文件输入模态（MODALITIES 枚举仅 text/image）；④ contextWindow 1M、reasoningEffort max、thinkingFormat deepseek+off:null 与官方一致未动。需重启 DSH 生效（勿在重启前用设置页保存以免旧内存态覆盖）。备份 backups/settings-glm53flash-vision-20260828-122940、settings-glm53flash-optimize-20260828-123359 |
| 2026-08-28 | 给 zai/glm-5.3-flash（当前 agent 默认模型）增加思考强度：settings.yaml zai 段该模型加 `reasoningEfforts: {off: null, low: low, high: high, max: max}` + `compat: {thinkingFormat: deepseek, supportsReasoningEffort: true}`。依据智谱官方文档（docs.bigmodel.cn「深度思考」）：GLM-5.3 系仅支持 max（默认）/high/low 三档、强制思考不可关（`thinking.type:disabled` 报错）；pi-ai deepseek 方言选中档位发 `thinking:{type:enabled}`+`reasoning_effort`，**off:null 必须声明**（否则"未选档位"分支发 disabled → 5.3-flash 报错）；**不可给 zai 配 provider 级 `reasoning:` 默认档**（glm-4.6v 无 reasoning 元数据会抛 UNSUPPORTED_REASONING_EFFORT）。已实测官方端点接受 reasoning_effort:low（HTTP 200）。glm-4.6v 不支持强度未动；tokenplan/GLM-5.2 按用户限定未动。选 off=不发参数→模型仍按默认 max 思考（强制思考模型 off 仅占位）。需重启 DSH 生效（改后先重启，勿在热加载前用设置页保存以免旧内存态覆盖）。备份 backups/settings-glm53flash-effort-20260828-121521 |
| 2026-08-24 | 修复 autoDream 整合失败 + 真正开启自动打标签：根因=dream 后台 LLM 切 xiaomi/mimo-v2.5 后 auto 整合 81 次全 failed（08-22 23:00 切换，切换前用 agent 默认 DeepSeek 曾 5 次成功）——mimo-v2.5 对 200 条大快照 consolidation 提示词不输出可解析 JSON（llm_audit_logs 从无 auto_tag 操作）；修复=cordis.patch.yml dsh-mneme 块**移除 dreamProvider/dreamModel**（autoDream 回退 agent 默认 DeepSeek-V4-Flash-0731，可靠 JSON），Sleep 保留 xiaomi/mimo-v2.5（一直正常），并**新增 autoTagEnabled: true + autoTagMaxPerRun: 10**（⚠ 设置页「自动打标签」UI 开关只写 user_settings，0.7.0 未接线到执行路径=无效，必须在 patch 配置里开）；dump-config 验证已合成。需用户重启 DSH 生效。备份 backups/mneme-dream-fix-autotag-20260824-105817。**第二轮（快照修复，08-24 11:23）**：切 DeepSeek 后 200 条快照仍 `no json array`（实测 3 条小快照 DeepSeek 完美出 JSON、成功历史全在快照≤39 条、≥41 条 100% 失败）→ 根因是大快照撑爆模型输出；cordis.patch.yml 追加 **dreamMaxSnapshotSize: 40 + dreamMaxTokens: 32768**（防大数组截断），配合 implicit keep 滑动覆盖全库。备份 backups/mneme-snapshot-fix-20260824-112354。**第三轮（覆盖率修复，08-24 11:35）**：快照 40 后模型已能出 JSON 但随机报 `invalid decisions: 1 errors`（全局错误=显式覆盖率<50%）；实测 40 条快照直接调 DeepSeek 输出合法（11 决策/覆盖 65%/update 0），确认是 0.7.0 提示词「只输出问题条目」与 50% 覆盖率校验矛盾 → **dreamMinExplicitCoverage: 0.1**（仍拦截真截断）。备份 backups/mneme-coverage-fix-20260824-113514。**第四轮（存量批量补标签，08-24 12:11）**：用户要求把记忆库存量无标签记忆补上标签；用脚本按内容关键词给 217 条无标签记忆分配 1-3 个中文标签（概率论/考试复习/计组/LaTeX/MinerU/GPU/插件/自动化/飞书/DSH运维/界面/2FA/图片bug/学习），**同时更新 `memories.tags` 列（权威数据源，插件 toRow 读此列）与 `entity_attrs` 表（tag: 检索源）**——两者都要写才完整生效；宁缺毋滥，27 条琐碎/无实义记忆保持无标签。验证：`tag:概率论`/`tag:MinerU` 检索正常命中。备份 backups/memory-tag-backfill-20260824-121126 |
| 2026-08-24 | 安装 dsh-doc 0.1.1（bundle，`dsh plugin --profile web add dsh-doc`）+ dsh-genui 0.9.1（bundle+client+skill，`dsh plugin --profile web add git+https://github.com/omdsh-dev/dsh-genui.git`）：① pnpm-workspace.yaml minimumReleaseAgeExclude 补 8-23 升级的 mineru@0.2.4/mneme@0.7.0/plugin-install@0.3.9/wallpaper-engine@0.6.3（解锁 24h 发布年龄供应链策略）；② git 全局代理 http://127.0.0.1:10090 不可达→用 GIT_CONFIG_COUNT 环境变量临时覆盖绕过（不改全局配置）；③ tesseract.js allowBuilds 模板占位符改 true；④ dsh-doc 额外下载离线 OCR runtime 到 DSH_HOME/runtimes/dshdoc-runtime-win32-x64（60 文件 SHA-256+manifest 校验通过），cordis.patch.yml 补 config（engine: python/runtimeDir/defaultOcr: true/maxOutputChars: 32000）；⑤ dump-config 验证 genui+dsh-doc 已合成。需用户重启 DSH 生效。备份 backups/install-dshdoc-genui-20260824-093633、pnpm-workspace-before-install-20260824-093820 |
| 2026-08-24 | AGENTS.md §7「修改记录」改名「修改经验」并新增规则：对 DSH 的任何修改每改必填、达 200 行上限时压缩精炼（保留日期/改动摘要/备份路径） |
| 2026-08-24 | 扩展 hide-sidebar-buttons.ps1 隐藏「自动化」按钮与顶部「壁纸仓库」按钮：① 记忆按钮因 8-23 每日插件更新（dsh-mneme 0.7.0）复现，重新隐藏；② dsh-automation lib/client.js 的 sidebar.footer.action 注入加 `if (false)` 死代码（自动化保留顶部 conversation.view 标签）；③ dsh-plugin-wallpaper-engine lib/client.js 顶部「壁纸仓库」RopeDock 挂载整体禁用（`if (false && …)` + `[dsh-wallpaper-rope-disabled]` 标记，壁纸背景与设置页 Wallpaper Engine 不受影响）；备份 backups/sidebar-buttons-hide-20260824-093243、sidebar-buttons-hide-20260824-093244 |
| 2026-08-23 | AGENTS.md 压缩：212→186 行（超 200 上限）；§4 package.json 精简为单行、§7 旧记录（2026-08-18~22）合并为 2 行，§2 目录结构与 §5 清单保持完整；备份 backups/agents-compress-20260823-215447 |
| 2026-08-23 | 定时任务改模型 + 推荐任务重写（最终版）：① daily-plugin-skill-recommend prompt 重写为「基于 DSH 记忆库 + @AGENTS.md 已装插件与内置 skill 基线，推荐 3-5 个新的插件/skill，只推荐不安装」（第 2 步读 Agent.md 插件清单+Skill 清单作排除基线，第 5 步排除已装项+按能力缺口筛选，报告去掉「替代建议」小节）；② 两个定时任务（daily-plugin-update、daily-plugin-skill-recommend）provider/model 由 tokenplan-vision/DeepSeek-V4-Flash-0731 改为 xiaomi/mimo-v2.5（经确认 xiaomi 路由可用：mneme 已长期走该路由）；改法=离线编辑 storages/dsh_automation.json（recommend rev 4→5、update rev 4→5、updatedAt=now），需重启 DSH 生效，重启前运行中内存态仍为旧值、且任何自动化写入会覆盖该文件；备份 backups/automation-recommend-edit-20260823-212849、automation-recommend-rewrite-20260823-215010 |
| 2026-08-23 | 安装 dsh-file-upload 0.1.6（bundle，`dsh plugin --profile web add github:a903067276-rgb/dsh-file-upload#655149f`）：上传按钮 + 拖拽文件/文件夹直进对话，图片走官方附件条；安全审查通过（仅写附件目录 + 本地 explorer 打开目录，不读凭据、不联网外发）；清理旧残留 node_modules/.ignored_dsh-file-upload；备份 backups/dsh-file-upload-install-20260823-181528 |
| 2026-08-23 | 记忆图谱开启实体抽取：根因=图谱依赖 entities/entity_relations 表，而实体抽取是 opt-in（entityExtractionEnabled 默认 false）从未开启→三表 0 行；cordis.patch.yml dsh-mneme 块增 entityExtractionEnabled=true + entityExtractionModel=mimo-v2.5（重启后对新写入生效）；备份 backups/entity-extraction-enable-20260823-103139；另写一次性回填脚本（复用插件 store+extractor，LLM 直连 xiaomi mimo-v2.5）跑存量记忆，用户中途叫停，已填约 45 条（entities 93 / relations 132 / attrs 55），脚本留于 %TEMP%/mneme-backfill.mjs |
| 2026-08-23 | 新增 hide-sidebar-buttons.ps1/.cmd（DSH 根目录）并删除左下角「记忆」/「Lark」按钮：对 dsh-mneme lib/client.js 与 dsh-lark-link dist/client.js 的 sidebar.footer.action 注入加 `if (false)` 死代码前缀（幂等、node --check 校验；记忆保留 conversation.view 顶部标签、Lark 保留服务端桥接；08-24 扩展「自动化」与「壁纸仓库」顶部按钮，09-03 修复 mneme 0.7.6 新布局路径） |
| 2026-08-23 | 安装 find-plugins skill（dsh-home/skills/）+ dsh-plugin-install 0.3.8（设置页装插件标签）；每日推荐任务 prompt 改用 find-plugins 检索；备份于 backups/plugin-install-install-20260823-090030、automation-recommend-find-plugins-20260823-090549 |
| 2026-08-18~23 | 建站期合并记录：创建文档/修重复"插件"条目/claude-mem→dsh-mneme+新增 lark-link/automation/balance；修 ATTACHMENT_WRITE_FAILED（exFAT 硬链接→rename）；装 dsh-superpower 6.3.0-dsh.6、mneme 后台 LLM 改走 xiaomi/mimo-v2.5；每日插件更新（vision-router 1.7.7/better-sidebar 0.15.2/mneme 0.7.0/wallpaper-engine 0.6.3/plugin-install 0.3.9/automation 0.1.7；pnpm 在 exFAT 失败→npm pack+替换 node_modules+手改 package.json/pnpm-lock）；dsh-balance 卸载与遗留插件清理；新增 Skill 清单/每日检查/升级前备份要求（相关备份曾存 backups/，2026-09-03 清空后路径失效） |

## 8. 安全退出并清理

- **仅退出**：只关闭应用，保留缓存（适合快速重启）。
- **安全退出并清理**：托盘/退出菜单 → 关闭应用并执行清理脚本，完成后可安全弹出 U 盘。

### 实际清理逻辑（resources/app/main.js）
1. **before-quit**：`killTree` 终止 dsh web 进程树（node.exe）、`updater.abort()`、停 session watcher。
2. **Cleanup()**：向 `%TEMP%/dsh-usb-cleanup.ps1` 写脚本并 detach 运行：等待 `DSH USB.exe` 完全退出
   （最长 60s）→ 删除 userData（`dsh/`）下 Electron 缓存：`Cache`、`Code Cache`、`GPUCache`、
   `DawnGraphiteCache`、`DawnWebGPUCache`、`blob_storage`、`logs`、`Network` → 脚本自删。
3. ⚠️ 当前清理**不会**删 `dsh-home` 下的附件/视觉产物/记忆/临时任务文件，这些按 §1.5 由各任务结束后自清。

> 💡 **uvx 封装（已精简）**：`bin/uvx.cmd` → `uvx-wrapper.ps1` → `uvx-real.exe` 纯透传；
> chroma-mcp 拦截已随 claude-mem 退役移除（2026-08-22）。
