# Unity CHECK-IN

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
