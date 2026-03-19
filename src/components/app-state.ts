import { api, type TabStatus, type SidebarEntry, type SavedTab } from '../api';

export interface NoteBlock {
  id: string;
  content: string;
  images?: string[]; // file paths of attached images
}

export type ShellType = 'cmd' | 'powershell' | 'wsl';

export interface TabState {
  id: string;
  title: string;
  status: TabStatus;
  shell: ShellType;
  color: string;
  aiTool: string;
  sidebarEntries: SidebarEntry[];
  noteBlocks: NoteBlock[];
  cwd: string;
}

class AppState {
  activeTabId: string | null = null;
  tabOrder: string[] = [];
  tabs: Map<string, TabState> = new Map();
  private listeners: Array<() => void> = [];

  subscribe(fn: () => void) { this.listeners.push(fn); }
  private notify() { this.listeners.forEach(fn => { try { fn(); } catch(e) { console.error('[AppState] listener error:', e); } }); }

  addTab(id: string): TabState {
    const index = this.tabOrder.length + 1;
    const tab: TabState = {
      id, title: `Terminal ${index}`, status: 'active', shell: 'cmd',
      color: '', aiTool: '', sidebarEntries: [], noteBlocks: [], cwd: '',
    };
    this.tabs.set(id, tab);
    this.tabOrder.push(id);
    this.activeTabId = id;
    this.notify();
    return tab;
  }

  removeTab(id: string): string | null {
    const idx = this.tabOrder.indexOf(id);
    if (idx === -1) return null;
    this.tabOrder.splice(idx, 1);
    this.tabs.delete(id);
    if (this.activeTabId === id) {
      this.activeTabId = this.tabOrder.length === 0 ? null
        : this.tabOrder[Math.min(idx, this.tabOrder.length - 1)];
    }
    this.notify();
    return this.activeTabId;
  }

  switchTab(id: string) {
    if (!this.tabs.has(id)) return;
    this.activeTabId = id;
    const tab = this.tabs.get(id)!;
    if (tab.status === 'done-unseen' || tab.status === 'waiting') tab.status = 'active';
    this.notify();
  }

  setShell(id: string, shell: ShellType) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.shell = shell;
    this.notify();
  }

  setColor(id: string, color: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.color = color;
    this.notify();
  }

  setStatus(id: string, status: TabStatus) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    // If this is the active tab, don't mark as done-unseen — user is already viewing it
    if (id === this.activeTabId && status === 'done-unseen') {
      tab.status = 'active';
      // Clear Dock badge since user is already viewing this tab
      api.clearBadge();
    } else {
      tab.status = status;
    }
    this.notify();
  }

  setAiTool(id: string, aiTool: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.aiTool = aiTool;
    this.notify();
  }

  setCwd(id: string, cwd: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.cwd = cwd;
    this.notify();
  }

  addSidebarEntry(id: string, entry: SidebarEntry) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.sidebarEntries.push(entry);
    this.notify();
  }

  switchToNext() {
    if (this.tabOrder.length <= 1 || !this.activeTabId) return;
    const idx = this.tabOrder.indexOf(this.activeTabId);
    this.switchTab(this.tabOrder[(idx + 1) % this.tabOrder.length]);
  }

  switchToPrev() {
    if (this.tabOrder.length <= 1 || !this.activeTabId) return;
    const idx = this.tabOrder.indexOf(this.activeTabId);
    this.switchTab(this.tabOrder[(idx - 1 + this.tabOrder.length) % this.tabOrder.length]);
  }

  moveTab(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= this.tabOrder.length) return;
    if (toIndex < 0 || toIndex >= this.tabOrder.length) return;
    const [id] = this.tabOrder.splice(fromIndex, 1);
    this.tabOrder.splice(toIndex, 0, id);
    this.notify();
    this.persistTabs();
  }

  renameTab(id: string, name: string) {
    const tab = this.tabs.get(id);
    if (!tab || tab.title === name) return;
    tab.title = name;
    this.notify();
    this.persistTabs();
  }

  persistTabs() {
    const saved: SavedTab[] = this.tabOrder.map(id => {
      const tab = this.tabs.get(id)!;
      return { name: tab.title, shell: tab.shell, noteBlocks: tab.noteBlocks.map(b => ({ id: b.id, content: b.content })), cwd: tab.cwd, aiTool: tab.aiTool };
    });
    api.saveTabs(saved);
  }
}

export const appState = new AppState();
