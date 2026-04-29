[English](./README.en.md) | 中文

# AI-Terminal

跨平台多标签终端,为 AI CLI 工具(尤其是 Claude Code)深度优化。基于 Tauri 2 + Rust + TypeScript/xterm.js。

## 主要特性

### 终端核心
- **多标签 + 分屏** — 同窗口任意拖拽分屏,每个面板独立标签管理
- **xterm.js 内核** — WebGL 加速渲染、Unicode 11、搜索、序列化、Canvas 回退
- **多 Shell 支持** — Windows 下可切 cmd / PowerShell / WSL,macOS/Linux 走默认 shell
- **快速终端窗口** — 单独 Quick Terminal,全局快捷键随时呼出
- **主题** — 内置多套配色,支持自定义字体

### AI 优化
- **Claude Code 专项调优** — 针对 Claude Code 的输出节奏、ANSI 序列、长输出处理做了适配
- **Triggers / Blocks** — 在终端输出里识别关键事件,自动触发动作或注入代码块
- **Profiles** — 不同 AI 工具/项目使用不同的启动参数与环境变量
- **Long-output 摘要** — 长输出自动折叠摘要,避免被刷屏

### 桌面体验
- **Ghostty 风格通知** — 仅在窗口失焦时触发系统通知
- **Dock 徽章 + 图标弹跳** — 待处理事件计数,失焦同步,聚焦自动清零
- **系统集成** — 全局快捷键、剪贴板、原生菜单
- **跨平台** — macOS / Windows / Linux 同一份代码

## 系统要求

- macOS 11+(Apple Silicon / Intel)
- Windows 10+(WebView2 — Win11 内置;Win10 自动安装)
- Linux(WebKit2GTK)

## 安装

到 [Releases](https://github.com/yvo-zym/AI-Terminal/releases) 下载对应平台的安装包。

### macOS

下载 `.dmg`,拖入"应用程序"。首次启动若被 Gatekeeper 拦截,到「系统设置 → 隐私与安全性」点 **仍要打开**。

### Windows

下载 `.msi` 或 `.exe` 双击安装。Windows 11 自带 WebView2;Win10 首次启动会自动安装运行时。

### Linux

- **Debian / Ubuntu**: `sudo dpkg -i AI-Terminal_*.deb`
- **其他发行版**: `chmod +x AI-Terminal_*.AppImage` 后直接运行

依赖:`webkit2gtk-4.1`、`libappindicator3`(系统托盘用)。

### 自行编译

需要 [Rust](https://rustup.rs/) 1.77+ 和 Node.js 18+:

```bash
git clone git@github.com:yvo-zym/AI-Terminal.git
cd AI-Terminal
npm install
npm run tauri:dev          # 开发模式
npx tauri build            # 出当前平台的安装包
```

**Linux 额外依赖**(Ubuntu/Debian):
```bash
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev \
    librsvg2-dev patchelf libssl-dev libgtk-3-dev
```

**Windows 额外要求**:Visual Studio 2022 + "Desktop development with C++" 工作负载。

## 技术栈

- **前端** — TypeScript + xterm.js + Vite,无 UI 框架,纯 DOM
- **后端** — Rust(`src-tauri/src/`):
  - PTY 管理基于 `portable-pty`
  - 通过 Tauri command 桥接前端
- **平台特性** — `tauri-plugin-global-shortcut`(快捷键)、`tauri-plugin-notification`(通知)、`tauri-plugin-shell`、`tauri-plugin-dialog`

## 文档

- [`AGENTS.md`](./AGENTS.md) — AI 代理开发指南、架构说明、代码风格
- [`docs/`](./docs/) — 设计文档、开发笔记

## 贡献

欢迎提 Issue 和 PR。**提交 Pull Request 即视为你同意:将所贡献代码的版权及再许可权(包括以非 GPL 协议再发布的权利)无偿授予项目作者**。这样作者可以保持单一版权人身份,在未来需要时(如 App Store 上架等场景)对代码进行重新授权。

如不接受此条款,请不要提交 PR;可改为开 Issue 讨论。

## License

GPL-3.0-or-later。完整条款见 [LICENSE](./LICENSE)。

简单来说:你可以自由使用、修改、分发本项目的代码,但**衍生作品也必须以 GPL 兼容许可开源**。
如需用于闭源/商业产品,请联系作者讨论商业授权。
