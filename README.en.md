English | [中文](./README.md)

# AI-Terminal

Cross-platform tabbed terminal, deeply tuned for AI CLI tools (Claude Code in particular). Built on Tauri 2 + Rust + TypeScript/xterm.js.

## Features

### Terminal core
- **Tabs + split panes** — drag-to-split within one window, independent tabs per pane
- **xterm.js engine** — WebGL-accelerated rendering, Unicode 11, search, serialization, Canvas fallback
- **Multiple shells** — switch between cmd / PowerShell / WSL on Windows; uses the default shell on macOS / Linux
- **Quick Terminal** — a dedicated quick window, summonable via global shortcut
- **Themes** — multiple built-in color schemes, custom fonts

### AI optimizations
- **Tuned for Claude Code** — adapted to Claude Code's output rhythm, ANSI sequences, and long-output handling
- **Triggers / Blocks** — detect key events in terminal output and run actions or inject code blocks
- **Profiles** — per-tool / per-project launch arguments and environment variables
- **Long-output summarization** — auto-fold long outputs into summaries to avoid being overwhelmed

### Desktop niceties
- **Ghostty-style notifications** — system notifications fire only when the window is unfocused
- **Dock badge + icon bounce** — pending-event counter, syncs on blur, clears on focus
- **OS integration** — global shortcuts, clipboard, native menus
- **Cross-platform** — single codebase for macOS / Windows / Linux

## Requirements

- macOS 11+ (Apple Silicon / Intel)
- Windows 10+ (WebView2 — bundled on Win11; auto-installs on Win10)
- Linux (WebKit2GTK)

## Install

Download the package for your platform from [Releases](https://github.com/YvoStudio/AI-Terminal/releases).

### macOS

Download `.dmg` and drag to Applications. If Gatekeeper blocks the first launch, go to **System Settings → Privacy & Security** and click **Open Anyway**.

### Windows

Download `.msi` or `.exe` and run it. Windows 11 ships with WebView2; on Windows 10 it will be installed on first launch.

### Linux

- **Debian / Ubuntu**: `sudo dpkg -i AI-Terminal_*.deb`
- **Other distros**: `chmod +x AI-Terminal_*.AppImage` and run

Runtime deps: `webkit2gtk-4.1`, `libappindicator3` (for tray icon).

### Build from source

Requires [Rust](https://rustup.rs/) 1.77+ and Node.js 18+:

```bash
git clone git@github.com:YvoStudio/AI-Terminal.git
cd AI-Terminal
npm install
npm run tauri:dev          # development
npx tauri build            # produces a package for the current platform
```

**Extra dependencies on Linux** (Ubuntu/Debian):
```bash
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev \
    librsvg2-dev patchelf libssl-dev libgtk-3-dev
```

**Windows requirements**: Visual Studio 2022 with the "Desktop development with C++" workload.

## Architecture

- **Frontend** — TypeScript + xterm.js + Vite, no UI framework, plain DOM
- **Backend** — Rust (`src-tauri/src/`):
  - PTY management via `portable-pty`
  - Bridged to the frontend through Tauri commands
- **Plugins** — `tauri-plugin-global-shortcut`, `tauri-plugin-notification`, `tauri-plugin-shell`, `tauri-plugin-dialog`

## Contributing

Issues and pull requests are welcome. **By submitting a pull request you agree to assign the copyright and re-licensing rights (including the right to relicense under non-GPL terms) of your contribution to the project author, free of charge.** This keeps the project under a single copyright holder so the author can relicense the code if needed (e.g. for App Store distribution).

If you do not agree to this clause, please do not open a pull request; open an issue for discussion instead.

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE) for the full text.

In short: you may use, modify, and redistribute this code freely, but **derivative works must also be released under a GPL-compatible license**. For closed-source / commercial use, contact the author about a commercial license.
