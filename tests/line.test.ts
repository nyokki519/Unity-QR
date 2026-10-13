import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { LineService, verifyLineSignature } from "../server/line.js";
import { hashPassword, verifyTicket } from "../server/security.js";
const admin: any = { id: "test-admin", role: "Admin", events: [] };
const key = "test-only-signing-key-".repeat(3),
  channel = "1234567890";
function fixture() {
  const db = new Store(":memory:");
  db.addUser("operator", hashPassword("test-only-password-123"), "Admin");
  const event = db.createEvent(
    admin,
    {
      title: "LINE NIGHT",
      venue: "Tokyo",
      capacity: 2,
      startsAt: new Date().toISOString(),
      opensAt: new Date(Date.now() - 60000).toISOString(),
      closesAt: new Date(Date.now() + 3600000).toISOString(),
    },
    randomUUID(),
  );
  const service = new LineService(db, {
    origin: "https://test.example",
    signingKey: key,
    lineChannelId: channel,
  });
  service.configure(
    admin,
    {
      eventId: event.id,
      enabled: true,
      opensAt: new Date(Date.now() - 86400000).toISOString(),
      closesAt: new Date(Date.now() + 1800000).toISOString(),
    },
    randomUUID(),
  );
  return { db, event, service };
}
function event(
  id = randomUUID(),
  user = "U" + "a".repeat(32),
  message = "参加希望",
): any {
  return {
    type: "message",
    webhookEventId: id,
    replyToken: "test-reply",
    timestamp: Date.now(),
    source: { type: "user", userId: user },
    message: { type: "text", text: message },
  };
}
test("LINE signatures authenticate exact raw bytes before JSON parsing", () => {
  const raw = Buffer.from('{"events":[]}');
  const secret = "test-only-line-secret";
  const signature = createHmac("sha256", secret).update(raw).digest("base64");
  assert.doesNotThrow(() => verifyLineSignature(raw, signature, secret));
  assert.throws(
    () => verifyLineSignature(Buffer.from("{}"), signature, secret),
    /invalid_line_signature/,
  );
  assert.throws(
    () => verifyLineSignature(raw, "invalid", secret),
    /invalid_line_signature/,
  );
  assert.throws(
    () => verifyLineSignature(raw, signature, undefined),
    /line_unavailable/,
  );
});
test("LINE registration and webhook redelivery create one identity, registration and receipt", () => {
  const { db, event: ev, service } = fixture();
  try {
    const e = event();
    assert.equal(service.claim(e), true);
    assert.equal(
      service.claim({ ...e, deliveryContext: { isRedelivery: true } }),
      false,
    );
    const first = service.respond(e, "Yuki");
    const second = service.respond(event(), "Changed LINE name");
    assert.equal(db.row("SELECT count(*) n FROM participants").n, 1);
    assert.equal(db.row("SELECT count(*) n FROM registrations").n, 1);
    assert.equal(db.row("SELECT name FROM participants").name, "Yuki");
    assert.equal(first[0].type, "text");
    assert.match(first[0].text, /https:\/\/test.example\/ticket\/#/);
    assert.match(second[0].text, /ticket/);
    const token = first[0].text.match(/#([a-f0-9]{64})/)![1];
    const ticket = service.ticket(token);
    assert.equal(ticket.event.title, "LINE NIGHT");
    assert.ok(ticket.token);
    assert.equal(verifyTicket(key, ticket.token!, ev.id).eventId, ev.id);
    assert.throws(() => service.ticket("0".repeat(64)), /ticket_not_found/);
    assert.equal(db.row("SELECT count(*) n FROM line_webhooks").n, 1);
  } finally {
    db.close();
  }
});
test("LINE registrations enforce capacity, cancellations and prior attendance", () => {
  const { db, event: ev, service } = fixture();
  try {
    const a = service.respond(event(), "A");
    service.respond(event(randomUUID(), "U" + "b".repeat(32)), "B");
    const full = service.respond(
      event(randomUUID(), "U" + "c".repeat(32)),
      "C",
    );
    assert.match(full[0].text, /定員/);
    const cancel = service.respond(
      event(randomUUID(), undefined, "キャンセル"),
      "A",
    );
    assert.match(cancel[0].text, /キャンセル/);
    service.respond(
      {
        ...event(),
        type: "postback",
        postback: { data: cancel[0].quickReply!.items[0].action.data },
      },
      undefined,
    );
    const token = a[0].text.match(/#([a-f0-9]{64})/)![1];
    assert.equal(service.ticket(token).status, "cancelled");
    assert.equal(service.ticket(token).qr, undefined);
    const retry = service.respond(event(), "A");
    assert.match(retry[0].text, /キャンセル済み/);
    service.respond({...event(),type:"postback",postback:{data:retry[0].quickReply!.items[0].action.data}}, "A");
    const p = db.row(
      "SELECT participant_id FROM line_identities WHERE subject_hash IS NOT NULL",
    ).participant_id;
    db.checkin(admin, ev.id, p, randomUUID());
    assert.match(
      service.respond(event(randomUUID(), undefined, "キャンセル"), "A")[0]
        .text,
      /受付済み/,
    );
  } finally {
    db.close();
  }
});
test("LINE ignores group events, handles no events, multiple selection and expiring name requests", () => {
  const { db, event: ev, service } = fixture();
  try {
    assert.deepEqual(
      service.respond(
        { ...event(), source: { type: "group", userId: "U" + "a".repeat(32) } },
        "A",
      ),
      [],
    );
    service.configure(
      admin,
      {
        eventId: ev.id,
        enabled: false,
        opensAt: new Date(Date.now() - 60000).toISOString(),
        closesAt: new Date(Date.now() + 60000).toISOString(),
      },
      randomUUID(),
    );
    assert.match(
      service.respond(event(), "A")[0].text,
      /受付中のイベントがありません/,
    );
    service.configure(
      admin,
      {
        eventId: ev.id,
        enabled: true,
        opensAt: new Date(Date.now() - 60000).toISOString(),
        closesAt: new Date(Date.now() + 60000).toISOString(),
      },
      randomUUID(),
    );
    assert.match(service.respond(event(), undefined)[0].text, /お名前/);
    assert.equal(db.row("SELECT count(*) n FROM participants").n, 0);
    assert.match(
      service.respond(
        event(randomUUID(), undefined, "入力した名前"),
        undefined,
      )[0].text,
      /ticket/,
    );
    assert.throws(
      () => service.configure({ ...admin, role: "Staff" }, {}, randomUUID()),
      /forbidden/,
    );
  } finally {
    db.close();
  }
});
test("LINE webhook records uncertain sends, never pushes and refuses redelivery", async () => {
  const { db, event: ev } = fixture();
  const service = new LineService(db, {
    origin: "https://test.example",
    signingKey: key,
    lineChannelId: channel,
    lineChannelSecret: "test-line-secret",
    lineAccessToken: "test-not-real-token",
  });
  try {
    const e = event(),
      raw = Buffer.from(
        JSON.stringify({ destination: "U" + "d".repeat(32), events: [e, e] }),
      );
    const sig = createHmac("sha256", "test-line-secret")
      .update(raw)
      .digest("base64");
    const calls: string[] = [];
    await service.webhook(raw, sig, async (input: any) => {
      calls.push(String(input));
      if (String(input).includes("/profile/"))
        return Response.json({ displayName: "API name" });
      throw new Error("timeout after send");
    });
    assert.equal(calls.length, 2);
    assert.ok(calls.every((x) => !x.includes("/push")));
    assert.equal(db.row("SELECT status FROM line_webhooks").status, "unknown");
    assert.equal(db.row("SELECT count(*) n FROM registrations").n, 1);
    await service.webhook(raw, sig, async () => {
      throw new Error("must not call");
    });
    assert.equal(db.row("SELECT count(*) n FROM registrations").n, 1);
    const raw2 = Buffer.from(
      JSON.stringify({ destination: "U" + "d".repeat(32), events: [] }),
    );
    assert.deepEqual(
      await service.webhook(
        raw2,
        createHmac("sha256", "test-line-secret").update(raw2).digest("base64"),
      ),
      { ok: true },
    );
  } finally {
    db.close();
  }
});
test("QR page waits until reception opens, even for registration days ahead", () => {
  const { db, event: ev, service } = fixture();
  try {
    db.run(
      "UPDATE events SET opens_at=?,closes_at=? WHERE id=?",
      new Date(Date.now() + 2 * 86400000).toISOString(),
      new Date(Date.now() + 2 * 86400000 + 3600000).toISOString(),
      ev.id,
    );
    const link = service.respond(event(), "A")[0].text;
    const token = link.match(/#([a-f0-9]{64})/)![1];
    assert.equal(service.ticket(token).status, "upcoming");
    assert.equal(service.ticket(token).token, undefined);
    db.run(
      "UPDATE events SET opens_at=?,closes_at=? WHERE id=?",
      new Date(Date.now() - 60000).toISOString(),
      new Date(Date.now() + 3600000).toISOString(),
      ev.id,
    );
    assert.equal(service.ticket(token).status, "planned");
    assert.ok(service.ticket(token).expiresAt! <= Date.now() + 10 * 60000);
  } finally {
    db.close();
  }
});

test("LINE cancellation requires explicit event confirmation before changing registration", () => {
  const { db, event: ev, service } = fixture();
  try {
    service.respond(event(), "A");
    const preview = service.respond(
      event(randomUUID(), undefined, "キャンセル"),
    );
    assert.equal(db.row("SELECT status FROM registrations").status, "planned");
    assert.match(preview[0].text, /キャンセル.*確認|キャンセルしますか/);
    const confirm = preview[0].quickReply!.items[0].action.data;
    const result = service.respond(
      { ...event(), type: "postback", postback: { data: confirm } },
      undefined,
    );
    assert.match(result[0].text, /キャンセルしました/);
    assert.equal(
      db.row("SELECT status FROM registrations").status,
      "cancelled",
    );
  } finally {
    db.close();
  }
});
test("LINE bounded batches start other events before one slow profile finishes", async () => {
  const { db } = fixture();
  const service = new LineService(db, {
    origin: "https://test.example",
    signingKey: key,
    lineChannelId: channel,
    lineChannelSecret: "test-line-secret",
    lineAccessToken: "test-not-real-token",
  });
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  let profiles = 0,
    replies = 0;
  try {
    const e1 = event(),
      e2 = event(randomUUID(), "U" + "b".repeat(32));
    const raw = Buffer.from(
      JSON.stringify({ destination: "U" + "d".repeat(32), events: [e1, e2] }),
    );
    const work = service.webhook(
      raw,
      createHmac("sha256", "test-line-secret").update(raw).digest("base64"),
      async (input: any) => {
        if (String(input).includes("/profile/")) {
          profiles++;
          await blocked;
          return Response.json({ displayName: "A" });
        }
        replies++;
        return Response.json({ sentMessages: [] });
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    const started = profiles;
    release();
    await work;
    assert.equal(started, 2, "both profiles start before the first finishes");
    assert.equal(replies, 2);
    assert.equal(
      db.row("SELECT count(*) n FROM line_webhooks WHERE status='sent'").n,
      2,
    );
  } finally {
    release();
    db.close();
  }
});

test("multiple event selection is explicit and stale postbacks cannot register", () => {
  const { db, event: ev, service } = fixture();
  try {
    const second = db.createEvent(
      admin,
      {
        title: "Other event",
        venue: "Osaka",
        capacity: 5,
        startsAt: new Date().toISOString(),
        opensAt: new Date(Date.now() - 60000).toISOString(),
        closesAt: new Date(Date.now() + 3600000).toISOString(),
      },
      randomUUID(),
    );
    service.configure(
      admin,
      {
        eventId: second.id,
        enabled: true,
        opensAt: new Date(Date.now() - 60000).toISOString(),
        closesAt: new Date(Date.now() + 1800000).toISOString(),
      },
      randomUUID(),
    );
    const choices = service.respond(event(), "A");
    assert.equal(choices[0].quickReply!.items.length, 2);
    assert.equal(db.row("SELECT count(*) n FROM registrations").n, 0);
    const selected = choices[0].quickReply!.items.find(
      (i: any) => i.action.data === "register:" + ev.id,
    ).action.data;
    const message = service.respond(
      { ...event(), type: "postback", postback: { data: selected } },
      "A",
    );
    assert.match(message[0].text, /ticket/);
    assert.equal(db.row("SELECT event_id FROM registrations").event_id, ev.id);
    service.configure(
      admin,
      {
        eventId: second.id,
        enabled: false,
        opensAt: new Date(Date.now() - 60000).toISOString(),
        closesAt: new Date(Date.now() + 1800000).toISOString(),
      },
      randomUUID(),
    );
    assert.match(
      service.respond(
        {
          ...event(),
          type: "postback",
          postback: { data: "register:" + second.id },
        },
        "A",
      )[0].text,
      /選択が無効/,
    );
  } finally {
    db.close();
  }
});
test("profile failure requests name, successful replies finish, redirect failures never push", async () => {
  const { db } = fixture();
  const service = new LineService(db, {
    origin: "https://test.example",
    signingKey: key,
    lineChannelId: channel,
    lineChannelSecret: "test-line-secret",
    lineAccessToken: "test-not-real-token",
  });
  try {
    for (const [i, replyStatus] of [200, 302, 429].entries()) {
      const e = event(randomUUID(), "U" + String(i + 1).repeat(32));
      const raw = Buffer.from(
        JSON.stringify({ destination: "U" + "d".repeat(32), events: [e] }),
      );
      const requests: string[] = [];
      await service.webhook(
        raw,
        createHmac("sha256", "test-line-secret").update(raw).digest("base64"),
        async (input: any, init: any) => {
          requests.push(String(input));
          assert.equal(init.redirect, "manual");
          if (String(input).includes("/profile/"))
            return new Response(null, { status: 503 });
          const message = JSON.parse(init.body);
          assert.match(message.messages[0].text, /お名前/);
          return new Response(null, { status: replyStatus });
        },
      );
      assert.equal(requests.length, 2);
      assert.ok(requests.every((x) => !x.endsWith("/push")));
      assert.equal(
        db.row("SELECT status FROM line_webhooks WHERE id=?", e.webhookEventId)
          .status,
        replyStatus === 200 ? "sent" : "failed",
      );
    }
    assert.equal(db.row("SELECT count(*) n FROM participants").n, 0);
    db.run("UPDATE line_conversations SET expires_at=0");
    assert.match(
      service.respond(
        event(randomUUID(), "U" + "1".repeat(32), "Expired name"),
      )[0].text,
      /参加希望/,
    );
    assert.equal(db.row("SELECT count(*) n FROM participants").n, 0);
  } finally {
    db.close();
  }
});
