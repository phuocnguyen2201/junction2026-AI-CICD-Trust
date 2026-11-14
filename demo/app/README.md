# Event sign-up (synthetic demo)

A tiny synthetic app used to exercise Pre-PR Guard. All code and data are made up.

- `api/`: back-end. A pure request handler (`routes.js`) over an in-memory store, plus a data-quality report.
- `api/contract.json`: the public API contract. Every route must be declared here.
- `web/`: front-end sign-up page.
- `test/`: `node:test` tests, run in two modes:
  - `default`: string ids
  - `legacy`: numeric ids (`ID_FORMAT=legacy`), for an older client. Its file list is explicit, so every new test file must be added to it.
- `tools/`: small stand-ins for a formatter, linter and type checker, so the demo needs no installs.

Runtime: Node (see `.nvmrc`).
