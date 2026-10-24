# Unity QR 2.0 Implementation Plan

> Implement inline using superpowers:executing-plans; user requested autonomous execution and minimal redundant review.

**Goal:** reliable reception, participant management and signed QR operations, preserving the existing demo.
**Architecture:** Node 24 TypeScript HTTP server, private persistent SQLite, `/ops/` static client, isolated integration adapters.
**Spec:** `docs/qr-v2-design.md`.

## Global constraints
- No DROP changes, no production DB migration, no fake LINE/PASS credentials.
- Root demo files/storage remain unchanged. Work on `feature/unity-qr-v2` from verified production.
- No public reception API without server authentication; no offline success.

## Review focus
Same-name participants must remain distinct; retries must not duplicate audit/sync; cancelled registrations must reject tickets; old QR must fail after expiry; database backup must survive WAL and restore without touching the original.

## Tasks

1. **Data and security** — create `server/store.ts`, `server/security.ts`; tests `tests/v2.test.ts`. Write/run failing tests for role boundaries, signed QR, transaction attendance/undo, idempotency, duplicate names and backup; implement; run suite.
2. **HTTP and integrations** — create `server/app.ts`, `server/integrations.ts`, `server/main.ts`, `server/cli.ts`; extend isolated API tests for cookies/origin, authentication, permissions, imports and sync retry. Implement authenticated APIs and run tests. Provide explicit integration contracts.
3. **Operations UI and scanner** — create `ops/index.html`, `ops/style.css`, `ops/app.js`, `ops/scanner.js`, `server/decoder.ts`; write browser flows before implementing. Bundle QR decoder locally; render six responsive views, accessible status and camera lifecycle. Run genuine QR decode and mobile browser checks.
4. **Release protection** — create Dockerfile, environment template and deployment/backup docs; typecheck/build/tests, separate security diff review, secret check, commit/push recovery and feature branches, create PR. Deploy only with verified persistent hosting and backups; otherwise record the blocker, leaving existing Pages untouched.
