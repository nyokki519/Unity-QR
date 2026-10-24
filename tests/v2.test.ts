import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/store.js";
import {
  signTicket,
  verifyTicket,
  hashPassword,
  checkPassword,
} from "../server/security.js";

const key = "test-only-key-not-production-".repeat(3);
const admin = { id: "admin", role: "Admin", events: [] } as const;
function setup() {
  const db = new Store(":memory:");
  const event = db.createEvent(
    admin,
    {
      title: "UNITY NIGHT",
      startsAt: new Date().toISOString(),
      opensAt: new Date(Date.now() - 60_000).toISOString(),
      closesAt: new Date(Date.now() + 3600_000).toISOString(),
      capacity: 2,
      venue: "Tokyo",
    },
    crypto.randomUUID(),
  );
  const participant = db.register(
    admin,
    event.id,
    { name: "Yuki" },
    crypto.randomUUID(),
  );
  return { db, event, participant };
}
test("passwords use salted hashes and reject incorrect passwords", () => {
  const one = hashPassword("test-only-password-123");
  assert.notEqual(one, hashPassword("test-only-password-123"));
  assert.equal(checkPassword("test-only-password-123", one), true);
  assert.equal(checkPassword("wrong", one), false);
});
test("signed tickets reject tampering, expiry, wrong event and unknown issuer", () => {
  const token = signTicket(key, "event", "person", Date.now() + 60000);
  assert.equal(verifyTicket(key, token, "event").participantId, "person");
  assert.throws(() => verifyTicket(key, token + "x", "event"));
  assert.throws(() => verifyTicket(key, token, "other"));
  assert.throws(() =>
    verifyTicket(
      key,
      signTicket(key, "event", "person", Date.now() - 1),
      "event",
    ),
  );
  assert.throws(() =>
    verifyTicket(key, "https://foreign.test/ticket", "event"),
  );
});
test("idempotency and unique attendance prevent duplicate audit, capacity and sync counts", () => {
  const { db, event, participant } = setup();
  const request = crypto.randomUUID();
  const first = db.checkin(admin, event.id, participant.id, request);
  assert.deepEqual(db.checkin(admin, event.id, participant.id, request), first);
  assert.equal(
    db.checkin(admin, event.id, participant.id, crypto.randomUUID()).duplicate,
    true,
  );
  assert.equal(db.summary(admin, event.id).checkedIn, 1);
  assert.equal(
    db.history(admin, event.id).filter((r: any) => r.action === "checkin")
      .length,
    1,
  );
  assert.equal(db.outbox().length, 1);
  assert.throws(
    () => db.checkin(admin, event.id, "different", request),
    /idempotency_conflict/,
  );
  db.close();
});
test("same-name people stay distinct, search and cancellation are explicit", () => {
  const { db, event, participant } = setup();
  const second = db.register(
    admin,
    event.id,
    { name: "Yuki" },
    crypto.randomUUID(),
  );
  assert.notEqual(participant.id, second.id);
  assert.equal(db.participants(admin, event.id, { search: "Yuki" }).length, 2);
  assert.equal(
    db.participants(admin, event.id, { search: "absent" }).length,
    0,
  );
  db.cancel(
    admin,
    event.id,
    participant.id,
    "本人から取消",
    crypto.randomUUID(),
  );
  assert.throws(
    () => db.checkin(admin, event.id, participant.id, crypto.randomUUID()),
    /registration_cancelled/,
  );
  assert.equal(
    db.participants(admin, event.id, { status: "cancelled" }).length,
    1,
  );
  db.close();
});
test("Staff/Viewer event scopes are enforced and undo needs Admin plus an audited reason", () => {
  const { db, event, participant } = setup();
  const staff: any = { id: "staff", role: "Staff", events: [event.id] };
  const viewer: any = { id: "viewer", role: "Viewer", events: [event.id] };
  assert.equal(db.participants(viewer, event.id).length, 1);
  assert.throws(
    () => db.checkin(viewer, event.id, participant.id, crypto.randomUUID()),
    /forbidden/,
  );
  assert.throws(
    () => db.participants({ ...staff, events: [] }, event.id),
    /forbidden/,
  );
  db.checkin(staff, event.id, participant.id, crypto.randomUUID());
  assert.throws(
    () =>
      db.undo(staff, event.id, participant.id, "mistake", crypto.randomUUID()),
    /forbidden/,
  );
  assert.throws(
    () => db.undo(admin, event.id, participant.id, "", crypto.randomUUID()),
    /reason_required/,
  );
  db.undo(
    admin,
    event.id,
    participant.id,
    "読み取りを訂正",
    crypto.randomUUID(),
  );
  assert.equal(db.summary(admin, event.id).checkedIn, 0);
  assert.equal(db.history(admin, event.id)[0].reason, "読み取りを訂正");
  assert.equal(db.outbox().length, 2);
  db.checkin(admin, event.id, participant.id, crypto.randomUUID());
  assert.equal(db.summary(admin, event.id).checkedIn, 1);
  db.close();
});
test("full event keeps duplicate receipt valid but rejects another arrival", () => {
  const { db, event, participant } = setup();
  const second = db.register(
    admin,
    event.id,
    { name: "Other" },
    crypto.randomUUID(),
  );
  const third = db.register(
    admin,
    event.id,
    { name: "Third" },
    crypto.randomUUID(),
  );
  db.checkin(admin, event.id, participant.id, crypto.randomUUID());
  db.checkin(admin, event.id, second.id, crypto.randomUUID());
  assert.equal(
    db.checkin(admin, event.id, participant.id, crypto.randomUUID()).duplicate,
    true,
  );
  assert.throws(
    () => db.checkin(admin, event.id, third.id, crypto.randomUUID()),
    /capacity_reached/,
  );
  assert.equal(db.summary(admin, event.id).checkedIn, 2);
  db.close();
});
test("expired events and stale migrations do not admit attendees", () => {
  const { db, event, participant } = setup();
  db.sql
    .prepare("UPDATE events SET closes_at=? WHERE id=?")
    .run(new Date(Date.now() - 1).toISOString(), event.id);
  assert.throws(
    () => db.checkin(admin, event.id, participant.id, crypto.randomUUID()),
    /event_closed/,
  );
  db.migrate();
  assert.equal(db.participants(admin, event.id).length, 1);
  db.close();
});
test("online backup restores records and audit without clearing the source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unity-backup-"));
  const { db, event, participant } = setup();
  db.checkin(admin, event.id, participant.id, crypto.randomUUID());
  try {
    await db.backup(join(dir, "copy.sqlite"));
    const restored = new Store(join(dir, "copy.sqlite"));
    assert.equal(restored.summary(admin, event.id).checkedIn, 1);
    assert.equal(
      restored
        .history(admin, event.id)
        .filter((r: any) => r.action === "checkin").length,
      1,
    );
    assert.equal(db.summary(admin, event.id).checkedIn, 1);
    restored.close();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("event edits and cancelled-registration restoration require Admin and retain attendance", () => {
  const { db, event, participant } = setup();
  const staff: any = { id: "staff", role: "Staff", events: [event.id] };
  assert.throws(
    () =>
      db.updateEvent(
        staff,
        event.id,
        { ...event, title: "Changed" },
        crypto.randomUUID(),
      ),
    /forbidden/,
  );
  db.checkin(admin, event.id, participant.id, crypto.randomUUID());
  const changed = db.updateEvent(
    admin,
    event.id,
    { ...event, title: "Changed" },
    crypto.randomUUID(),
  );
  assert.equal(changed.title, "Changed");
  assert.equal(db.summary(admin, event.id).checkedIn, 1);
  const other = db.register(
    admin,
    event.id,
    { name: "Other" },
    crypto.randomUUID(),
  );
  db.cancel(admin, event.id, other.id, "取消", crypto.randomUUID());
  db.restore(admin, event.id, other.id, "取消を訂正", crypto.randomUUID());
  assert.equal(
    db.participants(admin, event.id).find((p: any) => p.id === other.id).status,
    "waiting",
  );
  assert.equal(db.history(admin, event.id)[0].action, "restore");
  db.close();
});
test("opening an unrelated database fails before modifying its schema or journal mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "unity-foreign-"));
  const path = join(dir, "foreign.sqlite");
  const foreign = new DatabaseSync(path);
  foreign.exec(
    "CREATE TABLE valuable_data(id TEXT);INSERT INTO valuable_data VALUES('preserve')",
  );
  foreign.close();
  try {
    assert.throws(() => new Store(path), /foreign_database/);
    const check = new DatabaseSync(path);
    assert.equal(
      (check.prepare("SELECT id FROM valuable_data").get() as any).id,
      "preserve",
    );
    assert.equal(
      (
        check
          .prepare("SELECT count(*) c FROM sqlite_master WHERE name='events'")
          .get() as any
      ).c,
      0,
    );
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("additive v1-to-v4 outbox migration preserves attendance and durable mutation order", () => {
  const { db, event, participant } = setup();
  db.checkin(admin, event.id, participant.id, crypto.randomUUID());
  db.undo(admin, event.id, participant.id, "訂正", crypto.randomUUID());
  const original = db.outbox().map((r: any) => r.id);
  db.sql.exec(`ALTER TABLE outbox RENAME TO old_outbox;
    CREATE TABLE outbox(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at TEXT NOT NULL);
    INSERT INTO outbox SELECT id,event_id,payload,status,attempts,next_attempt,last_error,created_at FROM old_outbox ORDER BY sequence;
    DROP TABLE old_outbox; PRAGMA user_version=1;`);
  db.migrate();
  const migrated = db.rows("SELECT * FROM outbox ORDER BY sequence");
  assert.deepEqual(
    migrated.map((r: any) => r.id),
    original,
  );
  assert.equal(db.summary(admin, event.id).checkedIn, 0);
  assert.deepEqual(
    migrated.map((r: any) => JSON.parse(r.payload).sequence),
    [1, 2],
  );
  assert.equal(db.row("PRAGMA user_version").user_version, 4);
  db.close();
});
