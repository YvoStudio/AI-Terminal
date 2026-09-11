export interface PromptSubmission {
  text: string;
  imageCount: number;
}

/** Best-effort mirror of the terminal editor, not a log of typed characters.
 * All input paths (xterm, host shortcuts and paste) must use the same cursor.
 * App-side completions/custom keybindings are not observable from PTY input. */
export class PromptInput {
  private chars: string[] = [];
  private cursor = 0;
  private images = 0;
  private sequence = '';
  private paste: string | null = null;
  private history: string[] = [];
  private historyIndex = -1;
  private draft = '';

  get text(): string { return this.chars.join(''); }
  get hasContent(): boolean { return this.chars.length > 0 || this.images > 0; }

  reset(clearHistory = false) {
    this.chars = [];
    this.cursor = 0;
    this.images = 0;
    this.sequence = '';
    this.paste = null;
    this.historyIndex = -1;
    this.draft = '';
    if (clearHistory) this.history = [];
  }

  addImage() { this.images++; }

  /** A paste/IME commit inserts at the caret; its newlines never submit. */
  insert(text: string) {
    const chars = Array.from(text.replace(/\r\n?/g, '\n'));
    this.chars = this.chars.slice(0, this.cursor).concat(chars, this.chars.slice(this.cursor));
    this.cursor += chars.length;
  }

  /** Also called for queue submissions, which bypass xterm.onData. */
  accept(text: string) {
    if (text.trim() && this.history[0] !== text) {
      this.history.unshift(text);
      this.history = this.history.slice(0, 100);
    }
    this.reset();
  }

  private lineStart(): number {
    return this.cursor === 0 ? 0 : this.chars.lastIndexOf('\n', this.cursor - 1) + 1;
  }

  private lineEnd(): number {
    const end = this.chars.indexOf('\n', this.cursor);
    return end < 0 ? this.chars.length : end;
  }

  private wordLeft(): number {
    let pos = this.cursor;
    while (pos > 0 && /\s/.test(this.chars[pos - 1])) pos--;
    while (pos > 0 && !/\s/.test(this.chars[pos - 1])) pos--;
    return pos;
  }

  private wordRight(): number {
    let pos = this.cursor;
    while (pos < this.chars.length && /\s/.test(this.chars[pos])) pos++;
    while (pos < this.chars.length && !/\s/.test(this.chars[pos])) pos++;
    return pos;
  }

  private erase(start: number, end: number) {
    this.chars.splice(start, end - start);
    this.cursor = start;
  }

  private vertical(direction: -1 | 1) {
    const start = this.lineStart();
    const end = this.lineEnd();
    const column = this.cursor - start;
    if (direction < 0 && start > 0) {
      const previous = start === 1 ? 0 : this.chars.lastIndexOf('\n', start - 2) + 1;
      this.cursor = Math.min(previous + column, start - 1);
    } else if (direction > 0 && end < this.chars.length) {
      const nextEnd = this.chars.indexOf('\n', end + 1);
      this.cursor = Math.min(end + 1 + column, nextEnd < 0 ? this.chars.length : nextEnd);
    } else {
      // Prompt history observed during this session. Keep an unfinished draft
      // so Up then Down restores it instead of appending the recalled prompt.
      const index = this.historyIndex - direction;
      if (index < -1 || index >= this.history.length) return;
      if (this.historyIndex === -1) this.draft = this.text;
      this.historyIndex = index;
      this.chars = Array.from(index === -1 ? this.draft : this.history[index]);
      this.cursor = this.chars.length;
    }
  }

  private key(key: string, modifiers = 1) {
    const bits = modifiers - 1;
    const word = !!(bits & (2 | 4)); // Alt / Ctrl
    switch (key) {
      case 'left': this.cursor = bits & 8 ? this.lineStart() : word ? this.wordLeft() : Math.max(0, this.cursor - 1); break;
      case 'right': this.cursor = bits & 8 ? this.lineEnd() : word ? this.wordRight() : Math.min(this.chars.length, this.cursor + 1); break;
      case 'home': this.cursor = bits & 4 ? 0 : this.lineStart(); break;
      case 'end': this.cursor = bits & 4 ? this.chars.length : this.lineEnd(); break;
      case 'up': this.vertical(-1); break;
      case 'down': this.vertical(1); break;
      case 'backspace': this.erase(word ? this.wordLeft() : Math.max(0, this.cursor - 1), this.cursor); break;
      case 'delete': this.erase(this.cursor, word ? this.wordRight() : Math.min(this.chars.length, this.cursor + 1)); break;
    }
  }

  private control(ch: string, submit: (value: PromptSubmission) => void) {
    switch (ch) {
      case '\r': {
        const value = { text: this.text, imageCount: this.images };
        this.accept(value.text);
        if (value.text.trim() || value.imageCount) submit(value);
        break;
      }
      case '\x03': this.reset(); break; // Ctrl+C clears the prompt and images
      case '\x01': this.key('home'); break;
      case '\x05': this.key('end'); break;
      case '\x02': this.key('left'); break;
      case '\x06': this.key('right'); break;
      case '\x08': case '\x7f': this.key('backspace'); break;
      case '\x04': this.key('delete'); break;
      case '\x0b': this.erase(this.cursor, this.lineEnd()); break; // Ctrl+K
      case '\x15': this.erase(this.lineStart(), this.cursor); break; // Ctrl+U
      case '\x17': this.erase(this.wordLeft(), this.cursor); break; // Ctrl+W
      case '\x10': this.key('up'); break;
      case '\x0e': this.key('down'); break;
      case '\n': this.insert('\n'); break;
      default: if (ch >= ' ' && ch !== '\x7f') this.insert(ch);
    }
  }

  private escape(seq: string, submit: (value: PromptSubmission) => void) {
    if (seq === '\x1b[200~') { this.paste = ''; return; }
    // Legacy Alt+word movement/deletion (macOS Option bindings).
    if (seq === '\x1bb') { this.key('left', 3); return; }
    if (seq === '\x1bf') { this.key('right', 3); return; }
    if (seq === '\x1bd') { this.key('delete', 3); return; }
    if (seq === '\x1b\x7f') { this.key('backspace', 3); return; }
    const match = /^\x1b(?:\[|O)([\d;:]*)([A-Za-z~])$/.exec(seq);
    if (!match) return;
    const [first = '1', mod = '1'] = match[1].split(';');
    const [modValue, event] = mod.split(':').map(Number);
    if (event === 3) return; // Kitty release event isn't another edit
    const modifiers = modValue || 1;
    const code = Number(first.split(':')[0]);
    const final = match[2];
    const arrows: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
    if (arrows[final]) { this.key(arrows[final], modifiers); return; }
    if (final === '~') {
      const keys: Record<number, string> = { 1: 'home', 7: 'home', 4: 'end', 8: 'end', 3: 'delete' };
      if (keys[code]) this.key(keys[code], modifiers);
      return;
    }
    if (final !== 'u' || !Number.isFinite(code)) return;
    if (code === 13) {
      if ((modifiers - 1) & (1 | 2)) this.insert('\n'); // Shift/Alt+Enter
      else if (modifiers === 1) this.control('\r', submit);
      return;
    }
    const keys: Record<number, string> = { 127: 'backspace', 57349: 'delete', 57350: 'left', 57351: 'right', 57352: 'up', 57353: 'down', 57356: 'home', 57357: 'end' };
    if (keys[code]) { this.key(keys[code], modifiers); return; }
    if ((modifiers - 1) & 4 && code >= 97 && code <= 122) {
      this.control(String.fromCharCode(code - 96), submit);
    } else if ((modifiers - 1) & 2 && [98, 100, 102].includes(code)) {
      this.key(code === 98 ? 'left' : code === 102 ? 'right' : 'delete', 3);
    } else if (!((modifiers - 1) & (2 | 4 | 8)) && code >= 32 && code <= 0x10ffff) {
      this.insert(String.fromCodePoint(code));
    }
  }

  /** Consume terminal bytes, including CSI/SS3, Kitty and bracketed paste.
   * Escape sequences and paste delimiters can span multiple onData events. */
  feed(data: string, submit: (value: PromptSubmission) => void) {
    // A standalone Escape is a UI action, not the start of the next typed key.
    if (data === '\x1b' && !this.sequence && this.paste === null) return;
    for (const ch of data) {
      if (this.paste !== null) {
        this.paste += ch;
        if (this.paste.endsWith('\x1b[201~')) {
          this.insert(this.paste.slice(0, -6));
          this.paste = null;
        }
        continue;
      }
      if (this.sequence) {
        this.sequence += ch;
        if (this.sequence === '\x1b[' || this.sequence === '\x1bO') continue;
        if (this.sequence.length === 2 || /[@-~]/.test(ch)) {
          const seq = this.sequence;
          this.sequence = '';
          this.escape(seq, submit);
        }
        continue;
      }
      if (ch === '\x1b') this.sequence = ch;
      else this.control(ch, submit);
    }
  }
}
