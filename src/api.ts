/**
 * Tauri API adapter — mirrors the Electron preload API shape
 * so that components don't need to change.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

export type TabStatus = 'active' | 'executing' | 'done-unseen' | 'waiting';

export interface SidebarEntry {
  type: 'user-input' | 'claude-response' | 'tool-call';
  timestamp: number;
  content: string;
}

export interface SavedTab {
  id?: string;
  name: string;
  noteBlocks?: Array<{ id: string; content: string; images?: string[] }>;
  shell?: 'cmd' | 'powershell' | 'wsl';
  cwd?: string;
  aiTool?: string;
  userRenamed?: boolean;
}

export interface ClaudeSession {
  session_id: string;
  slug: string;
  cwd: string;
  timestamp: string;
  user_messages: string[];
}

export interface HistoryEntry {
  name: string;
  cwd: string;
  timestamp: number;
  shell: 'cmd' | 'powershell' | 'wsl';
  ai_tool?: string;
}

// Keep track of per-tab event listeners so we can unlisten on close
const tabListeners = new Map<string, UnlistenFn[]>();

async function addTabListener(tabId: string, fn: UnlistenFn) {
  if (!tabListeners.has(tabId)) tabListeners.set(tabId, []);
  tabListeners.get(tabId)!.push(fn);
}

export const api = {
  async createTerminal(cwd?: string, preferredId?: string): Promise<string> {
    return invoke<string>('create_terminal', { cwd: cwd ?? null, preferredId: preferredId ?? null });
  },

  writeTerminal(tabId: string, data: string): void {
    invoke('write_terminal', { tabId, data }).catch(err => {
      console.warn('[writeTerminal] failed:', err);
    });
  },

  /** Tell the backend the user actually typed into this tab — only call from
   *  xterm's onData (real keystrokes), NOT from programmatic write_terminal
   *  callers (paste injection, Kitty protocol replies, etc.) */
  markTerminalInput(tabId: string): void {
    invoke('mark_terminal_input', { tabId }).catch(() => {});
  },

  resizeTerminal(tabId: string, cols: number, rows: number): void {
    invoke('resize_terminal', { tabId, cols, rows }).catch(() => {});
  },

  async switchShell(tabId: string, shell: 'cmd' | 'powershell' | 'wsl'): Promise<void> {
    return invoke('switch_shell', { tabId, shell });
  },

  closeTerminal(tabId: string): void {
    // Unlisten all tab-specific events
    const fns = tabListeners.get(tabId);
    if (fns) { fns.forEach(fn => fn()); tabListeners.delete(tabId); }
    invoke('close_terminal', { tabId }).catch(() => {});
  },

  async onTerminalOutput(tabId: string, cb: (data: string) => void): Promise<void> {
    const unlisten = await listen<string>(`terminal-output-${tabId}`, (e) => cb(e.payload));
    addTabListener(tabId, unlisten);
  },

  // Global status / sidebar events emitted by backend
  onTabStatusChanged(cb: (tabId: string, status: TabStatus) => void): void {
    listen<{ tabId: string; status: TabStatus }>('tab-status-changed', (e) => {
      cb(e.payload.tabId, e.payload.status);
    });
  },

  onSidebarEntryAdded(cb: (tabId: string, entry: SidebarEntry) => void): void {
    listen<{ tabId: string; entry: SidebarEntry }>('sidebar-entry-added', (e) => {
      cb(e.payload.tabId, e.payload.entry);
    });
  },

  onTabAutoRenamed(cb: (tabId: string, name: string) => void): void {
    listen<{ tabId: string; name: string }>('tab-auto-rename', (e) => {
      cb(e.payload.tabId, e.payload.name);
    });
  },

  onAiDetected(cb: (tabId: string, cwd: string, aiTool: string) => void): void {
    listen<{ tabId: string; cwd: string; aiTool: string }>('tab-ai-detected', (e) => {
      cb(e.payload.tabId, e.payload.cwd, e.payload.aiTool);
    });
  },

  onCwdChanged(cb: (tabId: string, cwd: string) => void): void {
    listen<{ tabId: string; cwd: string }>('tab-cwd-changed', (e) => {
      cb(e.payload.tabId, e.payload.cwd);
    });
  },

  onTerminalNotification(cb: (tabId: string, title: string, body: string) => void): void {
    listen<{ tabId: string; title: string; body: string }>('terminal-notification', (e) => {
      cb(e.payload.tabId, e.payload.title, e.payload.body);
    });
  },

  async fireNotification(title: string, body: string, force = false): Promise<void> {
    return invoke('fire_notification', { title, body, force });
  },

  async saveScrollback(tabId: string, data: string): Promise<void> {
    return invoke('save_scrollback', { tabId, data });
  },

  async loadScrollback(tabId: string): Promise<string> {
    return invoke<string>('load_scrollback', { tabId });
  },

  async deleteScrollback(tabId: string): Promise<void> {
    return invoke('delete_scrollback', { tabId });
  },

  async openExternal(url: string): Promise<void> {
    const { open } = await import('@tauri-apps/plugin-shell');
    return open(url);
  },

  onTerminalProgress(cb: (tabId: string, state: number, progress: number) => void): void {
    listen<{ tabId: string; state: number; progress: number }>('terminal-progress', (e) => {
      cb(e.payload.tabId, e.payload.state, e.payload.progress);
    });
  },

  async getTerminalCwd(tabId: string): Promise<string> {
    return invoke<string>('get_terminal_cwd', { tabId });
  },

  async getSidebarEntries(tabId: string): Promise<SidebarEntry[]> {
    return invoke<SidebarEntry[]>('get_sidebar_entries', { tabId });
  },

  async saveTabs(tabs: SavedTab[]): Promise<void> {
    return invoke('save_tabs', { tabs });
  },

  async loadTabs(): Promise<SavedTab[]> {
    return invoke<SavedTab[]>('load_tabs');
  },

  async loadHistory(): Promise<HistoryEntry[]> {
    return invoke<HistoryEntry[]>('load_history');
  },

  async addHistory(tabId: string, name: string, cwd: string, shell?: string, aiTool?: string): Promise<void> {
    return invoke('add_history', { tabId, name, cwd, shell: shell ?? null, aiTool: aiTool ?? null });
  },

  async updateHistoryName(tabId: string, newName: string, cwd?: string, aiTool?: string): Promise<void> {
    return invoke('update_history_name', { tabId, newName, cwd: cwd ?? null, aiTool: aiTool ?? null });
  },

  async selectFile(): Promise<string> {
    return invoke<string>('select_file');
  },

  async selectImage(): Promise<string> {
    return invoke<string>('select_image');
  },

  async selectDirectory(): Promise<string> {
    return invoke<string>('select_directory');
  },

  async readClipboardText(): Promise<string> {
    return invoke<string>('read_clipboard_text');
  },

  async writeClipboardText(text: string): Promise<void> {
    return invoke('write_clipboard_text', { text });
  },

  /** Read clipboard image via backend, save to temp file, return path (empty if no image) */
  async readClipboardImage(): Promise<string> {
    return invoke<string>('read_clipboard_image');
  },

  async saveClipboardImage(dataUrl: string): Promise<string> {
    return invoke<string>('save_clipboard_image', { dataUrl });
  },

  async convertImagePath(filePath: string): Promise<string> {
    return invoke<string>('convert_image_path', { filePath });
  },

  async loadQuickCommands(): Promise<string> {
    return invoke<string>('load_quick_commands');
  },

  async saveQuickCommands(json: string): Promise<void> {
    return invoke('save_quick_commands', { json });
  },

  async listClaudeSessions(projectCwd?: string): Promise<ClaudeSession[]> {
    return invoke<ClaudeSession[]>('list_claude_sessions', { projectCwd: projectCwd ?? null });
  },

  async deleteClaudeSession(sessionId: string): Promise<void> {
    return invoke('delete_claude_session', { sessionId });
  },

  async deleteHistoryEntry(index: number): Promise<void> {
    return invoke('delete_history_entry', { index });
  },

  async clearHistory(): Promise<void> {
    return invoke('clear_history');
  },

  async getClaudeSessionHistory(sessionId: string): Promise<string[]> {
    return invoke<string[]>('get_claude_session_history', { sessionId });
  },

  notifyTaskDone(pendingCount: number, requestAttention = true): void {
    invoke('notify_task_done', { pendingCount, requestAttention }).catch(() => {});
  },

  clearBadge(): void {
    invoke('clear_badge').catch(() => {});
  },

  setInputColor(_colorCode: number, _bgCode: number): void {
    // No-op for now — shell color customization is macOS-specific
  },

  toggleMaximize(): void {
    getCurrentWindow().toggleMaximize().catch(() => {});
  },

  minimizeWindow(): void {
    getCurrentWindow().minimize().catch(() => {});
  },

  closeWindow(): void {
    getCurrentWindow().close().catch(() => {});
  },
};
