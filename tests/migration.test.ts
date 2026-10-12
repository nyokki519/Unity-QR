import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.js";
import { hashPassword, checkPassword } from "../server/security.js";
import { exportSnapshot, importOwnedSnapshot } from "../server/migration.js";

function source() {
  const db = new Store(":memory:");
  const userId = db.addUser(
    "operator",
    hashPassword("test-migration-password-123"),
    "Admin",
  );
  const actor = { id: userId, role: "Admin" as const, events: [] };
  const event = db.createEvent(
    actor,
    {
      title: "Migration test",
      venue: "Test only",
      capacity: 10,
      startsAt: new Date().toISOString(),
      opensAt: new Date(Date.now() - 60000).toISOString(),
      closesAt: new Date(Date.now() + 3600000).toISOString(),
    },
    crypto.randomUUID(),
  );
  const person = db.register(
    actor,
    event.id,
    { name: "Test A" },
    crypto.randomUUID(),
  );
  db.checkin(actor, event.id, person.id, crypto.randomUUID(), "qr");
  db.login("operator", "test-migration-password-123");
  return { db, actor, event, person };
}

test("cloud migration preserves IDs, password hashes, receipt, audit and outbox but excludes sessions", () => {
  const s = source(),
    target = new Store(":memory:");
  try {
    const snapshot = exportSnapshot(s.db);
    assert.equal("sessions" in snapshot.tables, false);
    const result = importOwnedSnapshot(target, snapshot);
    assert.equal(result.counts.participants, 1);
    assert.equal(
      target.person(s.actor, s.event.id, s.person.id).status,
      "checkedIn",
    );
    assert.deepEqual(target.outbox(), s.db.outbox());
    assert.deepEqual(
      target.history(s.actor, s.event.id),
      s.db.history(s.actor, s.event.id),
    );
    assert.ok(
      checkPassword(
        "test-migration-password-123",
        target.row("SELECT password_hash FROM users WHERE id=?", s.actor.id)
          .password_hash,
      ),
    );
    assert.equal(target.row("SELECT count(*) n FROM sessions").n, 0);
    assert.ok(target.login("operator", "test-migration-password-123"));
    assert.deepEqual(importOwnedSnapshot(target, snapshot), result);
    assert.equal(target.row("SELECT count(*) n FROM attendance").n, 1);
  } finally {
    s.db.close();
    target.close();
  }
});

test("migration refuses nonempty destinations instead of merging or overwriting", () => {
  const s = source(),
    target = new Store(":memory:");
  try {
    target.addUser(
      "existing",
      hashPassword("test-existing-password-123"),
      "Admin",
    );
    assert.throws(
      () => importOwnedSnapshot(target, exportSnapshot(s.db)),
      /destination_not_empty/,
    );
    assert.equal(target.row("SELECT username FROM users").username, "existing");
    assert.equal(target.row("SELECT count(*) n FROM events").n, 0);
  } finally {
    s.db.close();
    target.close();
  }
});

test("broken foreign keys roll back the entire import and permit a corrected retry", () => {
  const s = source(),
    target = new Store(":memory:");
  try {
    const broken = structuredClone(exportSnapshot(s.db));
    broken.tables.registrations[0].participant_id = "missing-participant";
    assert.throws(() => importOwnedSnapshot(target, broken));
    assert.equal(target.row("SELECT count(*) n FROM users").n, 0);
    assert.equal(target.row("SELECT count(*) n FROM events").n, 0);
    assert.equal(target.row("SELECT count(*) n FROM _qr_imports").n, 0);
    assert.equal(
      importOwnedSnapshot(target, exportSnapshot(s.db)).counts.attendance,
      1,
    );
  } finally {
    s.db.close();
    target.close();
  }
});

test("migration rejects unknown tables, credentials with unsupported hashes and snapshots without an enabled Admin", () => {
  const s = source(),
    target = new Store(":memory:");
  try {
    const snapshot = exportSnapshot(s.db);
    assert.throws(
      () =>
        importOwnedSnapshot(target, {
          ...snapshot,
          tables: { ...snapshot.tables, secrets: [] },
        }),
      /invalid_migration/,
    );
    const badHash = structuredClone(snapshot);
    badHash.tables.users[0].password_hash = "plaintext";
    assert.throws(
      () => importOwnedSnapshot(target, badHash),
      /invalid_migration/,
    );
    const noAdmin = structuredClone(snapshot);
    noAdmin.tables.users[0].enabled = 0;
    assert.throws(
      () => importOwnedSnapshot(target, noAdmin),
      /invalid_migration/,
    );
    assert.equal(target.row("SELECT count(*) n FROM users").n, 0);
  } finally {
    s.db.close();
    target.close();
  }
});
test("null or mistyped identifiers and broken structured payloads cannot commit or lock out the migrated Admin", () => {
  const s = source(),
    target = new Store(":memory:");
  try {
    for (const [table, column, value] of [
      ["users", "id", null],
      ["events", "id", null],
      ["participants", "id", null],
      ["users", "id", 42],
      ["users", "username", 42],
      ["registrations", "event_id", null],
      ["outbox", "payload", "not JSON"],
    ] as const) {
      const broken = structuredClone(exportSnapshot(s.db));
      broken.tables[table][0][column] = value;
      assert.throws(
        () => importOwnedSnapshot(target, broken),
        /invalid_migration/,
        `${table}.${column}`,
      );
      assert.equal(target.row("SELECT count(*) n FROM users").n, 0);
      assert.equal(target.row("SELECT count(*) n FROM _qr_imports").n, 0);
    }
    importOwnedSnapshot(target, exportSnapshot(s.db));
    const token = target.login("operator", "test-migration-password-123");
    assert.equal(target.session(token)?.id, s.actor.id);
  } finally {
    s.db.close();
    target.close();
  }
});
