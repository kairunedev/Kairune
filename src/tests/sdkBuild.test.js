// The SDK ships a COMMITTED build. `sdk/package.json` points `main`/`module`/
// `types` at `dist/`, and `dist/` is tracked in git — so what consumers install
// is the build output, not `src/index.ts`. Nothing rebuilt it automatically.
//
// That gap shipped a real bug: commit d078268 added `if (opts.sign === true)`
// to `checkCounterparty` in the source, but `dist/` was left at its 2026-09-03
// build. For five days `checkCounterparty(ref, { sign: true })` silently
// dropped the flag, so every SDK consumer asking for a signed verdict got an
// unsigned one back. `npm run test:sdk` passed the whole time, because the
// suite never called that method and imports `dist/` anyway — a stale build
// tests itself as consistent.
//
// These tests make the build a checked artifact instead of a trusted one. They
// are deliberately STATIC: no tsup run, no network, so they work in CI without
// adding a build step. They compare the public surface of the source against
// the public surface of the committed output, which is exactly the invariant
// that broke.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SDK = path.join(__dirname, '..', '..', 'sdk');
const src = fs.readFileSync(path.join(SDK, 'src', 'index.ts'), 'utf8');
const distCjs = fs.readFileSync(path.join(SDK, 'dist', 'index.js'), 'utf8');
const distEsm = fs.readFileSync(path.join(SDK, 'dist', 'index.mjs'), 'utf8');
const distDts = fs.readFileSync(path.join(SDK, 'dist', 'index.d.ts'), 'utf8');

// Public methods on the Kairune class. Two-space indent + `async name(` is how
// every one is declared. `constructor` is not part of the callable surface, and
// control-flow keywords at the same indent match the same shape — a bare `for (`
// inside a top-level helper made this report a missing method named "for".
const NOT_METHODS = new Set([
  'constructor', 'for', 'if', 'while', 'switch', 'catch', 'return', 'do', 'function',
]);

function sourceMethods() {
  const names = new Set();
  for (const line of src.split('\n')) {
    const m = /^ {2}(?:async )?([a-zA-Z][A-Za-z0-9_]*)\s*\(/.exec(line);
    if (m && !NOT_METHODS.has(m[1])) names.add(m[1]);
  }
  return names;
}

function sourceExportedTypes() {
  return new Set(
    [...src.matchAll(/^export (?:interface|type) ([A-Za-z0-9_]+)/gm)].map((m) => m[1])
  );
}

test('every method in sdk/src is present in the committed CJS build', () => {
  const missing = [...sourceMethods()].filter((n) => !distCjs.includes(n + '('));
  assert.deepStrictEqual(
    missing,
    [],
    'sdk/dist is stale — run `npm run build` in sdk/ and commit the output. Missing: ' +
      missing.join(', ')
  );
});

test('every method in sdk/src is present in the committed ESM build', () => {
  const missing = [...sourceMethods()].filter((n) => !distEsm.includes(n + '('));
  assert.deepStrictEqual(missing, [], 'Missing from dist/index.mjs: ' + missing.join(', '));
});

test('every exported type in sdk/src is declared in the committed .d.ts', () => {
  const missing = [...sourceExportedTypes()].filter(
    (t) => !new RegExp(`\\b(?:interface|type) ${t}\\b`).test(distDts)
  );
  assert.deepStrictEqual(
    missing,
    [],
    'sdk/dist type declarations are stale. Missing: ' + missing.join(', ')
  );
});

test('every exported type in sdk/src appears in the .d.ts export list', () => {
  // tsup emits one trailing `export { ... }`. A type declared but not re-exported
  // is invisible to consumers, which is the same failure with a different shape.
  const list = /export \{([^}]*)\};?\s*$/m.exec(distDts);
  assert.ok(list, 'could not find the export list in dist/index.d.ts');
  const missing = [...sourceExportedTypes()].filter(
    (t) => !new RegExp(`\\b${t}\\b`).test(list[1])
  );
  assert.deepStrictEqual(missing, [], 'Declared but not exported: ' + missing.join(', '));
});

test('the signed-verdict opt-in survives the build', () => {
  // The specific line that went missing. Kept as its own named test so a
  // regression reads as "the sign flag is gone" rather than a generic diff.
  assert.match(
    src,
    /opts\.sign === true/,
    'source no longer forwards opts.sign — if this moved, update this test'
  );
  for (const [label, out] of [['CJS', distCjs], ['ESM', distEsm]]) {
    assert.match(
      out,
      /sign === true/,
      `${label} build does not forward the sign flag; checkCounterparty({sign:true}) would silently return an unsigned verdict`
    );
  }
});

// Deliberately NOT an mtime comparison. A `dist newer than src` check looks
// like the obvious staleness signal, but it is flaky: `git clone` writes files
// in path order, so `sdk/dist/*` lands before `sdk/src/index.ts` and the build
// appears ~9ms older than its own source on every fresh checkout (measured).
// CI would go red on a correct build. Content equivalence is the real invariant.

test('the request paths reachable from src all survive the build', () => {
  // Catches a route added to the source and never rebuilt, which is invisible
  // to the method-name checks when the method itself already existed.
  const paths = new Set(
    [...src.matchAll(/'(\/[a-z0-9][a-z0-9/_-]*)'/g)].map((m) => m[1])
  );
  const missing = [...paths].filter((p) => !distCjs.includes(p) || !distEsm.includes(p));
  assert.deepStrictEqual(
    missing,
    [],
    'sdk/dist does not contain every endpoint path from src — rebuild it. Missing: ' +
      missing.join(', ')
  );
});

test('package.json entry points refer to files that exist', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SDK, 'package.json'), 'utf8'));
  for (const field of ['main', 'module', 'types']) {
    assert.ok(pkg[field], `sdk/package.json is missing "${field}"`);
    assert.ok(
      fs.existsSync(path.join(SDK, pkg[field])),
      `sdk/package.json "${field}" points at a missing file: ${pkg[field]}`
    );
  }
  // `files` gates what npm publish uploads. If dist were dropped from it the
  // package would install with no code at all.
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.includes('dist'),
    'sdk/package.json "files" must include dist or the published package ships no build'
  );
});

test('sdk/package.json exposes a test script', () => {
  // `npm test` inside sdk/ used to fail with "Missing script: test", which
  // reads like a broken suite when the suite is fine.
  const pkg = JSON.parse(fs.readFileSync(path.join(SDK, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts && pkg.scripts.test, 'sdk/package.json has no test script');
  assert.match(pkg.scripts.test, /test\.js/);
});
