import { api } from './api';
import { appState } from './components/app-state';
import { TabBar } from './components/tab-bar';
import { TerminalView } from './components/terminal-view';
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
  api.clearBadge();
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
void tabBar;

// Platform-specific title bar
const isMacOS = navigator.userAgent.includes('Mac');
if (isMacOS) {
  // macOS: native traffic lights via Overlay, hide custom window controls
  document.getElementById('window-controls')?.remove();
  document.getElementById('traffic-light-spacer')!.style.display = '';
} else {
  // Windows/Linux: custom window controls, no traffic light spacer
  document.getElementById('traffic-light-spacer')?.remove();
  const wc = document.getElementById('window-controls');
  if (wc) wc.style.display = 'flex';
  document.getElementById('btn-minimize')?.addEventListener('click', () => api.minimizeWindow());
  document.getElementById('btn-maximize')?.addEventListener('click', () => api.toggleMaximize());
  document.getElementById('btn-close')?.addEventListener('click', () => api.closeWindow());
  // On Windows we need decorations:false — set via Tauri API
  import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    getCurrentWindow().setDecorations(false).catch(() => {});
  });
}

// Double-click tab bar to maximize/restore
document.getElementById('tab-bar')!.addEventListener('dblclick', (e) => {
  const target = e.target as HTMLElement;
  if (target.id === 'tab-bar' || !target.closest('.tab, #new-tab-btn, .tab-bar-btn, #window-controls')) {
    api.toggleMaximize();
  }
});


function refitActiveTerminal() {
  if (appState.activeTabId) {
    const view = terminalViews.get(appState.activeTabId);
    if (view) requestAnimationFrame(() => view.fit());
  }
}

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
            <div class="tips-section-title">底栏工具</div>
            <div class="tips-item"><span class="tips-icon">📎</span>插入路径：选择文件或目录</div>
            <div class="tips-item"><span class="tips-icon">🕐</span>历史会话：恢复标签或会话</div>
            <div class="tips-item"><span class="tips-icon">🎨</span>主题切换：右下角主题名</div>
          </div>
          <div class="tips-section">
            <div class="tips-section-title">快捷键</div>
            <div class="tips-item"><span class="tips-key">⌘T</span> 新建标签</div>
            <div class="tips-item"><span class="tips-key">⌘W</span> 关闭标签</div>
            <div class="tips-item"><span class="tips-key">⌘[</span> / <span class="tips-key">⌘]</span> 切换标签</div>
            <div class="tips-item"><span class="tips-key">⌘1-9</span> 跳转到指定标签</div>
            <div class="tips-item"><span class="tips-key">⌘F</span> 终端内搜索</div>
            <div class="tips-item"><span class="tips-key">⌘K</span> 命令面板</div>
          </div>
          <div class="tips-section">
            <div class="tips-section-title">标签 & Notepad</div>
            <div class="tips-item"><span class="tips-icon">✏️</span>双击标签名可重命名</div>
            <div class="tips-item"><span class="tips-icon">↔️</span>拖动标签可排序</div>
            <div class="tips-item"><span class="tips-icon" style="color:var(--accent-red)">●</span>红点 = 后台任务完成</div>
            <div class="tips-item"><span class="tips-icon" style="color:var(--accent-yellow)">●</span>黄点 = 等待输入</div>
            <div class="tips-item"><span class="tips-icon">+</span>Notepad 预写提示词</div>
            <div class="tips-item"><span class="tips-icon" style="color:var(--accent-green)">▶</span>发送文本块到终端</div>
            <div class="tips-item"><span class="tips-icon" style="color:var(--accent-blue)">⚡</span>等待时自动发送</div>
          </div>
        </div>
        <div class="tips-column">
          <div class="tips-section">
            <div class="tips-section-title">Claude Code 启动</div>
            <div class="tips-item"><span class="tips-cmd">claude</span> 启动交互模式</div>
            <div class="tips-item"><span class="tips-cmd">claude -r</span> 恢复最近会话</div>
            <div class="tips-item"><span class="tips-cmd">claude -c</span> 继续上次对话</div>
            <div class="tips-item"><span class="tips-cmd">claude -p "prompt"</span> 单次任务</div>
            <div class="tips-item"><span class="tips-cmd">claude --dangerously-skip-permissions</span> 跳过权限</div>
            <div class="tips-item"><span class="tips-cmd">cat file | claude -p "分析"</span> 管道输入</div>
          </div>
          <div class="tips-section">
            <div class="tips-section-title">交互命令</div>
            <div class="tips-item"><span class="tips-cmd">/compact</span> 压缩上下文</div>
            <div class="tips-item"><span class="tips-cmd">/clear</span> 清空对话</div>
            <div class="tips-item"><span class="tips-cmd">/model</span> 切换模型</div>
            <div class="tips-item"><span class="tips-cmd">/cost</span> 查看用量</div>
            <div class="tips-item"><span class="tips-cmd">/help</span> 所有命令</div>
            <div class="tips-item"><span class="tips-cmd">/vim</span> Vim 模式</div>
          </div>
        </div>
        <div class="tips-column">
          <div class="tips-section">
            <div class="tips-section-title">Claude @ 命令</div>
            <div class="tips-item"><span class="tips-cmd">@file</span> 文件内容加入上下文</div>
            <div class="tips-item"><span class="tips-cmd">@dir</span> 目录结构加入上下文</div>
            <div class="tips-item"><span class="tips-cmd">@url</span> 抓取网页内容</div>
            <div class="tips-item"><span class="tips-cmd">@git</span> 引用 git 历史</div>
            <div class="tips-item"><span class="tips-cmd">@terminal</span> 引用终端输出</div>
          </div>
          <div class="tips-section">
            <div class="tips-section-title">高级用法</div>
            <div class="tips-item"><span class="tips-cmd">claude "任务" &</span> 后台运行</div>
            <div class="tips-item"><span class="tips-cmd">CLAUDE_MODEL=opus claude</span> 指定模型</div>
            <div class="tips-item"><span class="tips-cmd">claude config set model opus</span> 默认模型</div>
            <div class="tips-item"><span class="tips-cmd">claude mcp add name cmd</span> 添加 MCP</div>
          </div>
          <div class="tips-section tips-section-hints">
            <div class="tips-item">Notepad 预写长提示词，一键发送</div>
            <div class="tips-item">多标签并行运行多个 Claude 任务</div>
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

// Shared panel close helpers (so attach & history can dismiss each other)
let _closeAttachMenu: (() => void) | null = null;
let _closeHistoryPanel: (() => void) | null = null;

// History panel (unified: Claude sessions first, then plain history)
(() => {
  const historyBtn = document.getElementById('btn-history')!;
  let historyOpen = false; let historyEl: HTMLElement | null = null;

  function escapeHtml(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  interface UnifiedItem {
    type: 'session' | 'history';
    name: string;
    cwd: string;
    time: Date;
    sessionId?: string;
    slug?: string;
    preview?: string;
    shell?: 'cmd' | 'powershell' | 'wsl';
    historyIndex?: number; // original index in history array for deletion
  }

  let currentHistoryItems: UnifiedItem[] = [];
  function closeHistory() { if (historyOpen && historyEl) { historyEl.remove(); historyEl = null; historyOpen = false; } }
  _closeHistoryPanel = closeHistory;

  historyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (historyOpen && historyEl) { closeHistory(); return; }
    if (_closeAttachMenu) _closeAttachMenu();

    historyEl = document.createElement('div');
    historyEl.className = 'tips-panel';
    historyEl.style.maxHeight = '65vh';
    historyEl.style.overflow = 'hidden';
    historyEl.style.display = 'flex';
    historyEl.style.flexDirection = 'column';
    historyEl.style.paddingRight = '0';
    historyEl.innerHTML = `<h3>历史会话</h3><div class="history-content"><div style="color:var(--text-muted);font-size:12px;padding:8px 0;">加载中...</div></div><button class="history-clear-btn">清空历史</button>`;
    historyEl.addEventListener('click', (ev) => ev.stopPropagation());
    document.body.appendChild(historyEl);
    historyOpen = true;

    // Clear all button
    const clearBtn = historyEl.querySelector('.history-clear-btn')!;
    clearBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      // Clear plain history
      await api.clearHistory();
      // Also delete all Claude sessions that were listed
      for (const item of currentHistoryItems) {
        if (item.type === 'session' && item.sessionId) {
          await api.deleteClaudeSession(item.sessionId).catch(() => {});
        }
      }
      currentHistoryItems = [];
      const contentEl2 = historyEl!.querySelector('.history-content')!;
      contentEl2.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">已清空</div>`;
    });

    // Load both sources in parallel
    const [sessions, entries] = await Promise.all([
      api.listClaudeSessions().catch(() => []),
      api.loadHistory().catch(() => []),
    ]);

    // Build unified list
    const items: UnifiedItem[] = [];

    // Claude sessions
    for (const s of sessions) {
      const preview = s.user_messages.length > 0
        ? s.user_messages.map(m => m.slice(0, 50)).join(' → ')
        : '';
      items.push({
        type: 'session',
        name: s.slug,
        cwd: s.cwd,
        time: s.timestamp ? new Date(s.timestamp) : new Date(0),
        sessionId: s.session_id,
        slug: s.slug,
        preview,
      });
    }

    // Plain history (deduplicate against sessions by cwd)
    const sessionCwds = new Set(sessions.map(s => s.cwd));
    entries.forEach((h, i) => {
      if (sessionCwds.has(h.cwd)) return;
      items.push({
        type: 'history',
        name: h.name,
        cwd: h.cwd,
        time: new Date(h.timestamp),
        shell: h.shell,
        historyIndex: i,
      });
    });

    // Sort by time descending, limit to 20
    items.sort((a, b) => b.time.getTime() - a.time.getTime());
    if (items.length > 20) items.length = 20;
    currentHistoryItems = items;

    const contentEl = historyEl.querySelector('.history-content')!;
    contentEl.innerHTML = '';

    if (items.length === 0) {
      contentEl.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">暂无历史记录</div>`;
      return;
    }

    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'history-item';
      const shortCwd = item.cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^C:\\Users\\[^\\]+/, '~');
      const timeStr = `${item.time.getMonth()+1}/${item.time.getDate()} ${item.time.getHours().toString().padStart(2,'0')}:${item.time.getMinutes().toString().padStart(2,'0')}`;

      const badge = item.type === 'session'
        ? `<span class="history-badge-resume">resume</span>`
        : '';
      const previewHtml = item.preview
        ? `<div class="session-preview">${escapeHtml(item.preview)}</div>`
        : '';

      el.innerHTML = `<div class="history-item-name">${badge}${escapeHtml(item.name)}</div><div class="history-item-cwd">${escapeHtml(shortCwd)}</div>${previewHtml}<div class="history-item-time">${timeStr}</div>`;

      // Delete button
      const delBtn = document.createElement('button');
      delBtn.className = 'history-item-delete';
      delBtn.textContent = '×';
      delBtn.title = '删除';
      delBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (item.type === 'session' && item.sessionId) {
          await api.deleteClaudeSession(item.sessionId);
        } else if (item.historyIndex !== undefined) {
          await api.deleteHistoryEntry(item.historyIndex);
        }
        el.remove();
      });
      el.appendChild(delBtn);

      el.addEventListener('click', async () => {
        if (item.type === 'session') {
          const tabId = await createTab(`↻ ${item.slug}`, undefined, item.cwd || undefined);
          setTimeout(() => api.writeTerminal(tabId, `claude --resume ${item.sessionId}\n`), 500);
        } else {
          const tabId = await createTab(item.name, undefined, item.cwd);
          if (item.shell && item.shell !== 'cmd') await switchShell(tabId, item.shell);
        }
        historyEl?.remove(); historyEl = null; historyOpen = false;
      });
      contentEl.appendChild(el);
    }
  });
  document.addEventListener('click', () => { closeHistory(); });
})();

// Attach button — file/dir picker menu
(() => {
  const attachBtn = document.getElementById('btn-attach')!;
  let menuOpen = false;
  let menuEl: HTMLElement | null = null;

  function closeAttach() { if (menuOpen && menuEl) { menuEl.remove(); menuEl = null; menuOpen = false; attachBtn.classList.remove('menu-open'); } }
  _closeAttachMenu = closeAttach;

  attachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menuOpen && menuEl) { closeAttach(); return; }
    if (_closeHistoryPanel) _closeHistoryPanel();

    menuEl = document.createElement('div');
    menuEl.className = 'attach-menu';
    menuEl.innerHTML = `
      <div class="attach-menu-item" data-type="file">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13 1H5a1 1 0 00-1 1v2H3a1 1 0 00-1 1v9a1 1 0 001 1h8a1 1 0 001-1v-2h1a1 1 0 001-1V3l-2-2zm-3 13H4V6h6v8zm3-3h-1V5a1 1 0 00-1-1H6V3h4l2 2v6z"/></svg>
        文件
      </div>
      <div class="attach-menu-item" data-type="dir">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 3H7.5L6 1.5H2a1 1 0 00-1 1v11a1 1 0 001 1h12a1 1 0 001-1V4a1 1 0 00-1-1z"/></svg>
        目录
      </div>
    `;
    menuEl.addEventListener('click', async (ev) => {
      const item = (ev.target as HTMLElement).closest('.attach-menu-item') as HTMLElement | null;
      if (!item || !appState.activeTabId) return;
      menuEl?.remove(); menuEl = null; menuOpen = false;
      const type = item.dataset.type;
      const p = type === 'dir' ? await api.selectDirectory() : await api.selectFile();
      if (p) api.writeTerminal(appState.activeTabId, p);
    });
    document.body.appendChild(menuEl);
    menuOpen = true;
    attachBtn.classList.add('menu-open');
  });
  document.addEventListener('click', () => { closeAttach(); });
})();

// Backend events — auto-send notepad blocks when Claude is waiting
api.onTabStatusChanged((tabId, status) => {
  const prevStatus = appState.tabs.get(tabId)?.status;
  appState.setStatus(tabId, status);

  // Style user input: bright green text + subtle gray background when waiting for input
  const view = terminalViews.get(tabId);
  if (view) {
    if (status === 'waiting') {
      // ESC[38;2;80;220;100m = bright green fg, ESC[48;2;40;40;40m = dark gray bg
      view.terminal.write('\x1b[38;2;80;220;100m\x1b[48;2;40;40;40m');
    } else if (prevStatus === 'waiting' && status !== 'waiting') {
      // Reset colors when user submits input
      view.terminal.write('\x1b[0m');
    }
  }

  // Auto-submit first notepad block when tab becomes "waiting" (Claude waiting for input)
  if (status === 'waiting') {
    const tab = appState.tabs.get(tabId);
    if (tab && tab.noteBlocks.length > 0) {
      const block = tab.noteBlocks[0];
      if (block.content.trim()) {
        // Slight delay to ensure prompt is ready
        setTimeout(() => {
          api.writeTerminal(tabId, block.content);
          removeNoteBlock(tabId, block.id);
        }, 300);
      }
    }
  }
});
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
  else if (isCtrl && e.key === 'f') { e.preventDefault(); if (appState.activeTabId) { const v = terminalViews.get(appState.activeTabId); if (v) v.toggleSearch(); } }
  else if (isCtrl && e.key === 'Tab') { e.preventDefault(); if (e.shiftKey) appState.switchToPrev(); else appState.switchToNext(); if (appState.activeTabId) switchToTab(appState.activeTabId); }
  else if (isCtrl && e.shiftKey && e.key === 'p') { e.preventDefault(); toggleCommandPalette(); }
  else if (isCtrl && e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    const idx = parseInt(e.key) - 1;
    if (idx < appState.tabOrder.length) switchToTab(appState.tabOrder[idx]);
  }
});

// Command palette (Cmd+Shift+P)
let paletteEl: HTMLElement | null = null;
function toggleCommandPalette() {
  if (paletteEl) { paletteEl.remove(); paletteEl = null; return; }

  interface PaletteItem { label: string; detail?: string; action: () => void; }

  const items: PaletteItem[] = [
    { label: '新建标签', detail: '⌘T', action: () => createTab() },
    { label: '关闭标签', detail: '⌘W', action: () => { if (appState.activeTabId) closeTab(appState.activeTabId); } },
    { label: '终端搜索', detail: '⌘F', action: () => { if (appState.activeTabId) { const v = terminalViews.get(appState.activeTabId); if (v) v.toggleSearch(); } } },
    { label: '切换笔记面板', action: () => setNotepadVisible(notepadEl.classList.contains('hidden')) },
    { label: '清空终端', action: () => { if (appState.activeTabId) { const v = terminalViews.get(appState.activeTabId); if (v) v.clear(); } } },
  ];
  // Add theme items
  themes.forEach((t, i) => {
    items.push({ label: `主题: ${t.name}`, action: () => applyThemeToAll(i) });
  });
  // Add tab switch items
  for (const id of appState.tabOrder) {
    const tab = appState.tabs.get(id)!;
    items.push({ label: `切换到: ${tab.title}`, action: () => switchToTab(id) });
  }

  const overlay = document.createElement('div');
  overlay.className = 'palette-overlay';
  const panel = document.createElement('div');
  panel.className = 'command-palette';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '输入命令...';
  input.className = 'palette-input';
  const list = document.createElement('div');
  list.className = 'palette-list';

  let filtered = [...items];
  let selectedIdx = 0;

  function renderList() {
    list.innerHTML = '';
    filtered.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = `palette-item${i === selectedIdx ? ' selected' : ''}`;
      el.innerHTML = `<span>${item.label}</span>${item.detail ? `<span class="palette-detail">${item.detail}</span>` : ''}`;
      el.addEventListener('click', () => { close(); item.action(); });
      el.addEventListener('mouseenter', () => { selectedIdx = i; renderList(); });
      list.appendChild(el);
    });
  }

  function close() { if (paletteEl) { paletteEl.remove(); paletteEl = null; } }

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    filtered = items.filter(item => item.label.toLowerCase().includes(q));
    selectedIdx = 0;
    renderList();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIdx = Math.min(selectedIdx + 1, filtered.length - 1); renderList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selectedIdx = Math.max(selectedIdx - 1, 0); renderList(); }
    else if (e.key === 'Enter') { e.preventDefault(); close(); if (filtered[selectedIdx]) filtered[selectedIdx].action(); }
    else if (e.key === 'Escape') { close(); }
  });

  overlay.addEventListener('click', close);
  panel.appendChild(input);
  panel.appendChild(list);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  paletteEl = overlay;
  renderList();
  input.focus();
}

// Theme picker
function applyThemeToAll(index: number) {
  localStorage.setItem('terminal-theme-index', String(index));
  const t = themes[index];
  for (const view of terminalViews.values()) view.applyTheme(index);
  const root = document.documentElement;
  root.style.setProperty('--bg-primary', t.uiBg);
  if (t.light) {
    const bg = t.uiBg;
    const r = parseInt(bg.slice(1,3),16), g = parseInt(bg.slice(3,5),16), b = parseInt(bg.slice(5,7),16);
    const adjust = (amt: number) => '#' + [r,g,b].map(c => Math.max(0, Math.min(255, c - amt)).toString(16).padStart(2,'0')).join('');
    const lighten = (amt: number) => '#' + [r,g,b].map(c => Math.min(255, c + amt).toString(16).padStart(2,'0')).join('');
    root.style.setProperty('--bg-secondary', adjust(10));
    root.style.setProperty('--bg-tertiary', adjust(18));
    root.style.setProperty('--bg-hover', adjust(25));
    root.style.setProperty('--text-primary', '#1a1a1a');
    root.style.setProperty('--text-secondary', '#444444');
    root.style.setProperty('--text-muted', '#777777');
    root.style.setProperty('--border-color', adjust(20));
    root.style.setProperty('--tab-active-bg', bg);
    root.style.setProperty('--tab-inactive-bg', adjust(8));
    root.style.setProperty('--accent-green', '#006400');
    root.style.setProperty('--accent-red', '#c41a16');
    root.style.setProperty('--accent-blue', '#003d99');
    root.style.setProperty('--accent-yellow', '#7a5b00');
  } else {
    // Derive UI colors from theme background
    const bg = t.theme.background || t.uiBg;
    const r = parseInt(bg.slice(1,3),16), g = parseInt(bg.slice(3,5),16), b = parseInt(bg.slice(5,7),16);
    const lighten = (amt: number) => '#' + [r,g,b].map(c => Math.min(255, c + amt).toString(16).padStart(2,'0')).join('');
    const darken = (amt: number) => '#' + [r,g,b].map(c => Math.max(0, c - amt).toString(16).padStart(2,'0')).join('');
    root.style.setProperty('--bg-secondary', lighten(10));
    root.style.setProperty('--bg-tertiary', lighten(18));
    root.style.setProperty('--bg-hover', lighten(30));
    root.style.setProperty('--text-primary', '#cccccc');
    root.style.setProperty('--text-secondary', '#999999');
    root.style.setProperty('--text-muted', '#666666');
    root.style.setProperty('--border-color', lighten(25));
    root.style.setProperty('--tab-active-bg', bg);
    root.style.setProperty('--tab-inactive-bg', lighten(12));
    root.style.setProperty('--accent-green', '#4ec9b0');
    root.style.setProperty('--accent-red', '#f14c4c');
    root.style.setProperty('--accent-blue', '#569cd6');
    root.style.setProperty('--accent-yellow', '#dcdcaa');
  }
  // Update color-scheme for native scrollbar theming
  document.documentElement.style.colorScheme = t.light ? 'light' : 'dark';
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
