import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { runWrangler } from "./cloud-deploy.js";
export async function hiddenInput(prompt: string) {
  if (!process.stdin.isTTY)
    throw new Error(
      "対話ターミナルから実行してください。秘密情報はチャットへ送らないでください。",
    );
  process.stderr.write(prompt + ": ");
  const output = new Writable({
    write(_chunk, _encoding, cb) {
      cb();
    },
  });
  const reader = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  try {
    return await reader.question("");
  } finally {
    reader.close();
    process.stderr.write("\n");
  }
}
export async function cloudApi() {
  let identity: any;
  try {
    identity = JSON.parse(
      await runWrangler(["whoami", "--json"], { capture: true }),
    );
  } catch {
    await runWrangler(["login"]);
    identity = JSON.parse(
      await runWrangler(["whoami", "--json"], { capture: true }),
    );
  }
  const auth = JSON.parse(
    await runWrangler(["auth", "token", "--json"], { capture: true }),
  );
  const headers: Record<string, string> =
    auth.type === "api_key"
      ? { "X-Auth-Key": auth.key, "X-Auth-Email": auth.email }
      : { Authorization: "Bearer " + auth.token };
  return {
    identity,
    api: async (path: string) => {
      const r = await fetch("https://api.cloudflare.com/client/v4" + path, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok)
        throw new Error(
          "Cloudflare確認に失敗しました（HTTP " +
            r.status +
            "）。Account Billing Readを含む公開用トークンの権限を確認してください。",
        );
      const body: any = await r.json();
      if (!body.success) throw new Error("Cloudflare設定を確認できません。");
      return body.result;
    },
  };
}
export function readDeploymentState() {
  return JSON.parse(
    readFileSync("data/cloud-migration/deployment.json", "utf8"),
  );
}
