import { ReceptionStore } from "./store-core.js";
import { digest, fail } from "./security.js";

const legacyColumns: Record<string, string[]> = {
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
const lineColumns: Record<string, string[]> = {
  ...legacyColumns,
  line_identities: ["subject_hash", "participant_id", "created_at"],
  line_event_settings: ["event_id", "enabled", "opens_at", "closes_at"],
  line_tickets: ["token_hash", "event_id", "participant_id", "expires_at"],
  line_conversations: ["subject_hash", "event_id", "expires_at"],
  line_webhooks: ["id", "status", "error_code", "created_at"],
};
const columns: Record<string, string[]> = {
  ...lineColumns,
  form_config: ["id", "entry", "enabled"],
  form_event_mappings: ["external_event_id", "event_id", "event_date"],
  form_claims: [
    "token_hash",
    "receipt_hash",
    "external_event_id",
    "event_date",
    "name",
    "event_name",
    "created_at",
    "participant_id",
    "subject_hash",
  ],
};
function snapshotColumns(version: number) {
  return version === 2 ? legacyColumns : version === 3 ? lineColumns : columns;
}
export type OwnedSnapshot = {
  application: "unity-qr";
  version: 1;
  schemaVersion: 2 | 3 | 4;
  tables: Record<string, Record<string, any>[]>;
};
export function exportSnapshot(db: ReceptionStore): OwnedSnapshot {
  return db.sql.transaction(() => ({
    application: "unity-qr",
    version: 1,
    schemaVersion: 4,
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
  line_webhooks: ["error_code"],
  form_claims: ["participant_id", "subject_hash"],
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
  if (table.startsWith("form_")) {
    for (const key of ["token_hash", "receipt_hash", "subject_hash"])
      if (key in row && row[key] !== null && !/^[a-f0-9]{64}$/.test(row[key]))
        fail("invalid_migration");
    if (
      "event_date" in row &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(row.event_date) ||
        !Number.isFinite(Date.parse(row.event_date + "T00:00:00Z")) ||
        new Date(row.event_date + "T00:00:00Z").toISOString().slice(0, 10) !==
          row.event_date)
    )
      fail("invalid_migration");
    if (
      table === "form_config" &&
      (row.id !== 1 ||
        !/^entry\.\d{1,20}$/.test(row.entry) ||
        ![0, 1].includes(row.enabled))
    )
      fail("invalid_migration");
    if (
      table === "form_claims" &&
      row.subject_hash !== null && row.participant_id === null
    )
      fail("invalid_migration");
  }

  if (table.startsWith("line_")) {
    for (const key of ["subject_hash", "token_hash"])
      if (key in row && !/^[a-f0-9]{64}$/.test(row[key]))
        fail("invalid_migration");
    if (
      table === "line_event_settings" &&
      (![0, 1].includes(row.enabled) ||
        Date.parse(row.opens_at) >= Date.parse(row.closes_at))
    )
      fail("invalid_migration");
    if (
      table === "line_webhooks" &&
      !["processing", "sent", "failed", "unknown", "ignored"].includes(
        row.status,
      )
    )
      fail("invalid_migration");
  }

  for (const [key, value] of Object.entries(row)) {
    if (value === null && nullableColumns[table]?.includes(key)) continue;
    if (key === "id" && ["audit", "sync_runs", "form_config"].includes(table)) {
      if (!Number.isSafeInteger(value) || value < 1) fail("invalid_migration");
    } else if (key === "id" || key.endsWith("_id")) {
      if (!validText(value, 128)) fail("invalid_migration");
    } else if (
      [
        "enabled",
        "capacity",
        "attempts",
        "next_attempt",
        "sequence",
        "expires_at",
      ].includes(key)
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
        key === "name"
          ? 100
          : key === "username"
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
    ![2, 3, 4].includes(input.schemaVersion) ||
    !input.tables ||
    typeof input.tables !== "object" ||
    Array.isArray(input.tables) ||
    Object.keys(input.tables).sort().join() !==
      Object.keys(snapshotColumns(input.schemaVersion)).sort().join()
  )
    fail("invalid_migration");
  let total = 0;
  for (const [table, keys] of Object.entries(
    snapshotColumns(input.schemaVersion),
  )) {
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
  const eventIds=new Set(input.tables.events.map((e:any)=>e.id)),edges=new Map<string,string>();
  const actions=[...input.tables.audit].sort((a:any,b:any)=>a.id-b.id);
  for(const row of actions){
    if(!['event_archive','event_restore','event_merge','event_merge_receive'].includes(row.action))continue;
    if(!eventIds.has(row.event_id)||row.participant_id!==null)fail('invalid_migration');
    if(row.action==='event_merge'||row.action==='event_merge_receive'){
      const details=parsedObject(row.reason),other=row.action==='event_merge'?details.targetId:details.sourceId;
      if(!eventIds.has(other)||other===row.event_id)fail('invalid_migration');
      if(row.action==='event_merge')edges.set(row.event_id,other);
    }
  }
  for(const source of edges.keys()){let id=source;const seen=new Set<string>();for(let hops=0;;hops++){if(hops>=50||seen.has(id))fail('invalid_migration');seen.add(id);const next=edges.get(id);if(!next)break;id=next;}}
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
    for (const [table, keys] of Object.entries(
      snapshotColumns(input.schemaVersion),
    )) {
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
