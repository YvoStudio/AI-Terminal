import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { api } from '../api';
import { themes } from './themes';

export class TerminalView {
  terminal: Terminal;
  private fitAddon: FitAddon;
  private wrapper: HTMLElement;
  private resizeObserver: ResizeObserver;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

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

    this.terminal = new Terminal({
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Consolas', 'SF Mono', 'Menlo', monospace",
      theme: currentTheme.theme,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.wrapper);

    try { this.terminal.loadAddon(new WebglAddon()); } catch {}

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

    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.fit(), 100);
    });
    this.resizeObserver.observe(this.wrapper);
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
      this.fitAddon.fit();
      api.resizeTerminal(this.tabId, this.terminal.cols, this.terminal.rows);
    } catch {}
  }

  show() { this.wrapper.classList.add('visible'); requestAnimationFrame(() => this.fit()); }
  hide() { this.wrapper.classList.remove('visible'); }
  write(data: string) { this.terminal.write(data); }
  focus() { this.terminal.focus(); }
  clear() { this.terminal.clear(); }

  dispose() {
    this.resizeObserver.disconnect();
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.terminal.dispose();
    this.wrapper.remove();
  }
}
