const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadSource = require('./source-loader.cjs');
const { PromptInput } = loadSource('prompt-input.ts');

function editor() {
  const input = new PromptInput();
  const submitted = [];
  return { input, submitted, feed: data => input.feed(data, value => submitted.push({ ...value })) };
}

test('editing a version in the middle records the final instruction, not keystroke order', () => {
  const { input, feed, submitted } = editor();
  feed('把dev_0.1.0和dev_0.1.0都合并过来');
  feed('\x1b[D'.repeat(8)); // caret immediately before the second version’s 1
  feed('\x1b[3~2');
  feed('\x1b[F\r');
  assert.deepEqual(submitted, [{ text: '把dev_0.1.0和dev_0.2.0都合并过来', imageCount: 0 }]);
  assert.equal(input.hasContent, false);
});

test('IME commits and pasted text insert at the caret without damaging CJK or emoji', () => {
  const { input, feed, submitted } = editor();
  feed('把😀合并');
  feed('\x1bOD\x1bOD\x7f');
  input.insert('dev_0.1.0 和 dev_0.2.0 都');
  feed('\x1bOF\r');
  assert.equal(submitted[0].text, '把dev_0.1.0 和 dev_0.2.0 都合并');
});

test('Home/End, backspace and forward delete edit the caret rather than the tail', () => {
  const { feed, submitted } = editor();
  feed('abc尾部\x1b[H\x1b[C\x7fA\x1b[3~B\x1b[F!\r');
  assert.equal(submitted[0].text, 'ABc尾部!');
});

test('readline and Kitty Ctrl+K/U/W share the same cursor, preserving suffix and images', () => {
  const { input, feed, submitted } = editor();
  input.addImage();
  feed('wrong keep\x1b[1;5D\x1b[117;5u'); // Ctrl+Left, Ctrl+U
  assert.equal(input.text, 'keep');
  feed('new \x05 tail\x17\x02\x1b[107;5u\r'); // Ctrl+W, Left, Ctrl+K
  assert.deepEqual(submitted, [{ text: 'new keep', imageCount: 1 }]);
});

test('legacy Alt and Kitty Alt word movement/deletion are not appended as text', () => {
  const { feed, submitted } = editor();
  feed('one two three\x1bb\x1bdTHREE\x1b[98;3u\x1b[127;3u\r');
  assert.equal(submitted[0].text, 'one THREE');
});

test('Shift+Enter in Kitty mode inserts a newline instead of disappearing or submitting', () => {
  const { feed, submitted } = editor();
  feed('第一行\x1b[13;2u第二行\x1b[13;1:3u'); // release must not submit
  assert.equal(submitted.length, 0);
  feed('\r');
  assert.equal(submitted[0].text, '第一行\n第二行');
});

test('bracketed paste keeps embedded CRLF and control characters literal, even across chunks', () => {
  const { feed, submitted } = editor();
  feed('前后\x1b[D\x1b[20');
  feed('0~  a\r\nb\r\x03\x1b[20');
  assert.equal(submitted.length, 0);
  feed('1~\x1b[F\r');
  assert.equal(submitted[0].text, '前  a\nb\n\x03后');
});

test('multiline Home/End/Up/Down use logical lines and keep the suffix', () => {
  const { feed, submitted } = editor();
  feed('\x1b[200~\nabc\nxyz\x1b[201~');
  feed('\x1b[H\x1b[A\x1b[A开头\x1b[B\x1b[F!\r');
  assert.equal(submitted[0].text, '开头\nabc!\nxyz');
});

test('history recall replaces the draft; Down restores the draft', () => {
  const { input, feed, submitted } = editor();
  feed('first\rsecond\r未完成');
  feed('\x1b[A');
  assert.equal(input.text, 'second');
  feed('\x1b[B');
  assert.equal(input.text, '未完成');
  feed('\x03\x1b[A\x1b[H修改：\r');
  assert.equal(submitted[2].text, '修改：second');
});

test('queue submission consumes stale draft, records recall text, and session reset clears it', () => {
  const { input, feed, submitted } = editor();
  feed('stale');
  input.addImage();
  input.accept('queued task');
  feed('next\r\x1b[A\r');
  assert.deepEqual(submitted, [
    { text: 'next', imageCount: 0 },
    { text: 'next', imageCount: 0 },
  ]);
  input.reset(true);
  feed('\x1b[A\r');
  assert.equal(submitted.length, 2);
});

test('Ctrl+C clears images and text; focus events and empty Enter create no history', () => {
  const { input, feed, submitted } = editor();
  input.addImage();
  feed('discard\x03\x1b[I\x1b[O\r');
  assert.equal(submitted.length, 0);
  input.addImage();
  feed('\r');
  assert.deepEqual(submitted, [{ text: '', imageCount: 1 }]);
});

test('standalone Escape does not swallow the next IME commit', () => {
  const { feed, submitted } = editor();
  feed('\x1b');
  feed('任务\r');
  assert.equal(submitted[0].text, '任务');
});

test('leading/trailing whitespace is retained and large paste does not overflow arguments', () => {
  const { input, feed, submitted } = editor();
  const text = '  ' + 'x'.repeat(150000) + '\n  ';
  input.insert(text);
  feed('\r');
  assert.equal(submitted[0].text, text);
});
