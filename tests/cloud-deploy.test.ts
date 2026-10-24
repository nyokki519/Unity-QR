import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { hashPassword } from "../server/security.js";
import {
  assertFreeSubscriptions,
  prepareMigration,
  verifyMigrationReceipt,
  runWrangler,
  assertDeploymentOwnership,
} from "../scripts/cloud-deploy.js";

test("publication accepts Workers Free only and refuses paid or unknown Workers subscriptions", () => {
  assert.doesNotThrow(() => assertFreeSubscriptions([]));
  assert.doesNotThrow(() =>
    assertFreeSubscriptions([
      { rate_plan: { id: "free", public_name: "Workers Free" }, price: 0 },
    ]),
  );
  assert.doesNotThrow(() =>
    assertFreeSubscriptions([
      { rate_plan: { id: "pro", public_name: "Zone Pro", scope: "zone" } },
    ]),
  );
  assert.throws(
    () =>
      assertFreeSubscriptions([
        { rate_plan: { id: "workers_paid", public_name: "Workers Paid" } },
      ]),
    /Workers Free/,
  );
  assert.throws(
    () =>
      assertFreeSubscriptions([
        { rate_plan: { id: "workers_unknown", public_name: "Workers" } },
      ]),
    /Workers Free/,
  );
  assert.throws(() => assertFreeSubscriptions({}), /プラン/);
});
test("free-plan proof uses known plan fields, never incidental descriptions or unknown records", () => {
  assert.throws(
    () =>
      assertFreeSubscriptions([
        {
          rate_plan: {
            id: "workers_standard",
            public_name: "Workers Standard",
          },
          description: "Includes free requests",
        },
      ]),
    /Workers Free/,
  );
  assert.throws(() => assertFreeSubscriptions([null]), /プラン/);
  assert.throws(
    () =>
      assertFreeSubscriptions([
        {
          rate_plan: {
            id: "workers_mystery",
            public_name: "Workers Free trial",
          },
        },
      ]),
    /Workers Free/,
  );
});
test("interrupted deployment only recovers a remotely verified owner and never overwrites a conflicting Worker", () => {
  const owner = "test-owner-" + "a".repeat(32);
  assert.doesNotThrow(() => assertDeploymentOwnership(false, owner, undefined));
  assert.throws(
    () => assertDeploymentOwnership(false, owner, undefined, true),
    /所有/,
  );
  assert.throws(
    () => assertDeploymentOwnership(true, owner, { bindings: [] }),
    /所有/,
  );
  assert.throws(
    () =>
      assertDeploymentOwnership(true, owner, {
        bindings: [
          {
            name: "QR_DEPLOYMENT_ID",
            type: "plain_text",
            text: "someone-else",
          },
        ],
      }),
    /所有/,
  );
  assert.doesNotThrow(() =>
    assertDeploymentOwnership(true, owner, {
      bindings: [{ name: "QR_DEPLOYMENT_ID", type: "plain_text", text: owner }],
    }),
  );
});

test("migration preparation backs up online without modifying the source DB and retains a private snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qr-publish-source-"));
  const path = join(dir, "source.sqlite"),
    out = join(dir, "migration");
  const db = new Store(path);
  try {
    db.addUser("operator", hashPassword("test-publish-password-123"), "Admin");
    const before = db.rows("SELECT * FROM audit");
    const prepared = await prepareMigration(path, out);
    assert.ok(existsSync(prepared.backupPath));
    assert.ok(existsSync(prepared.snapshotPath));
    assert.equal(prepared.snapshot.tables.users[0].username, "operator");
    assert.deepEqual(db.rows("SELECT * FROM audit"), before);
    assert.equal(prepared.snapshot.tables.audit.length, before.length);
    assert.doesNotThrow(() =>
      verifyMigrationReceipt(prepared.snapshot, {
        fingerprint: prepared.fingerprint,
        counts: Object.fromEntries(
          Object.entries(prepared.snapshot.tables).map(([table, rows]) => [
            table,
            rows.length,
          ]),
        ),
      }),
    );
    assert.throws(
      () =>
        verifyMigrationReceipt(prepared.snapshot, {
          fingerprint: "wrong",
          counts: {},
        }),
      /移行結果/,
    );
    await assert.rejects(
      () => prepareMigration(join(dir, "missing.sqlite"), out),
      /見つかりません/,
    );
    assert.equal(existsSync(join(dir, "missing.sqlite")), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("capturing the supported Wrangler auth command never writes a credential-bearing debug log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qr-wrangler-log-"));
  const names = ["CLOUDFLARE_API_TOKEN", "WRANGLER_LOG_PATH"];
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  try {
    process.env.CLOUDFLARE_API_TOKEN = "test-only-not-a-working-credential";
    process.env.WRANGLER_LOG_PATH = join(dir, "logs");
    const result = JSON.parse(
      await runWrangler(["auth", "token", "--json"], { capture: true }),
    );
    assert.equal(result.token, "test-only-not-a-working-credential");
    assert.equal(existsSync(join(dir, "logs")), false);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completed production cannot be updated through initial migration helper without fresh backup", async () => {
  const { writeFileSync, mkdirSync, readFileSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const { digest } = await import("../server/security.js");
  const dir = mkdtempSync(join(tmpdir(), "qr-completed-deploy-"));
  try {
    mkdirSync(join(dir, "data/cloud-migration"), { recursive: true });
    const signing = "test-only-completed-key-".repeat(3);
    writeFileSync(join(dir, "data/iphone-test-signing.key"), signing);
    const path = join(dir, "data/cloud-migration/deployment.json");
    const original = JSON.stringify({
      application: "unity-qr-cloud-deploy-v1",
      name: "unity-qr-free-123456789abc",
      ownerId: "a".repeat(32),
      signingDigest: digest(signing),
      complete: true,
    });
    writeFileSync(path, original);
    const result = spawnSync(
      process.execPath,
      [resolve("dist/scripts/cloud-deploy.js")],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          QR_SIGNING_KEY: signing,
          WRANGLER_WRITE_LOGS: "false",
          WRANGLER_SEND_METRICS: "false",
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cloud:update/);
    assert.equal(readFileSync(path, "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
