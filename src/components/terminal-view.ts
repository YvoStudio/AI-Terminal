import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
// Canvas/WebGL addons removed — DOM renderer has best emoji support
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { api } from '../api';
import { themes } from './themes';

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

    // Windows 使用黑体，字号默认大一号
    const isWindows = navigator.platform.toLowerCase().includes('win');
    const fontSize = isWindows ? 14 : 13;
    const fontFamily = isWindows
      ? "'CaskaydiaCove Nerd Font', 'SimHei', 'Cascadia Code', 'Consolas', 'SF Mono', 'Menlo', 'Apple Color Emoji', 'Segoe UI Emoji', monospace"
      : "'MesloLGS Nerd Font', 'Hack Nerd Font', 'Menlo', 'Cascadia Code', 'SF Mono', 'Consolas', 'Apple Color Emoji', monospace";

    this.terminal = new Terminal({
      fontSize,
      fontFamily,
      theme: currentTheme.theme,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    this.terminal.open(this.wrapper);

    // Unicode 11 for proper emoji/CJK width calculation
    const unicode11 = new Unicode11Addon();
    this.terminal.loadAddon(unicode11);
    this.terminal.unicode.activeVersion = '11';

    // Using default DOM renderer for best emoji/Unicode support

    // Input → Rust backend
    this.terminal.onData((data) => {
      api.writeTerminal(tabId, data);
    });

    // Listen for output from Rust backend
    api.onTerminalOutput(tabId, (data) => {
      this.terminal.write(data);
    });

    // Paste image support
    this.wrapper.addEventListener('paste', (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          e.stopPropagation();
          const blob = item.getAsFile();
          if (!blob) return;
          const reader = new FileReader();
          reader.onload = async () => {
            const dataUrl = reader.result as string;
            const filePath = await api.saveClipboardImage(dataUrl);
            if (filePath) api.writeTerminal(tabId, filePath);
          };
          reader.readAsDataURL(blob);
          return;
        }
      }
    });

    // Scroll-to-bottom button
    this.scrollBtn = document.createElement('button');
    this.scrollBtn.className = 'terminal-scroll-bottom';
    this.scrollBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 11.5l-5-5h10z"/></svg>';
    this.scrollBtn.title = '回到底部';
    this.scrollBtn.addEventListener('click', () => {
      this.terminal.scrollToBottom();
      this.terminal.focus();
    });
    this.wrapper.appendChild(this.scrollBtn);

    this.terminal.onScroll(() => this.updateScrollBtn());
    this.terminal.onWriteParsed(() => this.updateScrollBtn());
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
    const atBottom = buf.viewportY >= buf.baseY;
    this.scrollBtn.classList.toggle('visible', !atBottom);
  }

  applyTheme(index: number) {
    const t = themes[index];
    if (t) this.terminal.options.theme = t.theme;
  }

  static getSavedThemeIndex(): number {
    const saved = localStorage.getItem('terminal-theme-index');
    const idx = saved ? parseInt(saved, 10) : 0;
    return idx >= 0 && idx < themes.length ? idx : 0;
  }

  fit() {
    try {
      // Preserve scroll position across resize to prevent jumping to top
      const buf = this.terminal.buffer.active;
      const wasAtBottom = buf.viewportY >= buf.baseY;
      const savedViewportY = buf.viewportY;

      this.fitAddon.fit();
      // Report 1 less col to PTY to prevent edge-case line wrapping
      // (scrollbar width and sub-pixel rounding can cause off-by-one)
      const safeCols = Math.max(1, this.terminal.cols - 1);
      api.resizeTerminal(this.tabId, safeCols, this.terminal.rows);

      // Restore scroll: if user was at bottom, stay at bottom; otherwise try to keep position
      if (wasAtBottom) {
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
    this.closeSearch();
    this.resizeObserver.disconnect();
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (this.scrollCheckTimer) clearInterval(this.scrollCheckTimer);
    this.terminal.dispose();
    this.wrapper.remove();
  }
}
