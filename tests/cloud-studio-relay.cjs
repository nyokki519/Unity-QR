const test = require("node:test"),
  assert = require("node:assert/strict");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const { mkdtempSync, rmSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createHmac } = require("node:crypto");
const secret = "synthetic-relay-secret",
  group = "C" + "a".repeat(32);
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}
async function eventually(check) {
  for (let n = 0; n < 80; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(check(), "expected bounded alarm delivery");
}
function persistedRelay(dir,check){
 for(const p of files(dir).filter(p=>p.endsWith('.sqlite'))){
  const db=new DatabaseSync(p,{readOnly:true});
  try{if(db.prepare("SELECT name FROM sqlite_master WHERE name='studio_relay_outbox'").get()){
   const row=db.prepare('SELECT status,payload FROM studio_relay_outbox').get();if(row&&check(row))return true;
  }}finally{db.close();}
 }
 return false;
}
test("workerd persists relay on failure, survives restart and signs only minimal media without LINE sends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qr-studio-"));
  let mf,
    calls = 0,
    fail = true;
  const received = [];
  const start = () =>
    new Miniflare(
      convertV4MiniflareOptions({
        name: "qr-studio",
        modules: true,
        scriptPath: resolve("dist/cloudflare-worker/worker.js"),
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          QR_SIGNING_KEY: "fixture-key-".repeat(5),
          LINE_CHANNEL_ID: "12345678",
          LINE_CHANNEL_SECRET: secret,
          LINE_CHANNEL_ACCESS_TOKEN: "fake-token",
          STUDIO_RELAY_ENABLED: "true",
          STUDIO_ALLOWED_GROUP_IDS: group,
        },
        durableObjects: {
          QR_DB: { className: "QRReception", useSQLite: true },
        },
        resourcePersistencePath: dir,
        telemetry: { enabled: false },
        outboundService: async (req) => {
          const body = await req.text();
          received.push({
            url: req.url,
            body,
            signature: req.headers.get("x-line-signature"),
          });
          calls++;
          return Response.json({ ok: !fail }, { status: fail ? 503 : 200 });
        },
      }),
    );
  try {
    mf = start();
    const body = JSON.stringify({
      destination: "U" + "b".repeat(32),
      events: [
        {
          type: "message",
          webhookEventId: "fixture-one",
          timestamp: Date.now(),
          replyToken: "private-reply",
          source: { type: "group", groupId: group, userId: "private-user" },
          message: {
            type: "image",
            id: "123",
            contentProvider: { type: "line" },
          },
        },
      ],
    });
    const request = () =>
      mf.dispatchFetch("https://qr.example/api/v2/line/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-line-signature": createHmac("sha256", secret)
            .update(body)
            .digest("base64"),
        },
        body,
      });
    assert.equal((await request()).status, 200);
    await eventually(() => calls === 1&&persistedRelay(dir,row=>row.status==='pending'));
    await mf.dispose();
    mf = undefined;
    let found = false;
    for (const p of files(dir).filter((p) => p.endsWith(".sqlite"))) {
      const db = new DatabaseSync(p);
      try {
        if (
          !db
            .prepare(
              "SELECT name FROM sqlite_master WHERE name='studio_relay_outbox'",
            )
            .get()
        )
          continue;
        assert.equal(
          db.prepare("SELECT status FROM studio_relay_outbox").get().status,
          "pending",
        );
        db.prepare("UPDATE studio_relay_outbox SET next_attempt=0").run();
        found = true;
      } finally {
        db.close();
      }
    }
    assert.ok(found);
    fail = false;
    mf = start();
    assert.equal((await request()).status, 200);
    await eventually(() => calls === 2&&persistedRelay(dir,row=>row.status==='sent'&&row.payload===null));
    for (const item of received) {
      assert.equal(
        item.url,
        "https://unity-auto-studio.kukki519.workers.dev/webhooks/line",
      );
      assert.equal(
        item.signature,
        createHmac("sha256", secret).update(item.body).digest("base64"),
      );
      assert.ok(!item.body.includes("private"));
    }
    await mf.dispose();
    mf = undefined;
    for (const p of files(dir).filter((p) => p.endsWith(".sqlite"))) {
      const db = new DatabaseSync(p, { readOnly: true });
      try {
        if (
          !db
            .prepare(
              "SELECT name FROM sqlite_master WHERE name='studio_relay_outbox'",
            )
            .get()
        )
          continue;
        const row = db
          .prepare("SELECT status,payload FROM studio_relay_outbox")
          .get();
        assert.equal(row.status, "sent");
        assert.equal(row.payload, null);
      } finally {
        db.close();
      }
    }
  } catch (error) {
    await mf?.dispose();
    mf = undefined;
    console.log("relay calls", calls);
    for (const p of files(dir).filter((p) => p.endsWith(".sqlite"))) {
      const db = new DatabaseSync(p, { readOnly: true });
      try {
        if (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE name='studio_relay_outbox'",
            )
            .get()
        )
          console.log(
            "relay state",
            db
              .prepare(
                "SELECT status,attempts,next_attempt,lease_until FROM studio_relay_outbox",
              )
              .all(),
          );
      } finally {
        db.close();
      }
    }
    throw error;
  } finally {
    await mf?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
