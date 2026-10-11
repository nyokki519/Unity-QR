import { DatabaseSync, backup } from "node:sqlite";
import { randomUUID, randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { checkPassword, digest, fail, text } from "./security.js";

export type Actor = {
  id: string;
  role: "Admin" | "Staff" | "Viewer";
  events: readonly string[];
};
const now = () => new Date().toISOString();
export class Store {
  sql: DatabaseSync;
  constructor(path: string) {
    this.sql = new DatabaseSync(path);
    try {
      const applicationId = (
        this.sql.prepare("PRAGMA application_id").get() as any
      ).application_id;
      const count = (
        this.sql
          .prepare(
            "SELECT count(*) count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .get() as any
      ).count;
      if (applicationId !== 0x55515232 && (count > 0 || applicationId !== 0))
        fail("foreign_database", 503);
      if (
        (this.sql.prepare("PRAGMA user_version").get() as any).user_version > 2
      )
        fail("unsupported_schema", 503);
      this.sql.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
      );
      this.migrate();
    } catch (e) {
      this.sql.close();
      throw e;
    }
  }
  close() {
    this.sql.close();
  }
  migrate() {
    const version = (this.sql.prepare("PRAGMA user_version").get() as any)
      .user_version;
    if (version > 2) fail("unsupported_schema", 503);
    this.sql.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('Admin','Staff','Viewer')), enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, title TEXT NOT NULL, starts_at TEXT NOT NULL, opens_at TEXT NOT NULL, closes_at TEXT NOT NULL, venue TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity>0), source TEXT, external_id TEXT, UNIQUE(source,external_id));
      CREATE TABLE IF NOT EXISTS user_events(user_id TEXT REFERENCES users(id),event_id TEXT REFERENCES events(id),PRIMARY KEY(user_id,event_id));
      CREATE TABLE IF NOT EXISTS participants(id TEXT PRIMARY KEY,name TEXT NOT NULL,member_id TEXT UNIQUE,source TEXT,external_id TEXT,created_at TEXT NOT NULL,UNIQUE(source,external_id));
      CREATE TABLE IF NOT EXISTS registrations(event_id TEXT REFERENCES events(id),participant_id TEXT REFERENCES participants(id),status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','cancelled')),PRIMARY KEY(event_id,participant_id));
      CREATE TABLE IF NOT EXISTS attendance(event_id TEXT REFERENCES events(id),participant_id TEXT REFERENCES participants(id),state TEXT NOT NULL CHECK(state IN ('in','undone')),checked_in_at TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(event_id,participant_id));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT,participant_id TEXT,actor_id TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency(actor_id TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor_id,key));
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at TEXT NOT NULL,sequence INTEGER NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS sync_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_audit_event ON audit(event_id,id);
      CREATE INDEX IF NOT EXISTS idx_registration_participant ON registrations(participant_id);
      CREATE INDEX IF NOT EXISTS idx_participants_name ON participants(name);
      PRAGMA application_id=${0x55515232};`);
    try {
      if (
        !this.rows("PRAGMA table_info(outbox)").some(
          (r) => r.name === "sequence",
        )
      ) {
        this.sql.exec(
          "ALTER TABLE outbox ADD COLUMN sequence INTEGER; UPDATE outbox SET sequence=rowid;",
        );
        for (const item of this.rows("SELECT id,payload,sequence FROM outbox"))
          this.run(
            "UPDATE outbox SET payload=? WHERE id=?",
            JSON.stringify({
              ...JSON.parse(item.payload),
              sequence: item.sequence,
            }),
            item.id,
          );
      }
      this.sql.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_sequence ON outbox(sequence); PRAGMA user_version=2; COMMIT;",
      );
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }
  async backup(path: string) {
    await backup(this.sql, path);
    chmodSync(path, 0o600);
  }
  row(sql: string, ...values: any[]): any {
    return this.sql.prepare(sql).get(...values);
  }
  rows(sql: string, ...values: any[]): any[] {
    return this.sql.prepare(sql).all(...values);
  }
  run(sql: string, ...values: any[]) {
    return this.sql.prepare(sql).run(...values);
  }
  admin(actor: Actor) {
    if (actor.role !== "Admin") fail("forbidden", 403);
  }
  access(actor: Actor, eventId: string, write = false) {
    if (actor.role !== "Admin" && !actor.events.includes(eventId))
      fail("forbidden", 403);
    if (write && actor.role === "Viewer") fail("forbidden", 403);
  }
  event(actor: Actor, id: string, write = false) {
    this.access(actor, id, write);
    const row = this.row(
      "SELECT id,title,starts_at startsAt,opens_at opensAt,closes_at closesAt,venue,capacity,source,external_id externalId FROM events WHERE id=?",
      id,
    );
    if (!row) fail("event_not_found", 404);
    return row;
  }
  events(actor: Actor) {
    return this.rows("SELECT id FROM events ORDER BY starts_at DESC")
      .filter((r) => actor.role === "Admin" || actor.events.includes(r.id))
      .map((r) => ({
        ...this.event(actor, r.id),
        ...this.summary(actor, r.id),
      }));
  }
  audit(
    actor: Actor,
    action: string,
    eventId: string | null,
    participant: string | null,
    reason = "",
  ) {
    this.run(
      "INSERT INTO audit(event_id,participant_id,actor_id,action,reason,created_at) VALUES(?,?,?,?,?,?)",
      eventId,
      participant,
      actor.id,
      action,
      reason,
      now(),
    );
  }
  mutate(actor: Actor, key: string, fingerprint: string, fn: () => any): any {
    if (typeof key !== "string" || !/^[\w-]{16,128}$/.test(key))
      fail("idempotency_required");
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.row(
        "SELECT * FROM idempotency WHERE actor_id=? AND key=?",
        actor.id,
        key,
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          fail("idempotency_conflict", 409);
        this.sql.exec("COMMIT");
        return JSON.parse(prior.result);
      }
      const result = fn();
      this.run(
        "INSERT INTO idempotency VALUES(?,?,?,?)",
        actor.id,
        key,
        fingerprint,
        JSON.stringify(result),
      );
      this.sql.exec("COMMIT");
      return result;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }
  cached(actor: Actor, key: string, fingerprint: string): any | undefined {
    if (typeof key !== "string" || !/^[\w-]{16,128}$/.test(key))
      fail("idempotency_required");
    const prior = this.row(
      "SELECT fingerprint,result FROM idempotency WHERE actor_id=? AND key=?",
      actor.id,
      key,
    );
    if (prior && prior.fingerprint !== fingerprint)
      fail("idempotency_conflict", 409);
    return prior ? JSON.parse(prior.result) : undefined;
  }
  createEvent(actor: Actor, body: any, key: string) {
    this.admin(actor);
    const title = text(body.title),
      venue = text(body.venue),
      starts = Date.parse(body.startsAt);
    if (!Number.isFinite(starts)) fail("invalid_event");
    const startsAt = new Date(starts).toISOString();
    const opens = Date.parse(body.opensAt),
      closes = Date.parse(body.closesAt);
    if (
      !Number.isFinite(opens) ||
      !Number.isFinite(closes) ||
      opens >= closes ||
      closes - opens > 7 * 86400_000 ||
      !Number.isInteger(body.capacity) ||
      body.capacity < 1 ||
      body.capacity > 10000
    )
      fail("invalid_event");
    return this.mutate(
      actor,
      key,
      digest(JSON.stringify(["event", body])),
      () => {
        const id = randomUUID();
        this.run(
          "INSERT INTO events(id,title,starts_at,opens_at,closes_at,venue,capacity) VALUES(?,?,?,?,?,?,?)",
          id,
          title,
          startsAt,
          new Date(opens).toISOString(),
          new Date(closes).toISOString(),
          venue,
          body.capacity,
        );
        this.audit(actor, "event_create", id, null);
        return this.event(actor, id);
      },
    );
  }
  updateEvent(actor: Actor, eventId: string, body: any, key: string) {
    this.admin(actor);
    this.event(actor, eventId, true);
    const title = text(body.title),
      venue = text(body.venue),
      starts = Date.parse(body.startsAt),
      opens = Date.parse(body.opensAt),
      closes = Date.parse(body.closesAt);
    if (
      !Number.isFinite(starts) ||
      !Number.isFinite(opens) ||
      !Number.isFinite(closes) ||
      opens >= closes ||
      closes - opens > 7 * 86400_000 ||
      !Number.isInteger(body.capacity) ||
      body.capacity < 1 ||
      body.capacity > 10000
    )
      fail("invalid_event");
    return this.mutate(
      actor,
      key,
      digest(JSON.stringify(["event_update", eventId, body])),
      () => {
        if (body.capacity < this.summary(actor, eventId).checkedIn)
          fail("capacity_reached", 409);
        this.run(
          "UPDATE events SET title=?,venue=?,starts_at=?,opens_at=?,closes_at=?,capacity=? WHERE id=?",
          title,
          venue,
          new Date(starts).toISOString(),
          new Date(opens).toISOString(),
          new Date(closes).toISOString(),
          body.capacity,
          eventId,
        );
        this.audit(actor, "event_update", eventId, null);
        return this.event(actor, eventId);
      },
    );
  }
  register(actor: Actor, eventId: string, body: any, key: string) {
    this.event(actor, eventId, true);
    const name = text(body.name, 60);
    if (body.memberId) this.admin(actor);
    const memberId = body.memberId ? text(body.memberId, 100) : null;
    return this.mutate(
      actor,
      key,
      digest(JSON.stringify(["register", eventId, name, memberId])),
      () => {
        let person = memberId
          ? this.row("SELECT * FROM participants WHERE member_id=?", memberId)
          : null;
        if (!person) {
          const id = randomUUID();
          this.run(
            "INSERT INTO participants(id,name,member_id,created_at) VALUES(?,?,?,?)",
            id,
            name,
            memberId,
            now(),
          );
          person = { id, name, member_id: memberId };
        }
        const existing = this.row(
          "SELECT status FROM registrations WHERE event_id=? AND participant_id=?",
          eventId,
          person.id,
        );
        if (existing?.status === "cancelled")
          fail("registration_cancelled", 409);
        this.run(
          "INSERT OR IGNORE INTO registrations(event_id,participant_id) VALUES(?,?)",
          eventId,
          person.id,
        );
        if (!existing) this.audit(actor, "register", eventId, person.id);
        return { id: person.id, name: person.name, memberId: person.member_id };
      },
    );
  }
  participants(actor: Actor, eventId: string, filter: any = {}) {
    this.event(actor, eventId);
    const list = this.rows(
      `SELECT p.id,p.name,p.member_id memberId,r.status registrationStatus,a.state,a.checked_in_at checkedInAt,
      (SELECT COUNT(*) FROM participants d JOIN registrations dr ON dr.participant_id=d.id WHERE dr.event_id=r.event_id AND d.name=p.name) nameMatches
      FROM registrations r JOIN participants p ON p.id=r.participant_id LEFT JOIN attendance a ON a.event_id=r.event_id AND a.participant_id=p.id WHERE r.event_id=?`,
      eventId,
    );
    const result = list
      .map((r) => ({
        ...r,
        status:
          r.registrationStatus === "cancelled"
            ? "cancelled"
            : r.state === "in"
              ? "checkedIn"
              : "waiting",
      }))
      .filter(
        (r) =>
          (!filter.search ||
            r.name
              .toLocaleLowerCase()
              .includes(String(filter.search).toLocaleLowerCase())) &&
          (!filter.status ||
            filter.status === "all" ||
            r.status === filter.status),
      );
    result.sort((a, b) =>
      filter.sort === "arrival"
        ? (b.checkedInAt || "").localeCompare(a.checkedInAt || "")
        : a.name.localeCompare(b.name, "ja") || a.id.localeCompare(b.id),
    );
    return result;
  }
  summary(actor: Actor, eventId: string) {
    const rows = this.participants(actor, eventId);
    return {
      total: rows.length,
      checkedIn: rows.filter((r) => r.status === "checkedIn").length,
      waiting: rows.filter((r) => r.status === "waiting").length,
      cancelled: rows.filter((r) => r.status === "cancelled").length,
    };
  }
  person(actor: Actor, eventId: string, id: string, write = false) {
    this.event(actor, eventId, write);
    const person = this.participants(actor, eventId).find((p) => p.id === id);
    if (!person) fail("participant_not_found", 404);
    return person;
  }
  change(eventId: string, participantId: string, action: string, at: string) {
    const event = this.row(
      "SELECT source,external_id FROM events WHERE id=?",
      eventId,
    );
    const person = this.row(
      "SELECT source,external_id,member_id FROM participants WHERE id=?",
      participantId,
    );
    const id = randomUUID();
    const sequence = this.row(
      "SELECT coalesce(max(sequence),0)+1 next FROM outbox",
    ).next;
    const payload = {
      version: 1,
      changeId: id,
      sequence,
      eventId,
      participantId,
      externalEventId: event.external_id,
      externalParticipantId: person.external_id,
      memberId: person.member_id,
      action,
      occurredAt: at,
    };
    this.run(
      "INSERT INTO outbox(id,event_id,payload,created_at,sequence) VALUES(?,?,?,?,?)",
      id,
      eventId,
      JSON.stringify(payload),
      at,
      sequence,
    );
  }
  checkin(
    actor: Actor,
    eventId: string,
    participantId: string,
    key: string,
    source = "manual",
    requestFingerprint?: string,
  ) {
    const event = this.event(actor, eventId, true);
    return this.mutate(
      actor,
      key,
      requestFingerprint || `checkin:${eventId}:${participantId}`,
      () => {
        const person = this.person(actor, eventId, participantId, true);
        if (person.status === "cancelled") fail("registration_cancelled", 409);
        const timestamp = now();
        if (timestamp < event.opensAt || timestamp >= event.closesAt)
          fail("event_closed", 410);
        if (person.status === "checkedIn")
          return {
            participantId,
            name: person.name,
            checkedInAt: person.checkedInAt,
            duplicate: true,
          };
        if (this.summary(actor, eventId).checkedIn >= event.capacity)
          fail("capacity_reached", 409);
        this.run(
          `INSERT INTO attendance VALUES(?,?,'in',?,?) ON CONFLICT(event_id,participant_id) DO UPDATE SET state='in',checked_in_at=excluded.checked_in_at,source=excluded.source`,
          eventId,
          participantId,
          timestamp,
          source,
        );
        this.audit(actor, "checkin", eventId, participantId);
        this.change(eventId, participantId, "checkin", timestamp);
        return {
          participantId,
          name: person.name,
          checkedInAt: timestamp,
          duplicate: false,
        };
      },
    );
  }
  undo(
    actor: Actor,
    eventId: string,
    participantId: string,
    reason: string,
    key: string,
  ) {
    this.admin(actor);
    this.person(actor, eventId, participantId, true);
    if (!reason?.trim()) fail("reason_required");
    reason = text(reason, 240);
    return this.mutate(
      actor,
      key,
      digest(`undo:${eventId}:${participantId}:${reason}`),
      () => {
        const current = this.row(
          "SELECT state FROM attendance WHERE event_id=? AND participant_id=?",
          eventId,
          participantId,
        );
        if (current?.state !== "in") fail("not_checked_in", 409);
        this.run(
          "UPDATE attendance SET state='undone' WHERE event_id=? AND participant_id=?",
          eventId,
          participantId,
        );
        this.audit(actor, "undo", eventId, participantId, reason);
        this.change(eventId, participantId, "undo", now());
        return { ok: true };
      },
    );
  }
  cancel(
    actor: Actor,
    eventId: string,
    participantId: string,
    reason: string,
    key: string,
  ) {
    this.admin(actor);
    const person = this.person(actor, eventId, participantId, true);
    if (!reason?.trim()) fail("reason_required");
    reason = text(reason, 240);
    return this.mutate(
      actor,
      key,
      digest(`cancel:${eventId}:${participantId}:${reason}`),
      () => {
        if (person.status === "checkedIn") fail("undo_required", 409);
        this.run(
          "UPDATE registrations SET status='cancelled' WHERE event_id=? AND participant_id=?",
          eventId,
          participantId,
        );
        this.audit(actor, "cancel", eventId, participantId, reason);
        return { ok: true };
      },
    );
  }
  restore(
    actor: Actor,
    eventId: string,
    participantId: string,
    reason: string,
    key: string,
  ) {
    this.admin(actor);
    this.person(actor, eventId, participantId, true);
    if (!reason?.trim()) fail("reason_required");
    reason = text(reason, 240);
    return this.mutate(
      actor,
      key,
      digest(`restore:${eventId}:${participantId}:${reason}`),
      () => {
        if (this.person(actor, eventId, participantId).status !== "cancelled")
          fail("not_cancelled", 409);
        this.run(
          "UPDATE registrations SET status='planned' WHERE event_id=? AND participant_id=?",
          eventId,
          participantId,
        );
        this.audit(actor, "restore", eventId, participantId, reason);
        return { ok: true };
      },
    );
  }
  rename(
    actor: Actor,
    eventId: string,
    participantId: string,
    name: string,
    reason: string,
    key: string,
  ) {
    this.admin(actor);
    this.person(actor, eventId, participantId, true);
    name = text(name, 60);
    if (!reason?.trim()) fail("reason_required");
    reason = text(reason, 240);
    return this.mutate(
      actor,
      key,
      digest(`rename:${eventId}:${participantId}:${name}:${reason}`),
      () => {
        this.run(
          "UPDATE participants SET name=? WHERE id=?",
          name,
          participantId,
        );
        this.audit(actor, "rename", eventId, participantId, reason);
        return { ok: true };
      },
    );
  }
  history(actor: Actor, eventId: string) {
    this.event(actor, eventId);
    return this.rows(
      "SELECT a.*,p.name FROM audit a LEFT JOIN participants p ON p.id=a.participant_id WHERE a.event_id=? ORDER BY a.id DESC LIMIT 500",
      eventId,
    );
  }
  insertUser(
    username: string,
    passwordHash: string,
    role: Actor["role"],
    events: string[] = [],
  ) {
    username = text(username, 60);
    if (!["Admin", "Staff", "Viewer"].includes(role)) fail("invalid_role");
    if (this.row("SELECT id FROM users WHERE username=?", username))
      fail("username_exists", 409);
    if (events.length > 1000 || new Set(events).size !== events.length)
      fail("invalid_request");
    for (const event of events)
      if (!this.row("SELECT id FROM events WHERE id=?", event))
        fail("event_not_found", 404);
    const id = randomUUID();
    this.run(
      "INSERT INTO users(id,username,password_hash,role) VALUES(?,?,?,?)",
      id,
      username,
      passwordHash,
      role,
    );
    for (const event of events)
      this.run("INSERT INTO user_events VALUES(?,?)", id, event);
    return id;
  }
  addUser(
    username: string,
    passwordHash: string,
    role: Actor["role"],
    events: string[] = [],
  ) {
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const id = this.insertUser(username, passwordHash, role, events);
      this.audit(
        { id: "bootstrap", role: "Admin", events: [] },
        "user_create",
        null,
        null,
      );
      this.sql.exec("COMMIT");
      return id;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }
  createUser(
    actor: Actor,
    input: any,
    key: string,
    fingerprint: string,
    passwordHash: () => string,
  ) {
    this.admin(actor);
    return this.mutate(actor, key, fingerprint, () => {
      const id = this.insertUser(
        input.username,
        passwordHash(),
        input.role,
        input.eventIds,
      );
      this.audit(actor, "user_create", null, null);
      return { id };
    });
  }
  login(username: string, password: string) {
    const user = this.row(
      "SELECT * FROM users WHERE username=? AND enabled=1",
      username,
    );
    // Equal work for unknown accounts, without a default usable password.
    const hash =
      user?.password_hash || `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;
    if (!checkPassword(password, hash) || !user) fail("unauthorized", 401);
    const token = randomBytes(32).toString("base64url");
    this.run("DELETE FROM sessions WHERE expires_at<=?", Date.now());
    this.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      digest(token),
      user.id,
      Date.now() + 8 * 3600_000,
    );
    return token;
  }
  session(token: string): Actor | null {
    if (!token || token.length > 128) return null;
    const user = this.row(
      "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=? AND expires_at>? AND enabled=1",
      digest(token),
      Date.now(),
    );
    return user
      ? {
          id: user.id,
          role: user.role,
          events: this.rows(
            "SELECT event_id FROM user_events WHERE user_id=?",
            user.id,
          ).map((r) => r.event_id),
        }
      : null;
  }
  logout(token: string) {
    this.run("DELETE FROM sessions WHERE token_hash=?", digest(token));
  }
  outbox() {
    return this.rows("SELECT * FROM outbox ORDER BY sequence");
  }
  syncHistory(actor: Actor) {
    this.admin(actor);
    return {
      runs: this.rows("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 100"),
      pending: this.row(
        "SELECT COUNT(*) count FROM outbox WHERE status!='sent'",
      ).count,
      failed: this.row(
        "SELECT COUNT(*) count FROM outbox WHERE status='failed'",
      ).count,
    };
  }
}
