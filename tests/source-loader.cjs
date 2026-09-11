const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');

module.exports = function loadSource(file, dependencies = {}, globals = {}) {
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
    console,
    ...globals,
  }, { filename: file });
  return exports;
};
