import { randomUUID, timingSafeEqual } from "node:crypto";
import type { ReceptionStore, Actor } from "./store-core.js";
import { digest, fail, text } from "./security.js";
import {normalizedEventName,similarReceptionEventNames} from "./event-names.js";
const system: Actor = { id: "system:form", role: "Admin", events: [] };
export function japanDate(value: string) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
function date(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
  )
    fail("invalid_form_claim");
  return value;
}
export function verifyFormAuth(header: unknown, key?: string) {
  if (!key || Buffer.byteLength(key) < 32) fail("form_unavailable", 503);
  if (
    typeof header !== "string" ||
    header.length > 512 ||
    !timingSafeEqual(
      Buffer.from(digest(header)),
      Buffer.from(digest("Bearer " + key)),
    )
  )
    fail("unauthorized", 401);
}
export class FormClaims {
  constructor(private db: ReceptionStore) {}
  publicConfig() {
    const c = this.db.row("SELECT entry,enabled FROM form_config WHERE id=1");
    return { version: 1, entry: c?.entry || null, enabled: c?.enabled === 1 };
  }
  configure(input: any) {
    if (
      typeof input?.enabled !== "boolean" ||
      typeof input.entry !== "string" ||
      !/^entry\.\d{1,20}$/.test(input.entry)
    )
      fail("invalid_form_config");
    this.db.sql.transaction(() => {
      this.db.run(
        "INSERT INTO form_config VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET entry=excluded.entry,enabled=excluded.enabled",
        input.entry,
        Number(input.enabled),
      );
      this.db.audit(system, "form_config", null, null);
    });
    return { ok: true };
  }
  accept(input: any) {
    if (
      !input ||
      !/^[a-f0-9]{64}$/.test(input.claimHash) ||
      !/^[a-f0-9]{64}$/.test(input.receiptHash)
    )
      fail("invalid_form_claim");
    const values = [
      input.claimHash,
      input.receiptHash,
      text(input.eventId, 128),
      date(input.eventDate),
      text(input.name, 100),
      text(input.eventName, 300),
    ];
    return this.db.sql.transaction(() => {
      const existing = this.db.row(
        "SELECT * FROM form_claims WHERE token_hash=? OR receipt_hash=?",
        values[0],
        values[1],
      );
      if (existing) {
        if (
          JSON.stringify(values) !==
          JSON.stringify([
            existing.token_hash,
            existing.receipt_hash,
            existing.external_event_id,
            existing.event_date,
            existing.name,
            existing.event_name,
          ])
        )
          fail("claim_conflict", 409);
        return { ok: true };
      }
      this.db.run(
        "INSERT INTO form_claims(token_hash,receipt_hash,external_event_id,event_date,name,event_name,created_at) VALUES(?,?,?,?,?,?,?)",
        ...values,
        new Date().toISOString(),
      );
      this.db.audit(system, "form_accepted", null, null);
      return { ok: true };
    });
  }
  settings(actor: Actor) {
    this.db.admin(actor);
    return {
      ...this.publicConfig(),
      pending: this.db.rows(
        `SELECT c.external_event_id externalEventId,c.event_date eventDate,c.event_name eventName,count(*) count FROM form_claims c LEFT JOIN form_event_mappings m ON m.external_event_id=c.external_event_id AND m.event_date=c.event_date LEFT JOIN events e ON e.source='analytics' AND e.external_id=c.external_event_id AND strftime('%Y-%m-%d',e.starts_at,'+9 hours')=c.event_date WHERE c.participant_id IS NULL AND m.event_id IS NULL AND e.id IS NULL GROUP BY c.external_event_id,c.event_date,c.event_name ORDER BY c.event_date LIMIT 30`,
      ),
      mappings: this.db.rows(
        "SELECT external_event_id externalEventId,event_id eventId,event_date eventDate FROM form_event_mappings",
      ),
    };
  }
  map(actor: Actor, input: any, key: string) {
    this.db.admin(actor);
    const ev = this.db.event(actor, text(input.eventId, 128));
    const externalId = text(input.externalEventId, 128),
      day = date(input.eventDate);
    if (japanDate(ev.startsAt) !== day) fail("claim_event_date_mismatch");
    return this.db.mutate(
      actor,
      key,
      digest(JSON.stringify(["form-map", input])),
      () => {
        const existing = this.db.row(
          "SELECT * FROM form_event_mappings WHERE external_event_id=?",
          externalId,
        );
        if (
          existing &&
          (existing.event_id !== ev.id || existing.event_date !== day)
        )
          fail("claim_event_mapping_conflict", 409);
        this.db.run(
          "INSERT OR IGNORE INTO form_event_mappings VALUES(?,?,?)",
          externalId,
          ev.id,
          day,
        );
        this.db.audit(actor, "form_event_map", ev.id, null);
        return { ok: true };
      },
    );
  }
  private autoReception(claim: any) {
    const key=claim.external_event_id,day=claim.event_date,name=claim.event_name;
    // Only the authenticated Form bridge's verifiable free-input key may create.
    if(key!=="sheet-event:"+digest(JSON.stringify([day,normalizedEventName(name)]))) return;
    if(Date.parse(day+"T00:00:00+09:00")+86400000<=Date.now())fail("event_closed",410);
    const rows=this.db.rows("SELECT id,title,starts_at FROM events WHERE strftime('%Y-%m-%d',starts_at,'+9 hours')=?",day);
    const candidates=rows.map((event:any)=>{
      const evidence=this.db.rows("SELECT DISTINCT c.event_name name FROM form_claims c JOIN form_event_mappings m ON m.external_event_id=c.external_event_id AND m.event_date=c.event_date WHERE m.event_id=?",event.id).map((row:any)=>row.name);
      return {event,names:[event.title,...evidence]};
    }).filter(({names}:any)=>names.some((other:string)=>similarReceptionEventNames(other,name)));
    if(candidates.length>1||candidates.some(({names}:any)=>!names.every((other:string)=>similarReceptionEventNames(other,name))))fail("claim_event_ambiguous",409);
    let eventId=candidates[0]?.event.id;
    if(eventId){
      const opaque=this.db.rows("SELECT external_event_id key FROM form_event_mappings m WHERE m.event_id=? AND m.external_event_id LIKE 'sheet-event:%' AND NOT EXISTS(SELECT 1 FROM form_claims c WHERE c.external_event_id=m.external_event_id AND c.event_date=m.event_date)",eventId);
      if(opaque.some((row:any)=>row.key!==key))fail("claim_event_ambiguous",409);
    } else {
      eventId=randomUUID();const opens=new Date(day+"T00:00:00+09:00").toISOString(),closes=new Date(Date.parse(opens)+86400000).toISOString();
      this.db.run("INSERT INTO events(id,title,starts_at,opens_at,closes_at,venue,capacity,source,external_id) VALUES(?,?,?,?,?,?,?,'analytics',?)",eventId,text(name,300),opens,opens,closes,"会場情報未登録",10000,key);
      this.db.audit(system,"form_event_auto_create",eventId,null);
    }
    this.db.run("INSERT INTO form_event_mappings VALUES(?,?,?)",key,eventId,day);
    this.db.audit(system,"form_event_auto_map",eventId,null);
  }
  redeem(token: string, subject: string) {
    if (!/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{64}$/.test(subject))
      fail("claim_invalid", 404);
    return this.db.sql.transaction(() => {
      const claim = this.db.row(
        "SELECT * FROM form_claims WHERE token_hash=?",
        digest(token),
      );
      if (!claim) fail("claim_pending", 409);
      if (claim.subject_hash && claim.subject_hash !== subject)
        fail("claim_used", 409);
      if(!this.db.row("SELECT 1 FROM form_event_mappings WHERE external_event_id=? AND event_date=?",claim.external_event_id,claim.event_date)&&!this.db.row("SELECT 1 FROM events WHERE source='analytics' AND external_id=?",claim.external_event_id))this.autoReception(claim);
      const mapping = this.db.row(
        "SELECT event_id FROM form_event_mappings WHERE external_event_id=? AND event_date=?",
        claim.external_event_id,
        claim.event_date,
      );
      const ev = mapping
        ? this.db.event(system, mapping.event_id)
        : this.db.row(
            "SELECT id,starts_at startsAt,closes_at closesAt,capacity,title FROM events WHERE source=? AND external_id=?",
            "analytics",
            claim.external_event_id,
          );
      if (!ev) fail("claim_event_pending", 409);
      if (japanDate(ev.startsAt) !== claim.event_date)
        fail("claim_event_date_mismatch", 409);
      if (Date.parse(ev.closesAt) <= Date.now()) fail("event_closed", 410);
      let identity = this.db.row(
        "SELECT participant_id FROM line_identities WHERE subject_hash=?",
        subject,
      );
      // A server-imported accepted claim may already have its own participant.
      // Ownership is enforced above by subject_hash, never by display name.
      const participantId = claim.participant_id;
      if(!claim.participant_id&&this.db.row("SELECT 1 FROM participants p JOIN registrations r ON r.participant_id=p.id WHERE r.event_id=? AND p.name=? AND p.source='analytics' AND p.id<>? LIMIT 1",ev.id,claim.name,participantId||''))
        fail('claim_registration_pending',409);
      const existing =
        participantId &&
        this.db.row(
          "SELECT status FROM registrations WHERE event_id=? AND participant_id=?",
          ev.id,
          participantId,
        );
      if (existing?.status === "cancelled") fail("registration_cancelled", 409);
      if (
        !existing &&
        this.db.row(
          "SELECT count(*) n FROM registrations WHERE event_id=? AND status='planned'",
          ev.id,
        ).n >= ev.capacity
      )
        fail("capacity_reached", 409);
      if (!participantId) {
        const id = randomUUID();
        this.db.run(
          "INSERT INTO participants(id,name,source,created_at) VALUES(?,?,?,?)",
          id,
          claim.name,
          "google-form",
          new Date().toISOString(),
        );
        this.db.run(
          "INSERT OR IGNORE INTO line_identities VALUES(?,?,?)",
          subject,
          id,
          new Date().toISOString(),
        );
        identity = { participant_id: id };
      }
      const resolvedId = participantId || identity.participant_id;
      if (!identity) this.db.run('INSERT INTO line_identities VALUES(?,?,?)',subject,resolvedId,new Date().toISOString());
      this.db.run(
        "INSERT OR IGNORE INTO registrations VALUES(?,?,'planned')",
        ev.id,
        resolvedId,
      );
      this.db.run(
        "UPDATE form_claims SET subject_hash=?,participant_id=? WHERE token_hash=?",
        subject,
        resolvedId,
        claim.token_hash,
      );
      if (!claim.subject_hash)
        this.db.audit(system, "form_claim", ev.id, resolvedId);
      return {
        event: this.db.event(system, ev.id),
        person: this.db.person(system, ev.id, resolvedId),
      };
    });
  }
}
