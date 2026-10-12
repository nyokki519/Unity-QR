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
  if (analytics) {
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
    analytics
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
