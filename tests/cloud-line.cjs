const test = require("node:test");
const assert = require("node:assert/strict");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { mkdtempSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID, createHmac } = require("node:crypto");
test("actual workerd LINE webhook, ticket page, cancelled QR and durable redelivery", async () => {
  const { Store } = await import("../dist/server/store.js");
  const { hashPassword } = await import("../dist/server/security.js");
  const { exportSnapshot } = await import("../dist/server/migration.js");
  const key = "test-only-worker-line-key-".repeat(3),
    secret = "test-only-line-secret",
    setup = "test-only-bootstrap-".repeat(3),
    origin = "https://line-fixture.example";
  const db = new Store(":memory:");
  const id = db.addUser(
    "operator",
    hashPassword("test-only-password-123"),
    "Admin",
  );
  const actor = { id, role: "Admin", events: [] };
  const event = db.createEvent(
    actor,
    {
      title: "Cloud LINE",
      venue: "Tokyo",
      capacity: 10,
      startsAt: new Date().toISOString(),
      opensAt: new Date(Date.now() - 60000).toISOString(),
      closesAt: new Date(Date.now() + 3600000).toISOString(),
    },
    randomUUID(),
  );
  const snapshot = exportSnapshot(db);
  db.close();
  const dir = mkdtempSync(join(tmpdir(), "qr-line-cloud-"));
  let mf,
    replies = [],
    requested = [];
  const start = () =>
    new Miniflare(
      convertV4MiniflareOptions({
        name: "line-test",
        modules: true,
        scriptPath: resolve("dist/cloudflare-worker/worker.js"),
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          QR_SIGNING_KEY: key,
          QR_SETUP_TOKEN: setup,
          LINE_CHANNEL_ID: "1234567890",
          LINE_CHANNEL_SECRET: secret,
          LINE_CHANNEL_ACCESS_TOKEN: "test-not-real-token",
        },
        durableObjects: {
          QR_DB: { className: "QRReception", useSQLite: true },
        },
        resourcePersistencePath: dir,
        telemetry: { enabled: false },
        outboundService: async (req) => {
          requested.push(req.url);
          assert.equal(new URL(req.url).hostname, "api.line.me");
          if (req.url.includes("/profile/"))
            return Response.json({ displayName: "Cloud attendee" });
          assert.ok(req.url.endsWith("/message/reply"));
          replies.push(await req.json());
          return Response.json({ sentMessages: [] });
        },
        assets: {
          directory: resolve("dist/cloudflare-public"),
          binding: "ASSETS",
          run_worker_first: ["/api/*"],
          routerConfig: { has_user_worker: true },
        },
      }),
    );
  const call = (path, method = "GET", data, cookie = "", extra = {}) =>
    mf.dispatchFetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
        ...extra,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  try {
    mf = start();
    await mf.ready;
    assert.equal(
      (
        await call("/api/v2/setup", "POST", snapshot, "", {
          Authorization: "Bearer " + setup,
        })
      ).status,
      200,
    );
    const login = await call("/api/v2/login", "POST", {
      username: "operator",
      password: "test-only-password-123",
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (
        await call(
          "/api/v2/line/events",
          "POST",
          {
            eventId: event.id,
            enabled: true,
            opensAt: new Date(Date.now() - 86400000).toISOString(),
            closesAt: new Date(Date.now() + 1800000).toISOString(),
          },
          cookie,
        )
      ).status,
      200,
    );
    const data = {
      destination: "U" + "d".repeat(32),
      events: [
        {
          type: "message",
          webhookEventId: randomUUID(),
          replyToken: "test-reply-token",
          timestamp: Date.now(),
          source: { type: "user", userId: "U" + "a".repeat(32) },
          message: { type: "text", text: "参加希望" },
        },
      ],
    };
    const signature = createHmac("sha256", secret)
      .update(JSON.stringify(data))
      .digest("base64");
    assert.equal(
      (
        await call("/api/v2/line/webhook", "POST", data, "", {
          "X-Line-Signature": "bad",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call("/api/v2/line/webhook", "POST", data, "", {
          "X-Line-Signature": signature,
        })
      ).status,
      200,
    );
    for (let i = 0; i < 40 && !replies.length; i++)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      replies.length,
      1,
      JSON.stringify({
        requested,
        settings: await (
          await call("/api/v2/settings", "GET", undefined, cookie)
        ).json(),
      }),
    );
    const token = replies[0].messages[0].text.match(/#([a-f0-9]{64})/)[1];
    const page = await call("/ticket/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("cache-control"), /no-store/);
    const ticket = await call("/api/v2/line/ticket", "GET", undefined, "", {
      Authorization: "Bearer " + token,
    });
    assert.equal(ticket.status, 200);
    const t = await ticket.json();
    assert.equal(t.name, "Cloud attendee");
    assert.match(t.qr, /<svg/);
    assert.equal(t.status, "planned");
    assert.equal(t.token, undefined);
    assert.equal(
      (await call("/api/v2/participants?event=" + event.id)).status,
      401,
    );
    const list = await (
      await call(
        "/api/v2/participants?event=" + event.id,
        "GET",
        undefined,
        cookie,
      )
    ).json();
    assert.equal(list.participants.length, 1);
    assert.equal(list.participants[0].lineLinked, 1);
    assert.equal(
      (
        await call(
          "/api/v2/cancel",
          "POST",
          {
            eventId: event.id,
            participantId: list.participants[0].id,
            reason: "test",
          },
          cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await (
          await call("/api/v2/line/ticket", "GET", undefined, "", {
            Authorization: "Bearer " + token,
          })
        ).json()
      ).status,
      "cancelled",
    );
    await mf.dispose();
    mf = start();
    await mf.ready;
    assert.equal(
      (
        await call("/api/v2/line/webhook", "POST", data, "", {
          "X-Line-Signature": signature,
        })
      ).status,
      200,
    );
    assert.equal(replies.length, 1);
    const backup = await (
      await call("/api/v2/backup", "GET", undefined, cookie)
    ).json();
    assert.equal(backup.schemaVersion, 3);
    assert.equal(backup.tables.line_webhooks.length, 1);
    assert.ok(!JSON.stringify(backup).includes("test-reply-token"));
  } finally {
    await mf?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
