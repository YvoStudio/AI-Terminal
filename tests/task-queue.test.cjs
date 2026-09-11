const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadSource = require('./source-loader.cjs');

// Small DOM double: exercise the real view/state methods without launching a
// Tauri webview, PTY or xterm renderer.
class Element {
  nodeType = 1;
  children = [];
  handlers = {};
  textContent = '';
  className = '';
  parentElement = null;
  classes = new Set();
  classList = {
    add: (...names) => names.forEach(name => this.classes.add(name)),
    remove: (...names) => names.forEach(name => this.classes.delete(name)),
    contains: name => this.classes.has(name),
    toggle: (name, force) => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name); else this.classes.delete(name);
      return on;
    },
  };
  append(...children) { children.forEach(child => this.appendChild(child)); }
  appendChild(child) { this.children.push(child); child.parentElement = this; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  querySelector() { return this.children[0] || null; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  closest(selectors) {
    const names = selectors.split(',').map(s => s.trim().slice(1));
    return names.includes(this.className) ? this : this.parentElement?.closest(selectors) || null;
  }
}

function setup() {
  const document = { hasFocus: () => true, createElement: () => new Element() };
  const globals = { document, location: { search: '?quick=1' }, URLSearchParams };
  const state = loadSource('app-state.ts', {
    '../api': { api: {} }, './tab-status': loadSource('tab-status.ts'),
  }, globals).appState;
  const prompt = loadSource('prompt-input.ts');
  const copies = [];
  const { TerminalView } = loadSource('terminal-view.ts', {
    '@xterm/xterm': {}, '@xterm/addon-fit': {}, '@xterm/addon-canvas': {},
    '@xterm/addon-search': {}, '@xterm/addon-serialize': {}, '@xterm/addon-unicode11': {},
    '@tauri-apps/api/core': { convertFileSrc: path => path },
    '../api': { api: {} }, './app-state': { appState: state }, './themes': {}, '../platform': {},
    './prompt-input': prompt,
  }, {
    ...globals,
    localStorage: { setItem() {} },
    navigator: { clipboard: { writeText: text => { copies.push(text); return Promise.resolve(); } } },
  });
  function view(id) {
    state.addTab(id).aiTool = 'pi';
    const view = Object.create(TerminalView.prototype);
    Object.assign(view, {
      tabId: id, pendingPrompt: new prompt.PromptInput(),
      notepadVisible: true, taskHistoryVisible: false,
    });
    for (const field of ['notepadEl', 'notepadFab', 'notepadTitleEl', 'notepadHistoryToggle',
      'taskHistoryEl', 'currentTaskEl', 'currentTaskTextEl', 'currentTaskLabelEl', 'notepadFabCurrent']) {
      view[field] = new Element();
    }
    view.notepadHistoryToggle.append(new Element());
    return view;
  }
  return { state, view, copies };
}

test('current task, history display and history copy all use the final edited text', () => {
  const { state, view, copies } = setup();
  const terminal = view('task');
  terminal.trackPromptInput('把dev_0.1.0和dev_0.1.0都合并过来');
  terminal.trackPromptInput('\x1b[D'.repeat(8));
  terminal.trackPromptInput('\x1b[3~2\r');
  const expected = '把dev_0.1.0和dev_0.2.0都合并过来';
  assert.equal(terminal.currentTaskTextEl.textContent, expected);
  assert.equal(state.tabs.get('task').taskHistory[0].content, expected);
  assert.equal(state.isPromptDirty('task'), false);
  terminal.setTaskHistoryVisible(true);
  const entry = terminal.taskHistoryEl.children[0];
  assert.equal(entry.children[1].textContent, expected);
  entry.children[0].children[1].handlers.click({ stopPropagation() {} });
  assert.deepEqual(copies, [expected]);
});

test('host paste, Kitty newline/deletion and queue submission share a clean prompt mirror', () => {
  const { state, view } = setup();
  const terminal = view('task');
  terminal.stagePromptText('  第一行\n待改  ');
  terminal.trackPromptInput('\x1b[H\x0b'); // intercepted Cmd/Ctrl+Delete sends Ctrl+K
  terminal.stagePromptText('第二行');
  terminal.trackPromptInput('\x1b[13;2u尾行\r');
  assert.equal(state.tabs.get('task').taskHistory[0].content, '  第一行\n第二行\n尾行');
  terminal.stagePromptText('stale draft');
  terminal.setCurrentTask('queue task');
  terminal.trackPromptInput('next\r');
  assert.equal(state.tabs.get('task').taskHistory[0].content, 'next');
  assert.equal(state.tabs.get('task').taskHistory.length, 3);
});

test('history/current task preserve original whitespace and history completion identity', () => {
  const { state, view } = setup();
  const terminal = view('task');
  const text = '  首行\n\n末行  \n';
  terminal.setCurrentTask(text);
  terminal.completeCurrentTask();
  assert.equal(terminal.currentTaskTextEl.textContent, text);
  const entry = state.tabs.get('task').taskHistory[0];
  assert.equal(entry.content, text);
  assert.ok(entry.completedAt >= entry.submittedAt);
});

test('two outside clicks return history to queue, then close; inside/FAB clicks do neither', () => {
  const { view } = setup();
  const terminal = view('task');
  terminal.setTaskHistoryVisible(true);
  const child = new Element();
  terminal.notepadEl.append(child);
  terminal.handleNotepadOutsideClick(child);
  terminal.handleNotepadOutsideClick(terminal.notepadFab);
  assert.equal(terminal.taskHistoryVisible, true);
  const outside = new Element();
  terminal.handleNotepadOutsideClick(outside);
  assert.equal(terminal.taskHistoryVisible, false);
  assert.equal(terminal.isNotepadVisible(), true);
  terminal.handleNotepadOutsideClick(outside);
  assert.equal(terminal.isNotepadVisible(), false);
  terminal.handleNotepadOutsideClick(outside);
  assert.equal(terminal.isNotepadVisible(), false);
});

test('explicit close from history reopens in queue mode', () => {
  const { view } = setup();
  const terminal = view('task');
  terminal.setTaskHistoryVisible(true);
  terminal.setNotepadVisible(false);
  terminal.setNotepadVisible(true);
  assert.equal(terminal.isNotepadVisible(), true);
  assert.equal(terminal.taskHistoryVisible, false);
  assert.equal(terminal.notepadTitleEl.textContent, '任务队列');
});

test('capture dismissal survives stopped bubbling, ignores portals/right-click, and handles split panes once', () => {
  const { view } = setup();
  const first = view('first');
  const second = view('second');
  first.setTaskHistoryVisible(true);
  second.setTaskHistoryVisible(true);
  const { registerNotepadDismiss } = loadSource('notepad-dismiss.ts');
  let listener;
  const root = {
    addEventListener(type, handler, capture) {
      assert.equal(type, 'mousedown');
      assert.equal(capture, true, 'xterm can stop bubbling; listener must capture');
      listener = handler;
    },
    removeEventListener(type, handler, capture) {
      assert.equal(type, 'mousedown'); assert.equal(handler, listener); assert.equal(capture, true);
      listener = null;
    },
  };
  const dispose = registerNotepadDismiss(() => [first, second], root);
  const click = (target, button = 0) => listener({ target, button, cancelBubble: true });
  const portal = new Element();
  const portalChild = new Element();
  portal.append(portalChild);
  for (const name of ['image-preview-overlay', 'skill-menu']) {
    portal.className = name;
    click(portalChild);
    assert.equal(first.taskHistoryVisible, true);
    assert.equal(second.taskHistoryVisible, true);
  }
  click(new Element(), 2);
  assert.equal(first.taskHistoryVisible, true);
  click(first.notepadEl);
  assert.equal(first.taskHistoryVisible, true);
  assert.equal(second.taskHistoryVisible, false);
  assert.equal(second.isNotepadVisible(), true);
  click(new Element());
  assert.equal(first.taskHistoryVisible, false);
  assert.equal(first.isNotepadVisible(), true);
  assert.equal(second.isNotepadVisible(), false);
  click(new Element());
  assert.equal(first.isNotepadVisible(), false);
  dispose();
  assert.equal(listener, null);
});
