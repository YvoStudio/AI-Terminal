const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadSource = require('./source-loader.cjs');
const { PiTaskEvents } = loadSource('pi-task-events.ts', {}, { atob, TextDecoder });

function frame(event, sequence, extra = {}, end = '\x1b\\') {
  const payload = { version: 1, session: 'session-1', event, sequence, ...extra };
  return '\x1b]633;AiTerminalTask;' + Buffer.from(JSON.stringify(payload)).toString('base64') + end;
}

test('identical recalled prompts are distinct submissions, duplicate transport frames are not', () => {
  const stream = new PiTaskEvents();
  const tasks = [];
  const task = { text: '把 dev_0.1.0 和 dev_0.2.0 都合并过来', imageCount: 0 };
  const submit = value => tasks.push({ ...value });
  stream.feed(frame('ready', 0), submit);
  stream.feed(frame('input', 1, task), submit);
  stream.feed(frame('input', 1, task), submit);
  stream.feed(frame('input', 2, task), submit);
  assert.deepEqual(tasks, [task, task]);
});

test('all PTY split positions preserve UTF-8/multiline input and never create phantom tasks', () => {
  const task = { text: '  旧任务😀\n再次执行\x07\x1b[31m  ', imageCount: 2 };
  const output = 'normal output\n' + frame('ready', 0) + frame('input', 1, task, '\x07') + '\nmore output';
  for (let at = 0; at <= output.length; at++) {
    const stream = new PiTaskEvents();
    const tasks = [];
    const submit = value => tasks.push({ ...value });
    stream.feed(output.slice(0, at), submit);
    stream.feed(output.slice(at), submit);
    assert.deepEqual(tasks, [task], `split at ${at}`);
  }
  const stream = new PiTaskEvents();
  const tasks = [];
  for (const ch of output) stream.feed(ch, value => tasks.push({ ...value }));
  assert.deepEqual(tasks, [task]);
});

test('readiness/shutdown/session identity gates live events and reset allows a new Pi runtime', () => {
  const stream = new PiTaskEvents();
  const tasks = [];
  const submit = value => tasks.push({ ...value });
  const task = { text: 'again', imageCount: 0 };
  stream.feed(frame('input', 1, task), submit);
  assert.equal(stream.active, false);
  assert.equal(tasks.length, 0);
  stream.feed(frame('ready', 0) + frame('input', 1, task) + frame('stop', 2), submit);
  assert.equal(stream.active, false);
  stream.feed(frame('ready', 0) + frame('input', 3, task), submit); // old runtime can't reenable itself
  assert.equal(tasks.length, 1);
  stream.feed(frame('ready', 0, { session: 'session-2' }), submit);
  stream.feed(frame('input', 4, task), submit); // previous runtime
  stream.feed(frame('input', 1, { ...task, session: 'session-2' }), submit);
  assert.equal(tasks.length, 2);
  stream.reset();
  assert.equal(stream.active, false);
});

test('malformed, empty and oversized protocol data is ignored without poisoning the next event', () => {
  const stream = new PiTaskEvents();
  const tasks = [];
  const submit = value => tasks.push({ ...value });
  stream.feed(frame('ready', 0), submit);
  stream.feed('\x1b]633;AiTerminalTask;not-base64\x07', submit);
  stream.feed(frame('input', 1, { text: 123, imageCount: 0 }), submit);
  stream.feed(frame('input', 1, { text: 'bad', imageCount: -1 }), submit);
  stream.feed(frame('input', 1, { version: 2, text: 'bad', imageCount: 0 }), submit);
  stream.feed(frame('input', 1, { text: '   ', imageCount: 0 }), submit);
  stream.feed('\x1b]633;AiTerminalTask;' + 'a'.repeat(1024 * 1024 + 1), submit);
  stream.feed('\x1b]633;AiTerminalTask;truncated', submit);
  stream.feed(frame('input', 2, { text: 'valid', imageCount: 0 }), submit);
  assert.deepEqual(tasks, [{ text: 'valid', imageCount: 0 }]);
});

function extension(mode = 'tui', enabled = true) {
  const handlers = new Map();
  const output = [];
  const { default: install } = loadSource('../../src-tauri/resources/pi-task-duration.ts', {
    'node:crypto': { randomUUID: () => 'test-runtime' },
    '@earendil-works/pi-tui': {},
  }, {
    Buffer,
    process: { env: { AI_TERMINAL_TASK_EVENTS: enabled ? '1' : undefined }, stdout: { write: value => output.push(value) } },
  });
  install({ on: (event, handler) => handlers.set(event, handler), registerEntryRenderer() {} });
  const ctx = { mode, ui: { setFooter() {}, setWorkingMessage() {} } };
  return { output, emit: (name, event = {}) => handlers.get(name)(event, ctx) };
}

test('bundled extension reports actual repeated interactive input without transforming it', async () => {
  const ext = extension();
  const stream = new PiTaskEvents();
  const tasks = [];
  await ext.emit('session_start', { reason: 'resume' });
  assert.equal(ext.output.length, 1, 'resume sends readiness, not old transcript tasks');
  const input = { text: '/skill:review 保留原始输入', source: 'interactive', images: [{ type: 'image' }] };
  assert.equal((await ext.emit('input', input)).action, 'continue');
  await ext.emit('input', { ...input, streamingBehavior: 'steer' });
  await ext.emit('input', { ...input, streamingBehavior: 'followUp' });
  await ext.emit('input', { ...input, source: 'extension' });
  await ext.emit('input', { ...input, source: 'rpc' });
  await ext.emit('agent_settled'); // no active timer: cannot report another input
  await ext.emit('session_shutdown');
  for (const output of ext.output) stream.feed(output, task => tasks.push({ ...task }));
  assert.deepEqual(tasks, Array(3).fill({ text: input.text, imageCount: 1 }));
  assert.equal(stream.active, false);
});

test('print/JSON/RPC and other terminals never receive task control bytes', async () => {
  for (const [mode, enabled] of [['print', true], ['json', true], ['rpc', true], ['tui', false]]) {
    const ext = extension(mode, enabled);
    await ext.emit('session_start');
    await ext.emit('input', { text: 'sensitive task', source: 'interactive' });
    await ext.emit('session_shutdown');
    assert.deepEqual(ext.output, [], `${mode}, enabled=${enabled}`);
  }
});
