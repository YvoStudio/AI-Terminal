import { api } from '../api';
import { appState } from './app-state';

export class TabBar {
  private tabListEl: HTMLElement;
  private editingTabId: string | null = null;
  private contextMenu: HTMLElement | null = null;

  constructor(
    private onNewTab: () => void,
    private onCloseTab: (id: string) => void,
    private onSwitchTab: (id: string) => void,
    private onSwitchShell: (id: string, shell: 'cmd' | 'powershell' | 'wsl') => void,
  ) {
    this.tabListEl = document.getElementById('tab-list')!;
    document.getElementById('new-tab-btn')!.addEventListener('click', onNewTab);
    appState.subscribe(() => this.render());
  }

  private closeContextMenu() {
    if (this.contextMenu) { this.contextMenu.remove(); this.contextMenu = null; }
  }

  private showContextMenu(x: number, y: number, tabId: string, titleEl: HTMLElement) {
    this.closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'tab-context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const renameItem = document.createElement('div');
    renameItem.className = 'tab-context-menu-item';
    renameItem.textContent = '重命名标签';
    renameItem.addEventListener('click', (e) => {
      e.stopPropagation(); this.closeContextMenu(); this.startEditing(titleEl, tabId);
    });

    const addHistoryItem = document.createElement('div');
    addHistoryItem.className = 'tab-context-menu-item';
    addHistoryItem.textContent = '加入记录';
    addHistoryItem.addEventListener('click', async (e) => {
      e.stopPropagation(); this.closeContextMenu();
      const tab = appState.tabs.get(tabId);
      if (tab) {
        const cwd = await api.getTerminalCwd(tabId);
        api.addHistory(tabId, tab.title, cwd, tab.shell);
      }
    });

    const sep = document.createElement('div');
    sep.className = 'tab-context-menu-sep';

    const currentShell = appState.tabs.get(tabId)?.shell ?? 'cmd';
    const shells: Array<{ label: string; shell: 'cmd' | 'powershell' | 'wsl' }> = [
      { label: 'CMD', shell: 'cmd' },
      { label: 'PowerShell', shell: 'powershell' },
      { label: 'WSL', shell: 'wsl' },
    ];
    const shellItems = shells.map(({ label, shell }) => {
      const item = document.createElement('div');
      item.className = 'tab-context-menu-item';
      const dot = shell === currentShell
        ? '<span class="tab-context-menu-dot"></span>'
        : '<span class="tab-context-menu-dot-placeholder"></span>';
      item.innerHTML = `切换到 ${label}${dot}`;
      item.addEventListener('click', (e) => {
        e.stopPropagation(); this.closeContextMenu(); this.onSwitchShell(tabId, shell);
      });
      return item;
    });

    menu.appendChild(renameItem);
    menu.appendChild(addHistoryItem);
    menu.appendChild(sep);
    shellItems.forEach(item => menu.appendChild(item));
    menu.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(menu);
    this.contextMenu = menu;
    setTimeout(() => {
      const close = () => { this.closeContextMenu(); document.removeEventListener('click', close); };
      document.addEventListener('click', close);
    }, 0);
  }

  private startEditing(titleEl: HTMLElement, tabId: string) {
    const tab = appState.tabs.get(tabId);
    if (!tab) return;
    this.editingTabId = tabId;
    titleEl.contentEditable = 'true';
    titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const finishEdit = () => {
      titleEl.contentEditable = 'false';
      const newName = titleEl.textContent?.trim() || tab.title;
      this.editingTabId = null;
      appState.renameTab(tabId, newName);
      api.updateHistoryName(tabId, newName);
    };
    titleEl.addEventListener('blur', finishEdit, { once: true });
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
      else if (e.key === 'Escape') { titleEl.textContent = tab.title; titleEl.blur(); }
    });
  }

  render() {
    if (this.editingTabId) return;
    this.tabListEl.innerHTML = '';

    for (const id of appState.tabOrder) {
      const tab = appState.tabs.get(id)!;
      const el = document.createElement('div');
      el.className = `tab${id === appState.activeTabId ? ' active' : ''}`;
      el.dataset.tabId = id;

      const indicator = document.createElement('span');
      indicator.className = `tab-indicator ${tab.status}`;

      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = tab.title;
      title.addEventListener('dblclick', (e) => { e.stopPropagation(); e.preventDefault(); this.startEditing(title, id); });

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '×';
      close.addEventListener('click', (e) => { e.stopPropagation(); this.onCloseTab(id); });

      el.appendChild(indicator);
      el.appendChild(title);
      el.appendChild(close);
      el.addEventListener('click', () => this.onSwitchTab(id));
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.showContextMenu(e.clientX, e.clientY, id, title); });
      this.tabListEl.appendChild(el);
    }

    const statusTabs = document.getElementById('status-tabs');
    if (statusTabs) statusTabs.textContent = `${appState.tabOrder.length} tab${appState.tabOrder.length !== 1 ? 's' : ''}`;

    const statusState = document.getElementById('status-state');
    if (statusState && appState.activeTabId) {
      const tab = appState.tabs.get(appState.activeTabId);
      statusState.textContent = tab ? tab.status : '';
    }
  }
}
