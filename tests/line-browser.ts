import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { chromium, webkit, expect } from "playwright/test";
const server = createServer((req, res) => {
  const files: Record<string, string> = {
    "/assets/unity-logo.webp": "../assets/unity-logo.webp",
    "/ticket/": "ticket.html",
    "/ticket/ticket.js": "ticket.js",
    "/ticket/ticket.css": "ticket.css",
  };
  const file =
    files[req.url || ""] ||
    (
      {
        "/ops/": "../ops/index.html",
        "/ops/app.js": "../ops/app.js",
        "/ops/scanner.js": "../ops/scanner.js",
        "/ops/decoder.js": "../ops/decoder.js",
        "/ops/style.css": "../ops/style.css",
      } as Record<string, string>
    )[req.url || ""];
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader(
    "Content-Type",
    file.endsWith(".webp")
      ? "image/webp"
      : file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html",
  );
  res.end(readFileSync("public/" + file));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + (server.address() as any).port;
const engine = process.env.BROWSER_ENGINE === "webkit" ? webkit : chromium;
const browser = await engine.launch({
  headless: true,
  executablePath:
    engine === chromium
      ? process.env.CHROMIUM_EXECUTABLE_PATH ||
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined)
      : process.env.WEBKIT_EXECUTABLE_PATH,
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let calls = 0,
    status = "planned",
    fail = false;
  await page.route("**/api/v2/line/ticket", (route) => {
    calls++;
    assert.equal(
      route.request().headers().authorization,
      "Bearer " + "a".repeat(64),
    );
    assert.ok(!route.request().url().includes("a".repeat(64)));
    if (fail) return route.abort("failed");
    return route.fulfill({
      json: {
        name: "<script>evil</script>",
        event: {
          title: "UNITY NIGHT",
          venue: "Tokyo",
          startsAt: new Date().toISOString(),
        },
        status,
        qr: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="white"/></svg>',
      },
    });
  });
  await page.goto(origin + "/ticket/#" + "a".repeat(64));
  await page.locator("#qr").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#name").textContent(),
    "<script>evil</script>",
  );
  assert.equal(await page.locator("#content script").count(), 0);
  assert.ok(await page.locator("#qr").getAttribute("src"));
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.goto(origin + "/ticket/#bad");
  await page.locator("#status").filter({ hasText: "リンク" }).waitFor();
  assert.equal(calls, 1);
  for (const next of ["upcoming", "checkedIn", "cancelled", "closed"]) {
    status = next;
    await page.goto(origin + "/ticket/#" + "a".repeat(64));
    await page.locator("#retry").click();
    await page.waitForFunction(
      () => !document.querySelector("button")?.disabled,
    );
    assert.equal(await page.locator("#qrArea").isVisible(), false);
    assert.ok(
      !(await page.locator("#status").textContent())?.includes(
        "確認しています",
      ),
    );
  }
  status = "planned";
  fail = true;
  await page.locator("#retry").click();
  await page.waitForFunction(() => !document.querySelector("button")?.disabled);
  assert.equal(await page.locator("#qrArea").isVisible(), false);
  fail = false;
  await page.locator("#retry").click();
  await page.locator("#qr").waitFor({ state: "visible" });
  const ops = await browser.newPage();
  const writes: any[] = [];
  let configured = false,
    mapped = false;
  const formDate = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const event = {
    id: "event-1",
    title: "UNITY NIGHT",
    venue: "Tokyo",
    startsAt: new Date().toISOString(),
    opensAt: new Date().toISOString(),
    closesAt: new Date(Date.now() + 3600000).toISOString(),
    capacity: 50,
    checkedIn: 0,
    waiting: 0,
    cancelled: 0,
  };
  await ops.route("**/api/v2/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    let json: any = {};
    if (path.endsWith("/session"))
      json = { role: "Admin", username: "operator", pollIntervalMs: 30000 };
    if (path.endsWith("/events") && !path.includes("/line/"))
      json = { events: [event] };
    if (path.endsWith("/participants")) json = { participants: [] };
    if (path.endsWith("/history")) json = { history: [] };
    if (path.endsWith("/settings"))
      json = {
        users: [],
        sync: { pending: 0, failed: 0, runs: [] },
        analyticsEventsConnected: true,
        forms: {
          configured: true,
          enabled: true,
          pending: mapped
            ? []
            : [
                {
                  externalEventId: "source-id",
                  eventDate: formDate,
                  eventName: "Accepted form event",
                  count: 1,
                },
              ],
          mappings: [],
        },
        line: {
          configured: true,
          channelIdConfigured: true,
          events: configured
            ? [
                {
                  eventId: event.id,
                  enabled: true,
                  opensAt: event.opensAt,
                  closesAt: event.closesAt,
                },
              ]
            : [],
          deliveries: [],
        },
      };
    if (path.endsWith("/form/map")) {
      writes.push(body);
      mapped = true;
      json = { ok: true };
    }
    if (path.endsWith("/line/events")) {
      writes.push(body);
      configured = true;
    }
    if (path.endsWith("/analytics-events")) {
      writes.push(body);
      json = body.preview
        ? {
            preview: { events: 1, skipped: 0 },
            snapshot: [{ id: "source-event" }],
          }
        : { events: 1, skipped: 0 };
    }
    await route.fulfill({ json });
  });
  await ops.goto(origin + "/ops/");
  await ops.locator('[data-view="settings"]').click();
  await ops.locator('[data-action="lineEvent"]').click();
  await ops.locator('[name="enabled"]').check();
  await ops.locator("#lineEventForm button").click();
  await expect(ops.locator("#modal")).not.toBeVisible();
  assert.equal(writes[0].eventId, event.id);
  assert.equal(writes[0].enabled, true);
  assert.ok(writes[0].opensAt.endsWith("Z"));
  await ops.locator('[data-action="analyticsEvents"]').click();
  await ops.locator('[name="venue"]').fill("Verified venue");
  await ops.locator('[name="capacity"]').fill("80");
  await ops.locator("#analyticsEventsForm button").click();
  await ops.locator("#confirmAnalyticsEvents").click();
  await expect(ops.locator("#modal")).not.toBeVisible();
  assert.deepEqual(writes[2], {
    venue: "Verified venue",
    capacity: 80,
    preview: false,
    events: [{ id: "source-event" }],
  });
  await ops.locator('[data-action="formMap"]').click();
  await ops.locator("#formMapForm button").click();
  await expect(ops.locator("#modal")).not.toBeVisible();
  assert.deepEqual(writes[3], {
    eventId: event.id,
    externalEventId: "source-id",
    eventDate: formDate,
  });
  console.log(
    "LINE ticket browser: safe participant display, bearer-only token, QR rendering, responsive layout, invalid link passed",
  );
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
}
