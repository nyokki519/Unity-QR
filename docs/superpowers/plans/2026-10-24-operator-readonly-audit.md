# Operator read-only audit implementation plan

> **For agentic workers:** Execute inline with the existing authorized workflow. Do not deploy or change production without the user's new explicit approval.

**Goal:** Diagnose operator login using existing snapshots or SQLite copies without modifying source data or revealing credentials.
**Architecture:** A local-only CLI reads SQLite with readOnly/query_only or an existing Unity QR JSON snapshot. It emits fixed account flags, integrity status and aggregate counts; never hashes, names, session tokens or source errors. No Store constructor, migration, remote requests or login attempts.
**Tech Stack:** Existing Node 24+, node:sqlite and TypeScript.
**Spec:** User's 2026-10-24 request: preserve production data, no guessed credentials, backup before changes, no redeploy before cause, explicit production approval.

## Global constraints
- All production calls in this task are GET metadata only. No reset, setup, login, deployment or SQL write.
- An old backup cannot establish current production account state.
- Authentication behavior stays unchanged until the cause is verified.

## Review focus
- Missing files must not create a DB.
- Foreign/malformed DB and JSON fail with fixed safe errors.
- Invalid hashes must be reported without printing them.
- Duplicate operator rows cannot be described as a healthy account.
- Diagnostics must preserve file bytes and never expose participant names or session material.

## Task 1: Local diagnostics and operating procedure
- [x] Add real-file CLI tests for the five cases above, then observe RED.
- [x] Implement scripts/diagnose-operator.ts with --sqlite or --snapshot, no password arguments.
- [x] Run focused tests, full npm test and typecheck.
- [x] Document 401 conditions, production source evidence, backup access options, guarded recovery matrix and remaining unknowns.
- [ ] Commit to fix/operator-readonly-audit; do not deploy.

## Read-only production proposal

Added raw SELECT maintenance routing before normal constructors after real workerd tests reproduced initialization/mutation in the earlier helper. Two regressions now pass. Ordinary initialization remains on normal fetch/alarm. Independent review: no Critical/Important issues. Full suite: 109 unit + 11 workerd + 15 legacy browser + 8 operations browser + 1 LINE browser =144 passed; typecheck passed. Production deployment remains unapproved and unperformed.
