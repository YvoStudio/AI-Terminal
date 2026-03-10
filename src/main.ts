import { api } from './api';
import { appState } from './components/app-state';
import { TabBar } from './components/tab-bar';
import { TerminalView } from './components/terminal-view';
import { Sidebar } from './components/sidebar';
import { themes } from './components/themes';

const terminalViews = new Map<string, TerminalView>();
const container = document.getElementById('terminal-container')!;

async function createTab(name?: string, noteBlocks?: Array<{ id: string; content: string }>, cwd?: string, shell?: 'cmd' | 'powershell' | 'wsl'): Promise<string> {
  const tabId = await api.createTerminal(cwd);
  const tab = appState.addTab(tabId);
  if (typeof name === 'string') tab.title = name;
  if (noteBlocks && noteBlocks.length > 0) {
    tab.noteBlocks = noteBlocks.map(b => ({ id: b.id, content: b.content }));
    blockCounter = Math.max(blockCounter, ...noteBlocks.map(b => parseInt(b.id.replace('b', '')) || 0));
  }

  const view = new TerminalView(tabId, container);
  terminalViews.set(tabId, view);

  switchToTab(tabId);

  if (shell && shell !== 'cmd') {
    await switchShell(tabId, shell);
  }

  appState.persistTabs();
  return tabId;
}

function closeTab(tabId: string) {
  api.closeTerminal(tabId);
  const view = terminalViews.get(tabId);
  if (view) { view.dispose(); terminalViews.delete(tabId); }

  const nextTabId = appState.removeTab(tabId);
  appState.persistTabs();
  if (nextTabId) { switchToTab(nextTabId); } else { createTab(); }
}

function switchToTab(tabId: string) {
  for (const [id, view] of terminalViews) {
    if (id === tabId) { view.show(); view.focus(); } else { view.hide(); }
  }
  appState.switchTab(tabId);
}

async function switchShell(tabId: string, shell: 'cmd' | 'powershell' | 'wsl') {
  await api.switchShell(tabId, shell);
  appState.setShell(tabId, shell);
  const view = terminalViews.get(tabId);
  if (view) {
    view.clear();
    // Sync actual terminal dimensions to the new PTY immediately,
    // otherwise PSReadLine starts with the default 30x120 and miscalculates cursor offsets
    requestAnimationFrame(() => view.fit());
  }
}

// Initialize components
const tabBar = new TabBar(() => createTab(), closeTab, switchToTab, switchShell);
const sidebar = new Sidebar();
void tabBar; void sidebar;

// Double-click title bar to maximize/restore
document.getElementById('tab-bar')!.addEventListener('dblclick', (e) => {
  const target = e.target as HTMLElement;
  if (target.id === 'tab-bar' || !target.closest('.tab, #new-tab-btn, .tab-bar-btn')) {
    api.toggleMaximize();
  }
});

function refitActiveTerminal() {
  if (appState.activeTabId) {
    const view = terminalViews.get(appState.activeTabId);
    if (view) requestAnimationFrame(() => view.fit());
  }
}

// Sidebar toggle
const sidebarEl = document.getElementById('sidebar')!;
const sidebarResizeEl = document.getElementById('sidebar-resize-handle')!;
const sidebarBtn = document.getElementById('btn-toggle-sidebar')!;
function setSidebarVisible(visible: boolean) {
  sidebarEl.classList.toggle('hidden', !visible);
  sidebarResizeEl.style.display = visible ? '' : 'none';
  sidebarBtn.classList.toggle('active', visible);
  localStorage.setItem('sidebar-hidden', visible ? '0' : '1');
  refitActiveTerminal();
}
sidebarBtn.addEventListener('click', () => setSidebarVisible(sidebarEl.classList.contains('hidden')));
if (localStorage.getItem('sidebar-hidden') !== '0') setSidebarVisible(false);

// Notepad toggle
const notepadEl = document.getElementById('notepad')!;
const notepadResizeEl = document.getElementById('notepad-resize-handle')!;
const notepadBtn = document.getElementById('btn-toggle-notepad')!;
const notepadBlocksEl = document.getElementById('notepad-blocks')!;
function setNotepadVisible(visible: boolean) {
  notepadEl.classList.toggle('hidden', !visible);
  notepadResizeEl.style.display = visible ? '' : 'none';
  notepadBtn.classList.toggle('active', visible);
  localStorage.setItem('notepad-hidden', visible ? '' : '1');
  refitActiveTerminal();
}
notepadBtn.addEventListener('click', () => setNotepadVisible(notepadEl.classList.contains('hidden')));
if (localStorage.getItem('notepad-hidden') !== '') setNotepadVisible(false);

// Notepad resize
(() => {
  let startX = 0, startWidth = 0;
  notepadResizeEl.addEventListener('mousedown', (e) => {
    startX = e.clientX; startWidth = notepadEl.offsetWidth;
    const onMove = (e: MouseEvent) => {
      notepadEl.style.width = Math.max(200, Math.min(600, startWidth - (e.clientX - startX))) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      refitActiveTerminal();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

// Notepad blocks
let blockCounter = 0;
function addNoteBlock(tabId: string, content = '') {
  const tab = appState.tabs.get(tabId);
  if (!tab) return;
  tab.noteBlocks.push({ id: `b${++blockCounter}`, content });
  if (tabId === appState.activeTabId) renderNoteBlocks(true);
  appState.persistTabs();
}
function removeNoteBlock(tabId: string, blockId: string) {
  const tab = appState.tabs.get(tabId);
  if (!tab) return;
  tab.noteBlocks = tab.noteBlocks.filter(b => b.id !== blockId);
  if (tabId === appState.activeTabId) renderNoteBlocks(true);
  appState.persistTabs();
}
function sendNoteBlock(tabId: string, blockId: string) {
  const tab = appState.tabs.get(tabId);
  if (!tab) return;
  const block = tab.noteBlocks.find(b => b.id === blockId);
  if (!block || !block.content.trim()) return;
  api.writeTerminal(tabId, block.content);
  removeNoteBlock(tabId, blockId);
}

let lastRenderedTabId: string | null = null;
let lastRenderedBlockCount = -1;

function renderNoteBlocks(force = false) {
  if (!appState.activeTabId) { notepadBlocksEl.innerHTML = ''; lastRenderedTabId = null; lastRenderedBlockCount = -1; return; }
  const tab = appState.tabs.get(appState.activeTabId);
  if (!tab) return;
  if (!force && appState.activeTabId === lastRenderedTabId && tab.noteBlocks.length === lastRenderedBlockCount && notepadEl.contains(document.activeElement)) return;

  lastRenderedTabId = appState.activeTabId;
  lastRenderedBlockCount = tab.noteBlocks.length;
  notepadBlocksEl.innerHTML = '';

  const tabId = appState.activeTabId;
  for (const block of tab.noteBlocks) {
    const el = document.createElement('div');
    el.className = 'note-block';
    const textarea = document.createElement('textarea');
    textarea.placeholder = '输入文本...';
    textarea.value = block.content;
    textarea.rows = 3;
    textarea.addEventListener('input', () => {
      block.content = textarea.value;
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
      appState.persistTabs();
    });
    requestAnimationFrame(() => { textarea.style.height = 'auto'; textarea.style.height = textarea.scrollHeight + 'px'; });

    const actions = document.createElement('div');
    actions.className = 'note-block-actions';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'note-block-btn send';
    sendBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M1 1l14 7-14 7V9l10-1-10-1z"/></svg> 发送';
    sendBtn.addEventListener('click', () => sendNoteBlock(tabId, block.id));
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'note-block-btn delete';
    deleteBtn.textContent = '删除';
    deleteBtn.addEventListener('click', () => removeNoteBlock(tabId, block.id));
    actions.appendChild(deleteBtn);
    actions.appendChild(sendBtn);
    el.appendChild(textarea);
    el.appendChild(actions);
    notepadBlocksEl.appendChild(el);
  }

  const addBtn = document.createElement('div');
  addBtn.className = 'notepad-empty';
  addBtn.textContent = '+ 点击添加文本块';
  addBtn.addEventListener('click', () => { if (appState.activeTabId) addNoteBlock(appState.activeTabId); });
  notepadBlocksEl.appendChild(addBtn);
}

document.getElementById('notepad-add-block')!.addEventListener('click', () => {
  if (appState.activeTabId) addNoteBlock(appState.activeTabId);
});
appState.subscribe(() => renderNoteBlocks());

// Tips panel
(() => {
  const tipsBtn = document.getElementById('btn-tips')!;
  let tipsOpen = false; let tipsEl: HTMLElement | null = null;
  tipsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (tipsOpen && tipsEl) { tipsEl.remove(); tipsEl = null; tipsOpen = false; return; }
    tipsEl = document.createElement('div');
    tipsEl.className = 'tips-panel tips-panel-wide';
    tipsEl.innerHTML = `
      <h3>使用技巧</h3>
      <div class="tips-columns">
        <div class="tips-column">
          <div class="tips-section">
            <div class="tips-section-title">快捷键</div>
            <div class="tips-item"><span class="tips-key">Ctrl+T</span> 新建标签</div>
            <div class="tips-item"><span class="tips-key">Ctrl+W</span> 关闭标签</div>
            <div class="tips-item"><span class="tips-key">Ctrl+Tab</span> 切换标签</div>
            <div class="tips-item"><span class="tips-key">Ctrl+1-9</span> 跳转到指定标签</div>
          </div>
          <div class="tips-section">
            <div class="tips-section-title">Notepad</div>
            <div class="tips-item"><span class="tips-icon">+</span>添加文本块，预写提示词</div>
            <div class="tips-item"><span class="tips-icon" style="color:var(--accent-green)">▶</span>发送文本块内容到终端</div>
            <div class="tips-item"><span class="tips-icon">✏️</span>双击标签名可重命名</div>
          </div>
        </div>
        <div class="tips-column">
          <div class="tips-section">
            <div class="tips-section-title">Claude Code 启动</div>
            <div class="tips-item"><span class="tips-cmd">claude</span> 正常启动交互模式</div>
            <div class="tips-item"><span class="tips-cmd">claude --dangerously-skip-permissions</span> 跳过所有权限确认</div>
            <div class="tips-item"><span class="tips-cmd">claude -p "prompt"</span> 执行单次任务后退出</div>
            <div class="tips-item"><span class="tips-cmd">claude -c</span> 继续上一次对话</div>
          </div>
          <div class="tips-section">
            <div class="tips-section-title">Claude Code 交互命令</div>
            <div class="tips-item"><span class="tips-cmd">/compact</span> 压缩上下文</div>
            <div class="tips-item"><span class="tips-cmd">/model</span> 切换模型</div>
            <div class="tips-item"><span class="tips-cmd">/cost</span> 查看 token 用量</div>
          </div>
        </div>
      </div>
    `;
    tipsEl.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(tipsEl);
    tipsOpen = true;
  });
  document.addEventListener('click', () => { if (tipsOpen && tipsEl) { tipsEl.remove(); tipsEl = null; tipsOpen = false; } });
})();

// History panel
(() => {
  const historyBtn = document.getElementById('btn-history')!;
  let historyOpen = false; let historyEl: HTMLElement | null = null;
  historyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (historyOpen && historyEl) { historyEl.remove(); historyEl = null; historyOpen = false; return; }
    const entries = await api.loadHistory();
    historyEl = document.createElement('div');
    historyEl.className = 'tips-panel';
    historyEl.style.maxHeight = '60vh';
    historyEl.innerHTML = `<h3>历史工作区</h3>`;
    if (entries.length === 0) {
      historyEl.innerHTML += `<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">暂无历史记录</div>`;
    } else {
      for (const entry of entries) {
        const item = document.createElement('div');
        item.className = 'history-item';
        const shortCwd = entry.cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^C:\\Users\\[^\\]+/, '~');
        const time = new Date(entry.timestamp);
        const timeStr = `${time.getMonth()+1}/${time.getDate()} ${time.getHours().toString().padStart(2,'0')}:${time.getMinutes().toString().padStart(2,'0')}`;
        item.innerHTML = `<div class="history-item-name">${entry.name}</div><div class="history-item-cwd">${shortCwd}</div><div class="history-item-time">${timeStr}</div>`;
        item.addEventListener('click', async () => {
          const tabId = await createTab(entry.name, undefined, entry.cwd);
          if (entry.shell && entry.shell !== 'cmd') {
            await switchShell(tabId, entry.shell);
          }
          historyEl?.remove(); historyEl = null; historyOpen = false;
        });
        historyEl.appendChild(item);
      }
    }
    historyEl.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(historyEl);
    historyOpen = true;
  });
  document.addEventListener('click', () => { if (historyOpen && historyEl) { historyEl.remove(); historyEl = null; historyOpen = false; } });
})();

// File/image/dir buttons
document.getElementById('btn-add-image')!.addEventListener('click', async () => {
  if (!appState.activeTabId) return;
  const p = await api.selectImage();
  if (p) api.writeTerminal(appState.activeTabId, p);
});
document.getElementById('btn-add-file')!.addEventListener('click', async () => {
  if (!appState.activeTabId) return;
  const p = await api.selectFile();
  if (p) api.writeTerminal(appState.activeTabId, p);
});
document.getElementById('btn-add-dir')!.addEventListener('click', async () => {
  if (!appState.activeTabId) return;
  const p = await api.selectDirectory();
  if (p) api.writeTerminal(appState.activeTabId, p);
});

// Backend events
api.onTabStatusChanged((tabId, status) => appState.setStatus(tabId, status));
api.onSidebarEntryAdded((tabId, entry) => appState.addSidebarEntry(tabId, entry));
api.onTabAutoRenamed((tabId, name) => {
  const tab = appState.tabs.get(tabId);
  if (tab && tab.title.startsWith('Terminal ')) {
    appState.renameTab(tabId, name);
    api.updateHistoryName(tabId, name);
  }
});
api.onClaudeDetected((tabId, cwd) => {
  const tab = appState.tabs.get(tabId);
  if (tab) api.addHistory(tabId, tab.title, cwd, tab.shell);
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const isCtrl = e.ctrlKey || e.metaKey;
  if (isCtrl && e.key === 't') { e.preventDefault(); createTab(); }
  else if (isCtrl && e.key === 'w') { e.preventDefault(); if (appState.activeTabId) closeTab(appState.activeTabId); }
  else if (isCtrl && e.key === 'Tab') { e.preventDefault(); if (e.shiftKey) appState.switchToPrev(); else appState.switchToNext(); if (appState.activeTabId) switchToTab(appState.activeTabId); }
  else if (isCtrl && e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    const idx = parseInt(e.key) - 1;
    if (idx < appState.tabOrder.length) switchToTab(appState.tabOrder[idx]);
  }
});

// Theme picker
function applyThemeToAll(index: number) {
  localStorage.setItem('terminal-theme-index', String(index));
  const t = themes[index];
  for (const view of terminalViews.values()) view.applyTheme(index);
  const root = document.documentElement;
  root.style.setProperty('--bg-primary', t.uiBg);
  if (t.light) {
    const isWhite = t.name === 'Pure White';
    root.style.setProperty('--bg-secondary', isWhite ? '#f5f5f5' : '#eee8d5');
    root.style.setProperty('--bg-tertiary', isWhite ? '#ebebeb' : '#e6dfcc');
    root.style.setProperty('--bg-hover', isWhite ? '#e0e0e0' : '#d6ceb5');
    root.style.setProperty('--text-primary', isWhite ? '#1a1a1a' : '#073642');
    root.style.setProperty('--text-secondary', isWhite ? '#555555' : '#586e75');
    root.style.setProperty('--text-muted', isWhite ? '#999999' : '#93a1a1');
    root.style.setProperty('--border-color', isWhite ? '#d4d4d4' : '#d3cbb7');
    root.style.setProperty('--tab-active-bg', t.uiBg);
    root.style.setProperty('--tab-inactive-bg', isWhite ? '#f5f5f5' : '#eee8d5');
  } else {
    root.style.setProperty('--bg-secondary', '#252526');
    root.style.setProperty('--bg-tertiary', '#2d2d2d');
    root.style.setProperty('--bg-hover', '#3c3c3c');
    root.style.setProperty('--text-primary', '#cccccc');
    root.style.setProperty('--text-secondary', '#999999');
    root.style.setProperty('--text-muted', '#666666');
    root.style.setProperty('--border-color', '#404040');
    root.style.setProperty('--tab-active-bg', '#1e1e1e');
    root.style.setProperty('--tab-inactive-bg', '#2d2d2d');
  }
  const statusTheme = document.getElementById('status-theme');
  if (statusTheme) statusTheme.textContent = t.name;
}

function setupThemePicker() {
  const themeEl = document.getElementById('status-theme')!;
  const currentIndex = TerminalView.getSavedThemeIndex();
  applyThemeToAll(currentIndex);

  let pickerOpen = false; let pickerEl: HTMLElement | null = null;
  themeEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pickerOpen && pickerEl) { pickerEl.remove(); pickerEl = null; pickerOpen = false; return; }
    const currentIdx = TerminalView.getSavedThemeIndex();
    pickerEl = document.createElement('div');
    pickerEl.className = 'theme-picker';
    themes.forEach((t, i) => {
      const item = document.createElement('div');
      item.className = `theme-picker-item${i === currentIdx ? ' active' : ''}`;
      const dot = document.createElement('span');
      dot.className = 'theme-color-dot';
      dot.style.background = t.theme.background as string;
      const label = document.createElement('span');
      label.textContent = t.name;
      item.appendChild(dot); item.appendChild(label);
      item.addEventListener('click', (ev) => { ev.stopPropagation(); applyThemeToAll(i); pickerEl?.remove(); pickerEl = null; pickerOpen = false; });
      pickerEl!.appendChild(item);
    });
    document.body.appendChild(pickerEl);
    pickerOpen = true;
  });
  document.addEventListener('click', () => { if (pickerOpen && pickerEl) { pickerEl.remove(); pickerEl = null; pickerOpen = false; } });
}

async function init() {
  setupThemePicker();
  const savedTabs = await api.loadTabs();
  if (savedTabs.length > 0) {
    for (const saved of savedTabs) await createTab(saved.name, saved.noteBlocks, undefined, saved.shell);
  } else {
    createTab();
  }
}

init();
