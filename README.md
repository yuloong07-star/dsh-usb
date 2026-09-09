# DSH USB

DeepSeek Harness（DSH）便携版，专为 U 盘 / 移动硬盘随身使用打造。双击安装包即解压即用，新机器无需安装任何环境。使用安装包安装时耗时极长，可能耗时大于30min，但安装后，在400MB/s的情况下，即使首次打开也不超过5s。

> **本项目基于 [DSH-Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)（deepseek-harness-desktop）开发**，在其桌面端基础上改造为便携模式：运行数据全部保存在安装包旁侧目录，不写 `%APPDATA%`、不写注册表，删文件夹即卸载。

## 硬件要求

> **推荐 U 盘 / 硬盘：存储 > 64GB，速度 > 300MB/s**
> 
> DSH 首次启动与插件初始化会产生较多小文件读写，低速 U 盘会明显拖慢启动与响应速度。

- 文件系统：exFAT / NTFS 均可（exFAT 自动启用 ESM proxy 模块链接，避免 junction/整包复制；每次启动 dsh 会自动 heal）
- 系统：Windows 10/11 x64

## 特性

- **解压即用**：双击安装包自动解压到当前目录 `dshusb\` 文件夹并启动
- **完全免安装**：内置 Node.js 24 运行时与 dsh 全部依赖，新机器零环境要求
- **数据本地化**：所有运行数据（会话、设置、日志）保存在 `dshusb\.dsh\` 内，拔盘即走
- **dsh 检查更新**：支持在应用内检查并安装官方 `@deepseek-ai/dsh` 新版本（内置 npm 运行时，更新数据落在盘内；旧版备份自动清理，仅保留最新 1 份）
- 壳自身不自动更新；新版本请从 Releases 手动下载替换
- 旧版 `dsh\` 布局首次启动自动迁移为 `dshusb\deepseek-ai` + `dshusb\.dsh`
- 安装包单实例运行，重复双击会被拦截；完成后在当前目录生成/覆盖 `DSH USB.lnk` 启动快捷方式
- 退出菜单支持「退出并清理缓存」

## 使用方法

1. 从 [Releases](https://github.com/yuloong07-star/dsh-usb/releases) 下载 `DSH-USB-portable-x64.exe` 到 U 盘 / 移动硬盘任意目录
2. 双击运行，等待解压完成后自动启动
3. 之后直接双击生成的 `DSH USB.lnk` 快捷方式即可
4. 首次启动需填写 DeepSeek API Key（在 [DeepSeek 开放平台](https://platform.deepseek.com) 获取）

## 版本说明

- **v1.3.0**：移除壳自更新；目录改为 `dshusb/deepseek-ai` + `dshusb/.dsh`；exFAT 补丁加固；更新临时文件自动清扫
- **v1.2.0**：壳源码开源入库（`dshusb/` + `scripts/`）；配套维护脚本与内置插件源码一并公开
- **v1.1.0**：修复「检查 dsh 更新」崩溃（updater.js 语法错误），补齐内置 npm 运行时，更新检查与安装功能恢复可用
- **v1.0.0**：首个便携版发布

## 源码结构

发行物在 [Releases](https://github.com/yuloong07-star/dsh-usb/releases)；仓库内是 Electron 壳源码与维护脚本：

```
dshusb/    # Electron 主进程（部署到 resources/app）
scripts/   # update-dsh.ps1、侧栏按钮脚本、运维笔记
```

详见 [dshusb/README.md](dshusb/README.md)。

## 免责声明

- 本项目为社区独立作品，与 DeepSeek 官方无隶属关系；DSH-Desktop 上游项目亦为社区作品
- 软件未经数字签名，Windows 可能提示「未知发布者」
- DeepSeek Harness 本体版权归 DeepSeek AI 所有，本项目仅做便携化封装
