import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Store } from "../server/store.js";
import { LineService } from "../server/line.js";
const secret = "fixture-channel-secret",
  group = "C" + "a".repeat(32),
  other = "C" + "b".repeat(32);
const cfg = {
  origin: "https://qr.example",
  signingKey: "fixture-key-".repeat(5),
  lineChannelId: "12345678",
  lineChannelSecret: secret,
  lineAccessToken: "fixture-token",
  studioRelayEnabled: true,
  studioAllowedGroupIds: group,
};
function event(id = "one", type = "image", message = "123") {
  return {
    type: "message",
    webhookEventId: id,
    timestamp: Date.now(),
    replyToken: "private-reply-token",
    source: { type: "group", groupId: group, userId: "U" + "a".repeat(32) },
    message: { id: message, type, contentProvider: { type: "line" } },
    unnecessary: "private",
  };
}
async function admit(db: Store, events: any[], config: any = cfg) {
  const raw = Buffer.from(
    JSON.stringify({ destination: "U" + "c".repeat(32), events }),
  );
  return new LineService(db, config).webhook(
    raw,
    createHmac("sha256", secret).update(raw).digest("base64"),
    async () => {
      throw Error("must not reply to group media");
    },
  );
}
async function relay() {
  return import("../server/studio-relay.js");
}
test("relay schema is additive and repeated migrations retain queued records", async () => {
  const db = new Store(":memory:");
  try {
    assert.ok(
      db.row("SELECT name FROM sqlite_master WHERE name='studio_relay_outbox'"),
    );
    await admit(db, [event()]);
    db.migrate();
    assert.equal(db.row("SELECT COUNT(*) n FROM studio_relay_outbox").n, 1);
  } finally {
    db.close();
  }
});
test("OFF and non-allowlisted or text events persist no relay payload", async () => {
  const db = new Store(":memory:");
  try {
    await admit(db, [event()], { ...cfg, studioRelayEnabled: false });
    await admit(db, [
      { ...event(), source: { type: "group", groupId: other } },
      event("text", "text"),
    ]);
    assert.equal(db.row("SELECT COUNT(*) n FROM studio_relay_outbox").n, 0);
  } finally {
    db.close();
  }
});
test("valid group media is minimized, deduplicated and delivered with exact HMAC without LINE sends", async () => {
  const db = new Store(":memory:");
  try {
    await admit(db, [event(), event()]);
    const row = db.row("SELECT * FROM studio_relay_outbox");
    assert.equal(db.row("SELECT COUNT(*) n FROM studio_relay_outbox").n, 1);
    assert.ok(!row.payload.includes("private"));
    let called = 0;
    await (
      await relay()
    ).deliverStudioRelay(db, cfg, async (url, init) => {
      called++;
      assert.equal(
        url,
        "https://unity-auto-studio.kukki519.workers.dev/webhooks/line",
      );
      const body = String(init!.body);
      assert.equal(
        new Headers(init!.headers).get("x-line-signature"),
        createHmac("sha256", secret).update(body).digest("base64"),
      );
      assert.equal(JSON.parse(body).events[0].message.id, "123");
      assert.equal(init!.redirect, "manual");
      return Response.json({ ok: true });
    });
    assert.equal(called, 1);
    assert.equal(
      db.row("SELECT status,payload FROM studio_relay_outbox").status,
      "sent",
    );
    assert.equal(
      db.row("SELECT payload FROM studio_relay_outbox").payload,
      null,
    );
    await admit(db, [event()]);
    assert.equal(db.row("SELECT COUNT(*) n FROM studio_relay_outbox").n, 1);
  } finally {
    db.close();
  }
});
test("forged signatures do not persist anything", async () => {
  const db = new Store(":memory:");
  try {
    await assert.rejects(
      new LineService(db, cfg as any).webhook(
        Buffer.from("{}"),
        "a".repeat(43) + "=",
      ),
      /invalid_line_signature/,
    );
    assert.equal(db.row("SELECT COUNT(*) n FROM studio_relay_outbox").n, 0);
  } finally {
    db.close();
  }
});
test("failed delivery persists fixed error and retries only after backoff", async () => {
  const db = new Store(":memory:");
  try {
    await admit(db, [event()]);
    const { deliverStudioRelay } = await relay();
    const now = Date.now();
    await deliverStudioRelay(
      db,
      cfg,
      async () => {
        throw Error("private-provider-detail");
      },
      now,
    );
    let row = db.row("SELECT * FROM studio_relay_outbox");
    assert.equal(row.status, "pending");
    assert.equal(row.last_error, "delivery_unavailable");
    let calls = 0;
    await deliverStudioRelay(
      db,
      cfg,
      async () => {
        calls++;
        return Response.json({ ok: true });
      },
      now + 1,
    );
    assert.equal(calls, 0);
    await deliverStudioRelay(
      db,
      cfg,
      async () => {
        calls++;
        return Response.json({ ok: true });
      },
      row.next_attempt,
    );
    assert.equal(calls, 1);
  } finally {
    db.close();
  }
});
test("unsend cancels pending image and is forwarded even if received first", async () => {
  const db = new Store(":memory:");
  try {
    const unsend = {
      ...event("cancel"),
      type: "unsend",
      unsend: { messageId: "123" },
    };
    delete (unsend as any).message;
    await admit(db, [event(), unsend]);
    await admit(db, [event("later")]);
    assert.equal(
      db.row(
        "SELECT COUNT(*) n FROM studio_relay_outbox WHERE kind='media' AND status='pending'",
      ).n,
      0,
    );
    assert.equal(
      db.row(
        "SELECT COUNT(*) n FROM studio_relay_outbox WHERE kind='unsend' AND status='pending'",
      ).n,
      1,
    );
  } finally {
    db.close();
  }
});
test("malformed relevant events reject atomically before QR claims or relay writes", async () => {
  const db = new Store(":memory:");
  try {
    await assert.rejects(
      admit(db, [event(), { ...event("bad"), timestamp: -1 }]),
      /invalid_studio_event/,
    );
    assert.equal(db.row("SELECT COUNT(*) n FROM studio_relay_outbox").n, 0);
  } finally {
    db.close();
  }
});
test("daily queue admission is bounded without preventing unsend", async () => {
  const db = new Store(":memory:");
  try {
    for (let n = 0; n < 100; n++)
      await admit(db, [event("event" + n, "image", String(n + 1))]);
    await assert.rejects(
      admit(db, [event("overflow", "image", "200")]),
      /studio_relay_capacity/,
    );
    await admit(db, [
      { ...event("revoke"), type: "unsend", unsend: { messageId: "1" } },
    ]);
    assert.equal(
      db.row("SELECT COUNT(*) n FROM studio_relay_outbox WHERE kind='unsend'")
        .n,
      1,
    );
  } finally {
    db.close();
  }
});
test("delivery batch max four and disabled or removed allowlist never transmits queued payload", async () => {
  const db = new Store(":memory:");
  try {
    await admit(
      db,
      Array.from({ length: 6 }, (_, i) =>
        event("batch" + i, "image", String(i + 1)),
      ),
    );
    const { deliverStudioRelay } = await relay();
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return Response.json({ ok: true });
    };
    await deliverStudioRelay(
      db,
      { ...cfg, studioRelayEnabled: false },
      fetcher,
    );
    assert.equal(calls, 0);
    await deliverStudioRelay(db, cfg, fetcher);
    assert.equal(calls, 4);
    await deliverStudioRelay(
      db,
      { ...cfg, studioAllowedGroupIds: other },
      fetcher,
    );
    assert.equal(calls, 4);
    assert.equal(
      db.row(
        "SELECT COUNT(*) n FROM studio_relay_outbox WHERE status='pending'",
      ).n,
      0,
    );
  } finally {
    db.close();
  }
});
test("expired lease retries after restart and stale owner cannot acknowledge replacement", async () => {
  const db = new Store(":memory:");
  try {
    await admit(db, [event()]);
    const { deliverStudioRelay } = await relay();
    let resume!: (r: Response) => void, ready!: () => void;
    const arrived = new Promise<void>((r) => (ready = r));
    const first = deliverStudioRelay(db, cfg, async () => {
      ready();
      return new Promise<Response>((r) => (resume = r));
    });
    await arrived;
    db.run("UPDATE studio_relay_outbox SET lease_until=0");
    await deliverStudioRelay(
      db,
      cfg,
      async () => new Response("", { status: 503 }),
    );
    resume(Response.json({ ok: true }));
    await first;
    assert.equal(
      db.row("SELECT status FROM studio_relay_outbox").status,
      "pending",
    );
  } finally {
    db.close();
  }
});
test("expired or exhausted payload is cleared and retained dedup does not resurrect it", async () => {
  const db = new Store(":memory:");
  try {
    await admit(db, [event()]);
    db.run("UPDATE studio_relay_outbox SET expires_at=0");
    let calls = 0;
    await (
      await relay()
    ).deliverStudioRelay(db, cfg, async () => {
      calls++;
      return Response.json({ ok: true });
    });
    assert.equal(calls, 0);
    assert.equal(
      db.row("SELECT payload FROM studio_relay_outbox").payload,
      null,
    );
    await admit(db, [event()]);
    assert.equal(db.row("SELECT COUNT(*) n FROM studio_relay_outbox").n, 1);
  } finally {
    db.close();
  }
});
test("QR alarm delivers Analytics independently while Studio fails and schedules its retry", async () => {
  const db = new Store(":memory:");
  const original = globalThis.fetch;
  try {
    await admit(db, [event()]);
    db.run(
      "INSERT INTO outbox(id,event_id,payload,created_at,sequence) VALUES('analytics-one','event','{}',?,1)",
      new Date().toISOString(),
    );
    globalThis.fetch = async (url) => {
      if (String(url) === "https://analytics.example/checkin")
        return Response.json({ accepted: true, changeId: "analytics-one" });
      throw Error("Studio unavailable");
    };
    const { QRReception } = await import("../cloudflare/worker.js");
    let alarm = 0;
    const object = Object.assign(Object.create(QRReception.prototype), {
      db,
      env: {
        QR_ORIGIN: "https://qr.example",
        QR_SIGNING_KEY: cfg.signingKey,
        LINE_CHANNEL_SECRET: secret,
        STUDIO_RELAY_ENABLED: "true",
        STUDIO_ALLOWED_GROUP_IDS: group,
        ANALYTICS_CHECKIN_URL: "https://analytics.example/checkin",
        ANALYTICS_API_TOKEN: "fixture-token",
      },
      ctx: {
        storage: {
          getAlarm: async () => null,
          setAlarm: async (at: number) => {
            alarm = at;
          },
        },
      },
    });
    await object.alarm();
    assert.equal(db.row("SELECT status FROM outbox").status, "sent");
    assert.equal(
      db.row("SELECT attempts FROM studio_relay_outbox").attempts,
      1,
    );
    assert.ok(alarm > Date.now());
  } finally {
    globalThis.fetch = original;
    db.close();
  }
});
test("disabled forwarding still schedules expiry and clears expired payload without network", async () => {
  const db = new Store(":memory:");
  try {
    await admit(db, [event()]);
    const { nextStudioDelivery, deliverStudioRelay } = await relay();
    const disabled = { ...cfg, studioRelayEnabled: false },
      expiry = db.row("SELECT expires_at FROM studio_relay_outbox").expires_at;
    assert.equal(nextStudioDelivery(db, disabled), expiry);
    let calls = 0;
    await deliverStudioRelay(
      db,
      disabled,
      async () => {
        calls++;
        throw Error("must not send");
      },
      expiry,
    );
    assert.equal(calls, 0);
    assert.equal(
      db.row("SELECT payload FROM studio_relay_outbox").payload,
      null,
    );
  } finally {
    db.close();
  }
});
test("revocation arriving during delivery cannot be acknowledged by stale image sender", async () => {
  const db = new Store(":memory:");
  try {
    await admit(db, [event()]);
    let release!: (r: Response) => void, ready!: () => void;
    const started = new Promise<void>((r) => (ready = r));
    let count = 0;
    const work = (await relay()).deliverStudioRelay(db, cfg, async () => {
      if (count++) return Response.json({ ok: true });
      ready();
      return new Promise<Response>((r) => (release = r));
    });
    await started;
    await admit(db, [
      { ...event("cancel"), type: "unsend", unsend: { messageId: "123" } },
    ]);
    release(Response.json({ ok: true }));
    await work;
    assert.equal(
      db.row("SELECT status FROM studio_relay_outbox WHERE kind='media'")
        .status,
      "cancelled",
    );
  } finally {
    db.close();
  }
});
test("admin settings expose relay counters without group IDs or pending payload", async () => {
  const db = new Store(":memory:");
  try {
    await admit(db, [event()]);
    const settings = new LineService(db, cfg).settings({
      id: "admin",
      role: "Admin",
      events: [],
    });
    assert.equal((settings as any).studioRelay.enabled, true);
    assert.equal((settings as any).studioRelay.allowedGroupCount, 1);
    assert.equal((settings as any).studioRelay.counts.pending, 1);
    assert.ok(!JSON.stringify(settings).includes(group));
    assert.ok(!JSON.stringify(settings).includes("private"));
    assert.throws(
      () =>
        new LineService(db, cfg).settings({
          id: "viewer",
          role: "Viewer",
          events: [],
        }),
      /forbidden/,
    );
  } finally {
    db.close();
  }
});
test("redirects are failed without following a different receiver", async () => {
  const db = new Store(":memory:");
  try {
    await admit(db, [event()]);
    let calls = 0;
    await (
      await relay()
    ).deliverStudioRelay(db, cfg, async (url, init) => {
      calls++;
      assert.equal(init!.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { Location: "https://untrusted.example" },
      });
    });
    assert.equal(calls, 1);
    assert.equal(
      db.row("SELECT status FROM studio_relay_outbox").status,
      "pending",
    );
  } finally {
    db.close();
  }
});
test("full retained queue rejects new media without losing duplicate acknowledgements", async () => {
  const db = new Store(":memory:");
  try {
    await admit(db, [event()]);
    db.sql.transaction(() => {
      for (let n = 1; n < 1000; n++)
        db.run(
          "INSERT INTO studio_relay_outbox(id,kind,group_hash,message_id,status,created_at,expires_at,retain_until,next_attempt) VALUES(?,'unsend','hash','123','sent',?,?,?,?)",
          "fixture" + n,
          Date.now(),
          Date.now() + 86400000,
          Date.now() + 86400000,
          Date.now(),
        );
    });
    await admit(db, [event()]);
    await assert.rejects(admit(db, [event("new")]), /studio_relay_capacity/);
    assert.equal(db.row("SELECT COUNT(*) n FROM studio_relay_outbox").n, 1000);
  } finally {
    db.close();
  }
});
test("exhausted deliveries clear retained payload without a thirteenth network attempt", async () => {
  const db = new Store(":memory:");
  try {
    await admit(db, [event()]);
    db.run("UPDATE studio_relay_outbox SET attempts=12");
    let calls = 0;
    await (
      await relay()
    ).deliverStudioRelay(db, cfg, async () => {
      calls++;
      return Response.json({ ok: true });
    });
    assert.equal(calls, 0);
    assert.equal(
      db.row("SELECT payload FROM studio_relay_outbox").payload,
      null,
    );
  } finally {
    db.close();
  }
});
test("pausing media forwarding still relays participant unsend", async () => {
  const db = new Store(":memory:");
  try {
    await admit(db, [event()]);
    const { deliverStudioRelay } = await relay();
    await deliverStudioRelay(db, cfg, async () => Response.json({ ok: true }));
    const paused = { ...cfg, studioRelayEnabled: false };
    await admit(
      db,
      [
        {
          ...event("revoke-off"),
          type: "unsend",
          unsend: { messageId: "123" },
        },
      ],
      paused,
    );
    let calls = 0;
    await deliverStudioRelay(db, paused, async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(String(init!.body)).events[0].type, "unsend");
      return Response.json({ ok: true });
    });
    assert.equal(calls, 1);
  } finally {
    db.close();
  }
});
test("removed group and pruned media history cannot block later revocation", async () => {
  const db = new Store(":memory:");
  try {
    await admit(db, [event()]);
    const { deliverStudioRelay } = await relay();
    await deliverStudioRelay(db, cfg, async () => Response.json({ ok: true }));
    db.run("DELETE FROM studio_relay_outbox");
    const removed = {
      ...cfg,
      studioRelayEnabled: false,
      studioAllowedGroupIds: "",
    };
    await admit(
      db,
      [
        {
          ...event("revoke-history"),
          type: "unsend",
          unsend: { messageId: "123" },
        },
      ],
      removed,
    );
    let calls = 0;
    await deliverStudioRelay(db, removed, async () => {
      calls++;
      return Response.json({ ok: true });
    });
    assert.equal(calls, 1);
    await admit(
      db,
      [
        {
          ...event("unknown-group"),
          type: "unsend",
          source: { type: "group", groupId: other },
          unsend: { messageId: "999" },
        },
      ],
      removed,
    );
    assert.equal(db.row("SELECT COUNT(*) n FROM studio_relay_outbox").n, 1);
  } finally {
    db.close();
  }
});
