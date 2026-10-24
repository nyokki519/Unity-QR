# Studio relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Durable group-media forwarding while preserving QR reception.
**Architecture:** SQLite outbox on existing QRReception, minimized signed envelopes and independent alarm delivery. Additive schema; defaults OFF.
**Tech Stack:** TypeScript, node:sqlite, Cloudflare SQLite Durable Objects, existing LINE HMAC.
**Spec:** docs/superpowers/specs/2026-10-24-studio-relay-design.md

## Global Constraints
No paid service, no LINE sends by relay, fixed destination, explicit allowlist, no production replacement without backup validation.

## Review Focus
- Forged/malformed or unrelated events must not persist payloads.
- Duplicate/restarted/concurrent delivery must be fenced and idempotent.
- Revocation before/during image delivery must prevent later use.
- Full queue or unavailable storage must not silently ACK lost events.
- Analytics alarm must continue if Studio unavailable or disabled.

### Task 1: Outbox and authenticated webhook admission
**Files:** new server/studio-relay.ts, tests/studio-relay.test.ts; modify server/line.ts and server/store-core.ts.
**Interfaces:** enqueueStudioEvents(db,cfg,events,now) persists only validated group media/unsend. deliverStudioRelay(db,cfg,fetcher,now) processes at most4 rows. nextStudioDelivery(db,cfg) computes next alarm or null.
- [x] Write tests covering OFF/allowlist, minimized HMAC envelopes, duplicate/restart, expiry/retry, full queue, unsend precedence, stale leases and invalid signature. Run `npx tsx --test tests/studio-relay.test.ts` and observe missing behavior.
- [x] Implement additive outbox and integrate admission after signature/schema checks, before QR claims.
- [x] Run focused tests and existing unit suite; commit.

### Task 2: Durable Object alarm, workerd proof and rollout records
**Files:** cloudflare/worker.ts, tests/cloud-studio-relay.cjs, package.json, docs/studio-relay.md.
**Interfaces:** CloudEnv STUDIO_RELAY_ENABLED/STUDIO_ALLOWED_GROUP_IDS mapped into LineConfig. Existing alarm handles both independent queues and schedules earliest next work.
- [x] Write actual workerd tests proving persisted failure/restart retry with valid signature, no LINE sends and Analytics independence; observe RED.
- [x] Wire config/alarm with bounded delivery and preserve Analytics scheduling. Add cloud test invocation.
- [x] Run `npm test`, `npm run typecheck`, compare baseline deployed bundle; request independent review and fix important findings RED→GREEN.
- [x] Commit/push feature branch. Deploy only with original backup prerequisites met; otherwise document exact blocker and secure registration steps.

Execution record: baseline build exactly matched deployed worker SHA25660cac2a1209a4e38a9c59077615ff9571ad784857286baeb453e2db25fe32972. One independent-review Important finding (OFF/removed groups suppress cancellation) reproduced RED and fixed GREEN. Native fetch redirect:error unsupported on Workers; actual workerd failure reproduced and changed to manual plus non-2xx failure. Ruling: existing QR admin backup credentials unavailable, so prepare/push branch but do not replace live QR; cost is delayed activation, not risk to existing reception. Portable v4 backup excludes queue and full DO recovery remains an activation gate. Cross-repo Studio cancellation admission updated narrowly with matching historical source hash. Final verification results recorded in docs/studio-relay.md.
