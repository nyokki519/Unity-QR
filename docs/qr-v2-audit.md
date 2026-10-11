# Unity QR 2.0 audit — 2026-10-11

- Verified repository: `nyokki519/Unity-QR`; remote `https://github.com/nyokki519/Unity-QR.git`. No DROP checkout edited.
- Initial checkout: `fix/unity-check-in-review`, `3bceaaf39590541c404eb0c021cdcf977d449ea0`, clean.
- GitHub default branch: `main` (`56ddea5693fa68cf699a51a609dc19fa75991852`). It is **not** the deployed frontend branch.
- Verified production: GitHub Pages, `preview/unity-check-in` at `260c83b44e6c9b4fd950f4290df4a9a67cb67aa3`. Public HTTP 200 on 2026-10-11.
- Working branch: `feature/unity-qr-v2`, based on that production commit. Recovery branch: `backup/unity-qr-pre-v2-20261011` at the same commit.
- Current frontend: plain HTML/CSS/JS; registration, member card, receipt, duplicate prevention, MY UNITY, simulated errors, localStorage demo history. No backend/API/DB or production LINE authentication. Preserve all original files and storage keys.
- Assets: existing U seal, editorial serif typography, locally retained gallery; no verified official-site URL supplied. No invented official brand assets.
- Existing tests: Playwright, 15 checks each for Chromium/WebKit; package `unity-check-in`, Node 20+ previously.
- Analytics inspected read-only: `nyokki519/unity-analytics` migration 001 has UUID events and participants; unique `tunagate_event_id`, `external_key`; attendance primary key `(event_id, participant_id)`; registration/PV snapshots are separate. Previous LINE attendance PR #8 remains OPEN/unmerged. Its proposed API cannot be assumed deployed.
- No verified PASS repository/API/keys. Treat PASS as disconnected until a real verification contract is configured.
- Runtime has no DB, LINE, PASS, Vercel or Analytics credential bindings. Actual external production DB settings and backup are unverified. No production DB access or destructive migration is authorized by this audit.

## Protection and deployment decision

Existing demo localStorage data is left untouched and never silently treated as real attendance. Operators may export browser demo history themselves; v2 does not import it as production attendance.

V2 adds its own SQLite database on a persistent server volume, with a versioned additive schema, unique attendance, sessions, audit and sync outbox. It must not run against an Analytics DB. Before real operation, take an online SQLite backup and verify integrity plus restore into a separate temporary database. Operational backup/restore is implemented and tested; no external production backup has been acquired.

GitHub Pages cannot run authenticated APIs or persistent databases. Keep the current public deployment intact. Create a PR and container-ready server; production rollout requires a verified HTTPS host with a persistent volume and an actual backup. Never label a static UI preview as production-ready reception.
