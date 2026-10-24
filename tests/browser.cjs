const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium, webkit, expect, devices } = require("playwright/test");

const KEY = "unity-checkin-demo-v2";
const MEMBER = {
  name: "Yuki",
  memberId: "U0001",
  memberSince: "2026",
  authMode: "demo",
};
const EVENT = "2026-10-18-repeaters-night";
const ISO = "2026-10-18T10:30:00.000Z";
const root = process.env.UNITY_TEST_ROOT || path.resolve(__dirname, "..");
const engine = process.env.BROWSER_ENGINE || "chromium";
assert.ok(
  ["chromium", "webkit"].includes(engine),
  "BROWSER_ENGINE must be chromium or webkit",
);
const errors = [];
const server = http.createServer((req, res) => {
  const file = new URL(req.url, "http://localhost").pathname;
  const name = file === "/" ? "index.html" : file.slice(1);
  if (!["index.html", "style.css", "app.js"].includes(name)) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader(
    "Content-Type",
    {
      "index.html": "text/html; charset=utf-8",
      "app.js": "text/javascript",
      "style.css": "text/css",
    }[name],
  );
  res.end(fs.readFileSync(path.join(root, name)));
});
let browser,
  baseURL,
  passed = 0;
async function test(name, run) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: devices["iPhone 13"].userAgent,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await run(page, context);
    passed++;
    console.log(`PASS ${name}`);
  } finally {
    await context.close();
  }
}
async function seed(page, value) {
  await page.goto(baseURL);
  await page.evaluate(
    ({ key, value }) =>
      localStorage.setItem(
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ),
    { key: KEY, value },
  );
}
async function memberPage(page, query = "") {
  await seed(page, { member: MEMBER });
  await page.goto(baseURL + query);
}
async function data(page) {
  return JSON.parse(await page.evaluate((key) => localStorage.getItem(key), KEY));
}
async function noOverflow(page) {
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "horizontal page overflow",
  );
}

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${server.address().port}/`;
  const executablePath =
    process.env.CHROMIUM_EXECUTABLE_PATH ||
    (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  browser = await (engine === "webkit" ? webkit : chromium).launch({
    headless: true,
    ...(engine === "chromium" && executablePath ? { executablePath } : {}),
    ...(engine === "webkit" && process.env.WEBKIT_EXECUTABLE_PATH
      ? { executablePath: process.env.WEBKIT_EXECUTABLE_PATH }
      : {}),
  });
  await test("first registration: empty validation, keyboard submit, persisted member", async (page) => {
    await page.goto(baseURL);
    await expect(page.locator("#welcomeModal")).toBeVisible();
    await expect(page.locator("#nameInput")).toBeFocused();
    await page.locator("#registerBtn").click();
    await expect(page.locator("#nameError")).toBeVisible();
    await page.locator("#nameInput").fill("  Yuki  ");
    await page.locator("#nameInput").press("Enter");
    await expect(page.locator("#welcomeModal")).toBeHidden();
    assert.equal((await data(page)).member.name, "Yuki");
    await page.reload();
    await expect(page.locator("#memberName")).toHaveText("Yuki.");
    await expect(page.locator("#welcomeModal")).toBeHidden();
  });
  await test("check-in completion, receipt, history and duplicate after reload", async (page) => {
    await memberPage(page);
    await page.locator("#checkinBtn").click();
    await expect(page.locator("#checking")).toBeVisible();
    await expect(page.locator("#success")).toBeVisible();
    await expect(page.locator("#closeSuccess")).toBeFocused();
    await expect(page.locator("#successEvent")).toHaveText("REPEATER’S NIGHT");
    await expect(page.locator("#successMember")).toHaveText("MEMBER U0001");
    await expect(page.locator("#successTime")).not.toBeEmpty();
    await expect(page.locator("#eventCount")).toHaveText("1");
    assert.equal(Object.keys((await data(page)).checkins).length, 1);
    const timestamp = (await data(page)).checkins[EVENT];
    await page.locator("#closeSuccess").click();
    await expect(page.locator("#success")).toBeHidden();
    await expect(page.locator("#profileBtn")).toBeFocused();
    await page.reload();
    await expect(page.locator("#checkinBtn")).toBeDisabled();
    await expect(page.locator("#checkinBtn span")).toHaveText(
      "ALREADY CHECKED IN",
    );
    assert.equal((await data(page)).checkins[EVENT], timestamp);
  });
  await test("double click produces only one check-in", async (page) => {
    await memberPage(page);
    await page.evaluate(() => {
      const b = document.querySelector("#checkinBtn");
      b.click();
      b.click();
    });
    await expect(page.locator("#success")).toBeVisible();
    assert.equal(Object.keys((await data(page)).checkins).length, 1);
  });
  await test("existing check-in and MY UNITY navigation", async (page) => {
    await seed(page, {
      member: MEMBER,
      checkins: { [EVENT]: ISO, earlier: "2026-09-01T10:00:00Z" },
    });
    await page.reload();
    await expect(page.locator("#checkinBtn")).toBeDisabled();
    await expect(page.locator("#eventCount")).toHaveText("2");
    await expect(page.locator(".visit")).toHaveCount(2);
    await page.locator("#profileBtn").click();
    await expect(page.locator("#myUnity")).toBeFocused();
    await expect(page.locator("#myUnity")).toBeInViewport();
  });
  await test("no event, including registration and preserved reset query", async (page) => {
    await memberPage(page, "?noevent=1");
    await expect(page.locator("#eventCard")).toBeHidden();
    await expect(page.locator("#noEvent")).toBeVisible();
    await page.goto(baseURL + "?reset=1&noevent=1&event=custom#myUnity");
    assert.ok(page.url().includes("noevent=1"));
    assert.ok(!page.url().includes("reset="));
    await expect(page.locator("#welcomeModal")).toBeVisible();
    await page.locator("#nameInput").fill("Yuki");
    await page.locator("#nameInput").press("Enter");
    await expect(page.locator("#noEvent")).toBeVisible();
  });
  await test("simulated communication error leaves no attendance and allows retry", async (page) => {
    await memberPage(page, "?error=1");
    await page.locator("#checkinBtn").click();
    await expect(page.locator("#toast")).toBeVisible();
    await expect(page.locator("#checking")).toBeHidden();
    await expect(page.locator("#success")).toBeHidden();
    await expect(page.locator("#checkinBtn")).toBeEnabled();
    await expect(page.locator("#eventCount")).toHaveText("0");
    assert.equal(Object.keys((await data(page)).checkins || {}).length, 0);
    await page.goto(baseURL);
    await page.locator("#checkinBtn").click();
    await expect(page.locator("#success")).toBeVisible();
  });
  await test("malformed stored members and history recover without crashes", async (page) => {
    for (const value of [
      "{bad json",
      "[]",
      "42",
      {
        member: MEMBER,
        checkins: { bad: null, invalid: "bad date", good: ISO },
      },
      { member: { name: 1 } },
    ]) {
      await seed(page, value);
      await page.reload();
      if (typeof value === "object" && value.member === MEMBER) {
        await expect(page.locator("#eventCount")).toHaveText("1");
      } else await expect(page.locator("#welcomeModal")).toBeVisible();
    }
  });
  await test("storage access denied shows an actionable registration error", async (page, context) => {
    await context.addInitScript(() => {
      Storage.prototype.getItem = () => {
        throw new DOMException("Blocked", "SecurityError");
      };
    });
    await page.goto(baseURL);
    await expect(page.locator("#toast")).toBeVisible();
    await page.locator("#nameInput").fill("Yuki");
    await page.locator("#nameInput").press("Enter");
    await expect(page.locator("#welcomeModal")).toBeVisible();
    await expect(page.locator("#toast")).toContainText(
      "登録情報を保存できません",
    );
  });
  await test("quota/write failure: registration and check-in remain retryable", async (page) => {
    await page.goto(baseURL);
    await page.evaluate(() => {
      window.originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = () => {
        throw new DOMException("Full", "QuotaExceededError");
      };
    });
    await page.locator("#nameInput").fill("Yuki");
    await page.locator("#nameInput").press("Enter");
    await expect(page.locator("#welcomeModal")).toBeVisible();
    await expect(page.locator("#toast")).toContainText(
      "登録情報を保存できません",
    );
    await page.evaluate(() => {
      Storage.prototype.setItem = window.originalSetItem;
    });
    await page.locator("#nameInput").press("Enter");
    await expect(page.locator("#welcomeModal")).toBeHidden();
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("Full", "QuotaExceededError");
      };
    });
    await page.locator("#checkinBtn").click();
    await expect(page.locator("#toast")).toHaveText(
      "Something went wrong. Please try again.",
    );
    await expect(page.locator("#checkinBtn")).toBeEnabled();
    await expect(page.locator("#eventCount")).toHaveText("0");
    await page.evaluate(() => {
      Storage.prototype.setItem = window.originalSetItem;
    });
    await page.locator("#checkinBtn").click();
    await expect(page.locator("#success")).toBeVisible();
  });
  await test("two tabs preserve other events and prevent duplicate timestamps", async (page, context) => {
    await memberPage(page, "?event=first");
    const other = await context.newPage();
    await other.goto(baseURL + "?event=second");
    await Promise.all([
      page.evaluate(() => document.querySelector("#checkinBtn").click()),
      other.evaluate(() => document.querySelector("#checkinBtn").click()),
    ]);
    await expect(page.locator("#success")).toBeVisible();
    await expect(other.locator("#success")).toBeVisible();
    assert.deepEqual(Object.keys((await data(page)).checkins).sort(), [
      "first",
      "second",
    ]);
    // Same event in two tabs: one completion, the second becomes already checked in.
    await page.goto(baseURL + "?event=third");
    await other.goto(baseURL + "?event=third");
    await Promise.all([
      page.evaluate(() => document.querySelector("#checkinBtn").click()),
      other.evaluate(() => document.querySelector("#checkinBtn").click()),
    ]);
    await expect(page.locator("#checking")).toBeHidden();
    await expect(other.locator("#checking")).toBeHidden();
    assert.equal(Object.keys((await data(page)).checkins).length, 3);
    const timestamp = (await data(page)).checkins.third;
    assert.ok(timestamp);
    const labels = await Promise.all([
      page.locator("#checkinBtn span").textContent(),
      other.locator("#checkinBtn span").textContent(),
    ]);
    assert.ok(labels.includes("ALREADY CHECKED IN"));
  });
  await test("storage updates and reset in another tab refresh member state", async (page, context) => {
    await memberPage(page);
    const other = await context.newPage();
    await other.goto(baseURL);
    await other.evaluate((key) => localStorage.removeItem(key), KEY);
    await expect(page.locator("#welcomeModal")).toBeVisible();
    await other.evaluate(
      ({ key, member }) =>
        localStorage.setItem(key, JSON.stringify({ member })),
      { key: KEY, member: MEMBER },
    );
    await expect(page.locator("#welcomeModal")).toBeHidden();
  });
  await test("responsive layouts, long names, short screens, focus trap, reduced motion", async (page) => {
    const name = "W".repeat(24);
    await seed(page, { member: { ...MEMBER, name } });
    for (const size of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
      { width: 768, height: 1024 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(size);
      await page.reload();
      await noOverflow(page);
      assert.ok(
        await page
          .locator("#cardName")
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        "member card name overflow",
      );
    }
    await page.setViewportSize({ width: 320, height: 320 });
    await page.goto(baseURL + "?reset=1");
    await page.locator("#nameInput").fill(name);
    await page.locator("#registerBtn").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#nameInput")).toBeFocused();
    await page.locator("#nameInput").press("Enter");
    await page.locator("#checkinBtn").click();
    await expect(page.locator("#success")).toBeVisible();
    await page.locator("#closeSuccess").click();
    await expect(page.locator("#success")).toBeHidden();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#profileBtn").click();
    await expect(page.locator("#myUnity")).toBeFocused();
    await noOverflow(page);
  });
  await test("LINE user-agent emulation: registration, check-in and no-event history", async (page, context) => {
    const lineContext = await browser.newContext({
      ...devices["iPhone 13"],
      userAgent: devices["iPhone 13"].userAgent + " Line/15.0.0",
    });
    try {
      const linePage = await lineContext.newPage();
      linePage.on("pageerror", (error) => errors.push(error.message));
      await linePage.goto(baseURL);
      await linePage.locator("#nameInput").fill("Unity Member");
      await linePage.locator("#registerBtn").click();
      await linePage.locator("#checkinBtn").click();
      await expect(linePage.locator("#success")).toBeVisible();
      await linePage.locator("#closeSuccess").click();
      await linePage.goto(baseURL + "?noevent=1");
      await expect(linePage.locator("#noEvent")).toBeVisible();
      await expect(linePage.locator("#eventCount")).toHaveText("1");
      await noOverflow(linePage);
    } finally {
      await lineContext.close();
    }
  });
  await test("Web Locks unavailable: check-in and duplicate reload still work", async (page, context) => {
    await context.addInitScript(() =>
      Object.defineProperty(navigator, "locks", { value: undefined }),
    );
    await memberPage(page);
    await page.locator("#checkinBtn").click();
    await expect(page.locator("#success")).toBeVisible();
    const timestamp = (await data(page)).checkins[EVENT];
    await page.reload();
    await expect(page.locator("#checkinBtn")).toBeDisabled();
    assert.equal((await data(page)).checkins[EVENT], timestamp);
  });
  await test("event IDs matching object properties do not create false duplicate states", async (page) => {
    for (const id of ["__proto__", "toString", "constructor"]) {
      await memberPage(page, "?event=" + id);
      await expect(page.locator("#checkinBtn")).toBeEnabled();
      await page.locator("#checkinBtn").click();
      await expect(page.locator("#success")).toBeVisible();
      assert.ok(Object.hasOwn((await data(page)).checkins, id));
      await page.reload();
      await expect(page.locator("#checkinBtn span")).toHaveText(
        "ALREADY CHECKED IN",
      );
    }
  });
  assert.deepEqual(errors, [], "uncaught browser errors");
  console.log(`${engine}: ${passed} tests passed; no uncaught browser errors`);
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
    server.close();
  });
