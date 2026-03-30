# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI-Terminal is a cross-platform desktop terminal app built with **Tauri 2** (Rust backend + TypeScript/xterm.js frontend), optimized for AI CLI tools like Claude Code. It manages multiple terminal sessions with AI-awareness features (auto-detecting Claude/Aider activity, parsing tool calls, populating a sidebar).

## Build & Development Commands

| Task | Command |
|------|---------|
| **Full dev mode (use this)** | `npm run tauri:dev` |
| Frontend only | `npm run dev` |
| Production build | `npx @tauri-apps/cli build` |
| Check Rust types | `cd src-tauri && cargo check` |
| Build Rust only | `cd src-tauri && cargo build` |
| Regenerate icons | `powershell -File scripts/gen-icon.ps1` |

No test suite or linter is configured. Installers output to `src-tauri/target/release/bundle/`.

## Architecture

**Backend (Rust, `src-tauri/src/`):**
- `lib.rs` — App entry point: registers Tauri plugins (shell, dialog), manages shared state (`PtyManager` in `Mutex`, `OutputParser` in `Arc<Mutex>`), and registers all IPC command handlers
- `commands.rs` — Tauri IPC command handlers (create/write/resize/close terminal, file I/O, clipboard, tab persistence, history, Claude session scanning from `~/.claude/projects/**/*.jsonl`, resume support)
- `pty_manager.rs` — PTY lifecycle per tab via `portable-pty` (create, write, resize, get_cwd; platform-specific logic for macOS/Linux/Windows)
- `output_parser.rs` — Parses terminal output to detect AI tools (Claude, Aider), extract user input lines (`❯`), identify tool calls (Read/Edit/Write/Bash), auto-rename tabs, and generate sidebar entries

**Frontend (TypeScript, `src/`):**
- `main.ts` — App orchestration: tab lifecycle, keyboard shortcuts, notepad toggle, theme picker, history panel, sidebar rendering
- `api.ts` — Tauri invoke adapter layer (all `invoke()` calls go through here)
- `platform.ts` — Platform detection (macOS/Windows/Linux) and per-platform config (fonts, font size, shell list, title bar style)
- `components/app-state.ts` — Global state with observer pattern (active tab, tab order, per-tab state including status/sidebar entries/note blocks)
- `components/terminal-view.ts` — xterm.js wrapper with WebGL acceleration, theming, resize handling, image paste, terminal search
- `components/tab-bar.ts` — Tab UI with context menus, shell switching, drag-to-reorder
- `components/themes.ts` — Theme definitions (Pure Black, One Dark, Dracula, Tokyo Night, etc.)

**Backend (Rust, `src-tauri/src/`) additional modules:**
- `notification.rs` — Dock/taskbar badge and notification system (macOS Dock bounce, Windows taskbar flash)

**Key Architectural Patterns:**
- **AI-aware parsing**: `OutputParser` detects Claude/Aider prompts (`❯`), tool calls (`Read`/`Edit`/`Write`/`Bash`), auto-names tabs after 5 inputs, tracks tab status (`active` → `executing` → `done-unseen` / `waiting`)
- **Resume integration**: Backend scans Claude JSONL session files, exposes `list_claude_sessions`/`get_claude_session_history` for history panel
- **Event-driven UI**: Backend emits events (`tab-status-changed`, `sidebar-entry-added`, `tab-auto-rename`, `tab-claude-detected`); frontend subscribes via `api.ts` listeners
- **Notepad auto-submit**: When tab status becomes `waiting` (Claude waiting for input), first notepad block auto-sends after 300ms delay

**Communication flow:** Frontend calls backend via `invoke<T>('command_name', { args })` (see `api.ts`). Backend pushes events to frontend via Tauri event system (e.g., `terminal-output-${tabId}`, `sidebar-entry-added`, `tab-auto-rename`). All IPC commands are registered in `lib.rs` and implemented in `commands.rs`.

**Shared state:** `PtyManager` and `OutputParser` are stored as Tauri managed state behind `Mutex`/`Arc<Mutex>`, accessed in command handlers via `State<>` extraction.

**Data persistence:** Tab state (`saved-tabs.json`) and session history (`tab-history.json`, last 15 entries) stored in the Tauri app data directory. Claude session data scanned from `~/.claude/projects/<encoded-cwd>/*.jsonl`.

**AI Strategy (from docs/design-notes.md):**
- **Claude-first design**: Core features (resume integration, sidebar history, idle detection, auto-submit) are purpose-built for Claude Code
- **Other AI compatibility**: Gemini CLI, Aider, Cursor work normally with basic detection; no forced deep integration
- **Notepad workflow**: Users draft prompts while Claude runs; blocks auto-submit when Claude enters `waiting` status

## Key Dependencies

- **Frontend:** `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`, `@tauri-apps/api`, `@tauri-apps/plugin-dialog`
- **Backend:** `tauri` 2, `portable-pty`, `serde`/`serde_json`, `uuid`, `strip-ansi-escapes`, `base64`
- **Build:** Vite 6, TypeScript 5.3

## Configuration

- Tauri config: `src-tauri/tauri.conf.json` (window 1400×900, min 800×500, overlay title bar, transparent false)
- Vite dev server: port 1450 (configured in both `vite.config.ts` and `tauri.conf.json` devUrl)
- TypeScript: strict mode, ES2021 target

## Roadmap (from docs/design-notes.md)

**P1 — High Priority:**
- Notepad "to send" / "sent" tabs with drag-to-reorder
- `::` inline command palette (triggered by typing `::` in terminal)

**P2 — Medium Priority:**
- Split-screen support (drag tabs to edges)
- Prompt template library

**P3 — Future:**
- Workspaces (save/restore groups of tabs + notepad)
- Multi-window (drag tabs out as separate windows)
- Session persistence (save terminal scrollback across restarts)

## Platform-Specific Notes

- **PowerShell PTY fix**: Disables PSReadLine prediction features that cause cursor rendering issues in PTY (`Set-PSReadLineOption -PredictionSource None`)
- **macOS**: Dock icon bounce + red badge counter for background task completion
- **Windows**: Taskbar flash notification; cmd/powershell/WSL shell switching supported
- **Icons**: Generated via `scripts/gen-icon.ps1` (GDI+ PNG-in-ICO, sizes 256/128/64/48/32/16) and `scripts/gen-png.ps1`

---

## 问题追踪与回归检查

### 技能使用
- **报告问题**: `/bug-tracker report <问题描述>`
- **查看清单**: `/bug-tracker list`
- **标记解决**: `/bug-tracker resolve <ID> <修复方案>`
- **回归检查**: `/bug-tracker check`

### 问题清单文件
- `docs/问题追踪清单.md` - 所有已报告和已修复的问题清单

### 回归检查清单（修改代码后必须验证）

| 功能 | 测试方法 | 问题 ID |
|------|----------|---------|
| 右键粘贴终端 | 右击终端区域，应粘贴剪贴板内容 | #001 |
| 双击复制 AI 命令 | 打开使用技巧面板，双击命令，应显示「已复制」 | #002 |
| 拖拽文件到终端 | 拖拽文件到终端，应输入文件路径 | #003 |
| 拖拽图片到 Notepad | 拖拽图片到笔记板，应显示图片预览 | #004 |
| Ctrl+V 粘贴图片 | 复制图片后 Ctrl+V，应插入路径 | #005 |
| Dock 红点清除 | 切换到已完成标签，角标应消失 | #006 |
| 标签名保护 | 用户自定义名称不应被自动覆盖 | #007 |

### 开发流程
1. **开发新功能前** - 先读取 `docs/问题追踪清单.md` 了解已知问题
2. **修改代码后** - 对照回归检查清单逐项验证
3. **修复问题后** - 更新清单，移动到「已解决」部分
4. **提交前** - 确认没有重新引入已修复的问题
