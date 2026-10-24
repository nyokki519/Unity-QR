# operatorログイン調査・復旧手順（2026-10-24 JST）

## 現時点の結論

原因未確定、復旧未確認。利用者が確認した `POST /api/v2/login` の `401 {"error":"unauthorized"}` は、Cookie保存前のID／パスワード照合段階で拒否されたことを示す。Cookie消去や試行制限解除だけで直るとの根拠はない。

今回の作業ではQR本番へ再デプロイ、設定変更、ログイン試行、DB書き込み、初期化、パスワード変更を行っていない。Cloudflare APIへのGETのみで配信モジュールを取得し、前回の制限解除版SHA256との一致、maintenance bindingsなし、同一DO bindingを確認した。既存パスワード・ハッシュ・トークンは出力していない。

## unauthorizedになる条件

`server/app.ts` のlogin分岐はOriginと試行回数を確認し、`ReceptionStore.login` を呼ぶ。ユーザー名は入力文字列の完全一致で、`enabled=1` の行を検索する。パスワードはtrim/Unicode正規化しない。

`server/store-core.ts` はユーザー不在／無効化時にダミーハッシュを使い、照合結果とユーザーの有無を同じ401へまとめる。`server/security.ts` の対応形式は `scrypt$`＋小文字hex32文字のsalt＋`$`＋小文字hex128文字。salt文字列をUTF-8としてNode scryptの既定パラメータで64バイト導出し、timingSafeEqualで比較する。入力パスワードが128文字を超える場合、保存形式不正の場合、不一致の場合はfalse。認証仕様を推測で変えない。

| 状態 | この経路の応答 |
| --- | --- |
| 正確に一致する有効ユーザーがない／ハッシュ不正／照合不一致 | 401 unauthorized |
| 10回の試行制限に到達 | 429 too_many_attempts |
| Origin不一致 | 403 forbidden |
| 入力の型が文字列以外 | 400 invalid_request |
| SQL／暗号APIなどの例外 | 500 operation_failed等 |

ログイン後の別APIも未認証で同じ401を返すため、画面の文言だけでは区別しない。今回は利用者がlogin POSTの401を確認済み。

## 配信差分の切り分け

本番は制限解除だけのmodule（SHA256 `97eb1663a82e54d5f84c01e9e56efbcac8a9d86503c07b93c857cec93bc30b21`）。その元版は `cda29f4` とbundle一致確認済み。今回のローカル診断案・Studio転送は未配信。認証のSQL・scrypt形式が本番と対応ソースで一致することを確認した。ただし、この一致は過去のDB内容や入力パスワードとの一致までは証明しない。

DOは `QR_DB` namespace内の固定名 `unity-qr-v2`。D1用のSQLコマンドや別名の新規DOで代用しない。実Nodeで作ったハッシュをworkerdで照合する既存テストもあるが、本番operatorのハッシュが正常との証明ではない。

## 本番DBへの読み取り経路

通常の `GET /api/v2/backup` は既存Adminセッションが必要。利用者の回答では利用可能な既存バックアップ／Adminセッションは不明・なし。現在の本番moduleには所有者向け診断APIがなく、CloudflareのWorkersソース取得APIからDOのSQLite行は取得できない。

したがって、現時点では本番operatorの存在・enabled・ハッシュ形式、バックアップ取得・復元を**確認できていない**。DB不整合・照合問題のどちらかを断定しない。「原因未確定の段階で再デプロイしない」を守る限り、診断コードの追加配信も実施できない。

### 既存バックアップを確保できた場合

取得日時・本番URL・DO namespace/objectとの対応を非公開で記録する。古いMacの移行用DBを現在の本番データとは扱わない。SQLiteは整合したコピーを使い、WALがある状態で本体だけをコピーしない。私有ディレクトリ700・ファイル600で保管し、バックアップ本文をチャット・Git・Actions artifactへ置かない。

```sh
npm run build
node --disable-warning=ExperimentalWarning dist/scripts/diagnose-operator.js --sqlite /private/path/qr-backup.sqlite
# または既存Unity QRスナップショット
node --disable-warning=ExperimentalWarning dist/scripts/diagnose-operator.js --snapshot /private/path/qr-backup.json
```

出力は存在・該当行数・enabled・Admin・ハッシュ形式・集計件数だけ。SQLiteはreadOnly＋query_onlyで開き、Store/マイグレーションを呼ばない。不在のファイルは作成しない。JSONのintegrity_okはnullで、復元検証済みとの意味ではない。DBのquick_check／foreign_key_checkも完全な復元試験の代わりではない。

本人が入力値との照合を必要とする場合は、本人の対話ターミナルでのみ `--check-password` を追加する。入力は非表示、ネットワークへ送らず、sessionや試行カウンタも作らない。値をコマンド引数・環境変数・ログへ渡さない。結果はpassword_matchesのboolean（照合不能ならnull）だけ。チャットでパスワードを尋ねない。

SQLだけを使える認可済みの読み取り接続向けには `docs/sql/operator-readonly.sql` を用意した。このファイルはSELECTだけで状態を返す。Cloudflare管理画面に任意SQL入力機能があるとは仮定しない。

### 既存経路がない場合の診断案（未承認・未配信）

`fix/operator-readonly-audit` の案は、期限10分以内のランダム一時Secretで既存DOをSELECTだけで読む。通常ユーザー・Cookie認証・パスワードは変更しない。新規DB／namespaceは作らない。変更対象は既存Workerのコードと一時Secret・期限のみ。受付の通常トラフィックは別に動くため、診断が全サービスを書き込み禁止にするわけではない。

以前の保守案はDO起動時に通常初期化を通り、processing webhookの失敗処理等が実行される点が厳密な読み取り専用ではなかった。今回の案は診断パスを通常初期化より前に分岐し、raw SQLのSELECTのみで読み出す。空DBの初期化禁止と、起動後も既存processing行を保持する実workerd回帰試験で確認する。診断のための行更新・migration・throttle解除・alarm作成はしない。

一時キーはネイティブ乱数で生成し、チャット・Git・ログへ出さない。レスポンスを非公開で保存し、4つの状態フラグだけ報告する。バックアップは既存v4 JSONを600で保管し、別のローカルDBへ復元して全テーブル件数等を確認する。検証失敗ならDB修正へ進まない。finallyで元コード・設定へ戻して一時Secretを削除し、元ソース一致とmaintenance bindings 0件を確認する。

この案には「原因未確定で再デプロイしない」の**診断目的だけの例外承認**が必要。承認がなければ実行しない。診断許可は、パスワード／enabledなどのDB修正の許可とは別。

## 原因が分かった後の最小修正（いずれも事前承認・バックアップ復元検証が条件）

| 確認結果 | 次の対応 |
| --- | --- |
| operator不在 | namespace/object・移行履歴・対応バックアップを比較。新規DBや同名ユーザーを直ちに作らない |
| operatorがdisabled | 無効化の監査理由と権限を確認後、既存IDのenabledだけを条件付きで修正する案を提示 |
| ハッシュ形式不正 | 元の正常なバックアップとの対応確認。既存値をログへ出さず、形式を推測変換しない |
| 形式正常・本人のオフライン照合が不一致 | 入力元・移行時期を確認。本人が希望する場合だけ対象1アカウントの安全な再設定案を提示 |
| オフライン一致・本番不一致 | 同じ時点のDO・バンドル・リクエスト入力・Node/workerdの差を合成データで再現し、コード原因を確定する |

修正時は対象の既存ユーザーIDと事前状態を条件にし、他の管理者・参加者・イベント・受付履歴の件数／内容を保持。本人のログイン成功→session取得→既存イベント／受付の閲覧を確認し、通常制限を維持する。実パスワードを自動推測して試すことはしない。

## データ保全状況

QR本番への変更は今回なし。削除・初期化・新規DBへの置換なし。既存データを変更した修復は未実施。本番バックアップ未取得なので、「データ保全をバックアップで検証済み」「復旧済み」とは報告しない。

直前に開始していたStudioの合成アップロードは、設定を元のOFFへ復帰し、合成データの削除完了・残パーツ0・予約容量0を確認して中断した。QR診断より先へは進めていない。

## ローカル検証結果

全144件（109単体＋11 workerd＋15既存ブラウザ＋8運営ブラウザ＋1 LINEブラウザ）と型検査が成功。新規の実ファイル診断8件・厳密な読取専用workerd2件を含む。独立レビューにCritical/Important指摘なし。本番operatorの検証・復旧成功を意味しない。
