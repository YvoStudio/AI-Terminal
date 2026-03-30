import { api } from './api';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { appState } from './components/app-state';
import { TabBar } from './components/tab-bar';
import { TerminalView } from './components/terminal-view';
import { themes } from './components/themes';
import { getDefaultFontSize, isMac, isWindows, shouldUseNativeTitleBar } from './platform';

function getFontFamilyOptions(): string {
  if (isMac) {
    return `
      <option value="auto">默认 (SF Mono)</option>
      <option value="menlo">Menlo</option>
      <option value="monaco">Monaco</option>
      <option value="courier">Courier New</option>
      <option value="meslo-nerd">MesloLGS Nerd Font</option>
      <option value="hack-nerd">Hack Nerd Font</option>
    `;
  } else {
    return `
      <option value="auto">默认 (Consolas)</option>
      <option value="cascadia">Cascadia Code</option>
      <option value="courier">Courier New</option>
      <option value="lucida">Lucida Console</option>
      <option value="caskaydia-nerd">CaskaydiaCove Nerd Font</option>
    `;
  }
}

function getCleanFontFamilyOptions(): string {
  if (isMac) {
    return `
      <option value="auto">默认 (SF Mono)</option>
      <option value="menlo">Menlo</option>
      <option value="monaco">Monaco</option>
      <option value="courier">Courier New</option>
      <option value="meslo-nerd">MesloLGS Nerd Font</option>
      <option value="hack-nerd">Hack Nerd Font</option>
    `;
  }

  return `
      <option value="auto">默认 (Cascadia Code)</option>
      <option value="cascadia">Cascadia Code</option>
      <option value="courier">Courier New</option>
      <option value="lucida">Lucida Console</option>
      <option value="caskaydia-nerd">CaskaydiaCove Nerd Font</option>
    `;
}

const terminalViews = new Map<string, TerminalView>();
const container = document.getElementById('terminal-container')!;
let windowHasFocus = document.hasFocus();

function getPendingDoneCount(): number {
  let count = 0;
  for (const tab of appState.tabs.values()) {
    if (tab.status === 'done-unseen') count += 1;
  }
  return count;
}

function syncPendingAttention(requestAttention = false): void {
  const pendingCount = getPendingDoneCount();
  if (pendingCount > 0) {
    api.notifyTaskDone(pendingCount, requestAttention);
  } else {
    api.clearBadge();
  }
}

function maybeShowSystemNotification(tabId: string): void {
  if (windowHasFocus && tabId === appState.activeTabId) return;
  if (!('Notification' in window)) return;

  const tab = appState.tabs.get(tabId);
  const title = tab?.title || 'AI Terminal';
  const body = `${title} 输出已完成，等待查看`;

  const show = () => {
    try {
      new Notification('AI Terminal', { body, tag: `task-done-${tabId}` });
    } catch {}
  };

  if (Notification.permission === 'granted') {
    show();
  } else if (Notification.permission === 'default') {
    void Notification.requestPermission().then(permission => {
      if (permission === 'granted') show();
    });
  }
}

async function createTab(name?: string, noteBlocks?: Array<{ id: string; content: string; images?: string[] }>, cwd?: string, shell?: 'cmd' | 'powershell' | 'wsl', aiTool?: string): Promise<string> {
  const tabId = await api.createTerminal(cwd);
  const tab = appState.addTab(tabId);
  if (typeof name === 'string') tab.title = name;
  if (aiTool) tab.aiTool = aiTool;
  if (noteBlocks && noteBlocks.length > 0) {
    tab.noteBlocks = noteBlocks.map(b => ({
      id: b.id,
      content: b.content,
      images: b.images ? [...b.images] : undefined,
    }));
    blockCounter = Math.max(blockCounter, ...noteBlocks.map(b => parseInt(b.id.replace('b', '')) || 0));
  }

  const view = new TerminalView(tabId, container);
  terminalViews.set(tabId, view);

  // 监听终端输出，每次有输出时立即更新 cwd
  api.onTerminalOutput(tabId, () => {
    if (appState.activeTabId === tabId) {
      // 直接调用 updateCwdDisplay，使用后端事件保存的 cwd
      const tab = appState.tabs.get(tabId);
      if (tab && tab.cwd) {
        const cwdEl = document.getElementById('status-cwd');
        if (cwdEl) {
          let shortCwd = tab.cwd;
          // Unix-style: /Users/xxx -> ~
          shortCwd = shortCwd.replace(/^\/Users\/[^/]+/, '~');
          // Windows-style: C:\Users\xxx -> ~\xxx
          shortCwd = shortCwd.replace(/^([A-Za-z]):\\Users\\[^\\]+\\/i, '$1:\\~');
          // Windows-style: 保留盘符，移除末尾反斜杠
          shortCwd = shortCwd.replace(/^([A-Za-z]):\\$/i, '$1:');
          cwdEl.textContent = shortCwd || '';
          cwdEl.title = tab.cwd || '';
        }
      }
    }
  }).catch(console.error);

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
  closeTipsPanel();
  for (const [id, view] of terminalViews) {
    if (id === tabId) { view.show(); view.focus(); } else { view.hide(); }
  }
  clearPendingDoneTimer(tabId);
  markDoneAcknowledged(tabId);
  appState.switchTab(tabId);
  syncPendingAttention(false);
  // 切换标签时更新 cwd 显示
  updateCwdDisplay(tabId);
}

async function updateCwdDisplay(tabId: string, newCwd?: string) {
  const cwdEl = document.getElementById('status-cwd');
  if (!cwdEl) return;

  let cwd: string;
  if (newCwd) {
    cwd = newCwd;
  } else {
    try {
      cwd = await api.getTerminalCwd(tabId);
    } catch {
      cwd = '';
    }
  }

  console.log('updateCwdDisplay: cwd =', cwd);
  // 更新 appState 中的 cwd
  appState.setCwd(tabId, cwd);
  // 缩短显示：将长路径缩写为 ~ 开头
  let shortCwd = cwd;
  // Unix-style: /Users/xxx -> ~
  shortCwd = shortCwd.replace(/^\/Users\/[^/]+/, '~');
  // Windows-style: C:\Users\xxx -> ~\xxx
  shortCwd = shortCwd.replace(/^([A-Za-z]):\\Users\\[^\\]+\\/i, '$1:\\~');
  // Windows-style: 保留盘符，移除末尾反斜杠
  shortCwd = shortCwd.replace(/^([A-Za-z]):\\$/i, '$1:');
  console.log('updateCwdDisplay: short =', shortCwd);
  cwdEl.textContent = shortCwd || '';
  cwdEl.title = cwd || '';
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

// Platform-specific setup
const wc = document.getElementById('window-controls');

if (shouldUseNativeTitleBar()) {
  if (wc) {
    wc.style.display = 'none';
    wc.remove();
  }
  document.getElementById('traffic-light-spacer')!.style.display = '';
} else {
  if (wc) wc.style.display = 'flex';
  document.getElementById('traffic-light-spacer')?.remove();
  document.getElementById('btn-minimize')?.addEventListener('click', () => api.minimizeWindow());
  document.getElementById('btn-maximize')?.addEventListener('click', () => api.toggleMaximize());
  document.getElementById('btn-close')?.addEventListener('click', () => api.closeWindow());
}

// On Windows we need decorations:false — set via Tauri API
if (!shouldUseNativeTitleBar()) {
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
    e.preventDefault();
    startX = e.clientX; startWidth = notepadEl.offsetWidth;
    const cleanup = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('mouseleave', cleanup);
      refitActiveTerminal();
    };
    const onMove = (e: MouseEvent) => {
      notepadEl.style.width = Math.max(200, Math.min(600, startWidth - (e.clientX - startX))) + 'px';
    };
    const onUp = () => cleanup();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('mouseleave', cleanup);
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
  if (!block) return;
  const hasText = block.content.trim().length > 0;
  const hasImages = block.images && block.images.length > 0;
  if (!hasText && !hasImages) return;
  // Send images first (as file paths), then text content
  if (hasImages) {
    for (const imgPath of block.images!) {
      api.writeTerminal(tabId, imgPath + ' ');
    }
  }
  if (hasText) {
    api.writeTerminal(tabId, block.content);
  }
  removeNoteBlock(tabId, blockId);
}

function showImagePreview(src: string) {
  items.splice(
    0,
    items.length,
    { label: '新建标签', detail: 'Ctrl+T', action: () => createTab() },
    { label: '关闭标签', detail: 'Ctrl+W', action: () => { if (appState.activeTabId) closeTab(appState.activeTabId); } },
    { label: '终端搜索', detail: 'Ctrl+F', action: () => { if (appState.activeTabId) { const v = terminalViews.get(appState.activeTabId); if (v) v.toggleSearch(); } } },
    { label: '切换笔记面板', action: () => setNotepadVisible(notepadEl.classList.contains('hidden')) },
    { label: '清空终端', action: () => { if (appState.activeTabId) { const v = terminalViews.get(appState.activeTabId); if (v) v.clear(); } } },
    ...themes.map((t, i) => ({ label: `主题: ${t.name}`, action: () => applyThemeToAll(i) })),
    ...appState.tabOrder.map((id) => {
      const tab = appState.tabs.get(id)!;
      return { label: `切换到 ${tab.title}`, action: () => switchToTab(id) };
    }),
  );

  const overlay = document.createElement('div');
  overlay.className = 'image-preview-overlay';
  const img = document.createElement('img');
  img.src = src;
  overlay.appendChild(img);
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
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
    textarea.dataset.blockId = block.id;
    textarea.rows = 3;
    textarea.placeholder = '输入文本...';
    textarea.addEventListener('input', () => {
      block.content = textarea.value;
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
      appState.persistTabs();
    });
    textarea.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) return;
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              const filePath = await api.saveClipboardImage(reader.result as string);
              if (filePath) {
                if (!block.images) block.images = [];
                block.images.push(filePath);
                appState.persistTabs();
                renderNoteBlocks(true);
              }
            } catch (err) { console.error('Failed to save pasted image:', err); }
          };
          reader.readAsDataURL(blob);
          return;
        }
      }
    });

    // Drag and drop support
    textarea.addEventListener('dragover', (e) => {
      e.preventDefault();
      textarea.style.borderColor = 'var(--accent-blue)';
    });
    textarea.addEventListener('dragleave', (e) => {
      e.preventDefault();
      textarea.style.borderColor = '';
    });
    textarea.addEventListener('drop', async (e) => {
      e.preventDefault();
      textarea.style.borderColor = '';
      const items = e.dataTransfer?.items;
      if (!items) return;
      
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (!file) continue;
          
          if (file.type.startsWith('image/')) {
            // Image file - save and show preview
            const reader = new FileReader();
            reader.onload = async () => {
              try {
                const filePath = await api.saveClipboardImage(reader.result as string);
                if (filePath) {
                  if (!block.images) block.images = [];
                  block.images.push(filePath);
                  appState.persistTabs();
                  renderNoteBlocks(true);
                }
              } catch (err) { console.error('Failed to save dropped image:', err); }
            };
            reader.readAsDataURL(file);
          } else {
            // Other file - insert file path (name only for browser security)
            const insertText = `"${file.name}" `;
            const pos = textarea.selectionStart;
            textarea.value = textarea.value.slice(0, pos) + insertText + textarea.value.slice(pos);
            block.content = textarea.value;
            appState.persistTabs();
          }
        }
      }
    });
    requestAnimationFrame(() => { textarea.style.height = 'auto'; textarea.style.height = textarea.scrollHeight + 'px'; });

    // Image previews
    if (block.images && block.images.length > 0) {
      const imgContainer = document.createElement('div');
      imgContainer.className = 'note-block-images';
      for (const imgPath of block.images) {
        const imgWrap = document.createElement('div');
        imgWrap.className = 'note-block-img-wrap';
        const img = document.createElement('img');
        img.src = convertFileSrc(imgPath);
        img.title = imgPath;
        img.style.cursor = 'pointer';
        img.addEventListener('click', (e) => {
          e.stopPropagation();
          showImagePreview(convertFileSrc(imgPath));
        });
        const rmBtn = document.createElement('button');
        rmBtn.className = 'note-block-img-remove';
        rmBtn.textContent = '×';
        rmBtn.addEventListener('click', () => {
          block.images = (block.images || []).filter(p => p !== imgPath);
          appState.persistTabs();
          renderNoteBlocks(true);
        });
        imgWrap.appendChild(img);
        imgWrap.appendChild(rmBtn);
        imgContainer.appendChild(imgWrap);
      }
      el.appendChild(imgContainer);
    }

    const actions = document.createElement('div');
    actions.className = 'note-block-actions';
    const imgBtn = document.createElement('button');
    imgBtn.className = 'note-block-btn';
    imgBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1H2a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1V2a1 1 0 00-1-1zm-1 12H3l3-4 2 2.5L11 7l2 6z"/><circle cx="5.5" cy="5.5" r="1.5"/></svg>';
    imgBtn.title = '插入图片';
    imgBtn.title = '插入图片';
    imgBtn.title = '插入图片';
    imgBtn.addEventListener('click', async () => {
      const p = await api.selectImage();
      if (p) {
        if (!block.images) block.images = [];
        block.images.push(p);
        appState.persistTabs();
        renderNoteBlocks(true);
      }
    });
    const sendBtn = document.createElement('button');
    sendBtn.className = 'note-block-btn send';
    sendBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M1 1l14 7-14 7V9l10-1-10-1z"/></svg> 发送';
    sendBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M1 1l14 7-14 7V9l10-1-10-1z"/></svg> 发送';
    sendBtn.addEventListener('click', () => sendNoteBlock(tabId, block.id));
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'note-block-btn delete';
    deleteBtn.textContent = '删除';
    deleteBtn.textContent = '删除';
    deleteBtn.addEventListener('click', () => removeNoteBlock(tabId, block.id));
    actions.appendChild(imgBtn);
    actions.appendChild(deleteBtn);
    actions.appendChild(sendBtn);
    el.appendChild(textarea);
    el.appendChild(actions);
    notepadBlocksEl.appendChild(el);
  }

  const addBtn = document.createElement('div');
  addBtn.className = 'notepad-empty';
  addBtn.textContent = '+ 点击添加文本块';
  addBtn.textContent = '+ 点击添加文本块';
  addBtn.addEventListener('click', () => { if (appState.activeTabId) addNoteBlock(appState.activeTabId); });
  notepadBlocksEl.appendChild(addBtn);
}

document.getElementById('notepad-add-block')!.addEventListener('click', () => {
  if (appState.activeTabId) addNoteBlock(appState.activeTabId);
});
appState.subscribe(() => renderNoteBlocks());

// 全局拖选状态
let isSelectingText = false;
let isMouseDown = false;

// 监听文本选择状态和鼠标按下状态
document.addEventListener('mousedown', (e) => {
  isMouseDown = true;
  
  // 只处理在终端区域内的鼠标按下
  const target = e.target as HTMLElement;
  if (target.closest('.terminal-wrapper') || target.closest('.xterm')) {
    isSelectingText = true;
  }
});

document.addEventListener('mouseup', () => {
  isMouseDown = false;
  // 鼠标松开后，根据当前选择状态更新
  const sel = window.getSelection();
  isSelectingText = sel ? !sel.isCollapsed : false;
});

// 监听窗口失去焦点，确保清除鼠标按下状态
window.addEventListener('blur', () => {
  isMouseDown = false;
  isSelectingText = false;
});

// 监听文本选择状态
document.addEventListener('selectionchange', () => {
  if (!isMouseDown) {
    const sel = window.getSelection();
    isSelectingText = sel ? !sel.isCollapsed : false;
  }
});

// Tips panel
let _tipsEl: HTMLElement | null = null;
let _tipsOpen = false;

// 暴露为全局函数，供 terminal-view.ts 调用
(window as any).toggleTipsPanel = toggleTipsPanel;

function closeTipsPanel() {
  if (_tipsEl) {
    _tipsEl.remove();
    _tipsEl = null;
  }
  _tipsOpen = false;
}

function getCurrentTerminalFontSize(): number {
  const firstView = terminalViews.values().next().value as TerminalView | undefined;
  const activeView = appState.activeTabId ? terminalViews.get(appState.activeTabId) : undefined;
  const view = activeView || firstView;
  const optionSize = view?.terminal.options.fontSize;
  return typeof optionSize === 'number' ? optionSize : getDefaultFontSize();
}

const TIPS_PANEL_HTML = `
      <h3>使用技巧</h3>
      <div class="tips-columns">
        <div class="tips-column">
          <div class="tips-section">
            <div class="tips-section-title">底栏工具</div>
            <div class="tips-item"><span class="tips-icon">📄</span>插入文件路径</div>
            <div class="tips-item"><span class="tips-icon">📁</span>插入目录路径</div>
            <div class="tips-item"><span class="tips-icon">🕘</span>历史面板可恢复标签或会话</div>
            <div class="tips-item"><span class="tips-icon">🎨</span>右下角可切换主题</div>
          </div>
          <div class="tips-section">
            <div class="tips-section-title">快捷键</div>
            <div class="tips-item"><span class="tips-key">Ctrl+T</span> 新建标签</div>
            <div class="tips-item"><span class="tips-key">Ctrl+W</span> 关闭标签</div>
            <div class="tips-item"><span class="tips-key">Ctrl+[</span> / <span class="tips-key">Ctrl+]</span> 切换标签</div>
            <div class="tips-item"><span class="tips-key">Ctrl+1-9</span> 跳转到指定标签</div>
            <div class="tips-item"><span class="tips-key">Ctrl+F</span> 终端内搜索</div>
            <div class="tips-item"><span class="tips-key">Alt+K</span> 打开技巧面板</div>
            <div class="tips-item"><span class="tips-key">Alt+S</span> 显示/隐藏窗口（全局）</div>
          </div>
          <div class="tips-section">
            <div class="tips-section-title">标签 & Notepad</div>
            <div class="tips-item"><span class="tips-icon">✏️</span>双击标签名可重命名</div>
            <div class="tips-item"><span class="tips-icon">↔️</span>拖动标签可排序</div>
            <div class="tips-item"><span class="tips-icon" style="color:var(--accent-red)">●</span>红点表示后台任务完成</div>
            <div class="tips-item"><span class="tips-icon">🎨</span>右键标签可修改颜色</div>
            <div class="tips-item"><span class="tips-icon">+</span>Notepad 可预写提示词</div>
            <div class="tips-item"><span class="tips-icon" style="color:var(--accent-green)">▶</span>点击发送文本块到当前终端</div>
          </div>
        </div>
        <div class="tips-column tips-column-ai">
          <div class="tips-tabs">
            <button class="tips-tab active" data-tab="claude">Claude Code</button>
            <button class="tips-tab" data-tab="opencode">OpenCode</button>
            <button class="tips-tab" data-tab="codex">Codex</button>
          </div>
          <div class="tips-tab-content active" data-content="claude">
            <div class="tips-section">
              <div class="tips-section-title">启动命令</div>
              <div class="tips-item"><span class="tips-cmd">claude</span> 启动交互模式</div>
              <div class="tips-item"><span class="tips-cmd">claude --continue</span> 继续最近一次会话</div>
              <div class="tips-item"><span class="tips-cmd">claude --resume</span> 打开会话选择器</div>
              <div class="tips-item"><span class="tips-cmd">claude "prompt"</span> 执行单次任务</div>
              <div class="tips-item"><span class="tips-cmd">claude --dangerously-skip-permissions</span> 跳过权限确认</div>
            </div>
            <div class="tips-section">
              <div class="tips-section-title">交互命令</div>
              <div class="tips-item"><span class="tips-cmd">/compact</span> 压缩上下文</div>
              <div class="tips-item"><span class="tips-cmd">/clear</span> 清空对话</div>
              <div class="tips-item"><span class="tips-cmd">/model</span> 切换模型</div>
              <div class="tips-item"><span class="tips-cmd">/cost</span> 查看用量</div>
              <div class="tips-item"><span class="tips-cmd">/help</span> 查看全部命令</div>
            </div>
            <div class="tips-section">
              <div class="tips-section-title">上下文引用</div>
              <div class="tips-item"><span class="tips-cmd">@file</span> 引用文件内容</div>
              <div class="tips-item"><span class="tips-cmd">@dir</span> 引用目录结构</div>
              <div class="tips-item"><span class="tips-cmd">@url</span> 抓取网页内容</div>
              <div class="tips-item"><span class="tips-cmd">@git</span> 引用 Git 历史</div>
              <div class="tips-item"><span class="tips-cmd">@terminal</span> 引用终端输出</div>
            </div>
          </div>
          <div class="tips-tab-content" data-content="opencode">
            <div class="tips-section">
              <div class="tips-section-title">启动命令</div>
              <div class="tips-item"><span class="tips-cmd">opencode</span> 启动交互界面</div>
              <div class="tips-item"><span class="tips-cmd">opencode --continue</span> 继续最近会话</div>
              <div class="tips-item"><span class="tips-cmd">opencode run "prompt"</span> 运行单次任务</div>
              <div class="tips-item"><span class="tips-cmd">opencode --help</span> 查看完整参数</div>
            </div>
            <div class="tips-section">
              <div class="tips-section-title">内置命令</div>
              <div class="tips-item"><span class="tips-cmd">/help</span> 查看帮助</div>
              <div class="tips-item"><span class="tips-cmd">/init</span> 初始化项目说明</div>
              <div class="tips-item"><span class="tips-cmd">/undo</span> 撤销上一条变更</div>
              <div class="tips-item"><span class="tips-cmd">/redo</span> 恢复撤销内容</div>
            </div>
            <div class="tips-section">
              <div class="tips-section-title">提示</div>
              <div class="tips-item"><span class="tips-cmd">@file</span> 可在提示中引用文件</div>
              <div class="tips-item"><span class="tips-note">Agent</span> 支持子任务与多代理</div>
              <div class="tips-item"><span class="tips-note">build / plan</span> 支持不同工作模式</div>
              <div class="tips-item"><span class="tips-note">说明</span> 以 <span class="tips-cmd">/help</span> 与官网文档为准</div>
            </div>
          </div>
          <div class="tips-tab-content" data-content="codex">
            <div class="tips-section">
              <div class="tips-section-title">启动命令</div>
              <div class="tips-item"><span class="tips-cmd">codex</span> 启动交互模式</div>
              <div class="tips-item"><span class="tips-cmd">codex --full-auto</span> 自动执行更多步骤</div>
              <div class="tips-item"><span class="tips-cmd">codex --auto-edit</span> 自动应用代码修改</div>
              <div class="tips-item"><span class="tips-cmd">codex --help</span> 查看完整参数</div>
            </div>
            <div class="tips-section">
              <div class="tips-section-title">交互命令</div>
              <div class="tips-item"><span class="tips-cmd">/help</span> 查看帮助</div>
              <div class="tips-item"><span class="tips-cmd">/status</span> 查看当前会话与环境状态</div>
              <div class="tips-item"><span class="tips-cmd">/mode</span> 切换执行模式</div>
              <div class="tips-item"><span class="tips-cmd">/model</span> 切换模型</div>
            </div>
            <div class="tips-section">
              <div class="tips-section-title">提示</div>
              <div class="tips-item"><span class="tips-note">并行代理</span> 适合多任务并行处理</div>
              <div class="tips-item"><span class="tips-note">终端 / IDE / App</span> 都可配合使用</div>
              <div class="tips-item"><span class="tips-note">模型与模式</span> 建议随任务复杂度调整</div>
              <div class="tips-item"><span class="tips-note">说明</span> 以 <span class="tips-cmd">/help</span> 与官方文档为准</div>
            </div>
          </div>
        </div>
      </div>
      <div class="tips-settings">
        <div class="tips-setting-item">
          <label>字号</label>
          <select id="font-size-select">
            <option value="11">11</option>
            <option value="12">12</option>
            <option value="13">13</option>
            <option value="14">14</option>
            <option value="15">15</option>
            <option value="16">16</option>
            <option value="18">18</option>
            <option value="20">20</option>
          </select>
        </div>
        <div class="tips-setting-item">
          <label>字体</label>
          <select id="font-family-select">
            ${getCleanFontFamilyOptions()}
          </select>
        </div>
      </div>
    `;

function isCopyableTipCommand(text: string): boolean {
  const value = text.trim();
  return value.startsWith('claude')
    || value.startsWith('opencode')
    || value.startsWith('codex')
    || value.startsWith('/')
    || value.startsWith('@');
}

function toggleTipsPanel() {
  if (_tipsOpen && _tipsEl) { closeTipsPanel(); return; }
  if (_tipsEl) closeTipsPanel();
  _tipsEl = document.createElement('div');
  _tipsEl.className = 'tips-panel tips-panel-wide';
  /* _tipsEl.innerHTML = `
      <h3>使用技巧</h3>
      <div class="tips-columns">
        <div class="tips-column">
          <div class="tips-section">
            <div class="tips-section-title">底栏工具</div>
            <div class="tips-item"><span class="tips-icon">📄</span>插入文件路径</div>
            <div class="tips-item"><span class="tips-icon">📁</span>插入目录路径</div>
            <div class="tips-item"><span class="tips-icon">🕐</span>历史会话：恢复标签或会话</div>
            <div class="tips-item"><span class="tips-icon">🎨</span>主题切换：右下角主题名</div>
          </div>
          <div class="tips-section">
            <div class="tips-section-title">快捷键</div>
            <div class="tips-item"><span class="tips-key">Ctrl+T</span> 新建标签</div>
            <div class="tips-item"><span class="tips-key">Ctrl+W</span> 关闭标签</div>
            <div class="tips-item"><span class="tips-key">Ctrl+[</span> / <span class="tips-key">Ctrl+]</span> 切换标签</div>
            <div class="tips-item"><span class="tips-key">Ctrl+1-9</span> 跳转到指定标签</div>
            <div class="tips-item"><span class="tips-key">Ctrl+F</span> 终端内搜索</div>
            <div class="tips-item"><span class="tips-key">Alt+K</span> 技巧面板</div>
          </div>
          <div class="tips-section">
            <div class="tips-section-title">标签 & Notepad</div>
            <div class="tips-item"><span class="tips-icon">✏️</span>双击标签名可重命名</div>
            <div class="tips-item"><span class="tips-icon">↔️</span>拖动标签可排序</div>
            <div class="tips-item"><span class="tips-icon" style="color:var(--accent-red)">●</span>红点 = 后台任务完成</div>
            <div class="tips-item"><span class="tips-icon">🎨</span>右键标签可改颜色</div>
            <div class="tips-item"><span class="tips-icon">+</span>Notepad 预写提示词</div>
            <div class="tips-item"><span class="tips-icon" style="color:var(--accent-green)">▶</span>点击发送文本块</div>
          </div>
        </div>
        <div class="tips-column tips-column-ai">
          <div class="tips-tabs">
            <button class="tips-tab active" data-tab="claude">Claude Code</button>
            <button class="tips-tab" data-tab="opencode">OpenCode</button>
            <button class="tips-tab" data-tab="codex">Codex</button>
          </div>
          <div class="tips-tab-content active" data-content="claude">
            <div class="tips-section">
              <div class="tips-section-title">启动命令</div>
              <div class="tips-item"><span class="tips-cmd">claude</span> 启动交互模式</div>
              <div class="tips-item"><span class="tips-cmd">claude -c</span> 继续上次对话</div>
              <div class="tips-item"><span class="tips-cmd">claude -r</span> 恢复最近会话</div>
              <div class="tips-item"><span class="tips-cmd">claude "prompt"</span> 单次任务</div>
              <div class="tips-item"><span class="tips-cmd">claude --dangerously-skip-permissions</span> 跳过权限</div>
            </div>
            <div class="tips-section">
              <div class="tips-section-title">交互命令</div>
              <div class="tips-item"><span class="tips-cmd">/compact</span> 压缩上下文</div>
              <div class="tips-item"><span class="tips-cmd">/clear</span> 清空对话</div>
              <div class="tips-item"><span class="tips-cmd">/model</span> 切换模型</div>
              <div class="tips-item"><span class="tips-cmd">/cost</span> 查看用量</div>
              <div class="tips-item"><span class="tips-cmd">/help</span> 所有命令</div>
            </div>
            <div class="tips-section">
              <div class="tips-section-title">@ 命令</div>
              <div class="tips-item"><span class="tips-cmd">@file</span> 文件内容加入上下文</div>
              <div class="tips-item"><span class="tips-cmd">@dir</span> 目录结构加入上下文</div>
              <div class="tips-item"><span class="tips-cmd">@url</span> 抓取网页内容</div>
              <div class="tips-item"><span class="tips-cmd">@git</span> 引用 git 历史</div>
              <div class="tips-item"><span class="tips-cmd">@terminal</span> 引用终端输出</div>
            </div>
          </div>
          <div class="tips-tab-content" data-content="opencode">
            <div class="tips-section">
              <div class="tips-section-title">启动命令</div>
              <div class="tips-item"><span class="tips-cmd">opencode</span> 启动交互模式</div>
              <div class="tips-item"><span class="tips-cmd">opencode -c</span> 继续上次会话</div>
              <div class="tips-item"><span class="tips-cmd">opencode run "prompt"</span> 单次任务</div>
              <div class="tips-item"><span class="tips-cmd">opencode --prompt "xxx"</span> 指定提示词</div>
            </div>
            <div class="tips-section">
              <div class="tips-section-title">交互命令</div>
              <div class="tips-item"><span class="tips-cmd">/compact</span> 压缩上下文</div>
              <div class="tips-item"><span class="tips-cmd">/clear</span> 清空对话</div>
              <div class="tips-item"><span class="tips-cmd">/help</span> 所有命令</div>
            </div>
            <div class="tips-section">
              <div class="tips-section-title">@ 命令</div>
              <div class="tips-item"><span class="tips-cmd">@file</span> 文件内容加入上下文</div>
              <div class="tips-item"><span class="tips-cmd">@dir</span> 目录结构加入上下文</div>
              <div class="tips-item"><span class="tips-cmd">@url</span> 抓取网页内容</div>
            </div>
          </div>
          <div class="tips-tab-content" data-content="codex">
            <div class="tips-section">
              <div class="tips-section-title">启动命令</div>
              <div class="tips-item"><span class="tips-cmd">codex</span> 启动交互模式</div>
              <div class="tips-item"><span class="tips-cmd">codex resume</span> 恢复上次会话</div>
              <div class="tips-item"><span class="tips-cmd">codex "prompt"</span> 单次任务</div>
              <div class="tips-item"><span class="tips-cmd">codex --full-auto</span> 全自动模式</div>
            </div>
            <div class="tips-section">
              <div class="tips-section-title">交互命令</div>
              <div class="tips-item"><span class="tips-cmd">/compact</span> 压缩上下文</div>
              <div class="tips-item"><span class="tips-cmd">/clear</span> 清空对话</div>
              <div class="tips-item"><span class="tips-cmd">/help</span> 所有命令</div>
            </div>
            <div class="tips-section">
              <div class="tips-section-title">@ 命令</div>
              <div class="tips-item"><span class="tips-cmd">@file</span> 文件内容加入上下文</div>
              <div class="tips-item"><span class="tips-cmd">@dir</span> 目录结构加入上下文</div>
              <div class="tips-item"><span class="tips-cmd">@url</span> 抓取网页内容</div>
            </div>
          </div>
        </div>
      </div>
      <div class="tips-settings">
        <div class="tips-setting-item">
          <label>字号</label>
          <select id="font-size-select">
            <option value="11">11</option>
            <option value="12">12</option>
            <option value="13">13</option>
            <option value="14">14</option>
            <option value="15">15</option>
            <option value="16">16</option>
            <option value="18">18</option>
            <option value="20">20</option>
          </select>
        </div>
        <div class="tips-setting-item">
          <label>字体</label>
          <select id="font-family-select">
            ${getFontFamilyOptions()}
          </select>
        </div>
      </div>
    `; */
  _tipsEl.innerHTML = TIPS_PANEL_HTML;
  _tipsEl.addEventListener('click', (e) => e.stopPropagation());
  _tipsEl.addEventListener('mousedown', (e) => e.stopPropagation());
  document.body.appendChild(_tipsEl);
  _tipsOpen = true;

  // Tab switching logic
  const tabs = _tipsEl.querySelectorAll('.tips-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = (tab as HTMLElement).dataset.tab;
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      _tipsEl!.querySelectorAll('.tips-tab-content').forEach(content => {
        content.classList.toggle('active', (content as HTMLElement).dataset.content === tabName);
      });
    });
  });

  // Auto-switch to current AI tool tab
  if (appState.activeTabId) {
    const currentTab = appState.tabs.get(appState.activeTabId);
    const aiTool = currentTab?.aiTool || '';
    const tabMap: Record<string, string> = { claude: 'claude', opencode: 'opencode', codex: 'codex' };
    const targetTab = tabMap[aiTool];
    if (targetTab && _tipsEl) {
      const targetTabBtn = _tipsEl.querySelector(`.tips-tab[data-tab="${targetTab}"]`) as HTMLElement;
      const targetContent = _tipsEl.querySelector(`.tips-tab-content[data-content="${targetTab}"]`) as HTMLElement;
      if (targetTabBtn && targetContent) {
        tabs.forEach(t => t.classList.remove('active'));
        targetTabBtn.classList.add('active');
        _tipsEl.querySelectorAll('.tips-tab-content').forEach(c => c.classList.remove('active'));
        targetContent.classList.add('active');
      }
    }
  }

  // Load saved font settings
  const savedFontSize = localStorage.getItem('terminal-font-size');
  const savedFontFamily = localStorage.getItem('terminal-font-family');
  const fontSizeSelect = _tipsEl.querySelector('#font-size-select') as HTMLSelectElement;
  if (fontSizeSelect) {
    fontSizeSelect.value = String(savedFontSize ? parseInt(savedFontSize, 10) : getCurrentTerminalFontSize());
  }
  if (savedFontFamily) {
    const fontFamilySelect = _tipsEl.querySelector('#font-family-select') as HTMLSelectElement;
    if (fontFamilySelect) fontFamilySelect.value = savedFontFamily;
  }

  // Font size change handler
  if (fontSizeSelect) {
    fontSizeSelect.addEventListener('change', () => {
      const size = parseInt(fontSizeSelect.value, 10);
      localStorage.setItem('terminal-font-size', fontSizeSelect.value);
      terminalViews.forEach(view => view.setFontSize(size));
    });
  }

  // Font family change handler
  const fontFamilySelect = _tipsEl.querySelector('#font-family-select') as HTMLSelectElement;
  if (fontFamilySelect) {
    fontFamilySelect.addEventListener('change', () => {
      localStorage.setItem('terminal-font-family', fontFamilySelect.value);
      terminalViews.forEach(view => view.setFontFamily(fontFamilySelect.value));
    });
  }

  // Double-click to copy AI commands
  const cmdElements = _tipsEl.querySelectorAll('.tips-cmd');
  cmdElements.forEach(cmd => {
    cmd.addEventListener('dblclick', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const commandText = cmd.textContent || '';
      if (commandText && isCopyableTipCommand(commandText)) {
        try {
          await navigator.clipboard.writeText(commandText);
          // Show toast notification
          const toast = document.createElement('div');
          toast.className = 'tips-toast';
          toast.textContent = '已复制';
          toast.style.cssText = `
            position: fixed;
            bottom: 60px;
            left: 50%;
            transform: translateX(-50%);
            background: var(--accent-green);
            color: #000;
            padding: 8px 16px;
            border-radius: 4px;
            font-size: 13px;
            font-weight: 600;
            z-index: 10000;
            animation: fade-in 0.2s ease-out;
          `;
          document.body.appendChild(toast);
          setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.2s ease-out';
            setTimeout(() => toast.remove(), 200);
          }, 1500);
        } catch (err) {
          console.error('复制失败:', err);
        }
      }
    });
  });
}

// Bind tips button click
(() => {
  const tipsBtn = document.getElementById('btn-tips')!;
  tipsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTipsPanel();
  });
})();

// Close tips panel on outside click
document.addEventListener('click', (e) => {
  if (!_tipsOpen || !_tipsEl) return;
  if (isSelectingText || isMouseDown) return;
  if (_tipsEl.contains(e.target as Node)) return;
  _tipsEl.remove();
  _tipsEl = null;
  _tipsOpen = false;
});;


// Shared panel close helpers
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
    aiTool?: string;
  }

  let currentHistoryItems: UnifiedItem[] = [];
  function closeHistory() { if (historyOpen && historyEl) { historyEl.remove(); historyEl = null; historyOpen = false; } }
  _closeHistoryPanel = closeHistory;

  historyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (historyOpen && historyEl) { closeHistory(); return; }

    historyEl = document.createElement('div');
    historyEl.className = 'tips-panel';
    historyEl.style.maxHeight = '65vh';
    historyEl.style.overflow = 'hidden';
    historyEl.style.display = 'flex';
    historyEl.style.flexDirection = 'column';
    historyEl.style.paddingRight = '0';
    historyEl.innerHTML = `<h3>历史会话 <button class="history-clear-btn" style="float:right;font-size:12px;padding:2px 8px;">清空历史</button></h3><div class="history-content"><div style="color:var(--text-muted);font-size:12px;padding:8px 0;">加载中...</div></div>`;
    historyEl.addEventListener('click', (ev) => ev.stopPropagation());
    document.body.appendChild(historyEl);
    historyOpen = true;

    // Load both sources in parallel
    const [sessions, entries] = await Promise.all([
      api.listClaudeSessions().catch(() => []),
      api.loadHistory().catch(() => []),
    ]);

    // Clear all button - set up AFTER data is loaded
    const clearBtn = historyEl.querySelector('.history-clear-btn')!;
    clearBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      console.log('Clearing history, sessions:', sessions.length);
      // Clear plain history
      await api.clearHistory();
      // Also delete all loaded Claude sessions
      let deletedCount = 0;
      for (const s of sessions) {
        if (s.session_id) {
          console.log('Deleting session:', s.session_id);
          await api.deleteClaudeSession(s.session_id)
            .then(() => { deletedCount++; console.log('Deleted:', s.session_id); })
            .catch((e) => console.error('Failed to delete:', s.session_id, e));
        }
      }
      console.log('Deleted', deletedCount, 'sessions');
      // Remove UI elements
      const contentEl2 = historyEl!.querySelector('.history-content')!;
      contentEl2.innerHTML = `<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">已清空 (${deletedCount}个会话)</div>`;
      clearBtn.remove();
    });

    // Build unified list
    const items: UnifiedItem[] = [];

    // Claude sessions (deduplicate by cwd, keep newest)
    const seenSessionCwds = new Set<string>();
    const sortedSessions = [...sessions].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    for (const s of sortedSessions) {
      if (seenSessionCwds.has(s.cwd)) continue;
      seenSessionCwds.add(s.cwd);
      const preview = s.user_messages.length > 0
        ? s.user_messages.map(m => m.slice(0, 50)).join(' → ')
        : '';
      // Use first user message as display name instead of slug
      const firstMsg = s.user_messages.length > 0 ? s.user_messages[0] : '';
      const displayName = firstMsg.length > 30 ? firstMsg.slice(0, 30) + '…' : (firstMsg || s.slug);
      items.push({
        type: 'session',
        name: displayName,
        cwd: s.cwd,
        time: s.timestamp ? new Date(s.timestamp) : new Date(0),
        sessionId: s.session_id,
        slug: s.slug,
        preview,
      });
    }

    // Plain history (deduplicate against sessions by cwd)
    const sessionCwds = seenSessionCwds;
    entries.forEach((h, i) => {
      if (sessionCwds.has(h.cwd)) return;
      items.push({
        type: 'history',
        name: h.name,
        cwd: h.cwd,
        time: new Date(h.timestamp),
        shell: h.shell,
        historyIndex: i,
        aiTool: h.ai_tool || undefined,
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
      // Only shorten paths for home directory, show full path otherwise
      let shortCwd = item.cwd;
      if (item.cwd.match(/^[A-Za-z]:\\Users\\/)) {
        // Windows: C:\Users\Yvo\... -> C:\~\...
        shortCwd = item.cwd.replace(/^([A-Za-z]):\\Users\\[^\\]+\\/, '$1:\\~\\');
      } else if (item.cwd.startsWith('/Users/')) {
        // Unix: /Users/xxx -> ~
        shortCwd = item.cwd.replace(/^\/Users\/[^/]+/, '~');
      }
      const timeStr = `${item.time.getMonth()+1}/${item.time.getDate()} ${item.time.getHours().toString().padStart(2,'0')}:${item.time.getMinutes().toString().padStart(2,'0')}`;

      const badge = item.type === 'session'
        ? `<span class="history-badge-resume">resume</span>`
        : '';
      // AI tool badge for history items
      const aiBadge = item.aiTool
        ? `<span class="history-badge-ai">${escapeHtml(item.aiTool)}</span>`
        : '';
      const previewHtml = item.preview
        ? `<div class="session-preview">${escapeHtml(item.preview)}</div>`
        : '';

      el.innerHTML = `<div class="history-item-name">${badge}${aiBadge}${escapeHtml(item.name)}</div><div class="history-item-cwd">${escapeHtml(shortCwd)}</div>${previewHtml}<div class="history-item-time">${timeStr}</div>`;

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

      el.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        console.log('[History Click] type:', item.type, 'cwd:', item.cwd, 'name:', item.name, 'aiTool:', item.aiTool);
        if (item.type === 'session') {
          console.log('[History Click] Creating session tab:', item.slug, item.cwd, 'sessionId:', item.sessionId);
          const tabId = await createTab(`↻ ${item.name}`, undefined, item.cwd || undefined);
          console.log('[History Click] Created tab:', tabId);
          const nameArg = item.name ? ` -n '${item.name.replace(/'/g, "'\\''")}'` : '';
          setTimeout(() => api.writeTerminal(tabId, `claude --resume ${item.sessionId}${nameArg}\n`), 500);
          switchToTab(tabId);
        } else {
          console.log('[History Click] Creating history tab:', item.name, item.cwd, item.shell, 'aiTool:', item.aiTool);
          const tabId = await createTab(item.name, undefined, item.cwd || undefined);
          console.log('[History Click] Created tab:', tabId, 'shell:', item.shell);
          if (item.shell && item.shell !== 'cmd') await switchShell(tabId, item.shell);
          // Auto-start AI tool if saved
          if (item.aiTool === 'claude') {
            setTimeout(() => api.writeTerminal(tabId, 'claude\n'), 500);
          } else if (item.aiTool === 'opencode') {
            setTimeout(() => api.writeTerminal(tabId, 'opencode\n'), 500);
          } else if (item.aiTool === 'codex') {
            setTimeout(() => api.writeTerminal(tabId, 'codex\n'), 500);
          }
          switchToTab(tabId);
        }
        historyEl?.remove(); historyEl = null; historyOpen = false;
      });
      contentEl.appendChild(el);
    }
  });
  document.addEventListener('click', () => { closeHistory(); });
})();

// File and directory buttons
(() => {
  const fileBtn = document.getElementById('btn-file')!;
  const dirBtn = document.getElementById('btn-dir')!;

  fileBtn.addEventListener('click', async () => {
    if (!appState.activeTabId) return;
    const p = await api.selectFile();
    if (p) api.writeTerminal(appState.activeTabId, p);
  });

  dirBtn.addEventListener('click', async () => {
    if (!appState.activeTabId) return;
    const p = await api.selectDirectory();
    if (p) api.writeTerminal(appState.activeTabId, p);
  });
})();

// Backend events — auto-send notepad blocks when Claude is waiting
const pendingDoneTimers = new Map<string, number>();
const lastExecutingAt = new Map<string, number>();
const lastAcknowledgedAt = new Map<string, number>();

function clearPendingDoneTimer(tabId: string): void {
  const timer = pendingDoneTimers.get(tabId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    pendingDoneTimers.delete(tabId);
  }
}

function armPendingDoneTimer(tabId: string): void {
  clearPendingDoneTimer(tabId);
  const timer = window.setTimeout(() => {
    pendingDoneTimers.delete(tabId);
    const tab = appState.tabs.get(tabId);
    if (!tab || tab.status === 'executing') return;
    const nextStatus = shouldShowDoneUnseen(tabId) ? 'done-unseen' : 'active';
    appState.setStatus(tabId, nextStatus);
    syncPendingAttention(nextStatus === 'done-unseen');
    if (nextStatus === 'done-unseen') maybeShowSystemNotification(tabId);
  }, 700);
  pendingDoneTimers.set(tabId, timer);
}

function markExecutingSeen(tabId: string): void {
  lastExecutingAt.set(tabId, Date.now());
}

function markDoneAcknowledged(tabId: string): void {
  lastAcknowledgedAt.set(tabId, Date.now());
}

function isLikelyStillExecuting(tabId: string): boolean {
  const last = lastExecutingAt.get(tabId);
  return last !== undefined && Date.now() - last < 1800;
}

function hasUnacknowledgedExecution(tabId: string): boolean {
  const lastExec = lastExecutingAt.get(tabId) ?? 0;
  const lastAck = lastAcknowledgedAt.get(tabId) ?? 0;
  return lastExec > lastAck;
}

function shouldShowDoneUnseen(tabId: string): boolean {
  return tabId !== appState.activeTabId || !windowHasFocus;
}

window.addEventListener('focus', () => {
  windowHasFocus = true;
  if (appState.activeTabId) {
    clearPendingDoneTimer(appState.activeTabId);
    markDoneAcknowledged(appState.activeTabId);
    const activeTab = appState.tabs.get(appState.activeTabId);
    if (activeTab?.status === 'done-unseen') {
      appState.setStatus(appState.activeTabId, 'active');
    }
  }
  syncPendingAttention(false);
});

window.addEventListener('blur', () => {
  windowHasFocus = false;
});

api.onTabStatusChanged((tabId, status) => {
  const existingTab = appState.tabs.get(tabId);
  if (existingTab?.status === 'done-unseen' && status !== 'done-unseen') {
    clearPendingDoneTimer(tabId);
    return;
  }

  if (status === 'executing') {
    markExecutingSeen(tabId);
    clearPendingDoneTimer(tabId);
    appState.setStatus(tabId, status);
    return;
  }

  if (status === 'done-unseen' || status === 'waiting') {
    if (!hasUnacknowledgedExecution(tabId)) {
      clearPendingDoneTimer(tabId);
      appState.setStatus(tabId, 'active');
      syncPendingAttention(false);
      return;
    }
    armPendingDoneTimer(tabId);
    appState.setStatus(tabId, isLikelyStillExecuting(tabId) ? 'executing' : 'active');
  } else {
    clearPendingDoneTimer(tabId);
    appState.setStatus(tabId, status);
    syncPendingAttention(false);
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
  if (!tab || tab.title === name) return;
  // Strip any lingering status prefixes from saved tab names (ASCII and Unicode variants)
  const cleanTitle = tab.title.replace(/^[*.\s●○◆◇■□✳✻•·∙⋅◉◎◌◍◐◑◒◓◴◵◶◷\u2800-\u28FF]+/u, '');
  // Allow rename for: default names, restored names, or AI-detected tabs (OSC title updates)
  if (tab.title.startsWith('Terminal ') || tab.title.startsWith('↻ ') || tab.aiTool || cleanTitle !== tab.title) {
    appState.renameTab(tabId, name);
    api.updateHistoryName(tabId, name, tab.cwd, tab.aiTool || undefined);
  }
});
api.onAiDetected((tabId, cwd, aiTool) => {
  console.log('AI detected event:', tabId, aiTool, cwd);
  const tab = appState.tabs.get(tabId);
  if (tab) {
    appState.setAiTool(tabId, aiTool);
    // 保存历史时使用当前实际的 cwd（从 appState 获取，因为会实时更新）
    const currentCwd = tab.cwd || cwd || '';
    api.addHistory(tabId, tab.title, currentCwd, tab.shell, aiTool);
    // 更新 cwd 显示
    if (currentCwd) {
      updateCwdDisplay(tabId, currentCwd);
    }
  }
});

// 监听 cwd 变化事件
api.onCwdChanged((tabId, cwd) => {
  console.log('>>> CWD event:', tabId, cwd);
  // Ignore invalid cwd (garbage from terminal output)
  if (!cwd || cwd.length > 500 || cwd.includes('"') || cwd.includes('\n')) return;
  appState.setCwd(tabId, cwd);
  // 立即更新底栏
  if (tabId === appState.activeTabId) {
    const el = document.getElementById('status-cwd');
    if (el) {
      let sc = cwd.replace(/^\/Users\/[^/]+/, '~');
      sc = sc.replace(/^([A-Za-z]):\\Users\\[^\\]+\\/i, '$1:\\~');
      sc = sc.replace(/^([A-Za-z]):\\$/i, '$1:');
      console.log('>>> Set to:', sc);
      el.textContent = sc;
      el.title = cwd;
    }
  }
});

// Re-focus terminal when window regains focus (fixes first Shift+key being swallowed)
window.addEventListener('focus', () => {
  if (appState.activeTabId) {
    const view = terminalViews.get(appState.activeTabId);
    if (view) view.focus();
  }
});

// Workaround: when xterm's textarea loses focus (e.g. clicking tab bar),
// the first keypress is swallowed. Detect this and re-dispatch the event.
document.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  const isInput = active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA' ||
                  (active as HTMLElement)?.contentEditable === 'true';
  // If focus is not in any input and not in xterm's textarea, refocus terminal
  if (!isInput && appState.activeTabId) {
    const view = terminalViews.get(appState.activeTabId);
    if (view) {
      const xtermTA = view.terminal.textarea;
      if (xtermTA && active !== xtermTA) {
        xtermTA.focus();
        // Re-dispatch the same key event to the now-focused textarea
        xtermTA.dispatchEvent(new KeyboardEvent('keydown', {
          key: e.key, code: e.code, keyCode: e.keyCode,
          shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey,
          bubbles: true, cancelable: true,
        }));
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
  }
}, true); // capture phase — before xterm sees it

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const activeElement = document.activeElement;
  const isInputElement = activeElement?.tagName === 'INPUT' || 
                        activeElement?.tagName === 'TEXTAREA' ||
                        (activeElement as HTMLElement)?.contentEditable === 'true';
                        
  // 如果是输入元素，则不要处理快捷键
  if (isInputElement) {
    return;
  }
  
  const isCtrl = e.ctrlKey || e.metaKey;
  if (isCtrl && e.key === 't') { e.preventDefault(); createTab(); }
  else if (isCtrl && e.key === 'w') { e.preventDefault(); if (appState.activeTabId) closeTab(appState.activeTabId); }
  else if (isCtrl && e.key === 'f') { e.preventDefault(); if (appState.activeTabId) { const v = terminalViews.get(appState.activeTabId); if (v) v.toggleSearch(); } }
  else if (e.altKey && e.key === 'k') { e.preventDefault(); toggleTipsPanel(); }
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
    for (const saved of savedTabs) {
      // 验证 shell 值，无效则使用默认值 cmd
      const validShells: Array<'cmd' | 'powershell' | 'wsl'> = ['cmd', 'powershell', 'wsl'];
      const shell = saved.shell && validShells.includes(saved.shell) ? saved.shell : undefined;
      await createTab(saved.name, saved.noteBlocks, saved.cwd || undefined, shell, saved.aiTool);
    }
  } else {
    createTab();
  }
}

init();

// Global drag-drop support with Tauri - using tauri://drag-drop event for full file paths
let dragCounter = 0;

// Listen for Tauri drag-drop events to get full file paths
listen<{ paths: string[]; position: { x: number; y: number } }>('tauri://drag-drop', async (event) => {
  const tabId = appState.activeTabId;
  if (!tabId || !event.payload.paths || event.payload.paths.length === 0) return;

  // Determine if we're dropping on notepad or terminal by checking element at drop position
  const pos = event.payload.position;
  const elementAtDrop = document.elementFromPoint(pos.x, pos.y);
  const notepadEl = document.getElementById('notepad');

  // Check if notepad is visible
  const isNotepadVisible = notepadEl && !notepadEl.classList.contains('hidden');

  // More lenient check: if drop is in right half of screen and notepad is visible, assume notepad
  const windowWidth = window.innerWidth;
  const isInRightHalf = pos.x > windowWidth * 0.6;

  // Try to find textarea - either directly under drop or the focused textarea in notepad
  let notepadTextarea: HTMLTextAreaElement | null = null;
  if (isNotepadVisible) {
    // First check: is drop in right half of screen (notepad area)?
    if (isInRightHalf || (elementAtDrop && notepadEl.contains(elementAtDrop))) {
      // First try: check if drop is directly on a textarea
      if (elementAtDrop?.tagName === 'TEXTAREA') {
        notepadTextarea = elementAtDrop as HTMLTextAreaElement;
      } else {
        // Second try: find closest textarea ancestor
        const closestTextarea = elementAtDrop?.closest('#notepad-blocks textarea') as HTMLTextAreaElement | null;
        if (closestTextarea) {
          notepadTextarea = closestTextarea;
        } else {
          // Third try: use the currently focused textarea if it's in notepad
          const activeEl = document.activeElement;
          if (activeEl?.tagName === 'TEXTAREA' && notepadEl.contains(activeEl)) {
            notepadTextarea = activeEl as HTMLTextAreaElement;
          } else {
            // Fourth try: find first textarea in notepad (drop on blank area)
            notepadTextarea = notepadEl.querySelector('textarea');
          }
        }
      }
    }
  }

  for (const filePath of event.payload.paths) {
    const isImage = /\.(jpg|jpeg|png|gif|bmp|webp|svg|ico)$/i.test(filePath);

    if (notepadTextarea) {
      // Dropping on notepad - insert file path or image markdown
      const cursorPos = notepadTextarea.selectionStart || 0;
      const currentValue = notepadTextarea.value;
      const before = currentValue.substring(0, cursorPos);
      const after = currentValue.substring(cursorPos);

      // Find the corresponding block
      const tab = appState.tabs.get(tabId);
      const blockId = notepadTextarea.dataset.blockId;
      const block = tab?.noteBlocks.find(b => b.id === blockId);

      if (isImage) {
        if (block) {
          // Copy image to temp and add to block's images array
          try {
            const imgPath = await api.convertImagePath(filePath);
            if (imgPath) {
              if (!block.images) block.images = [];
              block.images.push(imgPath);
              appState.persistTabs();
              renderNoteBlocks(true);
            }
          } catch (err) {
            console.error('Failed to process dropped image:', err);
          }
        } else {
          // Fallback: insert image markdown with original path
          const imageMarkdown = `![image](${filePath})`;
          notepadTextarea.value = before + imageMarkdown + after;
          notepadTextarea.selectionStart = notepadTextarea.selectionEnd = cursorPos + imageMarkdown.length;
        }
      } else {
        // Insert file path as text
        const quotedPath = `"${filePath}"`;
        notepadTextarea.value = before + quotedPath + after;
        notepadTextarea.selectionStart = notepadTextarea.selectionEnd = cursorPos + quotedPath.length;
        // Trigger input event to update block content
        notepadTextarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else {
      // Dropping on terminal - write file path
      if (isImage) {
        // For images, copy to app directory and get the asset URL
        try {
          const imgPath = await api.convertImagePath(filePath);
          if (imgPath) {
            api.writeTerminal(tabId, imgPath + ' ');
          } else {
            // Fallback: just write the original path
            api.writeTerminal(tabId, `"${filePath}" `);
          }
        } catch (err) {
          console.error('Failed to process dropped image:', err);
          api.writeTerminal(tabId, `"${filePath}" `);
        }
      } else {
        // Non-image files: write quoted path
        api.writeTerminal(tabId, `"${filePath}" `);
      }
    }
  }
});

// Visual feedback for drag operations
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  document.body.style.opacity = '0.7';
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy';
  }
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) {
    document.body.style.opacity = '';
  }
});

document.addEventListener('drop', (e) => {
  // Prevent default browser drop handling
  // Tauri will emit tauri://drag-drop event with full paths
  e.preventDefault();
  dragCounter = 0;
  document.body.style.opacity = '';
});
