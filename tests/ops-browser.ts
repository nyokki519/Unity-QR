import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium, webkit, expect, type Route } from "playwright/test";
import { createApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { hashPassword } from "../server/security.js";

const store = new Store(":memory:");
const admin: any = { id: "test-admin", role: "Admin", events: [] };
const event = store.createEvent(
  admin,
  {
    title: "UNITY NIGHT",
    venue: "Tokyo",
    capacity: 50,
    startsAt: new Date().toISOString(),
    opensAt: new Date(Date.now() - 60000).toISOString(),
    closesAt: new Date(Date.now() + 3600000).toISOString(),
  },
  crypto.randomUUID(),
);
const person = store.register(
  admin,
  event.id,
  { name: "Yuki" },
  crypto.randomUUID(),
);
store.register(admin, event.id, { name: "Yuki" }, crypto.randomUUID());
for (const role of ["Admin", "Staff", "Viewer"] as const)
  store.addUser(
    role.toLowerCase(),
    hashPassword("test-only-password-123"),
    role,
    [event.id],
  );
const cfg: any = {
  origin: "http://127.0.0.1",
  signingKey: "test-only-browser-key-".repeat(3),
  root: process.cwd(),
};
const app = createApp(store, cfg);
await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
cfg.origin = "http://127.0.0.1:" + (app.address() as any).port;
const engine = process.env.BROWSER_ENGINE || "chromium";
assert.ok(["chromium", "webkit"].includes(engine));
const browser = await (engine === "webkit" ? webkit : chromium).launch({
  headless: true,
  executablePath:
    engine === "webkit"
      ? process.env.WEBKIT_EXECUTABLE_PATH
      : process.env.CHROMIUM_EXECUTABLE_PATH ||
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
});
const errors: string[] = [];
let passed = 0;
async function run(
  name: string,
  fn: (page: any) => Promise<void>,
  role = "admin",
) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    timezoneId: "Asia/Tokyo",
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(cfg.origin + "/ops/");
    await expect(page.locator(".brand img.unityLogo")).toBeVisible();
    await expect.poll(() => page.locator(".brand img.unityLogo").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    if (process.env.QR_CAPTURE === "1" && passed === 0)
      await page.screenshot({
        path: "/tmp/unity-qr-v2-login.png",
        fullPage: true,
      });
    await page.getByLabel("ユーザー名").fill(role);
    await page
      .getByLabel("パスワード", { exact: true })
      .fill("test-only-password-123");
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "受付ダッシュボード" }),
    ).toBeVisible();
    if (process.env.QR_CAPTURE === "1" && passed === 0)
      await page.screenshot({
        path: "/tmp/unity-qr-v2-dashboard.png",
        fullPage: true,
      });
    await fn(page);
    passed++;
    console.log("PASS " + name);
  } finally {
    await context.close();
  }
}
try {
  await run(
    "dashboard, search, same-name distinction, manual arrival and audited undo",
    async (page) => {
      await page.getByRole("button", { name: "参加者", exact: true }).click();
      await page.getByLabel("名前で検索").fill("Yuki");
      await expect(page.locator(".person")).toHaveCount(2);
      await expect(
        page.getByText("同名の参加者", { exact: false }).first(),
      ).toBeVisible();
      await page.getByLabel("名前で検索").fill("absent");
      await expect(page.locator(".person")).toHaveCount(0);
      await page.getByLabel("名前で検索").fill("Yuki");
      await page
        .locator(".person")
        .filter({ has: page.locator(`[data-person="${person.id}"]`) })
        .getByRole("button", { name: "受付する", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText(
        "受付を確定しました",
      );
      await page
        .locator(`[data-action="undo"][data-person="${person.id}"]`)
        .click();
      await page.getByLabel("変更理由").fill("テスト受付の訂正");
      await page.getByRole("button", { name: "変更を確定" }).click();
      await expect(page.getByRole("status")).toContainText(
        "変更を保存しました",
      );
      await page.getByRole("button", { name: "履歴", exact: true }).click();
      await expect(
        page.getByText("テスト受付の訂正", { exact: false }),
      ).toBeVisible();
    },
  );
  await run(
    "walk-in registration and real signed ticket/QR issuance",
    async (page) => {
      await page.getByRole("button", { name: "参加者", exact: true }).click();
      await page.getByRole("button", { name: "当日参加を登録" }).click();
      await page.getByLabel("参加者名", { exact: true }).fill("Walk In");
      await page.getByRole("button", { name: "登録する", exact: true }).click();
      await expect(page.getByRole("status")).toContainText(
        "参加者を登録しました",
      );
      const card = page.locator(".person").filter({ hasText: "Walk In" });
      await card.getByRole("button", { name: "QRを表示" }).click();
      await expect(page.locator("#ticketImage")).toBeVisible();
      assert.ok(
        (await page.locator("#ticketToken").inputValue()).includes("."),
      );
    },
  );
  await run(
    "scanner validates signed ticket on server, blocks invalid QR and handles camera errors",
    async (page) => {
      await page.getByRole("button", { name: "スキャン", exact: true }).click();
      await page.getByLabel("QRの文字列").fill("https://invalid.test");
      await page.getByRole("button", { name: "QRを確認して受付" }).click();
      await expect(page.getByRole("status")).toContainText(
        "QRが正しくありません",
      );
      await page.getByRole("button", { name: "カメラを開始" }).click();
      await expect(page.locator("#cameraStatus")).toContainText(
        /許可|カメラ|利用/,
      );
      await page.getByRole("button", { name: "参加者検索へ" }).click();
      await expect(page.getByLabel("名前で検索")).toBeVisible();
    },
  );
  await run(
    "lost response retries the same mutation without a second attendance/audit",
    async (page) => {
      const p = store.register(
        admin,
        event.id,
        { name: "Retry Guest" },
        crypto.randomUUID(),
      );
      let lost = false;
      await page.route("**/api/v2/checkins", async (route: Route) => {
        if (!lost) {
          lost = true;
          await route.fetch();
          await route.abort();
        } else await route.continue();
      });
      await page.getByRole("button", { name: "参加者", exact: true }).click();
      await page.getByLabel("名前で検索").fill("Retry Guest");
      await page.getByRole("button", { name: "受付する", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("通信");
      await page.getByRole("button", { name: "受付する", exact: true }).click();
      await expect(page.getByRole("status")).toContainText(
        "受付を確定しました",
      );
      assert.equal(
        store
          .history(admin, event.id)
          .filter((r) => r.action === "checkin" && r.participant_id === p.id)
          .length,
        1,
      );
    },
  );
  await run(
    "iPhone layouts, short screen, long name and keyboard login preserve usable navigation",
    async (page) => {
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({
          width,
          height: width === 320 ? 420 : 844,
        });
        await page.getByRole("button", { name: "参加者", exact: true }).click();
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        await page
          .getByRole("button", { name: "ダッシュボード", exact: true })
          .click();
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
      }
    },
  );
  await run(
    "Viewer sees assigned participants but cannot issue QR or write attendance",
    async (page) => {
      await page.getByRole("button", { name: "参加者", exact: true }).click();
      await expect(page.locator(".person").first()).toBeVisible();
      await expect(
        page.getByRole("button", { name: "受付する", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole("button", { name: "QRを表示" })).toHaveCount(
        0,
      );
      await expect(
        page.getByRole("button", { name: "設定", exact: true }),
      ).toHaveCount(0);
    },
    "viewer",
  );
  await run(
    "event switch immediately removes stale participant actions while the next event loads",
    async (page) => {
      const other = store.createEvent(
        admin,
        {
          title: "SECOND EVENT",
          venue: "Tokyo",
          capacity: 50,
          startsAt: new Date().toISOString(),
          opensAt: new Date(Date.now() - 60000).toISOString(),
          closesAt: new Date(Date.now() + 3600000).toISOString(),
        },
        crypto.randomUUID(),
      );
      await page.getByRole("button", { name: "イベント", exact: true }).click();
      await page.getByRole("button", { name: "参加者", exact: true }).click();
      await page.locator("#eventSelect").selectOption(event.id);
      await expect(page.locator(".person").first()).toBeVisible();
      await page.route("**/api/v2/events", async (route: Route) => {
        await new Promise((r) => setTimeout(r, 700));
        await route.continue();
      });
      const staleActions = await page.evaluate((id: string) => {
        const select = document.querySelector(
          "#eventSelect",
        ) as HTMLSelectElement;
        select.value = id;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return document.querySelectorAll('[data-action="checkin"]').length;
      }, other.id);
      assert.equal(staleActions, 0);
      await expect(page.locator("#eventSelect")).toHaveValue(other.id);
      await expect(page.locator(".person")).toHaveCount(0);
    },
  );
  const lifecycleSource=store.createEvent(admin,{title:'統合元テスト',venue:'Test',capacity:20,startsAt:new Date().toISOString(),opensAt:new Date(Date.now()-60000).toISOString(),closesAt:new Date(Date.now()+3600000).toISOString()},crypto.randomUUID());
  const lifecycleTarget=store.createEvent(admin,{...lifecycleSource,title:'統合先テスト'},crypto.randomUUID());
  store.register(admin,lifecycleSource.id,{name:'Lifecycle A'},crypto.randomUUID());store.register(admin,lifecycleTarget.id,{name:'Lifecycle B'},crypto.randomUUID());
  await run('Admin merge preview, archive confirmation and restore preserve registrations',async(page)=>{
    await page.getByRole('button',{name:'イベント',exact:true}).click();
    const sourceCard=page.locator('.eventCard').filter({hasText:'統合元テスト'}),targetCard=page.locator('.eventCard').filter({hasText:'統合先テスト'});
    await sourceCard.getByRole('button',{name:'イベントをまとめる',exact:true}).click();
    await expect(page.getByRole('heading',{name:'登録イベントをまとめる',exact:true})).toBeVisible();
    await page.getByLabel('統合先',{exact:true}).selectOption(lifecycleTarget.id);await page.getByRole('button',{name:'統合内容を確認',exact:true}).click();
    await expect(page.getByRole('heading',{name:'イベント統合を確認',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'確認してイベントを統合',exact:true}).click();await expect(sourceCard).toHaveCount(0);assert.equal(store.summary(admin,lifecycleTarget.id).total,2);
    await targetCard.getByRole('button',{name:'削除・中止',exact:true}).click();await page.getByLabel('理由',{exact:true}).fill('Test cleanup');await page.getByRole('button',{name:'確認して削除・中止',exact:true}).click();await expect(targetCard).toHaveCount(0);
    await page.locator('details > summary').filter({hasText:'削除・中止・統合済み'}).click();await page.locator('.userRow').filter({hasText:'統合先テスト'}).getByRole('button',{name:'復元',exact:true}).click();await page.getByLabel('理由',{exact:true}).fill('Restore test');await page.getByRole('button',{name:'復元する',exact:true}).click();await expect(targetCard).toHaveCount(1);assert.equal(store.summary(admin,lifecycleTarget.id).total,2);
  });
  assert.deepEqual(errors, []);
  console.log(`${engine}: ${passed} operations browser checks passed`);
} finally {
  await browser.close();
  await new Promise<void>((r) => app.close(() => r()));
  store.close();
}
