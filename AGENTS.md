# AGENTS.md — AI 代理开发指南

## 项目概述

AI-Terminal 是基于 **Tauri 2** 的跨平台多标签终端应用（Rust 后端 + TypeScript/xterm.js 前端），为 AI CLI 工具（特别是 Claude Code）深度优化。

---

## 构建与开发命令

### 前端开发
```bash
npm run dev              # Vite 开发服务器（仅前端，端口 1450）
npm run build            # 生产构建前端到 /dist
```

### Tauri 全栈开发
```bash
npm run tauri:dev        # 完整 Tauri 开发模式（Rust + 前端 HMR）
```

### 类型检查与构建
```bash
cd src-tauri && cargo check              # Rust 类型检查
cd src-tauri && cargo build              # 构建 Rust 后端
npx @tauri-apps/cli build                # 生产构建（输出 .msi/.dmg/.app）
```

### 测试
**无测试套件配置** — 项目依赖手动测试。

### 其他工具
```bash
powershell -File scripts/gen-icon.ps1    # 重新生成应用图标
```

---

## 代码风格指南

### TypeScript/前端规范

#### 导入
- 相对路径导入使用 `./` 或 `../`，不使用 `.ts` 扩展名
- Tauri API 导入：`import { invoke } from '@tauri-apps/api/core'`
- 组件导入：`import { api } from './api'`

#### 类型
- 使用 TypeScript 严格模式（`strict: true`）
- 接口使用 PascalCase：`interface TabState { }`
- 类型别名使用 PascalCase：`type TabStatus = 'active' | 'executing'`
- 函数参数和返回值必须有显式类型注解
- 使用 `void` 表示无返回值的函数

#### 命名约定
- 变量/函数：camelCase（`createTab`, `activeTabId`）
- 类：PascalCase（`TerminalView`, `TabBar`）
- 常量：UPPER_CASE（仅用于真正常量）
- 文件：kebab-case（`terminal-view.ts`, `app-state.ts`）
- 私有字段：以下划线前缀表示可选（`_closeAttachMenu`）

#### 错误处理
- 异步错误使用 `.catch()` 静默处理或 `void` 忽略
- 不使用 try/catch 包装常见操作（如 invoke 调用）
- 示例：`api.closeTerminal(tabId).catch(() => {});`

#### 代码组织
- 组件使用类封装（`export class TerminalView`）
- 状态管理使用观察者模式（`AppState` 类 + `notify()`）
- IPC 调用统一通过 `api.ts` 适配层

### Rust/后端规范

#### 导入
- 模块导入：`use crate::output_parser::OutputParser;`
- 标准库分组：`use std::sync::{Arc, Mutex};`
- Tauri 相关：`use tauri::{AppHandle, Emitter, Manager};`

#### 命名约定
- 函数：snake_case（`create_terminal`, `get_cwd`）
- 类型/结构体：PascalCase（`PtyManager`, `SavedTab`）
- 常量：UPPER_CASE
- 文件：snake_case（`pty_manager.rs`, `output_parser.rs`）

#### 错误处理
- 返回 `Result<T, String>`，错误消息使用 `format!()`
- 使用 `map_err(|e| e.to_string())?` 转换 Mutex 错误
- 不 panic，所有错误通过 Result 传播
- 示例：
  ```rust
  pub fn write(&self, tab_id: &str, data: &str) -> Result<(), String> {
      let instance = self.instances.get(tab_id)
          .ok_or("Tab not found")?;
      let mut inst = instance.lock().map_err(|e| e.to_string())?;
      inst.writer.write_all(data.as_bytes())
          .map_err(|e| format!("Write failed: {}", e))
  }
  ```

#### 代码组织
- 模块结构：`lib.rs` 入口 + 功能模块分离
- Tauri 命令使用 `#[tauri::command]` 属性
- 共享状态使用 `State<'_, Mutex<T>>` 提取

#### 字符串处理
- 跨平台路径使用 `PathBuf`
- 截断字符串时注意 UTF-8 边界（使用 `is_char_boundary()`）
- 示例：
  ```rust
  fn truncate_str(s: &str, max_bytes: usize) -> &str {
      if s.len() <= max_bytes { return s; }
      let mut end = max_bytes;
      while end > 0 && !s.is_char_boundary(end) { end -= 1; }
      &s[..end]
  }
  ```

### 通用规范

#### 注释
- 模块/函数头部使用文档注释说明用途
- 代码内注释使用简体中文
- 不使用 emoji 注释

#### 格式化
- 缩进：2 空格（TypeScript），4 空格（Rust）
- 行宽：无硬性限制，保持可读性
- 空行：函数间空一行，逻辑块间空一行

#### Git 提交
- 提交消息使用简体中文
- 聚焦于 "why" 而非 "what"
- 示例：`fix: 修复 PowerShell 光标渲染问题`

---

## 架构要点

### 通信模式
- 前端 → 后端：`invoke<T>('command_name', { args })`
- 后端 → 前端：Tauri 事件系统（`emit('event-name', payload)`）
- 所有 IPC 命令在 `lib.rs` 注册，实现在 `commands.rs`

### 状态管理
- 前端：`AppState` 类（观察者模式，`subscribe()` 监听变化）
- 后端：`PtyManager` + `OutputParser` 存储在 Tauri `ManagedState`

### 数据持久化
- 标签状态：`saved-tabs.json`（应用数据目录）
- 会话历史：`tab-history.json`（最近 20 条）
- 主题选择：`localStorage`（前端）

---

## 平台差异处理

### Windows
- 默认 Shell：PowerShell（禁用 PSReadLine 预测功能）
- 字体：CaskaydiaCove Nerd Font + SimHei
- 窗口控制：自定义按钮（`setDecorations(false)`）

### macOS
- 原生交通灯按钮（`titleBarStyle: Overlay`）
- Dock 通知：图标跳动 + 角标数字
- 字体：MesloLGS Nerd Font + Menlo

---

## 文件结构

```
AI-Terminal/
├── src/                    # TypeScript 前端
│   ├── api.ts              # Tauri IPC 适配层
│   ├── main.ts             # 应用入口
│   └── components/         # UI 组件
├── src-tauri/              # Rust 后端
│   ├── src/
│   │   ├── lib.rs          # 入口 + IPC 注册
│   │   ├── commands.rs     # IPC 命令实现
│   │   ├── pty_manager.rs  # PTY 生命周期管理
│   │   └── output_parser.rs# AI 输出解析
│   └── Cargo.toml
├── docs/
│   └── design-notes.md     # 设计文档
└── CLAUDE.md               # 项目说明
```

---

## 其他配置

### 用户偏好 (CLAUDE.md)
- 常规操作无需确认直接执行
- 默认使用中文回复

---

## 调试技巧

### 前端调试
```bash
# 查看 Vite 开发服务器日志
npm run dev

# 检查 localStorage 数据
# 浏览器控制台：localStorage.getItem('terminal-theme-index')
```

### Rust 后端调试
```bash
# 运行 Clippy 检查代码质量
cd src-tauri && cargo clippy

# 查看详细编译信息
cd src-tauri && RUST_LOG=debug cargo run
```

### 常见问题
- **端口占用**: Vite 会自动尝试 1450、1451、1452...
- **热重载不生效**: 检查是否是 `src-tauri/` 的 Rust 代码，需要手动重启
- **终端无法输入**: 检查 PTY 进程是否正常，重启应用
- **字体加载失败**: 使用默认字体回退，检查 Nerd Font 安装

---

## 最近变更 (2025-03)

### 新增功能
- Tips 面板字体设置（字号 12-20，5 种字体选项）
- 跨平台字体支持（Windows/macOS/Linux 自动适配）
- 字体设置持久化到 localStorage

### 关键文件
- `src/main.ts`: Tips 面板 UI 和字体选择逻辑
- `src/components/terminal-view.ts`: `setFontSize()`, `setFontFamily()`, `getFontFamily()`
