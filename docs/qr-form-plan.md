# Form-to-LINE QR claim plan

Approved intent: user selected the submission-completion LINE link, using accepted submission name/event without tracking-ID identity guesses. Existing autonomous implementation authorization applies; no repeated approvals needed.
Base QR db11b3c; recovery backup/unity-qr-pre-claim-20261012. Unity_S base85c4014; recovery/PR tracked separately. Analytics main read-only inspected; no changes necessary to its metrics/participant fetch.

- [x] Investigate actual tracking/session ID, existing Google form metadata, source event IDs and unsafe public participant reader. Select authenticated Form acceptance hook, never public PII lookup.
- [x] Unity_S independent scoped worker: memory-only raw code, hash-only form entry, runtime config, LINE deep-link, exact accepted-response AppsScript hook, preserve Growth.
- [x] QR backend TDD: form secret/API, exact receipt deduplication, owned code redemption, stable event ID/date mapping and Admin controls, schema4 and old snapshots.
- [x] Independent review: no critical auth findings; pending date mismatch upgraded to Important usability and regression test fixed. Existing name preservation documented; page-close loss documented and real app-switch validation remains required. CLI v4 backup rejection reproduced and fixed.
- [x] Full tests/build/WebKit/Cloudflare, staged secrets, commit/push/PR prepared. Docker image build attempted but unavailable due ENOSPC; this is an optional Node-container check, not the Cloudflare target.

Ruling: no Analytics code changes. Its default branch still has anonymous participant reads; use the original accepted Form event instead, avoiding capability codes in a public sheet and unnecessary PII API expansions.
Ruling: do not auto-create guessed event timelines. Exact imported IDs match automatically, otherwise Admin selects an existing same-date event; incorrect dates stay visible for explicit resolution.

Validation: QR 61 unit/API tests + 7 real workerd tests, legacy 15/ops7/new LINE/Form mapping UI on Chromium and WebKit passed. Unity_S 19 unit tests and both browser engines passed, PR#4 CI passed. Active QR release checkout moved to /tmp/unity-qr-form-release because workspace root exhausted disk; source copy preserved at /workspace/Unity-QR.
