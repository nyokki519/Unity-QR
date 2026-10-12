import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { importOwnedSnapshot } from "../server/migration.js";
import {
  assertFreeSubscriptions,
  assertDeploymentOwnership,
  runWrangler,
} from "./cloud-deploy.js";
import { cloudApi, hiddenInput, readDeploymentState } from "./cloud-auth.js";
export function validateCloudUpdateState(state: any) {
  if (
    state?.application !== "unity-qr-cloud-deploy-v1" ||
    state.complete !== true ||
    !/^unity-qr-free-[a-f0-9]{12}$/.test(state.name) ||
    !/^[a-f0-9]{32}$/.test(state.ownerId) ||
    !/^[a-f0-9]{32}$/.test(state.accountId)
  )
    throw new Error("完了済みの公開設定が必要です。初回移行は再実行しません。");
  const url = new URL(state.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname.startsWith(state.name + ".") ||
    !url.hostname.endsWith(".workers.dev")
  )
    throw new Error("公開先が既存Workerと一致しません。");
  return { ...state, url: url.origin } as {
    name: string;
    ownerId: string;
    accountId: string;
    url: string;
  };
}
async function main() {
  process.umask(0o077);
  const state = validateCloudUpdateState(readDeploymentState());
  const { identity, api } = await cloudApi();
  if (!identity.accounts?.some((a: any) => a.id === state.accountId))
    throw new Error("既存公開先のアカウントにアクセスできません。");
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
  console.log(
    "更新前の受付DBを取得・復元検証します。更新中は新しい受付を行わないでください。",
  );
  const username = process.env.QR_ADMIN_USER || "operator";
  const password = await hiddenInput("既存の管理者パスワード");
  const login = await fetch(state.url + "/api/v2/login", {
    method: "POST",
    headers: { Origin: state.url, "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!login.ok || !cookie)
    throw new Error("管理者ログインに失敗しました。更新はしていません。");
  let backupPath: string;
  try {
    const response = await fetch(state.url + "/api/v2/backup", {
      headers: { Cookie: cookie },
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok || !response.body)
      throw new Error("バックアップ取得に失敗しました。更新を中止しました。");
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 5 * 1024 * 1024) {
        await reader.cancel();
        throw new Error(
          "自動復元検証の5MB上限を超えています。更新を中止しました。",
        );
      }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks),
      snapshot = JSON.parse(raw.toString());
    const copy = new Store(":memory:");
    try {
      importOwnedSnapshot(copy, snapshot);
    } finally {
      copy.close();
    }
    mkdirSync("data/cloud-backups", { recursive: true, mode: 0o700 });
    backupPath = resolve(
      "data/cloud-backups/" + Date.now() + "-" + randomUUID() + ".json",
    );
    writeFileSync(backupPath, raw, { flag: "wx", mode: 0o600 });
  } finally {
    await fetch(state.url + "/api/v2/logout", {
      method: "POST",
      headers: { Origin: state.url, Cookie: cookie },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  }
  console.log("バックアップ取得・復元検証済み: " + backupPath);
  await runWrangler(
    [
      "deploy",
      "--name",
      state.name,
      "--var",
      "QR_DEPLOYMENT_ID:" + state.ownerId,
    ],
    { accountId: state.accountId },
  );
  assertDeploymentOwnership(
    true,
    state.ownerId,
    await api(
      `/accounts/${state.accountId}/workers/scripts/${state.name}/settings`,
    ),
    true,
  );
  const health = await fetch(state.url + "/api/v2/health", {
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!health.ok || ((await health.json()) as any).service !== "unity-qr")
    throw new Error(
      "更新後の起動確認に失敗しました。バックアップは保持しています。",
    );
  console.log(
    "更新完了: " +
      state.url +
      "/ops/\n受付データ・署名鍵・既存secretsを維持しました。",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "更新できませんでした。",
    );
    process.exitCode = 1;
  });
