# QR → STUDIO転送の運用

QRのWebhook URL `/api/v2/line/webhook` を維持する。転送先はコードで固定した `https://unity-auto-studio.kukki519.workers.dev/webhooks/line` のみ。リダイレクトは追従しない。LINEへの返信・Pushはこの機能から行わない。

## 設定

QR Workerの変数に `STUDIO_RELAY_ENABLED=true` と `STUDIO_ALLOWED_GROUP_IDS`（許可したグループID、カンマ区切り）を設定する。未設定は新規素材の転送OFF。Secretの値をチャット・Gitへ保存しない。QR/STUDIO双方の `LINE_CHANNEL_SECRET` は同じMessaging APIチャネルのものが必要。QRの既存Secretを変更しない。

STUDIO側は同じグループの `ALLOWED_GROUP_IDS`、期限付き予算、受信機能、通常native runnerの接続が別途必要。転送を追加しただけで動画生成の運用開始にはならない。LINE公式アカウントのグループ参加許可も別設定。許可グループが未設定のまま勝手に全グループを収集しない。

## 保存と再試行

- 署名検証後、許可グループのimage/video/unsendだけをSQLiteへ永続保存してからACK。本文は最小化し、テキスト・個人ID・氏名・replyTokenは保存しない。転送時に最小本文をチャネルSecretでHMAC署名する。
- 1 alarm最大4件、1 HTTP最大5秒、lease60秒、最大12回、指数バックオフ（60秒〜最大1時間）。不明なHTTP応答も同じイベントで再試行し、STUDIOの重複防止に委ねる。失敗本文や認証値は記録せず、固定コードのみ。
- 原本画像/動画はQRに保存しない。待ち本文はmedia24時間、unsend7日で消去。完了後も本文は消去。重複・取消防止のハッシュ等は7日間保持し、その後削除する。OFF時も期限処理と、許可済み/過去に受付したグループからの送信取消は処理する。
- 新規mediaはUTC日100件、保持行最大1000。容量超過・保存失敗は503でLINE再送を要求し、黙って取りこぼさない。混合リクエストのQR操作もこの場合は再送後に処理する。LINEの再送設定が必要であり、無限の再送保証ではない。
- 取消は同じgroup/messageの未完了mediaを取消し、unsendを優先転送。転送中のmediaについてもSTUDIO側のtombstoneで利用を失効させる。許可解除後は新規mediaを受け付けず、待ちmediaを配送せず破棄する。過去の受付グループのSHA256のみを別テーブルに保持し、待ち行の7日間保存が終わった後も、そのグループの送信取消を受け付ける。取消以外の再収集には使わない。STUDIO受信側も、許可解除後の取消を既存message_id＋group_hashが一致する場合に限って受理する。
- Analyticsは独立したoutbox。片方の接続エラーで他方の処理やalarm予約を抑止しない。

管理者専用の既存 `GET /api/v2/line/settings` の `studioRelay` でenabled、許可グループ件数、状態別件数を確認できる。ID・本文・Secretを表示しない。`sent` はSTUDIOがHTTP成功を返した意味で、素材の検証/生成/同意許可完了とは別。

## 既存サービスへの反映

稼働版は `fix/line-silent-unrelated` の cda29f472392d3b62d0993da64b10b8b4572589f とbundle完全一致を確認した。mainは初期READMEのみなので、mainで既存QRを上書きしない。追加は `feature/studio-line-relay` に保存する。

本番更新前に既存の `npm run cloud:update` の手順どおり、QR管理者バックアップ取得・復元検証・既存Worker所有確認・Secret/DO/assetsの維持を行う。現環境にはQR管理者ログイン情報がなく、バックアップ確認前の本番置換は行わない。既存のQR管理画面からバックアップを取得し、保管/復元確認できる状態にしてから更新する。管理者パスワードやLINEキーをチャットへ送らない。

既存のportable JSONバックアップ形式v4はQR受付データ用であり、この追加の転送outboxを含まない。転送待ちを残した状態のJSONバックアップ/リストアだけでは未送信イベントを復元できない。更新前バックアップは転送OFFのまま取得し、運用後の復旧にはDurable Object全体のSQLite/PITRを別途検証する。転送を有効化する前にこの復旧条件も確認する。

## 今回の検証

2026-10-24 JST: `npm test` 全体成功（114単体＋8 workerd＋15既存ブラウザ＋8運営ブラウザ＋1チケットブラウザ、計146件）、`npm run typecheck` 成功。署名・最小化・重複・日次/保持容量・リダイレクト拒否・期限・stale lease・取消競合・OFF/許可解除後の取消・管理者限定件数表示を含む。実workerdで503を永続保持→プロセス再起動→同じイベントの署名付き再送→成功後本文消去まで検証。LINE実送信やQR本番変更は行っていない。

独立レビューの重要指摘1件（OFF/許可解除後の取消欠落）は再現試験RED→GREENで修正。STUDIO側も既存ソース照合に限った取消受付を追加し、受信側の独立レビューに重大指摘なし。Safari実機・実LINEグループ・本番DO復旧の証明ではない。
