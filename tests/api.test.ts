import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.js";
import { Store } from "../server/store.js";
import { hashPassword, signTicket } from "../server/security.js";
import {
  importSnapshot,
  deliverOutbox,
  verifyPass,
} from "../server/integrations.js";

const admin: any = { id: "admin", role: "Admin", events: [] };
const input = {
  title: "UNITY NIGHT",
  venue: "Tokyo",
  capacity: 50,
  startsAt: new Date().toISOString(),
  opensAt: new Date(Date.now() - 60000).toISOString(),
  closesAt: new Date(Date.now() + 3600000).toISOString(),
};
async function harness() {
  const store = new Store(":memory:");
  const event = store.createEvent(admin, input, crypto.randomUUID());
  const participant = store.register(
    admin,
    event.id,
    { name: "API Yuki" },
    crypto.randomUUID(),
  );
  store.addUser("admin", hashPassword("test-only-password-123"), "Admin");
  store.addUser("staff", hashPassword("test-only-password-123"), "Staff", [
    event.id,
  ]);
  store.addUser("viewer", hashPassword("test-only-password-123"), "Viewer", [
    event.id,
  ]);
  const config: any = {
    origin: "http://127.0.0.1",
    signingKey: "test-only-signing-key-".repeat(3),
    root: process.cwd(),
  };
  const app = createApp(store, config);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (app.address() as any).port;
  config.origin = base;
  const call = async (
    path: string,
    method = "GET",
    body?: any,
    cookie = "",
    origin = base,
    key = crypto.randomUUID(),
  ) =>
    fetch(base + path, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
        "Idempotency-Key": key,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (name = "admin") => {
    const r = await call("/api/v2/login", "POST", {
      username: name,
      password: "test-only-password-123",
    });
    assert.equal(r.status, 200);
    return r.headers.get("set-cookie")!.split(";")[0];
  };
  return {
    store,
    event,
    participant,
    call,
    login,
    config,
    close: async () => {
      await new Promise<void>((r) => app.close(() => r()));
      store.close();
    },
  };
}
test("private API requires server session, no-store, exact origin and viewer restrictions", async () => {
  const h = await harness();
  try {
    const unauth = await h.call("/api/v2/events");
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get("cache-control")!, /no-store/);
    assert.equal(
      (
        await h.call(
          "/api/v2/login",
          "POST",
          { username: "admin", password: "test-only-password-123" },
          "",
          "https://foreign.test",
        )
      ).status,
      403,
    );
    const cookie = await h.login("viewer");
    assert.equal(
      (
        await h.call(
          `/api/v2/participants?event=${h.event.id}`,
          "GET",
          undefined,
          cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await h.call(
          "/api/v2/checkins",
          "POST",
          { eventId: h.event.id, participantId: h.participant.id },
          cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (await h.call("/api/v2/settings", "GET", undefined, cookie)).status,
      403,
    );
    await h.call("/api/v2/logout", "POST", {}, cookie);
    assert.equal(
      (await h.call("/api/v2/events", "GET", undefined, cookie)).status,
      401,
    );
  } finally {
    await h.close();
  }
});
test("genuine ticket and concurrent API retries yield one server receipt", async () => {
  const h = await harness();
  try {
    const cookie = await h.login("staff");
    const qr = await h.call(
      `/api/v2/ticket?event=${h.event.id}&participant=${h.participant.id}`,
      "GET",
      undefined,
      cookie,
    );
    assert.equal(qr.status, 200);
    const { token } = await qr.json();
    const request = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        h.call(
          "/api/v2/checkins",
          "POST",
          { eventId: h.event.id, ticket: token },
          cookie,
          undefined,
          request,
        ),
      ),
    );
    const bodies = await Promise.all(results.map((r) => r.json()));
    assert.ok(results.every((r) => r.status === 200));
    assert.ok(bodies.every((b) => b.checkedInAt === bodies[0].checkedInAt));
    assert.equal(h.store.summary(admin, h.event.id).checkedIn, 1);
    assert.equal(h.store.outbox().length, 1);
    assert.equal(
      (
        await h.call(
          "/api/v2/checkins",
          "POST",
          { eventId: h.event.id, ticket: token + "x" },
          cookie,
        )
      ).status,
      400,
    );
    const other = h.store.createEvent(admin, input, crypto.randomUUID());
    const administrator = await h.login();
    assert.equal(
      (
        await h.call(
          "/api/v2/checkins",
          "POST",
          { eventId: other.id, ticket: token },
          administrator,
        )
      ).status,
      400,
    );
    h.store.sql.prepare("UPDATE sessions SET expires_at=0").run();
    assert.equal(
      (await h.call("/api/v2/events", "GET", undefined, cookie)).status,
      401,
    );
  } finally {
    await h.close();
  }
});
test("login throttles repeated failures and never exposes secrets in settings", async () => {
  const h = await harness();
  try {
    const cookie = await h.login();
    const settings = await (
      await h.call("/api/v2/settings", "GET", undefined, cookie)
    ).json();
    assert.equal(
      JSON.stringify(settings).includes("test-only-signing-key"),
      false,
    );
    let status = 0;
    for (let i = 0; i < 12; i++)
      status = (
        await h.call("/api/v2/login", "POST", {
          username: "wrong",
          password: "wrong",
        })
      ).status;
    assert.equal(status, 429);
  } finally {
    await h.close();
  }
});
test("Analytics import is idempotent, separates name collisions and preserves local attendance", () => {
  const db = new Store(":memory:");
  const snapshot: any = {
    version: 1,
    events: [{ ...input, externalId: "external-event" }],
    participants: [
      { externalId: "p1", name: "Same" },
      { externalId: "p2", name: "Same" },
    ],
    registrations: [
      { eventExternalId: "external-event", participantExternalId: "p1" },
      { eventExternalId: "external-event", participantExternalId: "p2" },
    ],
  };
  const preview = importSnapshot(db, admin, snapshot, true);
  assert.equal(preview.events, 1);
  assert.equal(db.events(admin).length, 0);
  importSnapshot(db, admin, snapshot);
  const event = db.events(admin)[0];
  const person = db.participants(admin, event.id)[0];
  db.checkin(admin, event.id, person.id, crypto.randomUUID());
  importSnapshot(db, admin, snapshot);
  assert.equal(db.events(admin).length, 1);
  assert.equal(db.participants(admin, event.id).length, 2);
  assert.equal(db.summary(admin, event.id).checkedIn, 1);
  db.cancel(
    admin,
    event.id,
    db.participants(admin, event.id).find((p: any) => p.id !== person.id).id,
    "取消",
    crypto.randomUUID(),
  );
  importSnapshot(db, admin, snapshot);
  assert.equal(db.summary(admin, event.id).cancelled, 1);
  assert.throws(
    () =>
      importSnapshot(db, admin, {
        ...snapshot,
        registrations: [
          { eventExternalId: "unknown", participantExternalId: "p1" },
        ],
      }),
    /invalid_snapshot/,
  );
  assert.equal(db.summary(admin, event.id).checkedIn, 1);
  db.close();
});
test("Analytics delivery preserves pending when disconnected, retries with same idempotency ID and records failure", async () => {
  const db = new Store(":memory:");
  const event = db.createEvent(admin, input, crypto.randomUUID());
  const p = db.register(admin, event.id, { name: "Yuki" }, crypto.randomUUID());
  db.checkin(admin, event.id, p.id, crypto.randomUUID());
  const config: any = {};
  assert.equal((await deliverOutbox(db, config)).connected, false);
  assert.equal(db.outbox()[0].attempts, 0);
  Object.assign(config, {
    analyticsDeliveryUrl: "https://analytics.example.test/reception",
    analyticsToken: "test-only",
  });
  const keys: string[] = [];
  await deliverOutbox(db, config, async (_url: any, options: any) => {
    keys.push(options.headers["Idempotency-Key"]);
    return new Response("", { status: 503 });
  });
  assert.equal(db.outbox()[0].status, "failed");
  db.sql.prepare("UPDATE outbox SET next_attempt=0").run();
  await deliverOutbox(db, config, async (_url: any, options: any) => {
    keys.push(options.headers["Idempotency-Key"]);
    return new Response(JSON.stringify({ accepted: true, changeId: keys[1] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  assert.equal(keys[0], keys[1]);
  assert.equal(db.outbox()[0].status, "sent");
  assert.equal(db.outbox()[0].attempts, 2);
  db.close();
});
test("PASS fails closed without a configured verifier and checks member/event/expiry", async () => {
  await assert.rejects(
    () => verifyPass({}, "ticket", "event"),
    /pass_disconnected/,
  );
  const cfg: any = {
    passVerifyUrl: "https://pass.example.test/verify",
    passToken: "test-only",
  };
  const response = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          version: 1,
          memberId: "member",
          eventId: "event",
          expiresAt: Date.now() + 60000,
        }),
      ),
    );
  assert.equal(
    (await verifyPass(cfg, "ticket", "event", response)).memberId,
    "member",
  );
  await assert.rejects(
    () => verifyPass(cfg, "ticket", "other", response),
    /invalid_pass/,
  );
});
test("a committed QR receipt recovers by exact request key even after ticket expiry", async (t) => {
  const h = await harness();
  try {
    const cookie = await h.login();
    const token = signTicket(
        "test-only-signing-key-".repeat(3),
        h.event.id,
        h.participant.id,
        Date.now() + 60000,
      ),
      key = crypto.randomUUID();
    const body = { eventId: h.event.id, ticket: token };
    const original = await (
      await h.call("/api/v2/checkins", "POST", body, cookie, undefined, key)
    ).json();
    const later = Date.now() + 120000;
    t.mock.method(Date, "now", () => later);
    const retry = await h.call(
      "/api/v2/checkins",
      "POST",
      body,
      cookie,
      undefined,
      key,
    );
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), original);
    assert.equal(
      (
        await h.call(
          "/api/v2/checkins",
          "POST",
          { ...body, ticket: token + "x" },
          cookie,
          undefined,
          key,
        )
      ).status,
      409,
    );
    assert.equal(
      (await h.call("/api/v2/checkins", "POST", body, cookie)).status,
      400,
    );
  } finally {
    t.mock.restoreAll();
    await h.close();
  }
});
test("failed Analytics predecessors block an undo until the original arrival is acknowledged", async () => {
  const db = new Store(":memory:");
  const event = db.createEvent(admin, input, crypto.randomUUID());
  const p = db.register(
    admin,
    event.id,
    { name: "Order Test" },
    crypto.randomUUID(),
  );
  db.checkin(admin, event.id, p.id, crypto.randomUUID());
  db.undo(admin, event.id, p.id, "test", crypto.randomUUID());
  const config: any = {
    analyticsDeliveryUrl: "https://analytics.example.test/reception",
    analyticsToken: "test-only",
  };
  const actions: string[] = [];
  const failure: any = async (_url: any, options: any) => {
    actions.push(JSON.parse(options.body).action);
    return new Response("", { status: 503 });
  };
  await deliverOutbox(db, config, failure);
  assert.deepEqual(actions, ["checkin"]);
  db.sql.prepare("UPDATE outbox SET next_attempt=0").run();
  const success: any = async (_url: any, options: any) => {
    const body = JSON.parse(options.body);
    actions.push(body.action);
    assert.ok(Number.isSafeInteger(body.sequence));
    return new Response(
      JSON.stringify({ accepted: true, changeId: body.changeId }),
    );
  };
  await deliverOutbox(db, config, success);
  await deliverOutbox(db, config, success);
  assert.deepEqual(actions, ["checkin", "checkin", "undo"]);
  assert.equal(db.outbox().filter((r: any) => r.status === "sent").length, 2);
  db.close();
});
test("Admin user creation retries recover success and audit failures roll back the account", async () => {
  const h = await harness();
  try {
    const cookie = await h.login(),
      key = crypto.randomUUID(),
      body = {
        username: "new-staff",
        password: "test-only-password-123",
        role: "Staff",
        eventIds: [h.event.id],
      };
    const first = await h.call(
      "/api/v2/users",
      "POST",
      body,
      cookie,
      undefined,
      key,
    );
    assert.equal(first.status, 201);
    const second = await h.call(
      "/api/v2/users",
      "POST",
      body,
      cookie,
      undefined,
      key,
    );
    assert.equal(second.status, 201);
    assert.deepEqual(await second.json(), await first.json());
    h.store.sql.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON audit WHEN NEW.action='user_create' BEGIN SELECT RAISE(ABORT,'test audit unavailable'); END",
    );
    assert.equal(
      (
        await h.call(
          "/api/v2/users",
          "POST",
          { ...body, username: "should-rollback" },
          cookie,
        )
      ).status,
      500,
    );
    assert.equal(
      h.store.row(
        "SELECT count(*) count FROM users WHERE username='should-rollback'",
      ).count,
      0,
    );
  } finally {
    await h.close();
  }
});
test("a committed PASS receipt retries without reverifying a consumed or unavailable external ticket", async (t) => {
  const h = await harness();
  const originalFetch = globalThis.fetch;
  let verifications = 0;
  try {
    Object.assign(h.config, {
      passVerifyUrl: "https://pass.example.test/verify",
      passToken: "test-only",
    });
    h.store.register(
      admin,
      h.event.id,
      { name: "PASS Person", memberId: "verified-member" },
      crypto.randomUUID(),
    );
    const cookie = await h.login();
    t.mock.method(globalThis, "fetch", async (url: any, options: any) => {
      if (String(url) === "https://pass.example.test/verify") {
        verifications++;
        return verifications === 1
          ? new Response(
              JSON.stringify({
                version: 1,
                memberId: "verified-member",
                eventId: h.event.id,
                expiresAt: Date.now() + 60000,
              }),
            )
          : new Response("", { status: 503 });
      }
      return originalFetch(url, options);
    });
    const key = crypto.randomUUID(),
      body = { eventId: h.event.id, ticket: "pass:test-only-opaque-ticket" };
    const first = await h.call(
      "/api/v2/checkins",
      "POST",
      body,
      cookie,
      undefined,
      key,
    );
    assert.equal(first.status, 200);
    const second = await h.call(
      "/api/v2/checkins",
      "POST",
      body,
      cookie,
      undefined,
      key,
    );
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), await first.json());
    assert.equal(verifications, 1);
  } finally {
    t.mock.restoreAll();
    await h.close();
  }
});
