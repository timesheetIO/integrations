// The sandboxed plugin runtime always exposes Web Crypto as `globalThis.crypto`, so
// plugin code uses it directly and must never reach for `node:crypto` (see the
// crypto bridge in plugin-runtime/src/executor/IsolateRunner.ts).
//
// Node only exposes that global unflagged from v19, and CI still builds on 18, where
// `globalThis.crypto.randomUUID()` throws and the failure surfaces as an unrelated
// assertion inside a try/catch. Give the tests the same global the runtime provides.
if (!globalThis.crypto) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  globalThis.crypto = require('node:crypto').webcrypto;
}
