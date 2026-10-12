# Free cloud reception implementation plan

> Execute natively with `superpowers:executing-plans`; one final independent review.

**Goal:** preserve QR reception while allowing free cloud use with the Mac closed.
**Architecture:** common synchronous Store/API, Node SQLite driver plus Cloudflare
SQLite Durable Object driver, static-assets Worker and a private migration helper.
**Spec:** `docs/qr-v2-free-cloud-design.md`.

## Constraints and review focus

- No paid resources or existing service overwrite; no DROP/Analytics changes.
- Preserve names/IDs/password hashes/history/outbox; no public database export.
- All mutations atomic; failed imports leave no partial accounts or arrivals.
- Lost upload acknowledgements recover by fingerprint without overwriting data.
- Cold start and object eviction must not reset auth throttling or receipt history.
- Refuse unrecognized/nonempty databases and leaked secrets in static assets.
- Deployment interruption must not rotate existing QR secrets or lose local backups.

## Tasks

1. Write red tests for backup export/import and owned SQL driver. Extract shared
   `server/store-core.ts` and `server/storage.ts`, retain Node API compatibility in
   `server/store.ts`, convert migration/import/mutation to driver transactions.
   Validate old tests and new import rollback/ID/hash/session-exclusion tests.
2. Write local workerd tests. Add `cloudflare/sql-driver.ts`, `worker.ts`, fetch
   bridge, one-time import and Admin backup. Add `wrangler.jsonc`, allowlisted
   asset build and typings. Validate true SQLite DO transactions, auth, QR,
   duplicates, restart, foreign data rejection and static security.
3. Add Mac publishing helper and safe free-plan operations instructions. Generate
   isolated service names and private backup/state, reuse signing key, set secrets,
   import and verify counts, remove bootstrap secret. Keep existing deployment
   paths supported. Add Cloudflare checks to CI and status ledger.
4. Run type/build, Node tests, workerd tests and Chromium/WebKit checks. Obtain one
   final reviewer, address findings, commit/push and update PR. Report cloud
   publication as pending the user's local Cloudflare login, never as completed.
