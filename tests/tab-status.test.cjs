const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');

// Compile with the project's existing TypeScript dependency; no browser, Tauri
// runtime, additional test framework, or Node-specific TS support is required.
function loadSource(file, dependencies = {}) {
  const source = readFileSync(resolve(__dirname, '../src/components', file), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  });
  const exports = {};
  runInNewContext(outputText, {
    exports,
    require(id) {
      assert.ok(id in dependencies, `Unexpected dependency: ${id}`);
      return dependencies[id];
    },
    document: { hasFocus: () => true },
    location: { search: '?quick=1' }, // ephemeral state; never persist during tests
    URLSearchParams,
    console,
  }, { filename: file });
  return exports;
}

const status = loadSource('tab-status.ts');
function createState() {
  return loadSource('app-state.ts', {
    '../api': { api: {} },
    './tab-status': status,
  }).appState;
}

function withBackgroundTab() {
  const state = createState();
  state.addTab('task');
  state.addTab('foreground');
  return state;
}

test('a new execution replaces the previous unread red dot with green', () => {
  const state = withBackgroundTab();
  for (let turn = 0; turn < 3; turn++) {
    state.setStatus('task', 'executing');
    assert.equal(state.tabs.get('task').status, 'executing');
    state.setStatus('task', 'done-unseen');
    assert.equal(state.tabs.get('task').status, 'done-unseen');
  }
});

test('viewing a running task cannot acknowledge its future completion', () => {
  const state = withBackgroundTab();
  state.setStatus('task', 'executing');
  state.switchTab('task');
  assert.equal(state.tabs.get('task').status, 'executing');
  state.switchTab('foreground');
  state.setStatus('task', 'done-unseen');
  assert.equal(state.tabs.get('task').status, 'done-unseen');
});

test('a fast completion clears green immediately without a timestamp gate', () => {
  const state = withBackgroundTab();
  state.setStatus('task', 'executing');
  state.setStatus('task', 'done-unseen');
  assert.equal(state.tabs.get('task').status, 'done-unseen');
  state.switchTab('task');
  assert.equal(state.tabs.get('task').status, 'active');
});

test('idle prompt redraws neither invent completion nor erase an unread result', () => {
  const state = withBackgroundTab();
  state.setStatus('task', 'waiting');
  assert.equal(state.tabs.get('task').status, 'active');
  state.setStatus('task', 'executing');
  state.setStatus('task', 'done-unseen');
  state.setStatus('task', 'waiting');
  assert.equal(state.tabs.get('task').status, 'done-unseen');
  state.switchTab('task');
  state.switchTab('foreground');
  state.setStatus('task', 'waiting');
  assert.equal(state.tabs.get('task').status, 'active');
});

test('completion in the focused tab is seen and stays seen after switching away', () => {
  const state = withBackgroundTab();
  state.setStatus('foreground', 'executing');
  state.setStatus('foreground', 'done-unseen');
  assert.equal(state.tabs.get('foreground').status, 'active');
  state.switchTab('task');
  assert.equal(state.tabs.get('foreground').status, 'active');
});

test('an unfocused foreground tab shows completion until window focus returns', () => {
  const state = withBackgroundTab();
  state.setStatus('foreground', 'executing');
  state.setWindowFocus(false);
  state.setStatus('foreground', 'done-unseen');
  assert.equal(state.tabs.get('foreground').status, 'done-unseen');
  state.setWindowFocus(true);
  assert.equal(state.tabs.get('foreground').status, 'active');
});

test('returning to a running task then leaving does not consume its completion', () => {
  const state = withBackgroundTab();
  state.setWindowFocus(false);
  state.setStatus('foreground', 'executing');
  state.setWindowFocus(true);
  state.setWindowFocus(false);
  state.setStatus('foreground', 'done-unseen');
  assert.equal(state.tabs.get('foreground').status, 'done-unseen');
});

test('split panes are seen only when focused; hidden tabs retain their red dots', () => {
  const state = withBackgroundTab();
  state.addTab('hidden');
  state.enterSplit('top-bottom', ['foreground', 'task']);
  for (const id of ['task', 'foreground', 'hidden']) {
    state.setStatus(id, 'executing');
    state.setStatus(id, 'done-unseen');
  }
  assert.equal(state.tabs.get('task').status, 'active');
  assert.equal(state.tabs.get('foreground').status, 'active');
  assert.equal(state.tabs.get('hidden').status, 'done-unseen');

  state.setWindowFocus(false);
  for (const id of ['task', 'foreground']) {
    state.setStatus(id, 'executing');
    state.setStatus(id, 'done-unseen');
    assert.equal(state.tabs.get(id).status, 'done-unseen');
  }
  state.setWindowFocus(true);
  assert.equal(state.tabs.get('task').status, 'active');
  assert.equal(state.tabs.get('foreground').status, 'active');
  assert.equal(state.tabs.get('hidden').status, 'done-unseen');
  state.switchPaneTab(0, 'hidden');
  assert.equal(state.tabs.get('hidden').status, 'active');
});

test('splitting, adding a pane and closing the foreground tab acknowledge revealed results', () => {
  const state = withBackgroundTab();
  state.addTab('third');
  state.setStatus('task', 'done-unseen');
  state.enterSplit('left-right', ['foreground', 'task']);
  assert.equal(state.tabs.get('task').status, 'active');
  state.setStatus('third', 'done-unseen');
  state.addPane('third');
  assert.equal(state.tabs.get('third').status, 'active');
  state.exitSplit();
  state.setStatus('foreground', 'done-unseen');
  state.removeTab('third');
  assert.equal(state.activeTabId, 'foreground');
  assert.equal(state.tabs.get('foreground').status, 'active');
});

test('status listeners receive acknowledged values and events for closed tabs are ignored', () => {
  const state = withBackgroundTab();
  const rendered = [];
  state.subscribe(() => rendered.push(state.tabs.get('task')?.status));
  state.setStatus('task', 'executing');
  state.setStatus('task', 'done-unseen');
  state.switchTab('task');
  assert.deepEqual(rendered, ['executing', 'done-unseen', 'active']);
  state.removeTab('task');
  const count = rendered.length;
  state.setStatus('task', 'done-unseen');
  assert.equal(rendered.length, count);
  assert.equal(state.tabs.has('task'), false);
});
