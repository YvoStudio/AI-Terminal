export interface PiTaskSubmission {
  text: string;
  imageCount: number;
}

// Private, non-rendering OSC channel from the bundled Pi extension. Only live
// PTY output is fed here: restoring scrollback must never replay submissions.
const PREFIX = '\x1b]633;AiTerminalTask;';
const MAX_FRAME = 1024 * 1024;

export class PiTaskEvents {
  private buffer = '';
  private session = '';
  private sequence = -1;
  private enabled = false;

  get active(): boolean { return this.enabled; }

  reset() {
    this.buffer = '';
    this.session = '';
    this.sequence = -1;
    this.enabled = false;
  }

  feed(data: string, onSubmit: (task: PiTaskSubmission) => void) {
    this.buffer += data;
    while (this.buffer) {
      const start = this.buffer.indexOf(PREFIX);
      if (start < 0) {
        // Retain only an incomplete prefix, not arbitrary terminal output.
        let length = Math.min(this.buffer.length, PREFIX.length - 1);
        while (length > 0 && !PREFIX.startsWith(this.buffer.slice(-length))) length--;
        this.buffer = length > 0 ? this.buffer.slice(-length) : '';
        return;
      }
      this.buffer = this.buffer.slice(start);
      const bel = this.buffer.indexOf('\x07', PREFIX.length);
      const st = this.buffer.indexOf('\x1b\\', PREFIX.length);
      const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
      const next = this.buffer.indexOf(PREFIX, PREFIX.length);
      if (next >= 0 && (end < 0 || next < end)) {
        this.buffer = this.buffer.slice(next); // recover from an unterminated frame
        continue;
      }
      if (end < 0) {
        if (this.buffer.length <= MAX_FRAME) return;
        this.buffer = this.buffer.slice(PREFIX.length);
        continue;
      }
      const encoded = this.buffer.slice(PREFIX.length, end);
      this.buffer = this.buffer.slice(end + (end === st ? 2 : 1));
      if (encoded.length > MAX_FRAME) continue;
      try {
        const bytes = Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0));
        const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (event?.version !== 1 || typeof event.session !== 'string' || !event.session
            || !Number.isSafeInteger(event.sequence) || event.sequence < 0) continue;
        if (event.event === 'ready') {
          if (event.session !== this.session) {
            this.session = event.session;
            this.sequence = event.sequence;
            this.enabled = true;
          }
          continue;
        }
        if (!this.enabled || event.session !== this.session || event.sequence <= this.sequence) continue;
        if (event.event === 'stop') {
          this.sequence = event.sequence;
          this.enabled = false;
        } else if (event.event === 'input' && typeof event.text === 'string'
            && Number.isSafeInteger(event.imageCount) && event.imageCount >= 0) {
          this.sequence = event.sequence;
          // Dedupe transport events by identity, never by prompt content. The
          // same old instruction submitted twice is two separate executions.
          if (event.text.trim() || event.imageCount) {
            onSubmit({ text: event.text, imageCount: event.imageCount });
          }
        }
      } catch { /* malformed/unrelated terminal output is not a task */ }
    }
  }
}
