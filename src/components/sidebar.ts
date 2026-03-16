import { type SidebarEntry } from '../api';
import { appState } from './app-state';

export class Sidebar {
  private entriesEl: HTMLElement;
  private currentTabId: string | null = null;
  private entryCount = 0;

  constructor() {
    this.entriesEl = document.getElementById('sidebar-entries')!;
    appState.subscribe(() => this.render());

    const handle = document.getElementById('sidebar-resize-handle')!;
    const sidebar = document.getElementById('sidebar')!;
    let startX = 0, startWidth = 0;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX; startWidth = sidebar.offsetWidth;
      const cleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('mouseleave', cleanup);
      };
      const onMove = (e: MouseEvent) => {
        sidebar.style.width = Math.max(180, Math.min(500, startWidth + e.clientX - startX)) + 'px';
      };
      const onUp = () => cleanup();
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('mouseleave', cleanup);
    });
  }

  render() {
    if (appState.activeTabId !== this.currentTabId) {
      this.currentTabId = appState.activeTabId;
      this.renderEntries();
    } else if (this.currentTabId) {
      const tab = appState.tabs.get(this.currentTabId);
      if (tab && this.entryCount < tab.sidebarEntries.length) {
        this.appendNewEntries(tab.sidebarEntries);
      }
    }
  }

  private renderEntries() {
    this.entriesEl.innerHTML = '';
    this.entryCount = 0;
    if (!this.currentTabId) return;
    const tab = appState.tabs.get(this.currentTabId);
    if (!tab) return;
    for (const entry of tab.sidebarEntries) this.entriesEl.appendChild(this.createEntryEl(entry));
    this.entryCount = tab.sidebarEntries.length;
    this.scrollToBottom();
  }

  private appendNewEntries(entries: SidebarEntry[]) {
    for (let i = this.entryCount; i < entries.length; i++) {
      this.entriesEl.appendChild(this.createEntryEl(entries[i]));
    }
    this.entryCount = entries.length;
    this.scrollToBottom();
  }

  private createEntryEl(entry: SidebarEntry): HTMLElement {
    const el = document.createElement('div');
    el.className = `sidebar-entry ${entry.type}`;
    const time = document.createElement('div');
    time.className = 'sidebar-entry-time';
    time.textContent = new Date(entry.timestamp).toLocaleTimeString();
    const content = document.createElement('div');
    const prefix = entry.type === 'user-input' ? '> ' : entry.type === 'tool-call' ? '🔧 ' : '';
    content.textContent = prefix + entry.content;
    el.appendChild(time);
    el.appendChild(content);
    return el;
  }

  private scrollToBottom() {
    requestAnimationFrame(() => { this.entriesEl.scrollTop = this.entriesEl.scrollHeight; });
  }
}
