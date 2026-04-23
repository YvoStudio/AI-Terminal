import { api, type TabStatus, type SidebarEntry, type SavedTab } from '../api';

export interface NoteBlock {
  id: string;
  content: string;
  images?: string[]; // file paths of attached images
}

export type ShellType = 'cmd' | 'powershell' | 'wsl';

export type SplitLayout = 'left-right' | 'top-bottom' | 'left-two-right' | 'grid';

export interface SplitPane {
  tabIds: string[];       // tabs in this pane
  activeTabId: string;    // currently visible tab in this pane
}

export interface SplitState {
  layout: SplitLayout;
  panes: SplitPane[];
  activePaneIndex: number;
  paneWidths?: number[]; // fractions summing to 1, e.g. [0.5, 0.5]
}

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
  userRenamed: boolean; // true if user manually renamed — blocks auto-rename
}

class AppState {
  activeTabId: string | null = null;
  tabOrder: string[] = [];
  tabs: Map<string, TabState> = new Map();
  splitState: SplitState | null = null;
  private tabCounter = 0;
  private listeners: Array<() => void> = [];

  subscribe(fn: () => void) { this.listeners.push(fn); }
  private notify() { this.listeners.forEach(fn => { try { fn(); } catch (e) { console.error('[AppState] listener error:', e); } }); }

  addTab(id: string): TabState {
    this.tabCounter++;
    const tab: TabState = {
      id, title: `Terminal ${this.tabCounter}`, status: 'active', shell: 'cmd',
      color: '', aiTool: '', sidebarEntries: [], noteBlocks: [], cwd: '', userRenamed: false,
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
    if (id === this.activeTabId && status === 'waiting') {
      tab.status = 'active';
      this.notify();
      return;
    }
    tab.status = status;
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
    // Reject garbage: must be absolute path, no control chars or quotes, reasonable length
    if (!cwd || cwd.length > 500) return;
    if (cwd.includes('"') || cwd.includes('\n') || cwd.includes('\x1b')) return;
    if (!cwd.startsWith('/') && !/^[A-Za-z]:/.test(cwd)) return;
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

  renameTab(id: string, name: string, byUser = true) {
    const tab = this.tabs.get(id);
    if (!tab || tab.title === name) return;
    tab.title = name;
    if (byUser) tab.userRenamed = true;
    this.notify();
    this.persistTabs();
  }

  enterSplit(layout: SplitLayout, tabIds: string[]) {
    // First pane gets all other tabs + the first specified tab
    const firstPaneTabs = this.tabOrder.filter(id => id !== tabIds[1]);
    const secondPaneTabs = [tabIds[1]];
    const panes: SplitPane[] = [
      { tabIds: firstPaneTabs, activeTabId: tabIds[0] },
      { tabIds: secondPaneTabs, activeTabId: tabIds[1] },
    ];
    this.splitState = { layout, panes, activePaneIndex: 0 };
    this.activeTabId = tabIds[0];
    this.notify();
  }

  exitSplit() {
    if (!this.splitState) return;
    const activePane = this.splitState.panes[this.splitState.activePaneIndex];
    const keepTabId = activePane?.activeTabId;
    this.splitState = null;
    if (keepTabId && this.tabs.has(keepTabId)) {
      this.activeTabId = keepTabId;
    }
    this.notify();
  }

  setActivePane(index: number) {
    if (!this.splitState || index < 0 || index >= this.splitState.panes.length) return;
    this.splitState.activePaneIndex = index;
    const pane = this.splitState.panes[index];
    this.activeTabId = pane.activeTabId;
    const tab = this.tabs.get(this.activeTabId!);
    if (tab && (tab.status === 'done-unseen' || tab.status === 'waiting')) tab.status = 'active';
    this.notify();
  }

  /** Switch which tab is active within a specific pane */
  switchPaneTab(paneIndex: number, tabId: string) {
    if (!this.splitState || paneIndex < 0 || paneIndex >= this.splitState.panes.length) return;
    const pane = this.splitState.panes[paneIndex];
    if (!pane.tabIds.includes(tabId)) return;
    pane.activeTabId = tabId;
    if (paneIndex === this.splitState.activePaneIndex) {
      this.activeTabId = tabId;
    }
    this.notify();
  }

  /** Move a tab into a pane (from global tab bar click or drag) */
  assignTabToPane(paneIndex: number, tabId: string) {
    if (!this.splitState || paneIndex < 0 || paneIndex >= this.splitState.panes.length) return;
    // Remove from any other pane first (but only if that pane has >1 tab)
    for (const pane of this.splitState.panes) {
      const idx = pane.tabIds.indexOf(tabId);
      if (idx !== -1) {
        if (pane.tabIds.length <= 1) return; // can't leave a pane empty
        pane.tabIds.splice(idx, 1);
        if (pane.activeTabId === tabId) pane.activeTabId = pane.tabIds[0];
        break;
      }
    }
    const targetPane = this.splitState.panes[paneIndex];
    if (!targetPane.tabIds.includes(tabId)) {
      targetPane.tabIds.push(tabId);
    }
    targetPane.activeTabId = tabId;
    this.splitState.activePaneIndex = paneIndex;
    this.activeTabId = tabId;
    this.notify();
  }

  /** Add a new pane (upgrade layout) */
  addPane(tabId: string) {
    if (!this.splitState) return;
    if (this.splitState.panes.length >= 4) return;
    this.splitState.panes.push({ tabIds: [tabId], activeTabId: tabId });
    const count = this.splitState.panes.length;
    if (count === 3) this.splitState.layout = 'left-two-right';
    else if (count === 4) this.splitState.layout = 'grid';
    this.splitState.activePaneIndex = count - 1;
    this.activeTabId = tabId;
    this.notify();
  }

  /** Remove a pane entirely when a tab is closed */
  removeTabFromSplit(tabId: string) {
    if (!this.splitState) return;
    for (let i = 0; i < this.splitState.panes.length; i++) {
      const pane = this.splitState.panes[i];
      const idx = pane.tabIds.indexOf(tabId);
      if (idx === -1) continue;
      pane.tabIds.splice(idx, 1);
      if (pane.tabIds.length === 0) {
        // Remove this pane
        this.splitState.panes.splice(i, 1);
        if (this.splitState.panes.length < 2) {
          const keepPaneTab = this.splitState.panes[0]?.activeTabId || this.tabOrder[0];
          this.splitState = null;
          if (keepPaneTab) this.activeTabId = keepPaneTab;
          this.notify();
          return;
        }
        // Downgrade layout
        const c = this.splitState.panes.length;
        if (c === 2 && (this.splitState.layout === 'grid' || this.splitState.layout === 'left-two-right')) {
          this.splitState.layout = 'left-right';
        } else if (c === 3 && this.splitState.layout === 'grid') {
          this.splitState.layout = 'left-two-right';
        }
        if (this.splitState.activePaneIndex >= c) this.splitState.activePaneIndex = c - 1;
      } else if (pane.activeTabId === tabId) {
        pane.activeTabId = pane.tabIds[0];
      }
      break;
    }
    if (this.splitState) {
      this.activeTabId = this.splitState.panes[this.splitState.activePaneIndex].activeTabId;
    }
    this.notify();
  }

  /** Find which pane contains a tab */
  findPaneForTab(tabId: string): number {
    if (!this.splitState) return -1;
    return this.splitState.panes.findIndex(p => p.tabIds.includes(tabId));
  }

  persistTabs() {
    // Quick Terminal window: don't persist — it's ephemeral
    if (new URLSearchParams(location.search).get('quick') === '1') return;
    const saved: SavedTab[] = this.tabOrder.map(id => {
      const tab = this.tabs.get(id)!;
      // Validate cwd before saving — reject garbage
      const cwd = tab.cwd;
      const validCwd = cwd && cwd.length <= 500 && !cwd.includes('"') && !cwd.includes('\n') && !cwd.includes('\x1b')
        && (cwd.startsWith('/') || /^[A-Za-z]:/.test(cwd)) ? cwd : undefined;
      return {
        name: tab.title,
        shell: tab.shell,
        noteBlocks: tab.noteBlocks.map(b => ({
          id: b.id,
          content: b.content,
          images: b.images ? [...b.images] : undefined,
        })),
        cwd: validCwd,
        aiTool: tab.aiTool,
        userRenamed: tab.userRenamed || undefined,
      };
    });
    api.saveTabs(saved);
  }
}

export const appState = new AppState();
