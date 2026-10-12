const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { readdirSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { randomUUID } = require("node:crypto");
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const QRCode = require("qrcode");
const { PNG } = require("pngjs");
let mf,
  snapshot,
  event,
  person,
  signing,
  password,
  adminCookie,
  Store,
  exportSnapshot,
  importOwnedSnapshot;
const origin = "https://qr-cloud-test.example";
const key = "test-only-cloud-signing-key-".repeat(3);
const setup = "test-only-cloud-setup-key-".repeat(3);
const dir = mkdtempSync(join(tmpdir(), "qr-cloudflare-test-"));
function start() {
  return new Miniflare(
    convertV4MiniflareOptions({
      name: "unity-qr-cloud-test",
      modules: true,
      scriptPath: resolve("dist/cloudflare-worker/worker.js"),
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { QR_SIGNING_KEY: key, QR_SETUP_TOKEN: setup },
      durableObjects: { QR_DB: { className: "QRReception", useSQLite: true } },
      resourcePersistencePath: dir,
      stripCfConnectingIp: false,
      assets: {
        directory: resolve("dist/cloudflare-public"),
        binding: "ASSETS",
        run_worker_first: ["/api/*"],
        routerConfig: { has_user_worker: true },
      },
      telemetry: { enabled: false },
    }),
  );
}
const call = (path, method = "GET", body, cookie = "", extras = {}) =>
  mf.dispatchFetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: cookie,
      "Idempotency-Key": randomUUID(),
      ...extras,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function login(username = "operator") {
  const r = await call("/api/v2/login", "POST", { username, password });
  assert.equal(r.status, 200, await r.clone().text());
  return r.headers.get("set-cookie").split(";")[0];
}
test.before(async () => {
  ({ Store } = await import("../dist/server/store.js"));
  ({ exportSnapshot, importOwnedSnapshot } = await import(
    "../dist/server/migration.js"
  ));
  const security = await import("../dist/server/security.js");
  signing = security.signTicket;
  password = "test-only-cloud-password-123";
  const source = new Store(":memory:");
  try {
    const id = source.addUser(
      "operator",
      security.hashPassword(password),
      "Admin",
    );
    const actor = { id, role: "Admin", events: [] };
    event = source.createEvent(
      actor,
      {
        title: "Cloud migration fixture",
        venue: "Test only",
        capacity: 10,
        startsAt: new Date().toISOString(),
        opensAt: new Date(Date.now() - 60000).toISOString(),
        closesAt: new Date(Date.now() + 3600000).toISOString(),
      },
      randomUUID(),
    );
    source.addUser("staff", security.hashPassword(password), "Staff", [
      event.id,
    ]);
    source.addUser("viewer", security.hashPassword(password), "Viewer", [
      event.id,
    ]);
    const existing = source.register(
      actor,
      event.id,
      { name: "Already arrived" },
      randomUUID(),
    );
    source.checkin(actor, event.id, existing.id, randomUUID(), "qr");
    person = source.register(
      actor,
      event.id,
      { name: "Cloud test A" },
      randomUUID(),
    );
    snapshot = exportSnapshot(source);
  } finally {
    source.close();
  }
  mf = start();
  await mf.ready;
});
test.after(async () => {
  if (mf) await mf.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("actual SQLite DO import requires a secret, rolls back broken data and recovers the exact committed import", async () => {
  const unauthorized = await call("/api/v2/setup", "POST", snapshot);
  assert.equal(unauthorized.status, 401, await unauthorized.clone().text());
  const broken = structuredClone(snapshot);
  broken.tables.registrations[0].participant_id = "missing";
  assert.ok(
    (
      await call("/api/v2/setup", "POST", broken, "", {
        Authorization: "Bearer " + setup,
      })
    ).status >= 400,
  );
  const first = await call("/api/v2/setup", "POST", snapshot, "", {
    Authorization: "Bearer " + setup,
  });
  assert.equal(first.status, 200, await first.clone().text());
  const result = await first.json();
  assert.equal(result.counts.attendance, 1);
  const retry = await call("/api/v2/setup", "POST", snapshot, "", {
    Authorization: "Bearer " + setup,
  });
  assert.deepEqual(await retry.json(), result);
  const other = structuredClone(snapshot);
  other.tables.events[0].title = "Different import";
  assert.equal(
    (
      await call("/api/v2/setup", "POST", other, "", {
        Authorization: "Bearer " + setup,
      })
    ).status,
    409,
  );
});
test("workerd scrypt login, CSRF, scoped Staff and Viewer restrictions match Node", async () => {
  assert.equal((await call("/api/v2/events")).status, 401);
  adminCookie = await login();
  const session = await call("/api/v2/session", "GET", undefined, adminCookie);
  assert.equal((await session.json()).pollIntervalMs, 30000);
  const staff = await login("staff"),
    viewer = await login("viewer");
  const people = await call(
    "/api/v2/participants?event=" + event.id,
    "GET",
    undefined,
    viewer,
  );
  assert.equal(people.status, 200);
  assert.equal((await people.json()).summary.checkedIn, 1);
  assert.equal(
    (
      await call(
        "/api/v2/ticket?event=" + event.id + "&participant=" + person.id,
        "GET",
        undefined,
        viewer,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/api/v2/checkins",
        "POST",
        { eventId: event.id, participantId: person.id },
        viewer,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/api/v2/participants?event=unassigned",
        "GET",
        undefined,
        staff,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/api/v2/checkins",
        "POST",
        { eventId: event.id, participantId: person.id },
        adminCookie,
        { Origin: "https://foreign.example" },
      )
    ).status,
    403,
  );
});
test("real QR, concurrent receipts, audit, duplicate rescan and Admin undo work on Durable SQL", async () => {
  const ticket = await call(
    "/api/v2/ticket?event=" + event.id + "&participant=" + person.id,
    "GET",
    undefined,
    adminCookie,
  );
  assert.equal(ticket.status, 200);
  const { token } = await ticket.json();
  const image = PNG.sync.read(
    await QRCode.toBuffer(token, { width: 600, margin: 4 }),
  );
  const { decode } = await import("../dist/server/decoder.js");
  assert.equal(
    decode(new Uint8ClampedArray(image.data), image.width, image.height),
    token,
  );
  const requestKey = randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 6 }, () =>
      call(
        "/api/v2/checkins",
        "POST",
        { eventId: event.id, ticket: token },
        adminCookie,
        { "Idempotency-Key": requestKey },
      ),
    ),
  );
  assert.ok(responses.every((r) => r.status === 200));
  const receipts = await Promise.all(responses.map((r) => r.json()));
  assert.ok(receipts.every((r) => r.checkedInAt === receipts[0].checkedInAt));
  const duplicate = await call(
    "/api/v2/checkins",
    "POST",
    { eventId: event.id, ticket: token },
    adminCookie,
  );
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(
    (
      await call(
        "/api/v2/checkins",
        "POST",
        { eventId: event.id, ticket: token + "x" },
        adminCookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "/api/v2/checkins",
        "POST",
        {
          eventId: event.id,
          ticket: signing(key, event.id, person.id, Date.now() - 1),
        },
        adminCookie,
      )
    ).status,
    400,
  );
  const undo = {
    eventId: event.id,
    participantId: person.id,
    reason: "Cloud test undo",
  };
  assert.equal(
    (await call("/api/v2/undo", "POST", undo, await login("staff"))).status,
    403,
  );
  assert.equal(
    (await call("/api/v2/undo", "POST", { ...undo, reason: "" }, adminCookie))
      .status,
    400,
  );
  assert.equal(
    (await call("/api/v2/undo", "POST", undo, adminCookie)).status,
    200,
  );
  const history = (
    await (
      await call(
        "/api/v2/history?event=" + event.id,
        "GET",
        undefined,
        adminCookie,
      )
    ).json()
  ).history;
  assert.equal(
    history.filter(
      (h) => h.participant_id === person.id && h.action === "checkin",
    ).length,
    1,
  );
  assert.equal(
    history.filter((h) => h.participant_id === person.id && h.action === "undo")
      .length,
    1,
  );
});
test("cloud backups are Admin-only, no-store and restorable; static assets never expose private files", async () => {
  assert.equal((await call("/api/v2/backup")).status, 401);
  assert.equal(
    (await call("/api/v2/backup", "GET", undefined, await login("viewer")))
      .status,
    403,
  );
  const backup = await call("/api/v2/backup", "GET", undefined, adminCookie);
  assert.equal(backup.status, 200);
  assert.equal(backup.headers.get("cache-control"), "no-store");
  const data = await backup.json();
  assert.equal("sessions" in data.tables, false);
  const target = new Store(":memory:");
  try {
    importOwnedSnapshot(target, data);
    assert.ok(target.login("operator", password));
    assert.equal(
      target.row(
        "SELECT state FROM attendance WHERE participant_id=?",
        person.id,
      ).state,
      "undone",
    );
  } finally {
    target.close();
  }
  const page = await call("/ops/");
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  for (const path of [
    "/data/qr.sqlite",
    "/.env",
    "/server/security.ts",
    "/package.json",
    "/README.md",
    "/.git/config",
  ])
    assert.equal((await call(path)).status, 404, path);
});
test("runtime restart preserves receipts, sessions and failed-login throttling", async () => {
  for (let n = 0; n < 10; n++)
    assert.equal(
      (
        await call(
          "/api/v2/login",
          "POST",
          { username: "missing", password },
          "",
          { "CF-Connecting-IP": "203.0.113.9" },
        )
      ).status,
      401,
    );
  await mf.dispose();
  mf = start();
  await mf.ready;
  assert.equal(
    (
      await call(
        "/api/v2/login",
        "POST",
        { username: "missing", password },
        "",
        { "CF-Connecting-IP": "203.0.113.9" },
      )
    ).status,
    429,
  );
  const list = await call(
    "/api/v2/participants?event=" + event.id,
    "GET",
    undefined,
    adminCookie,
  );
  assert.equal(list.status, 200);
  const people = await list.json();
  assert.equal(people.summary.checkedIn, 1);
  assert.equal(
    people.participants.find((p) => p.id === person.id).status,
    "waiting",
  );
  adminCookie = await login();
});
test("a missing cloud database owner marker is rejected without claiming or changing existing data", async () => {
  await mf.dispose();
  mf = undefined;
  function files(path) {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(path, entry.name))
        : [join(path, entry.name)],
    );
  }
  let database;
  for (const path of files(dir).filter((path) => path.endsWith(".sqlite"))) {
    const candidate = new DatabaseSync(path, { readOnly: true });
    try {
      if (
        candidate
          .prepare(
            "SELECT count(*) n FROM sqlite_master WHERE name='_unity_qr_meta'",
          )
          .get().n
      )
        database = path;
    } finally {
      candidate.close();
    }
  }
  assert.ok(database, "the real Durable Object SQLite file must exist");
  const raw = new DatabaseSync(database);
  raw.exec("DELETE FROM _unity_qr_meta WHERE key='application'");
  const count = raw.prepare("SELECT count(*) n FROM participants").get().n;
  raw.close();
  mf = start();
  await mf.ready;
  assert.equal((await call("/api/v2/health")).status, 503);
  await mf.dispose();
  mf = undefined;
  const verify = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(
      verify
        .prepare(
          "SELECT count(*) n FROM _unity_qr_meta WHERE key='application'",
        )
        .get().n,
      0,
    );
    assert.equal(
      verify.prepare("SELECT count(*) n FROM participants").get().n,
      count,
    );
  } finally {
    verify.close();
  }
});
