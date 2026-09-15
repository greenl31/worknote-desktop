# 工作日志 Worknote

**免费开源的本地今日任务清单 / A free, local-first daily task manager for desktop.**

[![Build](https://github.com/greenl31/worknote-desktop/actions/workflows/build.yml/badge.svg)](https://github.com/greenl31/worknote-desktop/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Worknote 是一款轻量桌面工作日志与今日任务工具，适合记录待办事项、安排日期、区分紧急和重要任务，并把最需要关注的任务优先置顶。数据默认保存在本机，不要求注册账号，也不依赖云服务。

Worknote is a lightweight local-first work journal, todo list, daily planner, and task manager for macOS and Windows.

## 主要功能

- 快速记录今日任务。
- “优先、紧急、重要”可以独立选择并自由组合。
- 优先任务自动置顶并使用醒目底色。
- 每条任务显示创建日期和时间。
- 支持今日、明日、待安排和指定日期。
- 支持完成、恢复、编辑、删除和批量清理。
- 使用 SQLite 在本地持久保存数据。
- 自动生成本地 JSON 备份，并可手动导出数据。
- 普通窗口、桌面浮窗和系统托盘。
- 顶部工作区在浏览较长任务列表时保持置顶。
- 内置「中 / EN」切换，可即时使用完整中文或英文界面。
- 同权重任务按照添加时间从早到晚稳定排列。

## 下载

前往 [Releases](https://github.com/greenl31/worknote-desktop/releases) 下载最新版：

- macOS：推荐下载 `.dmg`。
- macOS 备用包：下载 `.app.tar.gz` 后先解压，再将应用拖入“应用程序”文件夹。
- Windows 10/11：`-setup.exe`

公开版安装包由 GitHub Actions 在 macOS 和 Windows 环境分别构建。未签名的首次发行版可能触发 macOS Gatekeeper 或 Windows SmartScreen 提示，请只从本仓库的 Releases 页面下载。

### macOS 安装

1. 打开下载的 DMG，将“工作日志 Worknote”拖到“Applications / 应用程序”文件夹。只打开 DMG 不等于已经安装。
2. 从访达的“应用程序”中启动。当前公开版尚未经过 Apple 公证，因此首次启动时 macOS 可能提示“Apple 无法验证”。
3. 确认文件来自本仓库的 Releases 页面后，打开“系统设置”→“隐私与安全性”，向下滚动并点按“仍要打开”，然后在再次出现的提示中点按“打开”。

成功打开一次后，macOS 会将它保存为安全性例外，后续可以正常启动。不要对来源不明的软件执行“仍要打开”。

苹果官方说明：[在 Mac 上安全地打开 App](https://support.apple.com/zh-cn/102445)。

## 数据与隐私

- 不需要账号。
- 不收集遥测或使用统计。
- 不上传任务内容。
- 数据库、备份和导出文件均保存在系统分配的应用数据目录。

详细说明见 [隐私说明](docs/PRIVACY.md)。

## 开发

需要安装 [Rust](https://www.rust-lang.org/tools/install) 和 [Tauri v2 的系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
cd src-tauri
cargo test
cargo tauri build
```

本项目直接使用静态 HTML、CSS 和 JavaScript，不需要 npm、pnpm、yarn、Vite 或 `package.json`。未设置 `devUrl` 时，Tauri CLI 会直接使用 `frontendDist` 提供内置开发服务。

### 平台构建

- macOS 会生成应用包和 DMG。
- Windows 会生成 NSIS 安装程序。
- GitHub Actions 会在每次提交时执行检查，在版本标签推送时构建双平台安装包。
- 正式构建会重映射编译机用户目录，避免把 GitHub Runner 或本地电脑路径写入公开安装包。

## 关键词

工作日志、今日任务、待办清单、任务管理、桌面便签、效率工具、Todo、Task Manager、Daily Planner、Work Journal、Local-first、Tauri、Rust、SQLite、macOS、Windows。

## 参与贡献

欢迎提交 Issue 和 Pull Request。开始前请阅读 [贡献指南](CONTRIBUTING.md)。

## 开源许可

本项目使用 [MIT License](LICENSE)。你可以免费使用、修改和分发代码，包括商业使用，但需要保留版权和许可证声明。
