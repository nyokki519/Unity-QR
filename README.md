# Unity CHECK-IN

## Unity QR 2.0 — Operations

運営向けの新しい受付アプリを `/ops/` に追加しました。既存の会員デモとブラウザ内の履歴は変更していません。

- サーバー認証、Admin / Staff / Viewer、イベント別アクセス。
- 署名・有効期限付き参加者QR、iPhone向けカメラ読取、手動受付、二重受付防止。
- 参加者検索、同名判別、当日登録、受付・参加取消、名前編集と監査履歴。
- イベント作成・編集、受付人数、定員、受付時間帯。
- Analyticsの取込・同期アダプター、PASS検証アダプター（実サービス未接続）。

Node 24と永続SQLiteサーバーが必要です。GitHub Pagesの既存デモはそのまま公開されますが、新APIはPagesでは実行できません。

```sh
npm ci
npm run build
npm test
```

起動・本番設定・バックアップは [運用手順](docs/qr-v2-operations.md)、連携先の実装要件は [連携仕様](docs/qr-v2-integrations.md)、調査・制約は [監査記録](docs/qr-v2-audit.md) を参照してください。
以下は保持している旧デモの説明です。旧デモのlocalStorageデータを本番参加者として自動移行しません。

> 一生ものの仲間と、成長する。

Unity community専用の MEMBERS ONLY digital member card × event check-in experience。
Unity DROPとは完全に独立しています。

## Prototype

現在はUI/UXを実機確認するための DEMO MEMBER mode です。

実装済み:
- 初回 Welcome / Unity Name登録
- Welcome back
- TODAY event
- event QR compatible URL (`?event=...`)
- quiet CHECK IN interaction
- checked-in / already checked-in state
- digital member card
- YOUR UNITY / event count / last visit / recent visits
- no-event state (`?noevent=1`)
- branded communication-error state (`?error=1`)
- demo reset (`?reset=1`)
- iPhone safe area / 100dvh / reduced motion support

## Production architecture

LINE authentication is intentionally isolated from the demo UI. Production should use a dedicated CHECK-IN backend, not Unity DROP's Worker.

Data domains:
- `members`: memberId, lineUserId, displayName, lineDisplayName, pictureUrl, memberSince, createdAt, status
- `events`: eventId, title, date, startTime, location, status
- `checkins`: checkinId, memberId, eventId, checkedInAt

The server must derive member identity from verified LINE authentication. Never trust a memberId, lineUserId, or check-in state supplied only by localStorage or URL parameters.

## LINE configuration still required

Before production authentication is enabled, configure real values from LINE Developers:
- LINE Login channel
- LIFF app / LIFF ID
- Channel ID
- valid Endpoint URL / Callback URL
- server-side credentials/secrets as required

Do not commit secrets to this public repository or frontend JavaScript.

When credentials are available, replace the demo identity adapter only; the member UI and check-in flow can remain unchanged.

## Local development and regression tests

The frontend is a static application; there is no production authentication server or build step yet.
Serve this directory with any static HTTP server (for example `python3 -m http.server 4173`).

Browser tests start their own temporary HTTP server and use separate browser contexts:

```sh
npm ci
npx playwright install --with-deps chromium webkit
npm test
BROWSER_ENGINE=webkit npm test
```

Node.js 20+ is required for the test tooling. On Linux, the test runner uses `/usr/bin/chromium`
if available; otherwise it uses Playwright's Chromium. `CHROMIUM_EXECUTABLE_PATH` and
`WEBKIT_EXECUTABLE_PATH` can select existing browser launchers. Browser launch failures fail the
suite rather than silently skipping it.

Coverage includes registration, returning members, receipt/history, duplicates, cross-tab
writes, no-event/reset URLs, simulated communication failures, unavailable/full storage,
malformed stored data, MY UNITY, long names, 320px–1440px layouts, short viewports, focus
handling, reduced motion, and a LINE user-agent emulation. WebKit and a LINE user agent do
not replace actual iPhone Safari / LINE in-app browser testing. See [REVIEW.md](REVIEW.md).
