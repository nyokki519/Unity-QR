import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertFreeSubscriptions,
  assertDeploymentOwnership,
  runWrangler,
} from "./cloud-deploy.js";
import { validateCloudUpdateState } from "./cloud-update.js";
import { cloudApi, hiddenInput, readDeploymentState } from "./cloud-auth.js";
async function main() {
  const state = validateCloudUpdateState(readDeploymentState());
  const { api } = await cloudApi();
  assertFreeSubscriptions(
    await api(`/accounts/${state.accountId}/subscriptions`),
  );
  assertDeploymentOwnership(
    true,
    state.ownerId,
    await api(
      `/accounts/${state.accountId}/workers/scripts/${state.name}/settings`,
    ),
    true,
  );
  const analytics = process.argv.includes("--analytics");
  const values: Record<string, string> = {};
  const form = process.argv.includes("--form");
  if (form) {
    process.umask(0o077);
    mkdirSync("data", { recursive: true, mode: 0o700 });
    const path = "data/form-secret.key";
    const key = existsSync(path)
      ? readFileSync(path, "utf8").trim()
      : randomBytes(32).toString("hex");
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error("既存フォーム連携キーの形式を確認してください。");
    if (!existsSync(path))
      writeFileSync(path, key, { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
    if (process.platform !== "darwin")
      throw new Error(
        "Macで実行してください。連携キーはdata/form-secret.keyに安全に保存しています。",
      );
    const copy = spawnSync("pbcopy", [], { input: key });
    if (copy.status !== 0)
      throw new Error(
        "クリップボードにコピーできません。キーをチャットへ送らないでください。",
      );
    values.QR_FORM_SECRET = key;
  } else if (analytics) {
    values.ANALYTICS_OPERATOR_ORIGIN = await hiddenInput(
      "実際のUnity Analytics HTTPS URL（末尾のパスなし）",
    );
    const url = new URL(values.ANALYTICS_OPERATOR_ORIGIN);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("AnalyticsのHTTPS originを指定してください。");
    values.ANALYTICS_OPERATOR_ORIGIN = url.origin;
    values.ANALYTICS_OPERATOR_PASSWORD = await hiddenInput(
      "Analyticsの既存運営パスワード",
    );
    if (values.ANALYTICS_OPERATOR_PASSWORD.length < 16)
      throw new Error("運営パスワードの設定を確認してください。");
  } else {
    values.LINE_CHANNEL_ID = await hiddenInput("Messaging APIチャネルID");
    if (!/^\d{5,20}$/.test(values.LINE_CHANNEL_ID))
      throw new Error("実際のMessaging APIチャネルIDが必要です。");
    values.LINE_CHANNEL_SECRET = await hiddenInput(
      "Messaging APIチャネルシークレット",
    );
    values.LINE_CHANNEL_ACCESS_TOKEN = await hiddenInput(
      "Messaging APIチャネルアクセストークン",
    );
    if (!values.LINE_CHANNEL_SECRET || !values.LINE_CHANNEL_ACCESS_TOKEN)
      throw new Error("空の認証情報は登録できません。");
    const info = await fetch("https://api.line.me/v2/bot/info", {
      headers: { Authorization: "Bearer " + values.LINE_CHANNEL_ACCESS_TOKEN },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!info.ok)
      throw new Error(
        "LINEのアクセストークンを確認できません。設定を中止しました。",
      );
  }
  await runWrangler(["secret", "bulk", "--name", state.name], {
    accountId: state.accountId,
    input: JSON.stringify(values),
  });
  console.log(
    form
      ? "フォーム連携キーをCloudflareへ保存し、クリップボードへコピーしました。GoogleフォームのApps Scriptで、スクリプトプロパティ QR_FORM_SECRET に貼り付けてください。キーはここに表示しません。"
      : analytics
        ? "Analyticsの接続設定を保存しました。管理画面でイベント取込を確認してください。"
        : "LINE設定を保存しました。Webhook URL: " +
          state.url +
          "/api/v2/line/webhook\nLINE側でWebhookを有効にして接続検証し、専用テストイベントで「参加希望」を送ってください。",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "設定できませんでした。",
    );
    process.exitCode = 1;
  });
