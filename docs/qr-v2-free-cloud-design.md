# Free cloud reception design — 2026-10-12

## Goal and authorization

The user wants reception to work with the Mac closed and explicitly refuses paid
hosting. Preserve existing UI, accounts, participants, arrival history and role
enforcement. Implement autonomously in the current checkout; no repeated design
approval gates or extra implementation agents. Do not touch DROP or Analytics.

## Decision

Use Workers static assets plus one SQLite-backed Durable Object on **Workers
Free**. Official Cloudflare documentation confirms SQLite Durable Objects are
available on Free, persistent without a running Mac, and exceed-limit operations
fail instead of automatically billing on Free. Workers has 100,000 daily requests;
DO storage has 5 GB account-wide. All limits are account-wide and subject to the
provider's published terms; no uptime or unlimited-service claim. Use no paid
plan, containers, R2, domains or other billed resources. No change to Render's
existing paid example implies deploying that example.

Compared with ephemeral free Node hosting (which loses local SQLite), the Durable
Object persists individual SQL rows. Compared with a remote asynchronous database,
its synchronous SQL API lets us reuse reception transactions and constraints.
Passwords remain scrypt, HMAC QR keys remain server-side, sessions are server-side.
Heavy password hashing runs inside the DO (30 s CPU per request); the front Worker
only routes requests and serves assets (Free has 10 ms CPU per request).

## Boundaries

Extract a synchronous SQL driver and shared Store without Node filesystem or
`node:sqlite` imports. The existing Node Store retains DB ownership checks,
versioned migrations, CLI and online backups. DO uses `transactionSync()` rather
than SQL `BEGIN`, and an owned metadata table rather than unsupported PRAGMAs.
Reuse the existing API route handler through a Request/Response adapter; keep
Node HTTP entrypoints and legacy demo intact. Static build copies only the eight
allowed public files, never source, database, environment or backup files.

## Migration and publication

Publish a fresh, randomly named Workers service; never overwrite an unverified
existing site. A local-only deployment helper opens Cloudflare login if needed,
creates assets/bindings, sets signing/setup secrets without printing them, and
imports an online-backed-up Mac DB into an **empty** owned cloud database.
Preserve stable IDs, password hashes, registrations, audit and ordered outbox;
exclude expiring sessions so operators log in again. Reuse the Mac signing key.
Import uses a one-time secret-authenticated endpoint, validates tables/values and
foreign keys, is one transaction and refuses nonempty destinations. Failed/lost
responses can safely recover the same import by its fingerprint. Retain private
local backup and migration receipts; never delete or initialize the Mac source.

Authenticated Admin export provides a private cloud backup. Restore has no
overwrite endpoint: validate then import into another empty deployment. Bootstrap
secret is removed after confirmed import. No default Admin or fake third-party
credentials. Actual Cloudflare publication requires the user's account login on
their Mac, which this environment cannot operate.

## Evidence and remaining checks

Run existing Node unit/API/browser suites plus a real local workerd/SQLite DO
suite: cold start, migration failure rollback, scrypt login, roles/CSRF, genuine
QR decode/checkin, concurrent duplicate requests, audit/undo, preserved outbox,
export, restart persistence, static file protection. Account quota and public
HTTPS/iPhone checks remain external until the user runs the deployment helper.

Sources inspected from the official cloudflare/cloudflare-docs production branch:

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/
