import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { api } from '../api';
import { appState } from './app-state';
import { themes } from './themes';
import { isWindows, getDefaultFontSize, getPlatformFonts } from '../platform';

export class TerminalView {
  terminal: Terminal;
  private fitAddon: FitAddon;
  private searchAddon: SearchAddon;
  private wrapper: HTMLElement;
  private searchBar: HTMLElement | null = null;
  private resizeObserver: ResizeObserver;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollBtn: HTMLElement;
  private scrollCheckTimer: ReturnType<typeof setInterval> | null = null;

  private mouseSelectionInProgress = false;
  private userScrolledUp = false;

  constructor(
    private tabId: string,
    container: HTMLElement,
  ) {
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'terminal-wrapper';
    this.wrapper.dataset.tabId = tabId;
    container.appendChild(this.wrapper);

    const savedIndex = TerminalView.getSavedThemeIndex();
    const currentTheme = themes[savedIndex];

    // 加载保存的字体设置
    const savedFontSize = localStorage.getItem('terminal-font-size');
    const savedFontFamily = localStorage.getItem('terminal-font-family');
    const fontSize = savedFontSize ? parseInt(savedFontSize, 10) : getDefaultFontSize();
    const fontFamily = savedFontFamily
      ? TerminalView.getFontFamily(savedFontFamily)
      : TerminalView.getFontFamily('auto');

    this.terminal = new Terminal({
      fontSize,
      fontFamily,
      theme: currentTheme.theme,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      rightClickSelectsWord: true,
      macOptionClickForcesSelection: true,
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    this.terminal.open(this.wrapper);

    // Workaround: macOS WebView IME swallows first Shift+key after idle.
    // Track last keydown time; if idle > 1s, manually send Shift+printable chars.
    let lastKeyTime = Date.now();

    // Intercept key events inside xterm before it processes them
    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const now = Date.now();
      const wasIdle = now - lastKeyTime > 1000;
      // Only update lastKeyTime for non-modifier keys
      if (e.type === 'keydown' && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) lastKeyTime = now;
      // Block standalone modifier keys when there's a selection — prevents xterm from
      // scrolling to bottom when user presses Cmd/Ctrl before Cmd+C to copy
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key) && this.terminal.hasSelection()) {
        return false;
      }
      // Block both keydown and keyup for intercepted keys
      const key = e.key.toLowerCase();
      // Alt+K: toggle tips panel
      if (e.altKey && key === 'k') {
        if (e.type === 'keydown') {
          const toggleTips = (window as any).toggleTipsPanel;
          if (typeof toggleTips === 'function') toggleTips();
        }
        return false;
      }
      // Cmd+C / Ctrl+C: copy selection instead of sending SIGINT
      if ((e.ctrlKey || e.metaKey) && key === 'c' && this.terminal.hasSelection()) {
        if (e.type === 'keydown') navigator.clipboard.writeText(this.terminal.getSelection());
        return false;
      }
      // Cmd+V / Ctrl+V: paste via Tauri backend (text + image, no browser clipboard API)
      if ((e.ctrlKey || e.metaKey) && key === 'v') {
        if (e.type === 'keydown') {
          (async () => {
            try {
              // Try image first
              const imgPath = await api.readClipboardImage();
              if (imgPath) {
                api.writeTerminal(tabId, imgPath + ' ');
                return;
              }
            } catch (err) {
              // Image read failed - may not be an image or format not supported
              // Fall back to text paste
              console.log('[Paste] Image read failed:', err);
            }
            // Fall back to text
            try {
              const text = await api.readClipboardText();
              if (text) this.terminal.paste(text);
            } catch {}
          })();
        }
        return false;
      }
      // Shift+Enter: newline without executing command
      // For AI tools: send Kitty sequence for multiline input
      // For regular shell: send \r\n (not just \n, to ensure proper line break)
      if (e.key === 'Enter' && e.shiftKey) {
        if (e.type === 'keydown') {
          const tab = appState.tabs.get(tabId);
          if (tab?.aiTool) {
            // AI tools support kitty protocol for multiline
            api.writeTerminal(tabId, '\x1b[13;2u');
          } else {
            // Regular shell: send \r\n for proper line break
            // Some shells need both CR and LF for proper newline
            api.writeTerminal(tabId, '\r\n');
          }
        }
        return false;
      }
      // Workaround: macOS WebView IME swallows first Shift+key after idle.
      if (e.type === 'keydown' && wasIdle && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        api.writeTerminal(tabId, e.key);
        return false;
      }
      return true;
    });

    // 处理鼠标选择状态，防止拖动选择时鼠标移出窗口导致问题
    this.wrapper.addEventListener('mousedown', (e) => {
      this.mouseSelectionInProgress = true;
      
      // 获取当前焦点元素
      const activeElement = document.activeElement;
      const isInTerminal = activeElement === this.wrapper || 
                          activeElement?.classList.contains('xterm') || 
                          this.wrapper.contains(activeElement);
                          
      // 如果不是在终端内部点击，需要聚焦到终端
      if (!isInTerminal) {
        this.terminal.focus();
      }
    });
    
    const endSelection = () => {
      this.mouseSelectionInProgress = false;
    };
    
    document.addEventListener('mouseup', (e) => {
      endSelection();
      
      // 在mouseup之后的一小段时间内标记特殊状态，防止在此期间触发快捷键
      const selectionEndedRecently = true;
      setTimeout(() => {
        // this.selectionEndedRecently = false; // 如果之前定义了此变量
      }, 100);
    });
    window.addEventListener('blur', endSelection);
    
    // 防止鼠标移出窗口时丢失选择
    this.wrapper.addEventListener('mouseleave', (e) => {
      if (this.mouseSelectionInProgress) {
        // 如果仍在选择中，保持焦点
        e.preventDefault();
        // 不失去焦点，让选择继续
      }
    });

    // 监听选择变化，确保不发送额外事件
    this.terminal.onSelectionChange(() => {
      // 有选中文本时不做任何事
    });

    // Unicode 11 for proper emoji/CJK width calculation
    const unicode11 = new Unicode11Addon();
    this.terminal.loadAddon(unicode11);
    this.terminal.unicode.activeVersion = '11';

    try { this.terminal.loadAddon(new CanvasAddon()); } catch {}

    // Input → Rust backend
    this.terminal.onData((data) => {
      // Fix: macOS WebView IME composition converts ASCII to fullwidth on first keypress after idle
      // Convert fullwidth ASCII (！-～ U+FF01-FF5E) back to halfwidth
      const fixed = data.replace(/[\uff01-\uff5e]/g, c =>
        String.fromCharCode(c.charCodeAt(0) - 0xfee0)
      );
      // 始终过滤掉 Ctrl+C (\x03)，当有选中文本或鼠标选择进行中时
      if (fixed === '\x03' && (this.mouseSelectionInProgress || this.terminal.hasSelection())) {
        console.log('Blocked Ctrl+C during selection');
        return;
      }
      api.writeTerminal(tabId, fixed);
    });

    // Listen for output from Rust backend
    api.onTerminalOutput(tabId, (data) => {
      this.terminal.write(data);
    });

    // Block browser paste events — all paste is handled by Cmd+V keydown or right-click via Tauri backend
    this.wrapper.addEventListener('paste', (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
    }, true); // capture phase

    // Right-click: copy if there's a selection, otherwise paste
    this.wrapper.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      if (this.terminal.hasSelection()) {
        navigator.clipboard.writeText(this.terminal.getSelection());
        this.terminal.clearSelection();
      } else {
        api.readClipboardText().then(text => {
          if (text) {
            this.terminal.paste(text);
          }
        }).catch(() => {});
      }
    });

    // Scroll-to-bottom button
    this.scrollBtn = document.createElement('button');
    this.scrollBtn.className = 'terminal-scroll-bottom';
    this.scrollBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 11.5l-5-5h10z"/></svg>';
    this.scrollBtn.title = '回到底部';
    this.scrollBtn.addEventListener('click', () => {
      this.userScrolledUp = false;
      this.terminal.scrollToBottom();
      this.terminal.focus();
    });
    this.wrapper.appendChild(this.scrollBtn);

    // Track user scroll: mouse wheel means user is scrolling manually
    this.wrapper.addEventListener('wheel', () => {
      const buf = this.terminal.buffer.active;
      // After wheel, check if user scrolled away from bottom
      requestAnimationFrame(() => {
        this.userScrolledUp = buf.viewportY < buf.baseY - 3;
      });
    });

    this.terminal.onScroll(() => {
      // Update userScrolledUp on any scroll event (wheel, keyboard, mouse drag selection, etc.)
      const buf = this.terminal.buffer.active;
      const atBottom = buf.baseY - buf.viewportY <= 3;
      if (!atBottom) this.userScrolledUp = true;
      else this.userScrolledUp = false;
      this.updateScrollBtn();
    });
    this.terminal.onWriteParsed(() => {
      // If new content arrives and user hasn't scrolled up, stay at bottom
      if (!this.userScrolledUp) {
        this.terminal.scrollToBottom();
      }
      this.updateScrollBtn();
    });
    // Periodic check for scroll position (catches mouse wheel and other scroll events)
    this.scrollCheckTimer = setInterval(() => this.updateScrollBtn(), 500);

    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.fit(), 100);
    });
    this.resizeObserver.observe(this.wrapper);
  }

  private updateScrollBtn() {
    const buf = this.terminal.buffer.active;
    const atBottom = buf.baseY - buf.viewportY <= 3;
    if (atBottom) this.userScrolledUp = false;
    this.scrollBtn.classList.toggle('visible', !atBottom);
  }

  applyTheme(index: number) {
    const t = themes[index];
    if (t) this.terminal.options.theme = t.theme;
  }

  setFontSize(size: number) {
    this.terminal.options.fontSize = size;
    this.fit();
  }

  setFontFamily(family: string) {
    this.terminal.options.fontFamily = TerminalView.getFontFamily(family);
    this.fit();
  }

  static getSavedThemeIndex(): number {
    const saved = localStorage.getItem('terminal-theme-index');
    const idx = saved ? parseInt(saved, 10) : 0;
    return idx >= 0 && idx < themes.length ? idx : 0;
  }

  static getFontFamily(family: string): string {
    const fonts = getPlatformFonts();
    const cn = fonts.chinese;

    const fontMap: Record<string, string> = {
      // macOS fonts
      'menlo': `'Menlo', ${cn}, monospace`,
      'monaco': `'Monaco', ${cn}, monospace`,
      'meslo-nerd': `'MesloLGS Nerd Font', 'Menlo', ${cn}, monospace`,
      'hack-nerd': `'Hack Nerd Font', 'Menlo', ${cn}, monospace`,
      // Windows fonts
      'consolas': `'Consolas', ${cn}, monospace`,
      'cascadia': `'Cascadia Code', ${cn}, monospace`,
      'lucida': `'Lucida Console', ${cn}, monospace`,
      'caskaydia-nerd': `'CaskaydiaCove Nerd Font', 'Consolas', ${cn}, monospace`,
      // Shared
      'courier': `'Courier New', ${cn}, monospace`,
    };

    return fontMap[family] || `${fonts.mono}, ${cn}, monospace`;
  }

  fit() {
    try {
      const buf = this.terminal.buffer.active;
      const savedViewportY = buf.viewportY;

      this.fitAddon.fit();
      const safeCols = Math.max(1, this.terminal.cols - 1);
      api.resizeTerminal(this.tabId, safeCols, this.terminal.rows);

      // If user hasn't scrolled up, always stay at bottom
      if (!this.userScrolledUp) {
        this.terminal.scrollToBottom();
      } else {
        this.terminal.scrollToLine(savedViewportY);
      }
    } catch {}
  }

  show() { this.wrapper.classList.add('visible'); requestAnimationFrame(() => this.fit()); }
  hide() { this.wrapper.classList.remove('visible'); }
  write(data: string) { this.terminal.write(data); }
  focus() { this.terminal.focus(); }
  clear() { this.terminal.clear(); }

  toggleSearch() {
    if (this.searchBar) { this.closeSearch(); return; }
    const bar = document.createElement('div');
    bar.className = 'terminal-search-bar';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '搜索...';
    input.addEventListener('input', () => {
      if (input.value) this.searchAddon.findNext(input.value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.shiftKey ? this.searchAddon.findPrevious(input.value) : this.searchAddon.findNext(input.value);
      } else if (e.key === 'Escape') {
        this.closeSearch();
      }
    });
    const prevBtn = document.createElement('button');
    prevBtn.textContent = '▲';
    prevBtn.title = '上一个 (Shift+Enter)';
    prevBtn.addEventListener('click', () => this.searchAddon.findPrevious(input.value));
    const nextBtn = document.createElement('button');
    nextBtn.textContent = '▼';
    nextBtn.title = '下一个 (Enter)';
    nextBtn.addEventListener('click', () => this.searchAddon.findNext(input.value));
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.className = 'search-close';
    closeBtn.addEventListener('click', () => this.closeSearch());
    bar.appendChild(input);
    bar.appendChild(prevBtn);
    bar.appendChild(nextBtn);
    bar.appendChild(closeBtn);
    this.wrapper.appendChild(bar);
    this.searchBar = bar;
    input.focus();
  }

  closeSearch() {
    if (this.searchBar) {
      this.searchAddon.clearDecorations();
      this.searchBar.remove();
      this.searchBar = null;
      this.terminal.focus();
    }
  }

  dispose() {
    // 清理鼠标事件监听器
    const endSelection = () => {
      this.mouseSelectionInProgress = false;
    };
    document.removeEventListener('mouseup', endSelection);
    window.removeEventListener('blur', endSelection);
    
    this.closeSearch();
    this.resizeObserver.disconnect();
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (this.scrollCheckTimer) clearInterval(this.scrollCheckTimer);
    this.terminal.dispose();
    this.wrapper.remove();
  }
}
