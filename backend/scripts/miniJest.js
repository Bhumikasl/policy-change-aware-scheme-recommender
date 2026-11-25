#!/usr/bin/env node
/**
 * miniJest — a very small stand-in test runner.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * This project's real test runner is Jest, declared in package.json and run
 * with `npm test`. This file is NOT Jest and does not replace it.
 *
 * It exists because the development sandbox used to write parts of this
 * project has no access to the npm registry, so `npm install` cannot run and
 * Jest cannot be executed there. Without something like this, the .test.js
 * files could only be syntax-checked, never run — and a test file that has
 * never executed is not evidence of anything.
 *
 * miniJest implements the subset of the Jest API these tests actually use:
 *
 *   describe / it / test / .each / .only / .skip
 *   beforeAll / beforeEach / afterAll / afterEach
 *   jest.fn (incl. mockReturnThis) / jest.mock (incl. automock w/ no factory,
 *       falling back to {} if the real module can't load in this sandbox)
 *   jest.clearAllMocks / jest.resetAllMocks / jest.spyOn / jest.requireActual
 *   setupFiles (re-read from package.json's "jest.setupFiles" and re-run
 *       before every test file, matching real Jest's per-file environment)
 *   expect(...).toBe .toEqual .toContain .toMatch .toHaveProperty
 *              .toBeGreaterThan .toBeGreaterThanOrEqual .toBeLessThan
 *              .toBeLessThanOrEqual .toBeCloseTo .toBeNull .toBeUndefined
 *              .toBeDefined .toBeTruthy .toBeFalsy .toThrow
 *              .toHaveBeenCalled .toHaveBeenCalledTimes .toHaveBeenCalledWith
 *              .not.<any of the above>
 *              .resolves / .rejects
 *
 * A suite whose dependencies cannot be resolved in the sandbox (supertest,
 * express) is reported as SKIPPED with the reason. It is never counted as
 * passing. Anything this runner cannot express is a reason to run real Jest,
 * not a reason to trust this output.
 *
 * Usage:
 *   node scripts/miniJest.js                 # every tests/*.test.js
 *   node scripts/miniJest.js policyImpact    # only matching filenames
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const assert = require("assert");

// ---------------------------------------------------------------------------
// setupFiles — read the same `jest.setupFiles` list from package.json that
// real Jest uses, so both runners apply identical environment isolation
// (see jest.setup.js for why this exists: it prevents tests from making
// live LLM/API calls or touching a real database/SMTP server).
// Real Jest re-runs setupFiles in a fresh environment per test file; this
// runner mirrors that by re-requiring the file (via a cleared cache entry)
// before every test file, which is safe here because jest.setup.js only
// mutates process.env and is idempotent.
// ---------------------------------------------------------------------------
const pkgPath = path.join(__dirname, "..", "package.json");
let setupFilePaths = [];
try {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const list = (pkg.jest && pkg.jest.setupFiles) || [];
  setupFilePaths = list.map((p) =>
    path.resolve(path.join(__dirname, ".."), p.replace(/^<rootDir>\/?/, ""))
  );
} catch {
  /* no package.json / no jest config — nothing to run */
}
function runSetupFiles() {
  for (const p of setupFilePaths) {
    if (!fs.existsSync(p)) continue;
    delete require.cache[p];
    require(p);
  }
}

// ---------------------------------------------------------------------------
// Module mocking (jest.mock)
// ---------------------------------------------------------------------------
const mockRegistry = new Map(); // resolved path -> factory result
const origLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (parent) {
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      resolved = null;
    }
    if (resolved && mockRegistry.has(resolved)) return mockRegistry.get(resolved);
  }
  return origLoad.apply(this, arguments);
};

// ---------------------------------------------------------------------------
// automock — used by `jest.mock(path)` with NO factory. Real Jest loads the
// actual module, walks its shape, and replaces every function it finds with
// a jest.fn() (preserving structure so `Model.find` etc. still exist and are
// assertable/stubbable), while leaving non-function values as-is. This is a
// deliberately shallow re-implementation of that: enough for the Mongoose
// model shape (static methods + instance/prototype methods + nested statics)
// that tests/api.test.js relies on.
// ---------------------------------------------------------------------------
function automock(mod, seen = new Map()) {
  if (typeof mod === "function") {
    if (seen.has(mod)) return seen.get(mod);
    const mocked = fn();
    seen.set(mod, mocked);
    for (const key of Object.getOwnPropertyNames(mod)) {
      if (["length", "name", "arguments", "caller", "prototype"].includes(key)) continue;
      const desc = Object.getOwnPropertyDescriptor(mod, key);
      if (!desc || typeof desc.get === "function") continue; // skip accessors
      mocked[key] = typeof mod[key] === "function" ? automock(mod[key], seen) : mod[key];
    }
    if (mod.prototype) {
      const protoMock = {};
      for (const key of Object.getOwnPropertyNames(mod.prototype)) {
        if (key === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(mod.prototype, key);
        if (!desc || typeof desc.get === "function") continue;
        protoMock[key] = typeof mod.prototype[key] === "function" ? fn() : mod.prototype[key];
      }
      mocked.prototype = protoMock;
    }
    return mocked;
  }
  if (mod && typeof mod === "object") {
    if (seen.has(mod)) return seen.get(mod);
    const out = Array.isArray(mod) ? [] : {};
    seen.set(mod, out);
    for (const key of Object.keys(mod)) {
      out[key] = typeof mod[key] === "function" ? automock(mod[key], seen) : automock(mod[key], seen);
    }
    return out;
  }
  return mod; // primitives pass through unchanged
}

// ---------------------------------------------------------------------------
// jest.fn
// ---------------------------------------------------------------------------
const allMockFns = [];
function fn(impl) {
  const f = function mockFn(...args) {
    f.mock.calls.push(args);
    const once = f._onceImpls.shift();
    const use = once || f._impl;
    if (!use) return undefined;
    const out = use.apply(this, args);
    f.mock.results.push(out);
    return out;
  };
  f.mock = { calls: [], results: [] };
  f._impl = impl || null;
  f._onceImpls = [];
  f.mockReturnValue = (v) => ((f._impl = () => v), f);
  f.mockReturnValueOnce = (v) => (f._onceImpls.push(() => v), f);
  f.mockResolvedValue = (v) => ((f._impl = () => Promise.resolve(v)), f);
  f.mockResolvedValueOnce = (v) => (f._onceImpls.push(() => Promise.resolve(v)), f);
  f.mockRejectedValue = (v) => ((f._impl = () => Promise.reject(v)), f);
  f.mockRejectedValueOnce = (v) => (f._onceImpls.push(() => Promise.reject(v)), f);
  f.mockImplementation = (i) => ((f._impl = i), f);
  f.mockImplementationOnce = (i) => (f._onceImpls.push(i), f);
  f.mockReturnThis = () => ((f._impl = function () { return this; }), f);
  f.mockClear = () => ((f.mock.calls = []), (f.mock.results = []), f);
  f.mockReset = () => (f.mockClear(), (f._impl = null), (f._onceImpls = []), f);
  f._isMockFunction = true;
  allMockFns.push(f);
  return f;
}

// ---------------------------------------------------------------------------
// expect
// ---------------------------------------------------------------------------
const fmt = (v) => {
  if (typeof v === "function") return v._isMockFunction ? "[MockFunction]" : "[Function]";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

/**
 * Asymmetric matchers (expect.arrayContaining and friends). `expected` may
 * contain these at any depth, so equality has to walk the structure itself
 * rather than delegating wholesale to assert.deepStrictEqual.
 */
const ASYM = Symbol.for("miniJest.asymmetric");
const asym = (label, test) => ({ [ASYM]: true, label, test });

function deepEqual(a, b) {
  // b is the *expected* side, which is where asymmetric matchers appear.
  if (b && typeof b === "object" && b[ASYM]) return !!b.test(a);

  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    // Fall back for boxed primitives, dates, etc.
    try {
      assert.deepStrictEqual(a, b);
      return true;
    } catch {
      return false;
    }
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a instanceof Date || b instanceof Date) return String(a) === String(b);

  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return kb.every((k) => Object.prototype.hasOwnProperty.call(a, k) && deepEqual(a[k], b[k]));
}

function makeExpect(actual, negated = false) {
  const ok = (cond, msg) => {
    if (negated ? cond : !cond) {
      throw new Error(negated ? `expected NOT ${msg}` : `expected ${msg}`);
    }
  };
  const api = {
    toBe: (e) => ok(Object.is(actual, e), `${fmt(actual)} to be ${fmt(e)}`),
    toEqual: (e) => ok(deepEqual(actual, e), `${fmt(actual)} to equal ${fmt(e)}`),
    toStrictEqual: (e) => ok(deepEqual(actual, e), `${fmt(actual)} to strictly equal ${fmt(e)}`),
    toBeNull: () => ok(actual === null, `${fmt(actual)} to be null`),
    toBeUndefined: () => ok(actual === undefined, `${fmt(actual)} to be undefined`),
    toBeDefined: () => ok(actual !== undefined, `${fmt(actual)} to be defined`),
    toBeTruthy: () => ok(!!actual, `${fmt(actual)} to be truthy`),
    toBeFalsy: () => ok(!actual, `${fmt(actual)} to be falsy`),
    toBeGreaterThan: (e) => ok(actual > e, `${fmt(actual)} > ${fmt(e)}`),
    toBeGreaterThanOrEqual: (e) => ok(actual >= e, `${fmt(actual)} >= ${fmt(e)}`),
    toBeLessThan: (e) => ok(actual < e, `${fmt(actual)} < ${fmt(e)}`),
    toBeLessThanOrEqual: (e) => ok(actual <= e, `${fmt(actual)} <= ${fmt(e)}`),
    toBeCloseTo: (e, digits = 2) =>
      ok(Math.abs(actual - e) < Math.pow(10, -digits) / 2, `${fmt(actual)} close to ${fmt(e)}`),
    toContain: (e) => {
      const has =
        typeof actual === "string"
          ? actual.includes(e)
          : Array.isArray(actual)
          ? actual.some((x) => Object.is(x, e) || deepEqual(x, e))
          : false;
      ok(has, `${fmt(actual)} to contain ${fmt(e)}`);
    },
    toMatch: (re) =>
      ok(
        re instanceof RegExp ? re.test(String(actual)) : String(actual).includes(re),
        `${fmt(actual)} to match ${re}`
      ),
    toHaveLength: (n) => ok(actual && actual.length === n, `${fmt(actual)} to have length ${n}`),
    toContainEqual: (e) =>
      ok(
        Array.isArray(actual) && actual.some((x) => deepEqual(x, e)),
        `${fmt(actual)} to contain an item equal to ${fmt(e)}`
      ),
    toHaveProperty: (p, v) => {
      const val = String(p)
        .split(".")
        .reduce((o, k) => (o == null ? undefined : o[k]), actual);
      const has = val !== undefined;
      ok(arguments.length > 1 && v !== undefined ? has && deepEqual(val, v) : has,
        `${fmt(actual)} to have property ${p}`);
    },
    toThrow: (expected) => {
      let threw = false;
      let err = null;
      try {
        actual();
      } catch (e) {
        threw = true;
        err = e;
      }
      if (!expected) return ok(threw, `function to throw`);
      const msg = err ? String(err.message || err) : "";
      const matched =
        threw &&
        (expected instanceof RegExp ? expected.test(msg) : msg.includes(String(expected)));
      ok(matched, `function to throw matching ${expected}`);
    },
    toHaveBeenCalled: () => ok(actual.mock.calls.length > 0, `mock to have been called`),
    toHaveBeenCalledTimes: (n) =>
      ok(actual.mock.calls.length === n,
        `mock to have been called ${n} times (was ${actual.mock.calls.length})`),
    toHaveBeenCalledWith: (...args) =>
      ok(actual.mock.calls.some((c) => deepEqual(c, args)),
        `mock to have been called with ${fmt(args)}`),
  };
  if (!negated) {
    api.not = makeExpect(actual, true);
    api.resolves = new Proxy({}, {
      get: (_t, k) => async (...a) => makeExpect(await actual)[k](...a),
    });
    api.rejects = new Proxy({}, {
      get: (_t, k) => async (...a) => {
        let err;
        try {
          await actual;
        } catch (e) {
          err = e;
        }
        if (err === undefined) throw new Error("expected promise to reject, but it resolved");
        // `.rejects.toThrow(...)` asserts on the rejection reason, but toThrow
        // expects something it can CALL. Re-wrap so the matcher sees a thrower
        // rather than trying to invoke the Error object.
        if (k === "toThrow") {
          return makeExpect(() => {
            throw err;
          }).toThrow(...a);
        }
        return makeExpect(err)[k](...a);
      },
    });
  }
  return api;
}

// ---------------------------------------------------------------------------
// Suite tree
// ---------------------------------------------------------------------------
let root;
let current;
let hasOnly = false;

function makeNode(name, parent) {
  return { name, parent, children: [], tests: [], before: [], beforeEach: [], after: [], afterEach: [] };
}

function describe(name, body) {
  const node = makeNode(name, current);
  current.children.push(node);
  const prev = current;
  current = node;
  body();
  current = prev;
}
describe.skip = (name) => {};
describe.only = describe;

function addTest(name, body, { only = false, skip = false } = {}) {
  if (only) hasOnly = true;
  current.tests.push({ name, body, only, skip, suite: current });
}
const it = (n, b) => addTest(n, b);
it.skip = (n) => addTest(n, null, { skip: true });
it.only = (n, b) => addTest(n, b, { only: true });

// `.each` — table may be an array of arrays (spread as args) or of values.
const eachFor = (register) => (table) => (name, body) => {
  table.forEach((row, i) => {
    const args = Array.isArray(row) ? row : [row];
    let label = name;
    let ai = 0;
    label = label.replace(/%[sdifjop#]/g, () => {
      const v = args[ai++];
      return typeof v === "string" ? v : fmt(v);
    });
    if (label === name) label = `${name} [${i}]`;
    register(label, () => body(...args));
  });
};
it.each = eachFor((n, b) => addTest(n, b));
const test = it;
test.each = it.each;
test.skip = it.skip;
test.only = it.only;

const beforeAll = (f) => current.before.push(f);
const beforeEach = (f) => current.beforeEach.push(f);
const afterAll = (f) => current.after.push(f);
const afterEach = (f) => current.afterEach.push(f);

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
const results = { pass: 0, fail: 0, skip: 0, failures: [] };

function chainOf(node) {
  const chain = [];
  for (let n = node; n; n = n.parent) chain.unshift(n);
  return chain;
}

async function runNode(node, trail = []) {
  const label = [...trail, node.name].filter(Boolean);
  for (const f of node.before) await f();

  for (const t of node.tests) {
    const full = [...label, t.name].join(" › ");
    if (t.skip || (hasOnly && !t.only)) {
      results.skip++;
      continue;
    }
    const chain = chainOf(t.suite);
    try {
      for (const n of chain) for (const f of n.beforeEach) await f();
      await t.body();
      for (const n of [...chain].reverse()) for (const f of n.afterEach) await f();
      results.pass++;
    } catch (err) {
      results.fail++;
      results.failures.push({ name: full, message: err && err.message ? err.message : String(err) });
      try {
        for (const n of [...chain].reverse()) for (const f of n.afterEach) await f();
      } catch {
        /* an afterEach failing during cleanup must not mask the real failure */
      }
    }
  }

  for (const child of node.children) await runNode(child, label);
  for (const f of node.after) await f();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  const filter = process.argv[2] || "";
  const testsDir = path.join(__dirname, "..", "tests");
  const files = fs
    .readdirSync(testsDir)
    .filter((f) => f.endsWith(".test.js"))
    .filter((f) => !filter || f.includes(filter))
    .sort();

  const skippedFiles = [];
  const t0 = Date.now();

  for (const file of files) {
    const full = path.join(testsDir, file);

    root = makeNode(null, null);
    current = root;
    hasOnly = false;
    mockRegistry.clear();
    allMockFns.length = 0;

    // Fresh module registry per file, so jest.mock in one file cannot leak
    // into the next — this is what Jest's module isolation gives you.
    for (const k of Object.keys(require.cache)) {
      if (k.includes(`${path.sep}src${path.sep}`) || k.includes(`${path.sep}tests${path.sep}`)) {
        delete require.cache[k];
      }
    }

    runSetupFiles();

    const g = global;
    g.describe = describe;
    g.it = it;
    g.test = test;
    g.beforeAll = beforeAll;
    g.beforeEach = beforeEach;
    g.afterAll = afterAll;
    g.afterEach = afterEach;
    g.expect = (a) => makeExpect(a);
    g.expect.any = (ctor) =>
      asym(`any(${ctor && ctor.name})`, (v) =>
        ctor === String ? typeof v === "string"
          : ctor === Number ? typeof v === "number"
          : ctor === Boolean ? typeof v === "boolean"
          : ctor === Object ? v !== null && typeof v === "object"
          : ctor === Function ? typeof v === "function"
          : v instanceof ctor
      );
    g.expect.anything = () => asym("anything", (v) => v !== null && v !== undefined);
    g.expect.arrayContaining = (subset) =>
      asym("arrayContaining", (v) =>
        Array.isArray(v) && subset.every((s) => v.some((x) => deepEqual(x, s)))
      );
    g.expect.objectContaining = (subset) =>
      asym("objectContaining", (v) =>
        v !== null &&
        typeof v === "object" &&
        Object.entries(subset).every(([k, val]) => deepEqual(v[k], val))
      );
    g.expect.stringContaining = (s) =>
      asym("stringContaining", (v) => typeof v === "string" && v.includes(s));
    g.expect.stringMatching = (re) =>
      asym("stringMatching", (v) => typeof v === "string" && new RegExp(re).test(v));
    g.jest = {
      fn,
      mock(request, factory) {
        // Resolve relative to the test file, then register the factory result.
        const parentStub = {
          id: full,
          filename: full,
          paths: Module._nodeModulePaths(path.dirname(full)),
        };
        const resolved = Module._resolveFilename(request, parentStub);
        if (factory) {
          mockRegistry.set(resolved, factory());
          return;
        }
        // jest.mock(path) with NO factory: real Jest automocks by loading
        // the real module and replacing its functions with jest.fn()s. Do
        // the same here; if the real module itself can't be loaded in this
        // sandbox (e.g. it needs an uninstalled package like mongoose), fall
        // back to an empty object rather than letting that failure surface
        // as a misleading error about the *mocked* module.
        try {
          const real = origLoad(resolved, parentStub, false);
          mockRegistry.set(resolved, automock(real));
        } catch {
          mockRegistry.set(resolved, {});
        }
      },
      /**
       * jest.requireActual — load a module BYPASSING jest.mock.
       *
       * Needed by the Phase M boundary test, which patches the real Mongoose
       * SchemeChunk to prove nothing reaches it. Implemented by lifting the
       * mock registration for the duration of the load and putting it back
       * afterwards, so the mock still applies to every other require.
       */
      requireActual(request) {
        const parentStub = {
          id: full,
          filename: full,
          paths: Module._nodeModulePaths(path.dirname(full)),
        };
        const resolved = Module._resolveFilename(request, parentStub);
        const had = mockRegistry.has(resolved);
        const saved = mockRegistry.get(resolved);
        if (had) mockRegistry.delete(resolved);
        try {
          return origLoad(resolved, parentStub, false);
        } finally {
          if (had) mockRegistry.set(resolved, saved);
        }
      },
      clearAllMocks: () => allMockFns.forEach((f) => f.mockClear()),
      resetAllMocks: () => allMockFns.forEach((f) => f.mockReset()),
      spyOn: (obj, key) => {
        const orig = obj[key];
        const m = fn(orig && orig.bind ? orig.bind(obj) : orig);
        m.mockRestore = () => (obj[key] = orig);
        obj[key] = m;
        return m;
      },
      setTimeout: () => {},
    };

    const before = { pass: results.pass, fail: results.fail, skip: results.skip };
    try {
      require(full);
      await runNode(root);
    } catch (err) {
      const msg = String((err && err.message) || err);
      // A missing third-party module means the sandbox cannot run this suite.
      // Report it as skipped with the reason — never as passing.
      if (err && err.code === "MODULE_NOT_FOUND") {
        skippedFiles.push({ file, reason: msg.split("\n")[0] });
        continue;
      }
      results.fail++;
      results.failures.push({ name: `${file} (load)`, message: msg });
    }
    const d = {
      pass: results.pass - before.pass,
      fail: results.fail - before.fail,
      skip: results.skip - before.skip,
    };
    console.log(
      `${d.fail ? "FAIL" : "PASS"}  ${file.padEnd(34)} ` +
        `${d.pass} passed${d.fail ? `, ${d.fail} failed` : ""}${d.skip ? `, ${d.skip} skipped` : ""}`
    );
  }

  for (const s of skippedFiles) {
    console.log(`SKIP  ${s.file.padEnd(34)} ${s.reason}`);
  }

  console.log(
    `\n${results.pass} passed, ${results.fail} failed, ${results.skip} skipped, ` +
      `${skippedFiles.length} suite(s) skipped  (${Date.now() - t0}ms)`
  );

  if (results.failures.length) {
    console.log("\nFailures:");
    for (const f of results.failures.slice(0, 40)) {
      console.log(`\n  ✗ ${f.name}\n      ${f.message.split("\n").join("\n      ")}`);
    }
    if (results.failures.length > 40) {
      console.log(`\n  ... and ${results.failures.length - 40} more`);
    }
  }

  console.log(
    "\nNOTE: miniJest is a sandbox stand-in, not Jest. Run `npm install && npm test` " +
      "for the authoritative result."
  );
  process.exit(results.fail > 0 ? 1 : 0);
}

main();
