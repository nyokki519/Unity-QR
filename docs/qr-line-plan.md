# LINE automatic registration plan

Approved brief: user-approved full implementation prompt in this conversation (2026-10-12).
Base: f92a9c53f4a981dfd9c1ab11ff695c44c1419ed1. Recovery: backup/unity-qr-pre-line-20261012.

## Design and constraints

Reuse existing reception Store, signed tickets and authenticated operations UI. Add a versioned, additive schema for LINE identity mappings, public ticket capabilities, event signup windows, expiring conversation state and webhook delivery receipts. Raw LINE request body is authenticated before parsing. A durable event claim prevents replay, including uncertain sends; no Push API fallback. Private capability links use URL fragments and hashed database tokens, with QR issuance on page opening only during reception hours. No existing person is merged by name.

Ruling: the user has explicitly approved implementation and autonomous decisions; additional design approval is unnecessary. Use two independent scoped workers for UI and Analytics mapping, with the main agent implementing backend and integration; one final review. No worktrees or new dependencies.

## Tasks

- [x] Backend: signature/body tests RED, schema v3, bounded LINE client, atomic registrations, conversation and deduplication, reply status, public short-ticket API. Verify unit/API cases.
- [x] UI: participant page, LINE event setup, connection/delivery status. Verify WebKit/Chromium and existing reception.
- [x] Analytics: inspect existing operator API, safe read-only stable-ID event adapter with tests; QR-side manual import only.
- [x] Migration/update: preserve old backups; include new private operational tables; cloud update must obtain/validate backup before applying schema, preserve Worker ownership/signing key and never rerun initial import on populated production.
- [x] Verify: typecheck/build, full suite, actual workerd LINE flow, secret/diff review, independent review, commit/push/PR.

## Review focus

Concurrent webhook processing, reply outcome uncertainty, token leaks, event ambiguity/stale postbacks, old snapshot compatibility. Production update remains blocked without actual Cloudflare credentials and a verified production backup. LINE credentials are absent until securely configured; complete offline tests and user-side setup script regardless.

## Verified outcomes

54 unit/API tests; 7 real workerd tests; existing 15 legacy + 7 operations checks on both Chromium and WebKit; new participant/LINE/Analytics UI workflow on both engines. Typecheck, Worker dry-run, Docker build + nonroot health/login/private backup, production dependency audit (0 vulnerabilities) passed.

Final review Important findings reproduced RED then fixed GREEN: concurrent bounded webhook batch prevents slow first events starving later receipts; explicit cancellation confirmation precedes state mutation. Actual workerd surfaced unsupported redirect:error; manual redirects + non-2xx refusal preserves credential isolation. Additional initial-deploy guard prevents completed production updates bypassing fresh backup.

Deferred minor: multiple-event selection may ask for name after an initial profile fetch. Safe fallback, not lost registration. Production deployment and real LINE/Analytics authentication remain unverified due to absent cloud credentials/production backup access in this environment; user-side scripts are complete. Official LINE billing documentation is linked for current tariff confirmation; this environment cannot read that host, so no live tariff verification is claimed.
