# Operating Unity QR 2.0

## Before production

The existing GitHub Pages site remains unchanged. GitHub Pages cannot run the new APIs. Deploy a Node **24** server behind HTTPS, with a private persistent SQLite volume. A stateless Vercel/serverless deployment is unsupported. No default Admin, LINE ID, PASS key or fake integration endpoint is provided.

1. On the server, `npm ci`, `npm run build`.
2. Securely configure `QR_ORIGIN` as the real HTTPS origin (no path), `QR_DB_PATH` on durable storage, and `QR_SIGNING_KEY` as a random secret of at least 32 bytes. Example generation on your own server: `openssl rand -hex 32`. Changing the key invalidates previously issued tickets. Do not paste it in chat or commit it.
3. Create Admin using hidden password input. Example Bash:

```bash
read -r -s -p 'Admin password (16–128 characters): ' qr_admin_password
printf '%s' "$qr_admin_password" | npm run admin:create -- operator Admin
unset qr_admin_password
```

Use a unique strong password. Store keeps only a salted scrypt hash. The password passes via stdin, not a command argument. No bootstrap password is accepted by the HTTP API. User creation does not initialize/delete existing data.

4. Run `npm start` as a non-root service. `HOST` defaults to loopback; a container uses `0.0.0.0`. Expose port 4173 only through the HTTPS reverse proxy. Set `NODE_ENV=production`; the application refuses plain HTTP origin. For local development only, `QR_ALLOW_LOCAL=1` permits localhost HTTP outside production.
5. Open `/ops/`. Create a dedicated test event, Staff/Viewer event assignments and test participants. Verify permissions, expiry, QR/manual arrivals, duplicate receipt, undo and backups before opening real registration.

Dockerfile is supplied for a persistent-volume deployment. Local container build/start, non-root compiled CLI, authenticated arrival, backup verification and restart persistence were checked with test-only data. Production deployment still requires verification on the actual host. Environment template has empty secrets. Infrastructure credentials and DNS/HTTPS are not supplied by this repository.

Inside a running container, use `docker exec -i <container> node dist/server/cli.js user <username> Admin` with the password on standard input. Backups use `docker exec <container> node dist/server/cli.js backup /data/<new-backup>.sqlite` and `verify` on that same path. Only test fixtures were created during development.

## Backups and restoration

Before any future schema change or release, obtain an online backup using SQLite's backup API; do not copy a live main file without its WAL.

```bash
npm run backup -- /private/backups/unity-qr-YYYYMMDD-HHMM.sqlite
npm run backup:verify -- /private/backups/unity-qr-YYYYMMDD-HHMM.sqlite
```

Backup command refuses to overwrite a file or silently create a nonexistent source DB. Verify checks integrity, foreign keys and schema version read-only. Unit tests restore an online backup into a separate Store and check attendance/audit. Keep encrypted off-host copies and a documented retention policy; backup includes personal data, password hashes and session hashes, so restrict permissions.

To restore: stop the QR service; first back up the current database; verify the intended backup; copy it to a **new** DB path with private permissions; start an isolated instance against that path and compare event/participant/arrival/audit counts; only then switch `QR_DB_PATH` and restart. Never overwrite a live database or reuse stale `-wal/-shm` files. Downgrade binary together with the matching backup if schema versions differ. Existing browser demo histories and Analytics databases are not part of this database and are not migrated.

## Constraints

- One server process per SQLite file; local transaction locks serialize reception. Multi-host scaling requires a reviewed database/queue change.
- Capacity limits actual arrivals; duplicate receipts are not blocked by capacity. Reception timestamps and event/QR expiry are server-authoritative.
- Viewer cannot issue participant tickets or write; Staff cannot edit names/cancel/undo. Admin manages user access. Revoking a user immediately invalidates DB-backed sessions.
- Session lifetime 8h. HTTPS uses Secure/HttpOnly/SameSite=Lax cookies. Mutations require exact configured Origin. Login throttling is local; add edge limits at the real reverse proxy, especially behind shared proxy IPs.
- SQLite application ID identifies this service; unrelated databases are rejected before changing journal mode/schema. Schema v2 additively migrates existing v1 outbox order without deleting events, users or attendance.
- No offline success or background PII cache. A lost response is retried with the same idempotency key; until server acknowledgement, the UI does not show success.
- Tickets last at most 6h or until reception closes and are event-specific. Whoever holds a participant ticket can present it; operators should confirm displayed name/short ID. Individual ticket revocation/rotation and automatic participant delivery are not implemented.
- Events/people are private. Admin sync history retains safe result codes, not remote tokens. PASS and Analytics connection configuration does not prove external connectivity.
- Real iPhone Safari/LINE device camera, external PASS and Analytics end-to-end sync must be validated after actual hosting is configured. WebKit and camera-permission emulation are not physical device evidence.

## Validation commands

```sh
npm run typecheck
npm run build
npm test
WEBKIT_EXECUTABLE_PATH=/workspace/.cache/webkit-local.sh BROWSER_ENGINE=webkit npm test
```

Tests use temporary/in-memory databases and explicitly test-only accounts/keys. They never call production integrations or initialize production event attendance.
