import { api } from '../api';
import { appState } from './app-state';

export class TabBar {
  private tabListEl: HTMLElement;
  private editingTabId: string | null = null;
  private contextMenu: HTMLElement | null = null;
  private dragTabId: string | null = null;

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

    menu.appendChild(renameItem);
    menu.appendChild(addHistoryItem);

    // Shell switching only on Windows
    const isWindows = navigator.userAgent.includes('Windows');
    if (isWindows) {
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

      menu.appendChild(sep);
      shellItems.forEach(item => menu.appendChild(item));
    }
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

      // Drag-to-reorder via mousedown/mousemove (HTML5 drag blocked by Tauri drag region)
      el.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        // Ignore if clicking close button or editing title
        if ((e.target as HTMLElement).closest('.tab-close') || (e.target as HTMLElement).closest('[contenteditable="true"]')) return;
        e.preventDefault();
        const startX = e.clientX;
        let dragging = false;
        const cleanup = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.removeEventListener('mouseleave', onLeave);
          if (!dragging) return;
          el.classList.remove('dragging');
          document.body.classList.remove('tab-dragging');
          this.tabListEl.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
          this.dragTabId = null;
        };
        const onMove = (ev: MouseEvent) => {
          if (!dragging && Math.abs(ev.clientX - startX) > 5) {
            dragging = true;
            this.dragTabId = id;
            el.classList.add('dragging');
            document.body.classList.add('tab-dragging');
          }
          if (!dragging) return;
          // Highlight drop target
          this.tabListEl.querySelectorAll('.tab').forEach(t => {
            t.classList.remove('drag-over-left', 'drag-over-right');
            if (t === el) return;
            const rect = t.getBoundingClientRect();
            if (ev.clientX >= rect.left && ev.clientX <= rect.right) {
              const midX = rect.left + rect.width / 2;
              t.classList.toggle('drag-over-left', ev.clientX < midX);
              t.classList.toggle('drag-over-right', ev.clientX >= midX);
            }
          });
        };
        const onUp = (ev: MouseEvent) => {
          if (!dragging) { cleanup(); return; }
          // Find drop target
          const tabs = Array.from(this.tabListEl.querySelectorAll('.tab'));
          for (const t of tabs) {
            if (t === el) continue;
            const rect = t.getBoundingClientRect();
            if (ev.clientX >= rect.left && ev.clientX <= rect.right) {
              const targetId = (t as HTMLElement).dataset.tabId!;
              const fromIdx = appState.tabOrder.indexOf(id);
              let toIdx = appState.tabOrder.indexOf(targetId);
              const midX = rect.left + rect.width / 2;
              if (ev.clientX >= midX) {
                toIdx = fromIdx < toIdx ? toIdx : toIdx + 1;
              } else {
                toIdx = fromIdx > toIdx ? toIdx : toIdx - 1;
              }
              appState.moveTab(fromIdx, toIdx);
              break;
            }
          }
          cleanup();
        };
        const onLeave = () => cleanup();
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('mouseleave', onLeave);
      });

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
