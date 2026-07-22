import { api, type TabStatus, type SidebarEntry, type SavedTab } from '../api';

export interface NoteBlock {
  id: string;
  content: string;
  images?: string[]; // file paths of attached images
}

export type ShellType = 'cmd' | 'powershell' | 'wsl';

export type SplitLayout = 'left-right' | 'top-bottom' | 'left-two-right' | 'grid';

export interface SplitPane {
  tabIds: string[];       // tabs in this pane
  activeTabId: string;    // currently visible tab in this pane
}

export interface SplitState {
  layout: SplitLayout;
  panes: SplitPane[];
  activePaneIndex: number;
  paneWidths?: number[]; // fractions summing to 1, e.g. [0.5, 0.5]
}

export interface TabState {
  id: string;
  title: string;
  status: TabStatus;
  shell: ShellType;
  color: string;
  aiTool: string;
  sidebarEntries: SidebarEntry[];
  noteBlocks: NoteBlock[];
  // Per-session auto-send: when true, the head of this tab's task queue is sent
  // automatically each time the AI goes idle-ready.
  autoSend: boolean;
  cwd: string;
  userRenamed: boolean; // true if user manually renamed — blocks auto-rename
  // Image numbering. The AI CLI prints `[Image #N]` with N that restarts at 1
  // every new session (/clear, resume, relaunch). Its N stays on screen exactly
  // as printed; our globally-unique M (nextImageSeq) lives only in imageEpochs
  // and is resolved at click time. See bindImageRefsFromOutput for why the
  // number is no longer substituted into the stream.
  pastedTotal: number; // last M assigned to this tab — persistence/migration only.
  pastedById: Map<number, string>; // M → image path. Source of truth for click resolution.
  pendingPasteIds: number[]; // FIFO queue of pasted M values awaiting the AI's next [Image #N].
  imageEpochs: ImageEpoch[]; // one per AI session, oldest first. See ImageEpoch.
  outputResidue: string; // trailing partial `[Image #...` buffered across output chunks so a token split mid-stream isn't missed.
}

/** Live probe for the buffer line an epoch is anchored to. Backed by an xterm
 *  marker, which keeps the index correct as scrollback is trimmed and reports
 *  -1 once the line itself has been trimmed away. */
export type LineAnchor = () => number;

/** One AI session's worth of `[Image #N]` bindings.
 *
 *  N restarts at 1 every session, so the number alone doesn't identify an
 *  image — two sessions both print `[Image #1]` for different pastes, and both
 *  can be on screen at once once the first has scrolled up. What disambiguates
 *  them is WHERE they were drawn: everything below `startLine` belongs to this
 *  session, everything above it to an earlier one. */
type ImageEpoch = {
  startLine: LineAnchor;
  map: Map<number, number>; // this session's AI N → our M
  maxN: number; // highest N bound here; a lower N while a paste is pending ⇒ new session
};

class AppState {
  activeTabId: string | null = null;
  tabOrder: string[] = [];
  tabs: Map<string, TabState> = new Map();
  splitState: SplitState | null = null;
  private tabCounter = 0;
  private listeners: Array<() => void> = [];
  // Tabs where the user has typed into the prompt but not yet submitted/cleared
  // it. Transient (not persisted). Queue auto-send checks this so it won't inject
  // a note block on top of the user's in-progress input. See markPromptDirty.
  private promptDirtyTabs = new Set<string>();

  /** User typed printable input into this tab's prompt (composing). */
  markPromptDirty(tabId: string) { this.promptDirtyTabs.add(tabId); }
  /** Prompt was submitted (Enter) or cleared (Ctrl+C / Ctrl+U). */
  clearPromptDirty(tabId: string) { this.promptDirtyTabs.delete(tabId); }
  /** True while the user has unsubmitted text in this tab's prompt. */
  isPromptDirty(tabId: string): boolean { return this.promptDirtyTabs.has(tabId); }

  subscribe(fn: () => void) { this.listeners.push(fn); }
  private notify() { this.listeners.forEach(fn => { try { fn(); } catch (e) { console.error('[AppState] listener error:', e); } }); }

  addTab(id: string): TabState {
    this.tabCounter++;
    const tab: TabState = {
      id, title: `Terminal ${this.tabCounter}`, status: 'active', shell: 'cmd',
      color: '', aiTool: '', sidebarEntries: [], noteBlocks: [], autoSend: false, cwd: '', userRenamed: false,
      pastedTotal: 0,
      pastedById: new Map(),
      pendingPasteIds: [],
      imageEpochs: [],
      outputResidue: '',
    };
    this.tabs.set(id, tab);
    this.tabOrder.push(id);
    this.activeTabId = id;
    this.notify();
    return tab;
  }

  removeTab(id: string): string | null {
    const idx = this.tabOrder.indexOf(id);
    if (idx === -1) return null;
    this.tabOrder.splice(idx, 1);
    this.tabs.delete(id);
    this.promptDirtyTabs.delete(id);
    if (this.activeTabId === id) {
      this.activeTabId = this.tabOrder.length === 0 ? null
        : this.tabOrder[Math.min(idx, this.tabOrder.length - 1)];
    }
    this.notify();
    return this.activeTabId;
  }

  switchTab(id: string) {
    if (!this.tabs.has(id)) return;
    this.activeTabId = id;
    const tab = this.tabs.get(id)!;
    if (tab.status === 'done-unseen' || tab.status === 'waiting') tab.status = 'active';
    this.notify();
  }

  setShell(id: string, shell: ShellType) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.shell = shell;
    this.notify();
  }

  setColor(id: string, color: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.color = color;
    this.notify();
  }

  setStatus(id: string, status: TabStatus) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (id === this.activeTabId && status === 'waiting') {
      tab.status = 'active';
      this.notify();
      return;
    }
    tab.status = status;
    this.notify();
  }

  setAiTool(id: string, aiTool: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.aiTool = aiTool;
    this.notify();
  }

  setCwd(id: string, cwd: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    // Reject garbage: must be absolute path, no control chars or quotes, reasonable length
    if (!cwd || cwd.length > 500) return;
    if (cwd.includes('"') || cwd.includes('\n') || cwd.includes('\x1b')) return;
    if (!cwd.startsWith('/') && !/^[A-Za-z]:/.test(cwd)) return;
    tab.cwd = cwd;
    this.notify();
  }

  /** Global [Image #M] sequence shared by every tab — one unified counter that
   * only counts up, so no reset heuristic can ever produce two live refs with
   * the same number. Persisted so app restarts keep counting; wraps to 1 past
   * 9999 to keep refs short. */
  private nextImageSeq(): number {
    let seq = parseInt(localStorage.getItem('image-seq-global') || '0', 10) || 0;
    seq = seq >= 9999 ? 1 : seq + 1;
    localStorage.setItem('image-seq-global', String(seq));
    return seq;
  }

  addPastedImage(id: string, path: string) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    // Globally monotonic numbering: pastedById records this tab's refs for click
    // resolution; pendingPasteIds queues the M awaiting the AI's next [Image #N].
    if (!tab.pastedById) tab.pastedById = new Map();
    if (!tab.pendingPasteIds) tab.pendingPasteIds = [];
    const m = this.nextImageSeq();
    tab.pastedTotal = m;
    tab.pastedById.set(m, path);
    tab.pendingPasteIds.push(m);
    this.persistTabs();
  }

  /**
   * App-restart restore: re-seed the tab-lifetime image numbering saved in
   * SavedTab so numbering stays monotonic across app restarts and the
   * [Image #M] refs in restored scrollback remain clickable. The pending-paste
   * queue is deliberately NOT restored — a paste that never got bound belongs
   * to a dead AI session and must not bind to the next session's [Image #1].
   *
   * KNOWN GAP: imageEpochs are not persisted, so `[Image #N]` refs inside
   * restored scrollback resolve to nothing and clicking them does nothing.
   * Persisting them needs the anchors stored relative to the end of the
   * serialized scrollback (absolute buffer lines don't survive the restore).
   */
  restorePastedImages(id: string, total?: number, images?: Record<string, string>) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const entries = Object.entries(images || {})
      .map(([k, v]) => [parseInt(k, 10), v] as [number, string])
      .filter(([m]) => Number.isFinite(m) && m > 0);
    tab.pastedById = new Map(entries);
    const maxM = entries.reduce((acc, [m]) => Math.max(acc, m), 0);
    tab.pastedTotal = Math.max(total || 0, maxM);
    // Migration from per-tab counters: restored tabs may carry Ms above the
    // stored global sequence — push it past them so new pastes can't collide
    // with refs still visible in restored scrollback.
    const seq = parseInt(localStorage.getItem('image-seq-global') || '0', 10) || 0;
    if (tab.pastedTotal > seq && tab.pastedTotal < 9999) {
      localStorage.setItem('image-seq-global', String(tab.pastedTotal));
    }
  }

  /**
   * The AI started a fresh session (new alt-screen, /clear, resume, relaunch):
   * its [Image #N] counter restarts at 1. Open a new epoch so the next
   * [Image #N] re-binds from the pending queue without clobbering the previous
   * session's bindings — those still have to resolve for the refs left behind
   * in scrollback. Tab-lifetime state (pastedById / pastedTotal /
   * pendingPasteIds) is deliberately preserved.
   *
   * Only reset when there are pending pastes awaiting a fresh binding. Without
   * pending pastes a reset is pointless: Claude Code emits ?1049h on every
   * screen redraw within the same conversation, so it would churn epochs
   * mid-session for nothing.
   */
  resetAiSession(id: string, makeAnchor: () => LineAnchor) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if ((tab.pendingPasteIds?.length || 0) === 0) return;
    this.beginImageEpoch(tab, makeAnchor);
  }

  /** Open a new epoch anchored at the caller's current buffer line, and drop
   *  any older epoch whose anchor line has been trimmed out of scrollback —
   *  the refs it covered scrolled away with it, so nothing can resolve there.
   *
   *  If the newest epoch hasn't bound anything yet it is re-anchored in place
   *  rather than stacked on. Claude Code emits ?1049h on every screen redraw,
   *  so while a paste is pending this runs many times in a row; stacking would
   *  bury the epoch that actually holds the bindings under empty ones and make
   *  resolveImageRefAt return nothing. */
  private beginImageEpoch(tab: TabState, makeAnchor: () => LineAnchor): ImageEpoch {
    if (!tab.imageEpochs) tab.imageEpochs = [];
    tab.imageEpochs = tab.imageEpochs.filter(e => e.startLine() >= 0);
    const newest = tab.imageEpochs[tab.imageEpochs.length - 1];
    if (newest && newest.map.size === 0) {
      newest.startLine = makeAnchor();
      return newest;
    }
    const epoch: ImageEpoch = { startLine: makeAnchor(), map: new Map(), maxN: 0 };
    tab.imageEpochs.push(epoch);
    return epoch;
  }

  private currentImageEpoch(tab: TabState, makeAnchor: () => LineAnchor): ImageEpoch {
    const epochs = tab.imageEpochs;
    if (epochs && epochs.length > 0) return epochs[epochs.length - 1];
    return this.beginImageEpoch(tab, makeAnchor);
  }

  /**
   * Resolve an on-screen `[Image #N]` sitting at absolute buffer line `line`
   * into the M we assigned when that image was pasted.
   *
   * Picks the newest epoch anchored at or above the line, so a stale `[Image
   * #1]` left in scrollback by an earlier session resolves through THAT
   * session's bindings instead of the current one's — which is the collision
   * the old stream-rewriting numbering existed to prevent.
   */
  resolveImageRefAt(id: string, line: number, n: number): number | undefined {
    const tab = this.tabs.get(id);
    if (!tab?.imageEpochs?.length) return undefined;
    for (let i = tab.imageEpochs.length - 1; i >= 0; i--) {
      const start = tab.imageEpochs[i].startLine();
      if (start < 0) continue; // anchor trimmed away
      if (start <= line) return tab.imageEpochs[i].map.get(n);
    }
    return undefined;
  }

  /**
   * Map an AI-emitted `[Image #N]` to our tab-monotonic M. Bind once on first
   * sight (consuming the pending-paste queue) and reuse that binding on every
   * later redraw. Session restarts open a new epoch — via the alt-screen reset
   * in the caller, or the N-regression check below — so a rebound N never
   * clobbers the previous session's mapping.
   */
  private bindImageRefInEpoch(tab: TabState, epoch: ImageEpoch, n: number): void {
    if (!tab.pendingPasteIds) tab.pendingPasteIds = [];
    if (epoch.map.has(n)) return; // already bound — this is a redraw of the same ref
    if (tab.pendingPasteIds.length === 0) return;
    epoch.map.set(n, tab.pendingPasteIds.shift()!);
    if (n > epoch.maxN) epoch.maxN = n;
  }

  /**
   * Streaming scan: bind every `[Image #N]` in a freshly arrived chunk to the M
   * we assigned when that image was pasted. Holds back a trailing partial
   * `[Image #…` so a token split across chunk boundaries is still seen once its
   * tail arrives.
   *
   * The chunk is deliberately NOT modified. This used to substitute our M into
   * the stream so the on-screen number was globally unique — but M comes from a
   * counter that only ever grows (49, 300, 4000…) while the AI's N restarts at
   * 1 each session, so the substitution almost always made the line WIDER. The
   * AI redraws its inline UI by moving the cursor up a row count computed from
   * the string lengths IT emitted; a widened line that wrapped one row further
   * than the AI accounted for left the previous draw un-erased, which is the
   * duplicated-message ghost. Resolution moved to click time instead — see
   * resolveImageRefAt.
   */
  bindImageRefsFromOutput(id: string, chunk: string, makeAnchor: () => LineAnchor): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const data = (tab.outputResidue || '') + chunk;
    // Hold back a trailing partial token if the buffer ends mid-`[Image #...`.
    // The partial must also cover a half-arrived CHA separator (see IMAGE_REF
    // below), e.g. `[Image\x1b[13` with `G#1]` still in flight.
    let safeEnd = data.length;
    const tail = data.slice(Math.max(0, data.length - 24));
    const partial = tail.match(/\[(I(m(a(g(e([ \u00a0]*#? *\d*|\x1b(\[(\d*(G(#\d*)?)?)?)?)?)?)?)?)?)?$/);
    if (partial && partial[0].length > 0) {
      safeEnd = data.length - partial[0].length;
    }
    const head = data.slice(0, safeEnd);
    tab.outputResidue = data.slice(safeEnd);

    // `[Image #N]` as Claude emits it. Inline refs (prompt echo) separate with a
    // plain space, but transcript attachment lines (`⎿ [Image #1]`) position the
    // number with a CHA cursor move instead: `[Image\x1b[13G#1]`. Match both;
    // group 2 is N (group 1 is the separator, unused now that we only read).
    const IMAGE_REF = () => /\[Image((?:[ \u00a0]+|\x1b\[\d+G))#(\d+)\]/g;

    let epoch = this.currentImageEpoch(tab, makeAnchor);

    // In-place session restart (e.g. /clear, which doesn't re-enter the
    // alt-screen): the AI re-prints [Image #N] with N below the highest we've
    // bound while a fresh paste is waiting. Its counter can only have reset, so
    // open a new epoch — the old bindings stay valid for the refs still sitting
    // in scrollback above the new epoch's anchor.
    if ((tab.pendingPasteIds?.length || 0) > 0 && epoch.maxN > 0) {
      let chunkMax = 0;
      const scan = IMAGE_REF();
      let s: RegExpExecArray | null;
      while ((s = scan.exec(head)) !== null) {
        const v = parseInt(s[2], 10);
        if (v > chunkMax) chunkMax = v;
      }
      if (chunkMax > 0 && chunkMax < epoch.maxN) epoch = this.beginImageEpoch(tab, makeAnchor);
    }

    const refs = IMAGE_REF();
    let m: RegExpExecArray | null;
    while ((m = refs.exec(head)) !== null) {
      this.bindImageRefInEpoch(tab, epoch, parseInt(m[2], 10));
    }
  }

  addSidebarEntry(id: string, entry: SidebarEntry) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.sidebarEntries.push(entry);
    this.notify();
  }

  switchToNext() {
    if (this.tabOrder.length <= 1 || !this.activeTabId) return;
    const idx = this.tabOrder.indexOf(this.activeTabId);
    this.switchTab(this.tabOrder[(idx + 1) % this.tabOrder.length]);
  }

  switchToPrev() {
    if (this.tabOrder.length <= 1 || !this.activeTabId) return;
    const idx = this.tabOrder.indexOf(this.activeTabId);
    this.switchTab(this.tabOrder[(idx - 1 + this.tabOrder.length) % this.tabOrder.length]);
  }

  moveTab(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= this.tabOrder.length) return;
    if (toIndex < 0 || toIndex >= this.tabOrder.length) return;
    const [id] = this.tabOrder.splice(fromIndex, 1);
    this.tabOrder.splice(toIndex, 0, id);
    this.notify();
    this.persistTabs();
  }

  renameTab(id: string, name: string, byUser = true) {
    const tab = this.tabs.get(id);
    if (!tab || tab.title === name) return;
    tab.title = name;
    if (byUser) tab.userRenamed = true;
    this.notify();
    this.persistTabs();
  }

  enterSplit(layout: SplitLayout, tabIds: string[]) {
    // First pane gets all other tabs + the first specified tab
    const firstPaneTabs = this.tabOrder.filter(id => id !== tabIds[1]);
    const secondPaneTabs = [tabIds[1]];
    const panes: SplitPane[] = [
      { tabIds: firstPaneTabs, activeTabId: tabIds[0] },
      { tabIds: secondPaneTabs, activeTabId: tabIds[1] },
    ];
    this.splitState = { layout, panes, activePaneIndex: 0 };
    this.activeTabId = tabIds[0];
    this.notify();
  }

  exitSplit() {
    if (!this.splitState) return;
    const activePane = this.splitState.panes[this.splitState.activePaneIndex];
    const keepTabId = activePane?.activeTabId;
    this.splitState = null;
    if (keepTabId && this.tabs.has(keepTabId)) {
      this.activeTabId = keepTabId;
    }
    this.notify();
  }

  setActivePane(index: number) {
    if (!this.splitState || index < 0 || index >= this.splitState.panes.length) return;
    this.splitState.activePaneIndex = index;
    const pane = this.splitState.panes[index];
    this.activeTabId = pane.activeTabId;
    const tab = this.tabs.get(this.activeTabId!);
    if (tab && (tab.status === 'done-unseen' || tab.status === 'waiting')) tab.status = 'active';
    this.notify();
  }

  /** Switch which tab is active within a specific pane */
  switchPaneTab(paneIndex: number, tabId: string) {
    if (!this.splitState || paneIndex < 0 || paneIndex >= this.splitState.panes.length) return;
    const pane = this.splitState.panes[paneIndex];
    if (!pane.tabIds.includes(tabId)) return;
    pane.activeTabId = tabId;
    if (paneIndex === this.splitState.activePaneIndex) {
      this.activeTabId = tabId;
    }
    this.notify();
  }

  /** Move a tab into a pane (from global tab bar click or drag) */
  assignTabToPane(paneIndex: number, tabId: string) {
    if (!this.splitState || paneIndex < 0 || paneIndex >= this.splitState.panes.length) return;
    // Remove from any other pane first (but only if that pane has >1 tab)
    for (const pane of this.splitState.panes) {
      const idx = pane.tabIds.indexOf(tabId);
      if (idx !== -1) {
        if (pane.tabIds.length <= 1) return; // can't leave a pane empty
        pane.tabIds.splice(idx, 1);
        if (pane.activeTabId === tabId) pane.activeTabId = pane.tabIds[0];
        break;
      }
    }
    const targetPane = this.splitState.panes[paneIndex];
    if (!targetPane.tabIds.includes(tabId)) {
      targetPane.tabIds.push(tabId);
    }
    targetPane.activeTabId = tabId;
    this.splitState.activePaneIndex = paneIndex;
    this.activeTabId = tabId;
    this.notify();
  }

  /** Add a new pane (upgrade layout) */
  addPane(tabId: string) {
    if (!this.splitState) return;
    if (this.splitState.panes.length >= 4) return;
    this.splitState.panes.push({ tabIds: [tabId], activeTabId: tabId });
    const count = this.splitState.panes.length;
    if (count === 3) this.splitState.layout = 'left-two-right';
    else if (count === 4) this.splitState.layout = 'grid';
    this.splitState.activePaneIndex = count - 1;
    this.activeTabId = tabId;
    this.notify();
  }

  /** Remove a pane entirely when a tab is closed */
  removeTabFromSplit(tabId: string) {
    if (!this.splitState) return;
    for (let i = 0; i < this.splitState.panes.length; i++) {
      const pane = this.splitState.panes[i];
      const idx = pane.tabIds.indexOf(tabId);
      if (idx === -1) continue;
      pane.tabIds.splice(idx, 1);
      if (pane.tabIds.length === 0) {
        // Remove this pane
        this.splitState.panes.splice(i, 1);
        if (this.splitState.panes.length < 2) {
          const keepPaneTab = this.splitState.panes[0]?.activeTabId || this.tabOrder[0];
          this.splitState = null;
          if (keepPaneTab) this.activeTabId = keepPaneTab;
          this.notify();
          return;
        }
        // Downgrade layout
        const c = this.splitState.panes.length;
        if (c === 2 && (this.splitState.layout === 'grid' || this.splitState.layout === 'left-two-right')) {
          this.splitState.layout = 'left-right';
        } else if (c === 3 && this.splitState.layout === 'grid') {
          this.splitState.layout = 'left-two-right';
        }
        if (this.splitState.activePaneIndex >= c) this.splitState.activePaneIndex = c - 1;
      } else if (pane.activeTabId === tabId) {
        pane.activeTabId = pane.tabIds[0];
      }
      break;
    }
    if (this.splitState) {
      this.activeTabId = this.splitState.panes[this.splitState.activePaneIndex].activeTabId;
    }
    this.notify();
  }

  /** Find which pane contains a tab */
  findPaneForTab(tabId: string): number {
    if (!this.splitState) return -1;
    return this.splitState.panes.findIndex(p => p.tabIds.includes(tabId));
  }

  persistTabs() {
    // Quick Terminal window: don't persist — it's ephemeral
    if (new URLSearchParams(location.search).get('quick') === '1') return;
    const saved: SavedTab[] = this.tabOrder.map(id => {
      const tab = this.tabs.get(id)!;
      // Validate cwd before saving — reject garbage
      const cwd = tab.cwd;
      const validCwd = cwd && cwd.length <= 500 && !cwd.includes('"') && !cwd.includes('\n') && !cwd.includes('\x1b')
        && (cwd.startsWith('/') || /^[A-Za-z]:/.test(cwd)) ? cwd : undefined;
      return {
        id,
        name: tab.title,
        shell: tab.shell,
        noteBlocks: tab.noteBlocks.map(b => ({
          id: b.id,
          content: b.content,
          images: b.images ? [...b.images] : undefined,
        })),
        autoSend: tab.autoSend || undefined,
        cwd: validCwd,
        aiTool: tab.aiTool,
        userRenamed: tab.userRenamed || undefined,
        pastedTotal: tab.pastedTotal || undefined,
        pastedImages: tab.pastedById && tab.pastedById.size > 0
          ? Object.fromEntries(Array.from(tab.pastedById, ([m, p]) => [String(m), p]))
          : undefined,
      };
    });
    api.saveTabs(saved);
  }
}

export const appState = new AppState();
