import { ReceptionStore } from "./store-core.js";
import { digest, fail } from "./security.js";

const columns: Record<string, string[]> = {
  users: ["id", "username", "password_hash", "role", "enabled"],
  events: [
    "id",
    "title",
    "starts_at",
    "opens_at",
    "closes_at",
    "venue",
    "capacity",
    "source",
    "external_id",
  ],
  participants: [
    "id",
    "name",
    "member_id",
    "source",
    "external_id",
    "created_at",
  ],
  user_events: ["user_id", "event_id"],
  registrations: ["event_id", "participant_id", "status"],
  attendance: [
    "event_id",
    "participant_id",
    "state",
    "checked_in_at",
    "source",
  ],
  audit: [
    "id",
    "event_id",
    "participant_id",
    "actor_id",
    "action",
    "reason",
    "created_at",
  ],
  idempotency: ["actor_id", "key", "fingerprint", "result"],
  outbox: [
    "id",
    "event_id",
    "payload",
    "status",
    "attempts",
    "next_attempt",
    "last_error",
    "created_at",
    "sequence",
  ],
  sync_runs: ["id", "kind", "status", "detail", "created_at"],
};
export type OwnedSnapshot = {
  application: "unity-qr";
  version: 1;
  schemaVersion: 2;
  tables: Record<string, Record<string, any>[]>;
};
export function exportSnapshot(db: ReceptionStore): OwnedSnapshot {
  return db.sql.transaction(() => ({
    application: "unity-qr",
    version: 1,
    schemaVersion: 2,
    tables: Object.fromEntries(
      Object.keys(columns).map((name) => [
        name,
        db.rows(`SELECT * FROM ${name} ORDER BY rowid`),
      ]),
    ),
  }));
}
const nullable = new Set(["event_id", "participant_id"]);
const nullableColumns: Record<string, string[]> = {
  events: ["source", "external_id"],
  participants: ["member_id", "source", "external_id"],
  audit: [...nullable],
  outbox: ["last_error"],
};
function validText(value: unknown, max = 1024, allowEmpty = false) {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (allowEmpty || value.trim().length > 0) &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}
function iso(value: unknown) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function parsedObject(value: unknown): Record<string, any> {
  if (typeof value !== "string") fail("invalid_migration");
  try {
    const data = JSON.parse(value);
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {}
  fail("invalid_migration");
}
function validateRow(table: string, row: Record<string, any>) {
  for (const [key, value] of Object.entries(row)) {
    if (value === null && nullableColumns[table]?.includes(key)) continue;
    if (key === "id" && ["audit", "sync_runs"].includes(table)) {
      if (!Number.isSafeInteger(value) || value < 1) fail("invalid_migration");
    } else if (key === "id" || key.endsWith("_id")) {
      if (!validText(value, 128)) fail("invalid_migration");
    } else if (
      ["enabled", "capacity", "attempts", "next_attempt", "sequence"].includes(
        key,
      )
    ) {
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        (key === "sequence" && value < 1)
      )
        fail("invalid_migration");
    } else if (key.endsWith("_at")) {
      if (!iso(value)) fail("invalid_migration");
    } else if (["payload", "result", "detail"].includes(key)) {
      parsedObject(value);
    } else if (
      !validText(
        value,
        key === "name" || key === "username"
          ? 60
          : key === "reason"
            ? 240
            : 1024,
        key === "reason",
      )
    )
      fail("invalid_migration");
  }
  if (
    table === "events" &&
    (row.capacity < 1 ||
      row.capacity > 10000 ||
      Date.parse(row.opens_at) >= Date.parse(row.closes_at) ||
      Date.parse(row.closes_at) - Date.parse(row.opens_at) > 7 * 86400000)
  )
    fail("invalid_migration");
  if (
    table === "registrations" &&
    !["planned", "cancelled"].includes(row.status)
  )
    fail("invalid_migration");
  if (table === "attendance" && !["in", "undone"].includes(row.state))
    fail("invalid_migration");
  if (table === "idempotency" && !/^[\w-]{16,128}$/.test(row.key))
    fail("invalid_migration");
  if (table === "outbox") {
    const payload = parsedObject(row.payload);
    if (
      !["pending", "failed", "sent"].includes(row.status) ||
      payload.version !== 1 ||
      payload.changeId !== row.id ||
      payload.eventId !== row.event_id ||
      payload.sequence !== row.sequence ||
      !validText(payload.participantId, 128) ||
      !["checkin", "undo"].includes(payload.action) ||
      !iso(payload.occurredAt)
    )
      fail("invalid_migration");
  }
}
function validate(input: any): asserts input is OwnedSnapshot {
  if (
    !input ||
    input.application !== "unity-qr" ||
    input.version !== 1 ||
    input.schemaVersion !== 2 ||
    !input.tables ||
    typeof input.tables !== "object" ||
    Array.isArray(input.tables) ||
    Object.keys(input.tables).sort().join() !==
      Object.keys(columns).sort().join()
  )
    fail("invalid_migration");
  let total = 0;
  for (const [table, keys] of Object.entries(columns)) {
    const rows = input.tables[table];
    if (!Array.isArray(rows)) fail("invalid_migration");
    total += rows.length;
    if (total > 50000) fail("migration_too_large", 413);
    for (const row of rows) {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).sort().join() !== [...keys].sort().join()
      )
        fail("invalid_migration");
      for (const value of Object.values(row))
        if (
          value !== null &&
          typeof value !== "string" &&
          !(typeof value === "number" && Number.isSafeInteger(value))
        )
          fail("invalid_migration");
      validateRow(table, row);
    }
  }
  if (
    !input.tables.users.some((u: any) => u.role === "Admin" && u.enabled === 1)
  )
    fail("invalid_migration");
  for (const user of input.tables.users)
    if (
      !["Admin", "Staff", "Viewer"].includes(user.role) ||
      ![0, 1].includes(user.enabled) ||
      typeof user.password_hash !== "string" ||
      !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(user.password_hash)
    )
      fail("invalid_migration");
}
export function importOwnedSnapshot(db: ReceptionStore, input: unknown) {
  validate(input);
  const fingerprint = digest(JSON.stringify(input));
  return db.sql.transaction(() => {
    const cached = db.row(
      "SELECT counts FROM _qr_imports WHERE fingerprint=?",
      fingerprint,
    );
    if (cached)
      return {
        fingerprint,
        counts: JSON.parse(cached.counts) as Record<string, number>,
      };
    if (
      Object.keys(columns).some(
        (table) => db.row(`SELECT count(*) n FROM ${table}`).n > 0,
      )
    )
      fail("destination_not_empty", 409);
    const counts: Record<string, number> = {};
    for (const [table, keys] of Object.entries(columns)) {
      for (const row of input.tables[table])
        db.run(
          `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
          ...keys.map((key) => row[key]),
        );
      counts[table] = input.tables[table].length;
    }
    // Works on both Node SQLite and Durable Object SQLite; constraints are immediate.
    if (db.rows("PRAGMA foreign_key_check").length) fail("invalid_migration");
    db.run(
      "INSERT INTO _qr_imports VALUES(?,?,?)",
      fingerprint,
      JSON.stringify(counts),
      new Date().toISOString(),
    );
    return { fingerprint, counts };
  });
}
