import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { convertFileSrc } from '@tauri-apps/api/core';
import { api } from '../api';
import { appState } from './app-state';
import { themes } from './themes';
import { isWindows, getDefaultFontSize, getPlatformFonts } from '../platform';

export class TerminalView {
  terminal: Terminal;
  private fitAddon: FitAddon;
  private searchAddon: SearchAddon;
  private serializeAddon: SerializeAddon;
  private scrollbackSaveTimer: ReturnType<typeof setInterval> | null = null;
  // Command blocks (Warp-style): OSC 133 C/D boundaries tracked by xterm markers
  // so line numbers stay correct as scrollback shifts.
  private blocks: Array<{ start: any; end: any | null; exit: number | null }> = [];
  readonly wrapper: HTMLElement;
  private searchBar: HTMLElement | null = null;
  private resizeObserver: ResizeObserver;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollBtn: HTMLElement;
  private scrollCheckTimer: ReturnType<typeof setInterval> | null = null;

  private mouseSelectionInProgress = false;
  private userScrolledUp = false;
  // Kitty Keyboard Protocol (CSI u) state: flags stack. 0 = disabled.
  private kittyStack: number[] = [0];
  private get kittyFlags() { return this.kittyStack[this.kittyStack.length - 1] || 0; }

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
      // OSC 8 hyperlinks: cmd/ctrl-click opens via Tauri shell plugin.
      // xterm.js invokes `activate` on click events for OSC 8 escaped URIs.
      linkHandler: {
        activate: (_event, uri) => {
          // Resolve bare file paths to file:// URIs so the OS opens them
          const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : `file://${uri}`;
          api.openExternal(target).catch((e) => console.warn('openExternal failed:', e));
        },
        hover: () => {},
        leave: () => {},
      },
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.serializeAddon = new SerializeAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    this.terminal.loadAddon(this.serializeAddon);
    this.terminal.open(this.wrapper);

    // Restore scrollback from previous session (skip in Quick Terminal mode — ephemeral)
    const isQuick = new URLSearchParams(location.search).get('quick') === '1';
    if (!isQuick) {
      api.loadScrollback(tabId).then((sb) => {
        if (sb && sb.length > 0) {
          this.terminal.write(sb + '\r\n\x1b[2m── session restored ──\x1b[0m\r\n');
        }
      }).catch(() => {});
      // Save scrollback every 10s (debounced) to bound disk writes
      this.scrollbackSaveTimer = setInterval(() => {
        try {
          const data = this.serializeAddon.serialize({ scrollback: 2000 });
          if (data) api.saveScrollback(tabId, data).catch(() => {});
        } catch {}
      }, 10_000);
    }

    // Command block tracking: on OSC 133 C register a start marker, on D an end marker.
    try {
      const parser = (this.terminal as any).parser;
      if (parser && parser.registerOscHandler) {
        parser.registerOscHandler(133, (data: string) => {
          // data is e.g. "C" / "D;0" / "A" / "B"
          const kind = data.charAt(0);
          if (kind === 'C') {
            const start = this.terminal.registerMarker(0);
            this.blocks.push({ start, end: null, exit: null });
            if (this.blocks.length > 200) this.blocks.shift();
          } else if (kind === 'D') {
            const exitMatch = /D;(-?\d+)/.exec(data);
            const exit = exitMatch ? parseInt(exitMatch[1], 10) : 0;
            for (let i = this.blocks.length - 1; i >= 0; i--) {
              if (!this.blocks[i].end) {
                this.blocks[i].end = this.terminal.registerMarker(0);
                this.blocks[i].exit = exit;
                break;
              }
            }
          }
          return false; // don't consume — let other handlers see it too
        });
      }
    } catch {}

    // Kitty Keyboard Protocol: register CSI u handlers for push/pop/set/query.
    // Apps like Neovim/Helix enable via `CSI > flags u` and expect to receive
    // keys encoded as `CSI unicode;modifiers u` for combos xterm can't express.
    try {
      const parser = (this.terminal as any).parser;
      if (parser && parser.registerCsiHandler) {
        // CSI > flags u — push flags
        parser.registerCsiHandler({ final: 'u', prefix: '>' }, (params: any) => {
          const f = (params.params?.[0] ?? params[0] ?? 1) | 0;
          this.kittyStack.push(f);
          return true;
        });
        // CSI = flags ; mode u — set flags (mode 1=set, 2=OR, 3=AND-NOT)
        parser.registerCsiHandler({ final: 'u', prefix: '=' }, (params: any) => {
          const arr = params.params ?? params;
          const f = (arr[0] ?? 0) | 0;
          const mode = (arr[1] ?? 1) | 0;
          const cur = this.kittyFlags;
          const next = mode === 2 ? cur | f : mode === 3 ? cur & ~f : f;
          this.kittyStack[this.kittyStack.length - 1] = next;
          return true;
        });
        // CSI < [n] u — pop n flags (default 1)
        parser.registerCsiHandler({ final: 'u', prefix: '<' }, (params: any) => {
          const arr = params.params ?? params;
          let n = (arr[0] ?? 1) | 0; if (n < 1) n = 1;
          while (n-- > 0 && this.kittyStack.length > 1) this.kittyStack.pop();
          return true;
        });
        // CSI ? u — query; reply with `CSI ? flags u`
        parser.registerCsiHandler({ final: 'u', prefix: '?' }, () => {
          api.writeTerminal(this.tabId, `\x1b[?${this.kittyFlags}u`);
          return true;
        });
      }
    } catch { /* parser API optional — degrade silently */ }

    // macOS Chinese IME Shift+key fix:
    // Chinese IME uses Shift to toggle Chinese/English. When Shift is pressed quickly
    // before another key, the IME may: (a) swallow the char, or (b) output it AND
    // xterm also processes it → double input.
    // Fix: Use preventDefault() in capture phase on xterm's textarea to stop the IME
    // from seeing the event at all. We send the char directly ourselves.
    let shiftDownTime = 0;
    let shiftHeld = false;
    // Track the specific char sent via Shift+key bypass, so we only suppress
    // the exact IME duplicate — not unrelated subsequent keystrokes.
    let suppressChar = '';
    let suppressUntil = 0;
    // Track active IME composition. The Shift+key bypass must NOT fire while
    // the IME is composing, otherwise we send the char directly while the IME
    // still holds "dev" (or "dev_") in its preedit buffer — Enter then commits
    // the buffer on top of our already-sent char, producing e.g. "_dev_".
    let imeComposing = false;
    const xtermTextarea = this.wrapper.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
    if (xtermTextarea) {
      // Capture-phase keydown on textarea: block IME and send char directly
      xtermTextarea.addEventListener('keydown', (ev) => {
        const e = ev as KeyboardEvent;
        if (e.key === 'Shift') {
          shiftDownTime = Date.now();
          shiftHeld = true;
          return;
        }
        // Skip bypass entirely while IME is composing — let the IME commit
        // normally via compositionend. Also guard with e.isComposing and
        // e.key === 'Process' in case our flag lags the DOM event.
        if (imeComposing || e.isComposing || e.key === 'Process') return;
        // Only for non-letter chars (symbols/numbers like ?, !, @, etc.)
        // Letters are handled fine by IME's Shift-toggle-to-English mode.
        // Active while Shift is held to support rapid sequences (Shift+1,2,3).
        if (e.shiftKey && shiftHeld && !e.ctrlKey && !e.metaKey && !e.altKey
            && e.key.length === 1 && !/^[a-zA-Z]$/.test(e.key)) {
          e.preventDefault();
          api.writeTerminal(tabId, e.key);
          suppressChar = e.key;
          suppressUntil = Date.now() + 300;
        }
      }, true);
      xtermTextarea.addEventListener('keyup', (ev) => {
        if ((ev as KeyboardEvent).key === 'Shift') shiftHeld = false;
      }, true);
      // Track IME composition lifecycle so the Shift+key bypass can bail out
      // while the IME owns the keystroke.
      this.wrapper.addEventListener('compositionstart', () => {
        imeComposing = true;
      }, true);
      this.wrapper.addEventListener('compositionend', () => {
        imeComposing = false;
      }, true);
      // Block IME composition on the WRAPPER (parent), so capture phase fires
      // BEFORE xterm's own listeners on the textarea.
      for (const evt of ['compositionstart', 'compositionupdate', 'compositionend', 'input'] as const) {
        this.wrapper.addEventListener(evt, (e) => {
          if (Date.now() < suppressUntil) {
            e.stopImmediatePropagation();
            e.stopPropagation();
            e.preventDefault();
            xtermTextarea.value = '';
          }
        }, true);
      }
    }

    // Intercept key events inside xterm before it processes them
    this.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // Kitty Keyboard Protocol (CSI u): when enabled by the running app and
      // the key combo involves Ctrl/Alt in ways xterm can't encode, send
      // `CSI codepoint;mods u` directly and block xterm's default handling.
      if (this.kittyFlags && e.type === 'keydown' && !e.isComposing
          && !imeComposing && e.key !== 'Process') {
        const isMod = e.ctrlKey || e.altKey || e.metaKey;
        const specials: Record<string, number> = {
          Enter: 13, Tab: 9, Backspace: 127, Escape: 27,
        };
        let cp: number | null = null;
        if (specials[e.key] !== undefined) cp = specials[e.key];
        else if (e.key.length === 1 && isMod) cp = e.key.toLowerCase().codePointAt(0) ?? null;
        if (cp !== null && (isMod || e.key === 'Enter')) {
          const mods = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0)
                        + (e.ctrlKey ? 4 : 0) + (e.metaKey ? 8 : 0);
          // Only emit CSI u form when there are real modifiers beyond base 1
          // (avoid intercepting bare Enter, which TUIs still expect as \r).
          if (mods > 1 || (e.key === 'Enter' && (e.ctrlKey || e.shiftKey))) {
            api.writeTerminal(this.tabId, `\x1b[${cp};${mods}u`);
            e.preventDefault();
            return false;
          }
        }
      }
      // Shift+non-letter: already handled by capture-phase listener above
      if (e.shiftKey && shiftHeld && !e.ctrlKey && !e.metaKey && !e.altKey
          && e.key.length === 1 && !/^[a-zA-Z]$/.test(e.key)) {
        return false; // block xterm from also processing
      }
      // Block standalone modifier keys when there's a selection — prevents xterm from
      // scrolling to bottom when user presses Cmd/Ctrl before Cmd+C to copy.
      if (['Control', 'Alt', 'Meta'].includes(e.key) && this.terminal.hasSelection()) {
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
            const tab = appState.tabs.get(tabId);
            // Detect AI/TUI: parser-set aiTool, or alt-buffer (vim/htop/etc. also TUI).
            // Output-side parser detection (commands.rs) covers Claude sessions started
            // outside input tracking (resume, history-launched tabs).
            const bufType = this.terminal.buffer.active.type;
            const isAI = !!tab?.aiTool || bufType === 'alternate';
            try {
              const imgPath = await api.readClipboardImage();
              if (imgPath) {
                if (isAI) {
                  // TUI apps (Claude Code, Aider) read the OS clipboard themselves on bracketed
                  // paste and convert image clipboard contents to [Image #N]. Send an empty
                  // bracketed paste sequence as the trigger; track the path locally so
                  // [Image #N] tokens can be clicked for preview.
                  appState.addPastedImage(tabId, imgPath);
                  api.writeTerminal(tabId, '\x1b[200~\x1b[201~');
                } else {
                  // Plain shell: write absolute path (useful for `cat`, `cp`, etc.)
                  api.writeTerminal(tabId, imgPath + ' ');
                }
                return;
              }
            } catch (err) {
              console.log('[Paste] Image read failed:', err);
            }
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
    
    document.addEventListener('mouseup', () => {
      endSelection();
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

    // [Image #N] link provider — make Claude Code's image refs clickable to preview the original paste.
    this.terminal.registerLinkProvider({
      provideLinks: (lineNumber, callback) => {
        const buf = this.terminal.buffer.active;
        const line = buf.getLine(lineNumber - 1);
        if (!line) { callback(undefined); return; }
        const text = line.translateToString(true);
        const re = /\[Image #(\d+)\]/g;
        const links: any[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const n = parseInt(m[1], 10);
          const startCol = m.index + 1;
          const endCol = m.index + m[0].length;
          links.push({
            range: {
              start: { x: startCol, y: lineNumber },
              end: { x: endCol, y: lineNumber },
            },
            text: m[0],
            activate: () => {
              const tab = appState.tabs.get(tabId);
              const paths = tab?.pastedImages || [];
              const path = paths[n - 1] || paths[paths.length - 1];
              if (!path) return;
              const preview = (window as any).showImagePreview;
              if (typeof preview === 'function') preview(convertFileSrc(path));
            },
          });
        }
        callback(links.length ? links : undefined);
      },
    });

    // Input → Rust backend
    this.terminal.onData((data) => {
      // Fix: macOS WebView IME composition converts ASCII to fullwidth on first keypress after idle
      // Convert fullwidth ASCII (！-～ U+FF01-FF5E) back to halfwidth
      const fixed = data.replace(/[\uff01-\uff5e]/g, c =>
        String.fromCharCode(c.charCodeAt(0) - 0xfee0)
      );
      // Fallback: suppress IME duplicate that got through despite composition blocking.
      // Only suppress if it matches the exact char we just sent via Shift+key bypass.
      // Don't clear suppressChar — keep suppressing within the time window so rapid
      // repeat presses (hold Shift+symbol) don't leak duplicates.
      if (suppressChar && Date.now() < suppressUntil && fixed === suppressChar) {
        return;
      }
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
            this.terminal.focus();
          }
        }).catch(() => {});
      }
    });

    // Scroll-to-bottom button
    this.scrollBtn = document.createElement('button');
    this.scrollBtn.className = 'terminal-scroll-bottom';
    this.scrollBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 11.5l-5-5h10z"/></svg>';
    this.scrollBtn.title = '回到底部';
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
      api.resizeTerminal(this.tabId, this.terminal.cols, this.terminal.rows);

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
    prevBtn.textContent = '↑';
    prevBtn.title = '上一个 (Shift+Enter)';
    prevBtn.textContent = '▲';
    prevBtn.title = '上一个 (Shift+Enter)';
    prevBtn.addEventListener('click', () => this.searchAddon.findPrevious(input.value));
    const nextBtn = document.createElement('button');
    nextBtn.textContent = '↓';
    nextBtn.title = '下一个 (Enter)';
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
    if (this.scrollbackSaveTimer) clearInterval(this.scrollbackSaveTimer);
    // Best-effort final save so the next launch restores the freshest state.
    try {
      const data = this.serializeAddon.serialize({ scrollback: 2000 });
      if (data) api.saveScrollback(this.tabId, data).catch(() => {});
    } catch {}
    this.terminal.dispose();
    this.wrapper.remove();
  }

  /** Remove saved scrollback for this tab — call when the user closes the tab. */
  purgeScrollback() {
    api.deleteScrollback(this.tabId).catch(() => {});
  }

  /** Extract the text of the most recent completed command block (C→D). */
  getLastBlockText(): string | null {
    const buf = this.terminal.buffer.active;
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (!b.end || !b.start) continue;
      const startLine = b.start.line;
      const endLine = b.end.line;
      if (startLine < 0 || endLine < 0 || endLine < startLine) continue;
      const lines: string[] = [];
      for (let y = startLine; y <= endLine; y++) {
        const ln = buf.getLine(y);
        if (ln) lines.push(ln.translateToString(true));
      }
      return lines.join('\n').trim();
    }
    return null;
  }
}
