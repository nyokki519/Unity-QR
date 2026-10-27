# Registration and cancellation fixes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. User explicitly authorized autonomous implementation and publication; do not pause for design approval.

**Goal:** Fix the three reproduced review findings without losing applications or histories.
**Architecture:** Explicit claim reuse/new-person confirmation; participant-scoped LINE buttons and JST dates. Admin-only complete cancelled-registration snapshot consumed as a read-only source overlay by Analytics and Reminder. Existing check-in outbox is unchanged because its consumers may not support cancellation actions.
**Tech Stack:** Existing TypeScript/SQLite/Cloudflare and Next.js; no new dependency/schema.
**Spec:** User approved all three review fixes and production publication in this conversation.

## Global Constraints
- Preserve original submissions, QR histories, schemas, roles, backups and free hosting. Never change Unity DROP.
- Names and Unity measurement IDs are not identity. Only owned claim/registration IDs can match.
- No real LINE test sends; use fixture APIs. Credentials and deployment grants are not implied by user approval.

## Review Focus
- Repeated same-event claims must not inflate people before explicit confirmation; concurrent/replayed decisions remain idempotent.
- Existing duplicate/guest applications remain selectable; forged participant/claim postbacks expose no other person's details.
- Same-name sessions and cancellation confirmation show Japanese dates; cancelled rows are not offered for another cancellation.
- Cancellation snapshots are Admin-only, complete or rejected; restored/canonical merged records must not retain stale cancellations.
- Analytics matching is exact and event-scoped; unavailable/old QR must not silently corrupt source or existing attendance synchronization.

## Task 1 — LINE resubmission and selection
- [x] Add failing tests for new claims offering reuse/new selection without a second registration, explicit guests, old duplicates, wrong-subject choices, retries and same-name dates.
- [x] Implement claim reservation/decision in server/form-claims.ts; keep original records and names. Implement owned person selection and dates in server/line.ts.
- [x] Run relevant tests, typecheck and build; commit.

## Task 2 — Cancellation status contract
- [x] Add auth/scope/restore snapshot tests; review canonical merged-event filtering. Implement server/cancellations.ts and Admin-only versioned API plus feature flag in server/app.ts.
- [x] Do not add unsupported actions to the existing outbox or change database schema.
- [x] Run API/workerd regressions and commit.

## Task 3 — Analytics and Reminder
- [x] In nyokki519/unity-analytics implement bounded authenticated QR snapshot pull using existing server credentials and exact claimHash/registration ID overlay in the participant source.
- [x] Keep Google rows unchanged. Mark synchronization state explicitly, support old-backend rollout, prevent Reminder from silently using uncertain cancellation state.
- [x] Add focused tests for cancelled/restored/ambiguous/missing identifiers/failures and existing Reminder quotas/deduplication. Run full required tests/typecheck/build.

## Delivery
- [x] Independent focused security/compatibility review, fix blockers, check secrets/diff.
- [x] Commit/push both branches, create PRs, wait CI, merge and verify Vercel deployment.
- [ ] Deploy QR only through backup-verifying update with available legitimate Cloudflare credentials/state. Current environment has no Cloudflare/Vercel secrets and GitHub secret-management access is denied; do not bypass backup or invent production state.
- [x] Persist exact deployment state and remaining technical blocks in implementation-status files.

## Release evidence (2026-10-27 JST)
- QR PR19 merged as 26d632a into feature/sheet-authoritative-reception; validation run 40417150024 succeeded, including Chromium/WebKit. Source recovery branch: backup/pre-registration-fixes-20261027 (8b8fc22).
- Analytics PR27 merged as 1fc9aa4 into main; PR verification succeeded and the production Vercel commit status is success. Source recovery branch: backup/pre-qr-cancellation-20261027 (ce3abdd).
- Cloudflare credentials, QR administrator password and data/cloud-migration/deployment.json are absent here. No Cloudflare publication or real DB backup was performed. Owner Mac cloud:update remains required; do not claim the source recovery branches are DB backups.
- Direct production page access is blocked by the managed network; Vercel publication is verified through GitHub deployment status, not an authenticated live cancellation test.
