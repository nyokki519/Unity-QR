import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Store } from "../server/store.js";
import { digest, hashPassword, verifyTicket } from "../server/security.js";
import { FormClaims } from "../server/form-claims.js";
import { LineService } from "../server/line.js";
import { exportSnapshot, importOwnedSnapshot } from "../server/migration.js";
const admin: any = { id: "fixture", role: "Admin", events: [] };
const key = "test-only-claim-key-".repeat(3);
const formKey = "test-only-form-auth-key-".repeat(3);
function fixture() {
  const db = new Store(":memory:");
  db.addUser("operator", hashPassword("test-only-password-123"), "Admin");
  const ev = db.createEvent(
    admin,
    {
      title: "Accepted event",
      venue: "Tokyo",
      capacity: 5,
      startsAt: new Date().toISOString(),
      opensAt: new Date(Date.now() - 60000).toISOString(),
      closesAt: new Date(Date.now() + 3600000).toISOString(),
    },
    randomUUID(),
  );
  const token = randomBytes(32).toString("hex");
  const data = {
    claimHash: digest(token),
    receiptHash: digest("receipt1"),
    name: "Google申込名",
    eventId: randomUUID(),
    eventName: "Googleイベント",
    eventDate: new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
  };
  const claims = new FormClaims(db);
  return { db, ev, token, data, claims };
}
const message = (raw: string, user = "U" + "a".repeat(32)): any => ({
  type: "message",
  source: { type: "user", userId: user },
  message: { type: "text", text: "参加QR " + raw },
});
test("accepted Google claims deduplicate exact receipts and reject reuse with different data", () => {
  const { db, claims, data } = fixture();
  try {
    claims.accept(data);
    claims.accept({ ...data });
    assert.equal(db.row("SELECT count(*) n FROM form_claims").n, 1);
    assert.throws(
      () => claims.accept({ ...data, name: "changed" }),
      /claim_conflict/,
    );
    assert.throws(
      () => claims.accept({ ...data, receiptHash: digest("other") }),
      /claim_conflict/,
    );
    assert.throws(
      () => claims.accept({ ...data, eventDate: "2026-02-30" }),
      /invalid_form_claim/,
    );
    assert.equal(
      JSON.stringify(claims.publicConfig()).includes(data.name),
      false,
    );
  } finally {
    db.close();
  }
});
test("LINE accepted code assigns submitted name/event once and refuses another LINE user", () => {
  const { db, ev, token, data, claims } = fixture();
  try {
    claims.accept(data);
    claims.map(
      admin,
      {
        eventId: ev.id,
        externalEventId: data.eventId,
        eventDate: data.eventDate,
      },
      randomUUID(),
    );
    const service = new LineService(db, {
      origin: "https://test.example",
      signingKey: key,
      lineChannelId: "1234567890",
    });
    const first = service.respond(message(token), "Different LINE display");
    assert.match(first[0].text, /Google申込名/);
    assert.equal(db.row("SELECT name FROM participants").name, data.name);
    assert.match(first[0].text, /#([a-f0-9]{64})/);
    service.respond(message(token));
    assert.equal(db.row("SELECT count(*) n FROM registrations").n, 1);
    assert.match(
      service.respond(message(token, "U" + "b".repeat(32)))[0].text,
      /別のLINE|使用済み/,
    );
    assert.equal(db.row("SELECT count(*) n FROM participants").n, 1);
    const link = first[0].text.match(/#([a-f0-9]{64})/)![1];
    const ticket = service.ticket(link);
    assert.equal(verifyTicket(key, ticket.token!, ev.id).eventId, ev.id);
    assert.equal(ticket.name, data.name);
    const cancelledId = db.row("SELECT id FROM participants").id;
    db.cancel(admin, ev.id, cancelledId, "test", randomUUID());
    assert.match(service.respond(message(token))[0].text, /キャンセル/);
    assert.equal(
      db.row("SELECT status FROM registrations").status,
      "cancelled",
    );
  } finally {
    db.close();
  }
});
test("unconfirmed, unmapped and expired claims cannot create participants; mapping requires Admin", () => {
  const { db, ev, token, data, claims } = fixture();
  try {
    const line = new LineService(db, {
      origin: "https://test.example",
      signingKey: key,
      lineChannelId: "1234567890",
    });
    assert.match(line.respond(message(token))[0].text, /確認|受理/);
    assert.equal(db.row("SELECT count(*) n FROM participants").n, 0);
    claims.accept(data);
    assert.match(line.respond(message(token))[0].text, /運営|準備/);
    assert.throws(
      () => claims.map({ ...admin, role: "Staff" }, {}, randomUUID()),
      /forbidden/,
    );
    claims.map(
      admin,
      {
        eventId: ev.id,
        externalEventId: data.eventId,
        eventDate: data.eventDate,
      },
      randomUUID(),
    );
    db.run(
      "UPDATE events SET closes_at=? WHERE id=?",
      new Date(Date.now() - 1).toISOString(),
      ev.id,
    );
    assert.match(line.respond(message(token))[0].text, /終了/);
    assert.equal(db.row("SELECT count(*) n FROM participants").n, 0);
  } finally {
    db.close();
  }
});
test("v4 snapshots retain accepted receipt and ownership; v3 snapshot remains restorable", () => {
  const { db, claims, data } = fixture();
  const restored = new Store(":memory:"),
    old = new Store(":memory:");
  try {
    claims.accept(data);
    const snapshot = exportSnapshot(db);
    assert.equal(snapshot.schemaVersion, 4);
    importOwnedSnapshot(restored, snapshot);
    assert.equal(restored.row("SELECT count(*) n FROM form_claims").n, 1);
    const legacy: any = structuredClone(snapshot);
    legacy.schemaVersion = 3;
    for (const table of Object.keys(legacy.tables))
      if (table.startsWith("form_")) delete legacy.tables[table];
    importOwnedSnapshot(old, legacy);
    assert.equal(old.row("SELECT count(*) n FROM form_claims").n, 0);
  } finally {
    db.close();
    restored.close();
    old.close();
  }
});

test("date-mismatched Analytics IDs remain visible for explicit Admin mapping", () => {
  const { db, ev, data, claims } = fixture();
  try {
    claims.accept(data);
    db.run(
      "UPDATE events SET source=?,external_id=?,starts_at=? WHERE id=?",
      "analytics",
      data.eventId,
      new Date(Date.now() + 86400000).toISOString(),
      ev.id,
    );
    assert.equal(claims.settings(admin).pending.length, 1);
  } finally {
    db.close();
  }
});
test("CLI verifies owned v4 SQLite backup without rejecting the new schema", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { db } = fixture();
  const folder = mkdtempSync(join(tmpdir(), "form-v4-backup-"));
  try {
    const path = join(folder, "backup.sqlite");
    await db.backup(path);
    const result = spawnSync(
      process.execPath,
      [resolve("dist/server/cli.js"), "verify", path],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /verified/);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
