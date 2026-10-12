import { spawn } from "node:child_process";
import { DatabaseSync, backup } from "node:sqlite";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { Store } from "../server/store.js";
import { digest, secret } from "../server/security.js";
import { exportSnapshot, type OwnedSnapshot } from "../server/migration.js";

export function assertFreeSubscriptions(subscriptions: unknown) {
  if (!Array.isArray(subscriptions))
    throw new Error("Cloudflareのプランを確認できません。公開を中止しました。");
  for (const subscription of subscriptions) {
    if (
      !subscription ||
      typeof subscription !== "object" ||
      !subscription.rate_plan ||
      typeof subscription.rate_plan.id !== "string" ||
      !subscription.rate_plan.id ||
      (subscription.rate_plan.public_name !== undefined &&
        typeof subscription.rate_plan.public_name !== "string")
    )
      throw new Error(
        "Cloudflareのプラン情報を確認できません。公開を中止しました。",
      );
    const plan = subscription.rate_plan;
    const label = (plan.public_name || "").trim().toLowerCase();
    // Account subscriptions may include zone products. They do not grant paid Workers.
    if (plan.scope === "zone" && !label.includes("worker")) continue;
    if (["Cancelled", "Expired", "Failed"].includes(subscription.state))
      continue;
    // 'free' is the documented RatePlan ID; do not infer it from a description.
    if (
      plan.id !== "free" ||
      (label && !["free", "workers free"].includes(label)) ||
      plan.is_contract === true ||
      (subscription.price !== undefined && subscription.price !== 0)
    )
      throw new Error(
        "Workers Free以外の契約を検出しました。課金を避けるため公開を中止しました。",
      );
  }
}
export function assertDeploymentOwnership(
  exists: boolean,
  owner: string,
  settings: any,
  requireExisting = false,
) {
  if (!exists && !requireExisting) return;
  if (
    !exists ||
    !Array.isArray(settings?.bindings) ||
    !settings.bindings.some(
      (binding: any) =>
        binding.name === "QR_DEPLOYMENT_ID" &&
        binding.type === "plain_text" &&
        binding.text === owner,
    )
  )
    throw new Error(
      "公開先の所有を確認できません。既存Workerを上書きせず中止しました。",
    );
}
export function verifyMigrationReceipt(snapshot: OwnedSnapshot, receipt: any) {
  if (
    receipt?.fingerprint !== digest(JSON.stringify(snapshot)) ||
    !receipt.counts ||
    Object.keys(receipt.counts).sort().join() !==
      Object.keys(snapshot.tables).sort().join() ||
    Object.entries(snapshot.tables).some(
      ([table, rows]) => receipt.counts[table] !== rows.length,
    )
  )
    throw new Error(
      "移行結果を確認できません。Macのバックアップを保持して中止しました。",
    );
}
export async function prepareMigration(sourcePath: string, output: string) {
  if (!existsSync(sourcePath))
    throw new Error(
      "Macの受付DBが見つかりません。QR_DB_PATHに既存のDBを指定してください。",
    );
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const suffix = Date.now() + "-" + randomBytes(4).toString("hex");
  const backupPath = join(output, `before-cloud-${suffix}.sqlite`);
  const snapshotPath = join(output, `migration-${suffix}.json`);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const id = (source.prepare("PRAGMA application_id").get() as any)
      .application_id;
    const version = (source.prepare("PRAGMA user_version").get() as any)
      .user_version;
    if (id !== 0x55515232 || ![1, 2, 3].includes(version))
      throw new Error(
        "Unity QRの対応DBではありません。元データは変更しません。",
      );
    if (
      (source.prepare("PRAGMA integrity_check").get() as any)
        .integrity_check !== "ok" ||
      source.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("元DBの整合性を確認できません。");
    await backup(source, backupPath);
  } finally {
    source.close();
  }
  chmodSync(backupPath, 0o600);
  const copy = new Store(backupPath);
  let snapshot: OwnedSnapshot;
  try {
    snapshot = exportSnapshot(copy);
  } finally {
    copy.close();
  }
  if (!snapshot.tables.users.some((u) => u.role === "Admin" && u.enabled === 1))
    throw new Error(
      "有効な管理者がいません。Mac側のAdmin登録を確認してください。",
    );
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 5 * 1024 * 1024)
    throw new Error(
      "DBが自動移行の5MB上限を超えています。バックアップは保存しました。",
    );
  writeFileSync(snapshotPath, JSON.stringify(snapshot), {
    flag: "wx",
    mode: 0o600,
  });
  return {
    backupPath,
    snapshotPath,
    snapshot,
    fingerprint: digest(JSON.stringify(snapshot)),
  };
}

type DeployState = {
  application: "unity-qr-cloud-deploy-v1";
  name: string;
  ownerId: string;
  signingDigest: string;
  setupToken: string;
  snapshotPath: string;
  backupPath: string;
  accountId?: string;
  started?: boolean;
  url?: string;
  imported?: boolean;
  complete?: boolean;
};
const wranglerBin = resolve("node_modules/wrangler/bin/wrangler.js");
function run(
  args: string[],
  options: { capture?: boolean; input?: string; accountId?: string } = {},
) {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [wranglerBin, ...args], {
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_WRITE_LOGS: "false",
        WRANGLER_LOG_SANITIZE: "true",
        ...(options.accountId
          ? { CLOUDFLARE_ACCOUNT_ID: options.accountId }
          : {}),
      },
      stdio: [
        options.input === undefined ? "inherit" : "pipe",
        options.capture ? "pipe" : "inherit",
        options.capture ? "pipe" : "inherit",
      ],
    });
    let output = "";
    if (options.capture)
      child.stdout!.on("data", (chunk) => {
        output += chunk;
      });
    // Captured commands can contain auth credentials. Never print captured output or errors.
    if (options.capture) child.stderr!.resume();
    child.on("error", () =>
      reject(new Error("Wranglerを起動できません。npm ciを実行してください。")),
    );
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(output)
        : reject(
            new Error(
              `Wranglerの${args[0]}処理に失敗しました（終了コード ${code}）。`,
            ),
          ),
    );
    if (options.input !== undefined) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(options.input);
    }
  });
}
export { run as runWrangler };
async function main() {
  process.umask(0o077);
  const folder = resolve("data/cloud-migration");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const statePath = join(folder, "deployment.json");
  const signingKey = secret(
    process.env.QR_SIGNING_KEY ||
      (existsSync("data/iphone-test-signing.key")
        ? readFileSync("data/iphone-test-signing.key", "utf8").trim()
        : undefined),
  );
  let state: DeployState;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, "utf8"));
    if (
      state.application !== "unity-qr-cloud-deploy-v1" ||
      !/^unity-qr-free-[a-f0-9]{12}$/.test(state.name) ||
      !/^[a-f0-9]{32}$/.test(state.ownerId) ||
      state.signingDigest !== digest(signingKey)
    )
      throw new Error(
        "公開設定または署名キーが以前と異なります。既存クラウドを変更せず中止しました。",
      );
  } else {
    const candidates = ["data/iphone-test.sqlite", "data/qr.sqlite"].filter(
      existsSync,
    );
    const sourcePath =
      process.env.QR_DB_PATH ||
      (candidates.length === 1 ? candidates[0] : undefined);
    if (!sourcePath)
      throw new Error(
        "移行元DBを一意に選べません。QR_DB_PATHに実際に使っているDBを指定してください。",
      );
    console.log(
      "Macの受付DBをバックアップします。移行中は旧URLで新しい受付を行わないでください。",
    );
    const prepared = await prepareMigration(resolve(sourcePath), folder);
    state = {
      application: "unity-qr-cloud-deploy-v1",
      name: "unity-qr-free-" + randomBytes(6).toString("hex"),
      ownerId: randomBytes(16).toString("hex"),
      signingDigest: digest(signingKey),
      setupToken: randomBytes(32).toString("hex"),
      snapshotPath: prepared.snapshotPath,
      backupPath: prepared.backupPath,
    };
  }
  if (state.complete === true)
    throw new Error("既存クラウドの更新には npm run cloud:update を使ってください。初回移行で本番を上書きしません。");
  const save = () =>
    writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  save();
  let identity: any;
  try {
    identity = JSON.parse(await run(["whoami", "--json"], { capture: true }));
  } catch {
    console.log(
      "ブラウザでCloudflareにログインし、Wranglerへのアクセスを許可してください。",
    );
    await run(["login"]);
    identity = JSON.parse(await run(["whoami", "--json"], { capture: true }));
  }
  if (
    !identity.loggedIn ||
    !Array.isArray(identity.accounts) ||
    !identity.accounts.length
  )
    throw new Error("利用できるCloudflareアカウントがありません。");
  let account = identity.accounts.find(
    (a: any) => a.id === (state.accountId || process.env.CLOUDFLARE_ACCOUNT_ID),
  );
  if ((state.accountId || process.env.CLOUDFLARE_ACCOUNT_ID) && !account)
    throw new Error("指定したCloudflareアカウントへアクセスできません。");
  if (!account && identity.accounts.length === 1)
    account = identity.accounts[0];
  if (!account) {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      identity.accounts.forEach((a: any, i: number) =>
        console.log(`${i + 1}: ${a.name}`),
      );
      const n = Number(await prompt.question("公開先の番号: "));
      account = identity.accounts[n - 1];
    } finally {
      prompt.close();
    }
  }
  if (!account || typeof account.id !== "string")
    throw new Error("公開先を選択できませんでした。");
  state.accountId = account.id;
  save();
  // Supported Wrangler auth command; credentials stay in process memory, never files/logs.
  const auth = JSON.parse(
    await run(["auth", "token", "--json"], { capture: true }),
  );
  const authHeaders: Record<string, string> =
    auth.type === "api_key"
      ? { "X-Auth-Key": auth.key, "X-Auth-Email": auth.email }
      : { Authorization: "Bearer " + auth.token };
  const api = async (path: string) => {
    const response = await fetch(
      "https://api.cloudflare.com/client/v4" + path,
      {
        headers: authHeaders,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok)
      throw new Error(
        `Cloudflareの設定確認に失敗しました（HTTP ${response.status}）。公開を中止しました。`,
      );
    const body: any = await response.json();
    if (!body.success)
      throw new Error("Cloudflareの設定を確認できません。公開を中止しました。");
    return body.result;
  };
  assertFreeSubscriptions(await api(`/accounts/${account.id}/subscriptions`));
  console.log(
    "Workers Freeを確認しました。有料プラン・有料リソースは作成しません。",
  );
  const existing = await api(`/accounts/${account.id}/workers/scripts`);
  if (!Array.isArray(existing))
    throw new Error("既存Workerの確認に失敗しました。");
  const remoteExists = existing.some((item: any) => item.id === state.name);
  const remoteSettings = remoteExists
    ? await api(
        `/accounts/${account.id}/workers/scripts/${state.name}/settings`,
      )
    : undefined;
  assertDeploymentOwnership(
    remoteExists,
    state.ownerId,
    remoteSettings,
    false,
  );
  state.started = true;
  save();
  await run(
    [
      "deploy",
      "--name",
      state.name,
      "--var",
      `QR_DEPLOYMENT_ID:${state.ownerId}`,
    ],
    { accountId: account.id },
  );
  assertDeploymentOwnership(
    true,
    state.ownerId,
    await api(`/accounts/${account.id}/workers/scripts/${state.name}/settings`),
  );
  const { subdomain } = await api(`/accounts/${account.id}/workers/subdomain`);
  if (typeof subdomain !== "string" || !/^[a-z0-9-]+$/.test(subdomain))
    throw new Error("Cloudflareの公開URLを取得できません。");
  state.url = `https://${state.name}.${subdomain}.workers.dev`;
  save();
  if (!state.complete) {
    await run(["secret", "bulk", "--name", state.name], {
      accountId: account.id,
      input: JSON.stringify({
        QR_SIGNING_KEY: signingKey,
        QR_SETUP_TOKEN: state.setupToken,
      }),
    });
    const snapshot = JSON.parse(
      readFileSync(state.snapshotPath, "utf8"),
    ) as OwnedSnapshot;
    let verified = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await fetch(state.url + "/api/v2/setup", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + state.setupToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(snapshot),
          redirect: "error",
          signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) {
          if (response.status === 409 || response.status === 413)
            throw new Error(
              "移行先が空でない、または移行上限を超えています。上書きはしません。",
            );
          throw new Error("移行APIがまだ利用できません。");
        }
        verifyMigrationReceipt(snapshot, await response.json());
        verified = true;
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!verified) throw new Error("移行を確認できません。");
    state.imported = true;
    save();
    await run(["secret", "bulk", "--name", state.name], {
      accountId: account.id,
      input: JSON.stringify({ QR_SETUP_TOKEN: null }),
    });
    state.complete = true;
    save();
  }
  const health = await fetch(state.url + "/api/v2/health", {
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!health.ok || ((await health.json()) as any).service !== "unity-qr")
    throw new Error(
      "公開後の起動確認に失敗しました。バックアップは保持しています。",
    );
  console.log(
    `\n公開・移行完了: ${state.url}/ops/\nMacで登録した管理者のログイン名・パスワードを使えます。\n元DBとバックアップを残しました。以後はこのクラウドURLで受付してください。`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "公開に失敗しました。",
    );
    process.exitCode = 1;
  });
}
