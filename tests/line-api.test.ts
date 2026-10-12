import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { createApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { hashPassword } from "../server/security.js";
test("LINE endpoints preserve admin authorization, CSRF, public isolation and bounded signed webhook", async () => {
  const db = new Store(":memory:");
  db.addUser("operator", hashPassword("test-only-password-123"), "Admin");
  const ev = db.createEvent(
    { id: "test", role: "Admin", events: [] },
    {
      title: "API LINE",
      venue: "Tokyo",
      capacity: 10,
      startsAt: new Date().toISOString(),
      opensAt: new Date().toISOString(),
      closesAt: new Date(Date.now() + 3600000).toISOString(),
    },
    randomUUID(),
  );
  db.addUser("viewer", hashPassword("test-only-password-123"), "Viewer", [
    ev.id,
  ]);
  const cfg: any = {
    origin: "http://127.0.0.1",
    root: process.cwd(),
    signingKey: "test-only-line-api-key-".repeat(3),
  };
  const app = createApp(db, cfg);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  cfg.origin = "http://127.0.0.1:" + (app.address() as any).port;
  const call = (
    path: string,
    method = "GET",
    data?: any,
    cookie = "",
    origin = cfg.origin,
    extra: any = {},
  ) =>
    fetch(cfg.origin + path, {
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
    assert.equal((await call("/api/v2/line/events", "POST", {})).status, 401);
    const login = await call("/api/v2/login", "POST", {
      username: "viewer",
      password: "test-only-password-123",
    });
    const viewer = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await call("/api/v2/line/events", "POST", {}, viewer)).status,
      403,
    );
    assert.equal(
      (await call("/api/v2/analytics-events", "POST", {}, viewer)).status,
      403,
    );
    assert.equal((await call("/api/v2/line/ticket")).status, 404);
    assert.equal((await call("/api/v2/line/webhook", "POST", {})).status, 503);
    cfg.lineChannelSecret = "test-only-secret";
    cfg.lineChannelId = "1234567890";
    cfg.lineAccessToken = "test-not-real-token";
    const data = { destination: "U" + "d".repeat(32), events: [] };
    assert.equal(
      (
        await call(
          "/api/v2/line/webhook",
          "POST",
          data,
          "",
          "https://line.example",
          { "X-Line-Signature": "bad" },
        )
      ).status,
      401,
    );
    const sig = createHmac("sha256", cfg.lineChannelSecret)
      .update(JSON.stringify(data))
      .digest("base64");
    assert.equal(
      (
        await call(
          "/api/v2/line/webhook",
          "POST",
          data,
          "",
          "https://line.example",
          { "X-Line-Signature": sig },
        )
      ).status,
      200,
    );
    assert.equal(
      (await call("/api/v2/line/webhook", "POST", { text: "x".repeat(300000) }))
        .status,
      413,
    );
    const page = await call("/ticket/");
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    assert.match(page.headers.get("cache-control")!, /no-store/);
    assert.ok(!(await page.text()).includes(cfg.lineAccessToken));
    const adminLogin = await call("/api/v2/login", "POST", {
      username: "operator",
      password: "test-only-password-123",
    });
    const admin = adminLogin.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await call(
          "/api/v2/line/events",
          "POST",
          {},
          admin,
          "https://evil.example",
        )
      ).status,
      403,
    );
    const settings = (await (
      await call("/api/v2/settings", "GET", undefined, admin)
    ).json()) as any;
    assert.equal(settings.line.configured, true);
    assert.ok(!JSON.stringify(settings).includes(cfg.lineAccessToken));
    assert.equal(
      (
        await call(
          "/api/v2/analytics-events",
          "POST",
          { venue: "Tokyo", capacity: 50 },
          admin,
        )
      ).status,
      503,
    );
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    db.close();
  }
});
