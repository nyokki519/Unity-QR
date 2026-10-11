# Unity QR 2.0 implementation status

Plan: `docs/qr-v2-plan.md`. Spec: `docs/qr-v2-design.md`.

- Repository and production branch verified; audit saved.
- Recovery branch created locally at `260c83b`.
- Design decision: additive standalone persistent backend; preserve current static demo and browser histories. Analytics/PASS not assumed deployed.
- Environment reconnected after user published configuration.
- Task 1 complete: owned/versioned SQLite DB, roles, signed QR, transactional receipt/undo/registration, audit, idempotency, backup/restore.
- Task 2 complete: authenticated APIs, individual accounts and event assignments, bounded Analytics import, ordered durable outbox with backoff, disconnected PASS verifier adapter.
- Task 3 complete: six operations views, green/ivory/gold UI, native/jsQR camera fallback, manual reception, search, QR issuance, polling, explicit errors and receipt acknowledgement.
- Task 4 release in progress: Docker build/start/restart, CLI admin creation and backup verification passed; CI and setup docs supplied. GitHub release follows final checks.
- Validation: 22 unit/API/DB/QR/integration tests; legacy 15 and operations 7 browser checks **each** on Chromium and WebKit. Typecheck/build successful. Browser screenshots under `docs/screenshots` use test-only data.
- Independent review performed via `superpowers:requesting-code-review`. Important findings fixed with failing-then-passing regression tests: outbox predecessor ordering, stale event-switch actions, committed QR/PASS receipt recovery after expiration/remote failure. User creation is now idempotent and transactionally audited; remote import commits the exact previewed snapshot; ticket modal stays bound to its rendered event.
- Ruling: preserve the deployed static demo and add a separate Node 24 persistent server — Pages cannot provide private authenticated reception APIs. Cost: an actual backend host is required.
- Ruling: use an owned standalone SQLite database, not an unverified Analytics database — no DB credentials/backup were available. Cost: shared-data integrations require explicit stable-ID adapter contracts.
- Ruling: no offline success — reliable duplicate prevention requires a reachable authoritative server. Cost: venue reception requires network connectivity.
- Deferred external verification: physical iPhone/LINE camera, PASS verifier, Analytics receiver and actual production HTTPS host. No production credentials fabricated.
- Production database access/backup and backend HTTPS hosting are unavailable; production rollout must stop at PR unless those become verified.
