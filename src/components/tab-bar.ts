import { api } from '../api';
import { appState, type SplitLayout } from './app-state';
import { isWindows, getAvailableShells } from '../platform';

export class TabBar {
  private tabListEl: HTMLElement;
  private editingTabId: string | null = null;
  private contextMenu: HTMLElement | null = null;
  private dragTabId: string | null = null;

  private dropZone: HTMLElement | null = null;

  constructor(
    private onNewTab: () => void,
    private onCloseTab: (id: string) => void,
    private onSwitchTab: (id: string) => void,
    private onSwitchShell: (id: string, shell: 'cmd' | 'powershell' | 'wsl') => void,
    private onSplitWith?: (tabId: string, layout: SplitLayout) => void,
    private onAddToSplit?: (tabId: string) => void,
    private onExitSplit?: () => void,
    private onCreateTabInPane?: (paneIndex: number) => void,
    private onCloseSplitPane?: (paneIndex: number) => void,
    private onSwitchPaneTab?: (paneIndex: number, tabId: string) => void,
    private onDragToSplit?: (tabId: string) => void,
    private onMoveTabToPane?: (tabId: string, targetPaneIndex: number) => void,
  ) {
    this.tabListEl = document.getElementById('tab-list')!;
    // Use onclick (not addEventListener) so render() can override for split modes
    document.getElementById('new-tab-btn')!.onclick = () => onNewTab();
    appState.subscribe(() => this.render());
    window.addEventListener('resize', () => {
      if (appState.splitState) this.alignTabGroupsToSplitPanes();
    });
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
      e.stopPropagation(); this.closeContextMenu();
      requestAnimationFrame(() => this.startEditing(titleEl, tabId));
    });

    const colorItem = document.createElement('div');
    colorItem.className = 'tab-context-menu-color';
    const colors = ['#ff6b6b', '#feca57', '#48dbfb', '#1dd1a1', '#5f27cd', '#ff9ff3', '#54a0ff', '#00d2d3', '#ff9f43', '#ee5253', '#10ac84', '#2e86de', '#c8d6e5', '#222f3e'];
    const currentColor = appState.tabs.get(tabId)?.color ?? '';
    colors.forEach(color => {
      const colorDot = document.createElement('span');
      colorDot.className = 'tab-context-color-dot' + (color === currentColor ? ' selected' : '');
      colorDot.style.backgroundColor = color;
      if (!color) colorDot.style.background = 'linear-gradient(45deg, #fff 45%, #333 45%, #333 55%, #fff 55%)';
      colorDot.addEventListener('click', (e) => {
        e.stopPropagation(); this.closeContextMenu();
        appState.setColor(tabId, color);
      });
      colorItem.appendChild(colorDot);
    });

    const addHistoryItem = document.createElement('div');
    addHistoryItem.className = 'tab-context-menu-item';
    addHistoryItem.textContent = '加入记录';
    addHistoryItem.addEventListener('click', async (e) => {
      e.stopPropagation(); this.closeContextMenu();
      const tab = appState.tabs.get(tabId);
      if (tab) {
        // 使用 appState 中实时的 cwd，而不是 getTerminalCwd（返回的是初始目录）
        console.log('[加入记录] tab.cwd =', tab.cwd, 'tab.aiTool =', tab.aiTool);
        const cwd = tab.cwd || '';
        console.log('[加入记录] saving with cwd =', cwd, 'aiTool =', tab.aiTool);
        api.addHistory(tabId, tab.title, cwd, tab.shell, tab.aiTool || undefined);
      }
    });

    menu.appendChild(renameItem);
    menu.appendChild(colorItem);
    menu.appendChild(addHistoryItem);

    // Split screen options
    if (appState.tabOrder.length >= 2) {
      const splitSep = document.createElement('div');
      splitSep.className = 'tab-context-menu-sep';
      menu.appendChild(splitSep);

      if (appState.splitState) {
        // Already in split mode
        if (appState.findPaneForTab(tabId) === -1 && appState.splitState.panes.length < 4) {
          const addItem = document.createElement('div');
          addItem.className = 'tab-context-menu-item';
          addItem.textContent = '加入分屏';
          addItem.addEventListener('click', (e) => {
            e.stopPropagation(); this.closeContextMenu();
            this.onAddToSplit?.(tabId);
          });
          menu.appendChild(addItem);
        }
        const exitItem = document.createElement('div');
        exitItem.className = 'tab-context-menu-item';
        exitItem.textContent = '退出分屏';
        exitItem.addEventListener('click', (e) => {
          e.stopPropagation(); this.closeContextMenu();
          this.onExitSplit?.();
        });
        menu.appendChild(exitItem);
      } else {
        const splitLR = document.createElement('div');
        splitLR.className = 'tab-context-menu-item';
        splitLR.textContent = '左右分屏';
        splitLR.addEventListener('click', (e) => {
          e.stopPropagation(); this.closeContextMenu();
          this.onSplitWith?.(tabId, 'left-right');
        });
        menu.appendChild(splitLR);

        const splitTB = document.createElement('div');
        splitTB.className = 'tab-context-menu-item';
        splitTB.textContent = '上下分屏';
        splitTB.addEventListener('click', (e) => {
          e.stopPropagation(); this.closeContextMenu();
          this.onSplitWith?.(tabId, 'top-bottom');
        });
        menu.appendChild(splitTB);
      }
    }

    // Shell switching only on Windows
    if (isWindows) {
      const sep = document.createElement('div');
      sep.className = 'tab-context-menu-sep';

      const currentShell = appState.tabs.get(tabId)?.shell ?? 'cmd';
      const shellLabels: Record<string, string> = { cmd: 'CMD', powershell: 'PowerShell', wsl: 'WSL', bash: 'Bash' };
      const shells = getAvailableShells();
      const shellItems = shells.map(shell => {
        const item = document.createElement('div');
        item.className = 'tab-context-menu-item';
        const dot = shell === currentShell
          ? '<span class="tab-context-menu-dot"></span>'
          : '<span class="tab-context-menu-dot-placeholder"></span>';
        item.innerHTML = `切换到 ${shellLabels[shell] || shell}${dot}`;
        item.addEventListener('click', (e) => {
          e.stopPropagation(); this.closeContextMenu(); this.onSwitchShell(tabId, shell as 'cmd' | 'powershell' | 'wsl');
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
      // If Claude is active in this tab, rename the Claude session too
      if (tab.aiTool === 'claude' && newName !== tab.title) {
        api.writeTerminal(tabId, `/rename ${newName}\n`);
      }
    };
    titleEl.addEventListener('blur', finishEdit, { once: true });
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
      else if (e.key === 'Escape') { titleEl.textContent = tab.title; titleEl.blur(); }
    });
  }

  private alignTabGroupsToSplitPanes() {
    requestAnimationFrame(() => {
      const containerEl = document.getElementById('terminal-container');
      if (!containerEl) return;
      const panes = Array.from(containerEl.querySelectorAll('.split-pane')) as HTMLElement[];
      const groups = Array.from(this.tabListEl.querySelectorAll('.tab-group')) as HTMLElement[];
      if (panes.length === 0 || groups.length !== panes.length) return;

      // For top-bottom splits, just use equal flex (no horizontal alignment needed)
      if (appState.splitState?.layout === 'top-bottom') {
        groups.forEach(g => { g.style.flex = '1'; g.style.width = ''; });
        return;
      }

      const tabListRect = this.tabListEl.getBoundingClientRect();

      for (let i = 0; i < groups.length; i++) {
        const paneRect = panes[i].getBoundingClientRect();
        const left = Math.max(paneRect.left, tabListRect.left);
        const right = Math.min(paneRect.right, tabListRect.right);
        groups[i].style.flex = 'none';
        groups[i].style.width = Math.max(right - left, 50) + 'px';
      }
    });
  }

  private renderTab(id: string, tabEl: HTMLElement) {
    const tab = appState.tabs.get(id)!;
    if (tab.color) tabEl.style.setProperty('--tab-color', tab.color);

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

    tabEl.appendChild(indicator);
    tabEl.appendChild(title);
    tabEl.appendChild(close);
    tabEl.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.showContextMenu(e.clientX, e.clientY, id, title); });
  }

  private showDropZone(containerEl: HTMLElement) {
    if (this.dropZone) return;
    const rect = containerEl.getBoundingClientRect();
    this.dropZone = document.createElement('div');
    this.dropZone.className = 'split-drop-zone';
    this.dropZone.style.left = (rect.right - rect.width * 0.3) + 'px';
    this.dropZone.style.top = rect.top + 'px';
    this.dropZone.style.width = (rect.width * 0.3) + 'px';
    this.dropZone.style.height = rect.height + 'px';
    document.body.appendChild(this.dropZone);
  }

  private hideDropZone() {
    if (this.dropZone) { this.dropZone.remove(); this.dropZone = null; }
  }

  private isInDropZone(ev: MouseEvent): boolean {
    if (!this.dropZone) return false;
    const rect = this.dropZone.getBoundingClientRect();
    return ev.clientX >= rect.left && ev.clientX <= rect.right &&
           ev.clientY >= rect.top && ev.clientY <= rect.bottom;
  }

  private dragGhost: HTMLElement | null = null;

  private showDragGhost(tabTitle: string, x: number, y: number) {
    if (!this.dragGhost) {
      this.dragGhost = document.createElement('div');
      this.dragGhost.className = 'tab-drag-ghost';
      document.body.appendChild(this.dragGhost);
    }
    this.dragGhost.textContent = tabTitle;
    this.dragGhost.style.left = (x + 12) + 'px';
    this.dragGhost.style.top = (y - 10) + 'px';
  }

  private hideDragGhost() {
    if (this.dragGhost) { this.dragGhost.remove(); this.dragGhost = null; }
  }

  private setupDrag(el: HTMLElement, id: string) {
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('.tab-close') || (e.target as HTMLElement).closest('[contenteditable="true"]')) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      const containerEl = document.getElementById('terminal-container')!;
      const tab = appState.tabs.get(id);
      const tabTitle = tab?.title || 'Tab';

      const cleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('mouseleave', onLeave);
        this.hideDropZone();
        this.hideDragGhost();
        containerEl.querySelectorAll('.split-pane').forEach(p => p.classList.remove('drop-target'));
        this.tabListEl.querySelectorAll('.tab-group').forEach(g => g.classList.remove('drop-target-group'));
        if (!dragging) return;
        el.classList.remove('dragging');
        document.body.classList.remove('tab-dragging');
        this.tabListEl.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over-left', 'drag-over-right'));
        this.dragTabId = null;
      };
      const onMove = (ev: MouseEvent) => {
        if (!dragging && (Math.abs(ev.clientX - startX) > 5 || Math.abs(ev.clientY - startY) > 5)) {
          dragging = true;
          this.dragTabId = id;
          el.classList.add('dragging');
          document.body.classList.add('tab-dragging');
        }
        if (!dragging) return;

        // Show ghost following cursor
        this.showDragGhost(tabTitle, ev.clientX, ev.clientY);

        // Check if mouse is in the terminal container area (below tab bar)
        const containerRect = containerEl.getBoundingClientRect();
        const inContainer = ev.clientY > containerRect.top && ev.clientY < containerRect.bottom &&
                            ev.clientX > containerRect.left && ev.clientX < containerRect.right;
        const nearRightEdge = inContainer && ev.clientX > containerRect.right - containerRect.width * 0.3;

        // Clear pane highlights
        containerEl.querySelectorAll('.split-pane').forEach(p => p.classList.remove('drop-target'));

        if (nearRightEdge && appState.tabOrder.length >= 1 && (!appState.splitState || appState.splitState.panes.length < 4)) {
          this.showDropZone(containerEl);
        } else {
          this.hideDropZone();

          // In split mode: highlight pane under cursor for merge
          if (appState.splitState && inContainer) {
            const panes = containerEl.querySelectorAll('.split-pane');
            for (const pane of panes) {
              const r = pane.getBoundingClientRect();
              if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
                const paneIdx = parseInt((pane as HTMLElement).dataset.paneIndex || '-1');
                const srcPane = appState.findPaneForTab(id);
                if (paneIdx !== -1 && paneIdx !== srcPane) {
                  pane.classList.add('drop-target');
                }
                break;
              }
            }
          }
        }

        // In split mode: also detect drag over a different tab-group in the title bar
        if (appState.splitState && !this.dropZone) {
          this.tabListEl.querySelectorAll('.tab-group').forEach(g => g.classList.remove('drop-target-group'));
          const groups = this.tabListEl.querySelectorAll('.tab-group');
          const srcPane = appState.findPaneForTab(id);
          for (let gi = 0; gi < groups.length; gi++) {
            if (gi === srcPane) continue;
            const r = groups[gi].getBoundingClientRect();
            if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
              groups[gi].classList.add('drop-target-group');
              break;
            }
          }
        }

        // Tab reorder highlighting (only when not in drop zone area and not over panes/groups)
        const hasDropTarget = !!containerEl.querySelector('.split-pane.drop-target') || !!this.tabListEl.querySelector('.tab-group.drop-target-group');
        if (!this.dropZone && !hasDropTarget) {
          this.tabListEl.querySelectorAll('.tab').forEach(t => {
            t.classList.remove('drag-over-left', 'drag-over-right');
            if (t === el) return;
            const rect = t.getBoundingClientRect();
            if (ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
              const midX = rect.left + rect.width / 2;
              t.classList.toggle('drag-over-left', ev.clientX < midX);
              t.classList.toggle('drag-over-right', ev.clientX >= midX);
            }
          });
        }
      };
      const onUp = (ev: MouseEvent) => {
        if (!dragging) { cleanup(); return; }

        // Check drop zone first (new split pane)
        if (this.isInDropZone(ev)) {
          cleanup();
          this.onDragToSplit?.(id);
          return;
        }

        // Check if dropped on another split pane or tab group (merge into it)
        if (appState.splitState) {
          // Check pane area
          const targetPane = containerEl.querySelector('.split-pane.drop-target') as HTMLElement;
          if (targetPane) {
            const targetIdx = parseInt(targetPane.dataset.paneIndex || '-1');
            if (targetIdx !== -1) {
              cleanup();
              this.onMoveTabToPane?.(id, targetIdx);
              return;
            }
          }
          // Check tab group in title bar
          const targetGroup = this.tabListEl.querySelector('.tab-group.drop-target-group') as HTMLElement;
          if (targetGroup) {
            const groups = Array.from(this.tabListEl.querySelectorAll('.tab-group'));
            const targetIdx = groups.indexOf(targetGroup);
            if (targetIdx !== -1) {
              cleanup();
              this.onMoveTabToPane?.(id, targetIdx);
              return;
            }
          }
        }

        // Tab reorder
        const tabs = Array.from(this.tabListEl.querySelectorAll('.tab'));
        for (const t of tabs) {
          if (t === el) continue;
          const rect = t.getBoundingClientRect();
          if (ev.clientX >= rect.left && ev.clientX <= rect.right) {
            const targetId = (t as HTMLElement).dataset.tabId!;
            const fromIdx = appState.tabOrder.indexOf(id);
            let toIdx = appState.tabOrder.indexOf(targetId);
            const midX = rect.left + rect.width / 2;
            if (ev.clientX >= midX) toIdx = fromIdx < toIdx ? toIdx : toIdx + 1;
            else toIdx = fromIdx > toIdx ? toIdx : toIdx - 1;
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
  }

  render() {
    if (this.editingTabId) return;
    this.tabListEl.innerHTML = '';

    const newTabBtn = document.getElementById('new-tab-btn');

    if (appState.splitState && appState.splitState.layout !== 'top-bottom') {
      // Left-right split mode: render pane-grouped tabs in title bar
      this.tabListEl.classList.add('split-tabs');
      this.tabListEl.setAttribute('data-tauri-drag-region', '');
      if (newTabBtn) newTabBtn.style.display = 'none';

      for (let pi = 0; pi < appState.splitState.panes.length; pi++) {
        const pane = appState.splitState.panes[pi];
        const isActivePane = pi === appState.splitState.activePaneIndex;

        // Pane group container
        const group = document.createElement('div');
        group.className = 'tab-group' + (isActivePane ? ' active-group' : '');
        group.setAttribute('data-tauri-drag-region', '');

        for (const tabId of pane.tabIds) {
          const tab = appState.tabs.get(tabId);
          if (!tab) continue;

          const el = document.createElement('div');
          el.className = 'tab' + (tabId === pane.activeTabId && isActivePane ? ' active' : '') + (tabId === pane.activeTabId ? ' pane-active' : '');
          el.dataset.tabId = tabId;

          this.renderTab(tabId, el);
          el.addEventListener('click', () => {
            this.onSwitchPaneTab?.(pi, tabId);
          });
          this.setupDrag(el, tabId);
          group.appendChild(el);
        }

        // "+" button for this pane
        const addBtn = document.createElement('button');
        addBtn.className = 'tab-group-add';
        addBtn.textContent = '+';
        addBtn.title = '新建标签';
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onCreateTabInPane?.(pi);
        });
        group.appendChild(addBtn);

        this.tabListEl.appendChild(group);

        // Separator between pane groups (except after last)
        if (pi < appState.splitState.panes.length - 1) {
          const sep = document.createElement('div');
          sep.className = 'tab-group-sep';
          this.tabListEl.appendChild(sep);
        }
      }

      // Align tab groups with pane positions
      this.alignTabGroupsToSplitPanes();
    } else {
      // Single mode (or top-bottom split: title bar shows only top pane's tabs)
      this.tabListEl.classList.remove('split-tabs');
      this.tabListEl.removeAttribute('data-tauri-drag-region');

      const isTopBottom = appState.splitState?.layout === 'top-bottom';
      const topPaneTabs = isTopBottom ? appState.splitState!.panes[0].tabIds : null;
      const tabIds = topPaneTabs || appState.tabOrder;

      if (newTabBtn) {
        newTabBtn.style.display = '';
        if (isTopBottom) {
          newTabBtn.onclick = () => this.onCreateTabInPane?.(0);
        } else {
          newTabBtn.onclick = () => this.onNewTab();
        }
      }

      for (const id of tabIds) {
        const el = document.createElement('div');
        el.className = `tab${id === appState.activeTabId ? ' active' : ''}`;
        el.dataset.tabId = id;

        this.renderTab(id, el);
        if (isTopBottom) {
          el.addEventListener('click', () => this.onSwitchPaneTab?.(0, id));
        } else {
          el.addEventListener('click', () => this.onSwitchTab(id));
        }
        this.setupDrag(el, id);
        this.tabListEl.appendChild(el);
      }
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
