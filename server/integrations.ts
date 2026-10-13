import { randomUUID } from "node:crypto";
import type { ReceptionStore as Store, Actor } from "./store-core.js";
import { fail, text } from "./security.js";

export type IntegrationConfig = {
  analyticsSnapshotUrl?: string;
  analyticsDeliveryUrl?: string;
  analyticsToken?: string;
  passVerifyUrl?: string;
  passToken?: string;
};
function secureURL(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    fail("integration_configuration", 503);
  return url.toString();
}
async function readJSON(response: Response) {
  if (!response.ok) fail("integration_failed", 502);
  const reader = response.body?.getReader();
  if (!reader) fail("integration_failed", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 1024 * 1024) {
      await reader.cancel();
      fail("integration_failed", 502);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    fail("integration_failed", 502);
  }
}
function validateSnapshot(input: any) {
  if (
    !input ||
    input.version !== 1 ||
    !Array.isArray(input.events) ||
    !Array.isArray(input.participants) ||
    !Array.isArray(input.registrations) ||
    input.events.length > 1000 ||
    input.participants.length > 5000 ||
    input.registrations.length > 10000
  )
    fail("invalid_snapshot");
  const eventIds = new Set<string>(),
    personIds = new Set<string>(),
    pairs = new Set<string>();
  for (const e of input.events) {
    text(e.externalId, 120);
    if (e.receptionId !== undefined) text(e.receptionId, 120);
    if(e.aliases!==undefined&&(!Array.isArray(e.aliases)||e.aliases.length>100||new Set(e.aliases).size!==e.aliases.length||e.aliases.some((a:any)=>typeof a!=='string'||!/^sheet-event:[a-f0-9]{64}$/.test(a))))fail('invalid_snapshot');
    text(e.title);
    text(e.venue);
    const opens = Date.parse(e.opensAt),
      closes = Date.parse(e.closesAt);
    if (
      eventIds.has(e.externalId) ||
      !Number.isFinite(Date.parse(e.startsAt)) ||
      !Number.isFinite(opens) ||
      !Number.isFinite(closes) ||
      opens >= closes ||
      closes - opens > 7 * 86400_000 ||
      !Number.isInteger(e.capacity) ||
      e.capacity < 1 ||
      e.capacity > 10000
    )
      fail("invalid_snapshot");
    eventIds.add(e.externalId);
  }
  for (const p of input.participants) {
    text(p.externalId, 120);
    if (p.claimHash !== undefined && !/^[a-f0-9]{64}$/.test(p.claimHash)) fail("invalid_snapshot");
    text(p.name, 60);
    if (personIds.has(p.externalId)) fail("invalid_snapshot");
    personIds.add(p.externalId);
  }
  for (const r of input.registrations) {
    const pair = JSON.stringify([r.eventExternalId, r.participantExternalId]);
    if (
      !eventIds.has(r.eventExternalId) ||
      !personIds.has(r.participantExternalId) ||
      pairs.has(pair)
    )
      fail("invalid_snapshot");
    pairs.add(pair);
  }
  return input;
}
export function importSnapshot(
  db: Store,
  actor: Actor,
  input: any,
  preview = false,
) {
  db.admin(actor);
  const snapshot = validateSnapshot(input);
  const counts = {
    events: snapshot.events.length,
    participants: snapshot.participants.length,
    registrations: snapshot.registrations.length,
    preview,
    heldParticipants:0,
  };
  if (preview) return counts;
  return db.sql.transaction(() => {
    let heldParticipants=0;
    const eventRefs = new Map<string,string>(), personRefs = new Map<string,string>();
    const registrationRefs=new Map<string,any[]>();
    for(const r of snapshot.registrations)registrationRefs.set(r.participantExternalId,[...(registrationRefs.get(r.participantExternalId)||[]),r]);
    for (const e of snapshot.events) {
      if (e.receptionId) {
        const existing = db.event(actor,e.receptionId);
        // Existing event settings and history are never rewritten.
        if (new Date(existing.startsAt).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'}) !== new Date(e.startsAt).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'})) fail('invalid_snapshot');
        eventRefs.set(e.externalId, existing.id);
      } else {
        db.run("INSERT OR IGNORE INTO events(id,title,starts_at,opens_at,closes_at,venue,capacity,source,external_id) VALUES(?,?,?,?,?,?,?,'analytics',?)",randomUUID(),text(e.title),new Date(e.startsAt).toISOString(),new Date(e.opensAt).toISOString(),new Date(e.closesAt).toISOString(),text(e.venue),e.capacity,e.externalId);
        eventRefs.set(e.externalId,db.row("SELECT id FROM events WHERE source='analytics' AND external_id=?",e.externalId).id);
      }
    }
    for(const [externalId,id] of eventRefs){const target=db.canonicalEvent(id);if(db.event(actor,target).archived)fail('event_archived',409);eventRefs.set(externalId,target);}
    for(const e of snapshot.events) {
      const targetId=eventRefs.get(e.externalId)!,day=new Date(e.startsAt).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
      if(new Date(db.event(actor,targetId).startsAt).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'})!==day)fail('claim_event_date_mismatch',409);
      const aliases=new Set<string>([...(e.aliases||[]),...(/^sheet-event:[a-f0-9]{64}$/.test(e.externalId)?[e.externalId]:[])]);
      for(const alias of aliases) {
        const mapped=db.row('SELECT event_id FROM form_event_mappings WHERE external_event_id=? AND event_date=?',alias,day),direct=db.row("SELECT id FROM events WHERE source='analytics' AND external_id=?",alias);
        if((mapped&&mapped.event_id!==targetId)||(direct&&db.canonicalEvent(direct.id)!==targetId))fail('claim_event_mapping_conflict',409);
        db.run('INSERT OR IGNORE INTO form_event_mappings VALUES(?,?,?)',alias,targetId,day);
        if(!mapped)db.audit(actor,'sheet_event_map',targetId,null);
      }
    }
    for (const p of snapshot.participants) {
      const claim = p.claimHash ? db.row('SELECT * FROM form_claims WHERE token_hash=?',p.claimHash) : null;
      const refs = registrationRefs.get(p.externalId)||[];
      if (p.claimHash && refs.length !== 1) fail('invalid_snapshot');
      if(p.claimHash&&!claim){heldParticipants++;continue;}
      if(!claim) {
        // A name is only a collision warning, never proof of identity.
        const collision=refs.some((r:any)=>{
          const event=db.event(actor,eventRefs.get(r.eventExternalId)!);
          const day=new Date(event.startsAt).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
          return db.row('SELECT 1 FROM form_claims WHERE event_date=? AND name=? LIMIT 1',day,p.name) || db.row("SELECT 1 FROM registrations r JOIN participants p ON p.id=r.participant_id WHERE r.event_id=? AND p.name=? AND (p.source IS NULL OR p.source!='analytics') LIMIT 1",event.id,p.name);
        });
        if(collision){heldParticipants++;continue;}
      }

      if (claim) {
        const event = db.event(actor,eventRefs.get(refs[0].eventExternalId)!);
        const day = new Date(event.startsAt).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'});
        if (claim.event_date !== day || claim.name !== p.name) fail('claim_conflict',409);
        const mapped=db.row('SELECT event_id FROM form_event_mappings WHERE external_event_id=? AND event_date=?',claim.external_event_id,day);
        const direct=db.row("SELECT id FROM events WHERE source='analytics' AND external_id=?",claim.external_event_id);
        if ((mapped && mapped.event_id!==event.id)||(!mapped&&direct&&direct.id!==event.id)) fail('claim_event_mapping_conflict',409);
        db.run('INSERT OR IGNORE INTO form_event_mappings VALUES(?,?,?)',claim.external_event_id,event.id,day);
      }
      let person=claim?.participant_id ? db.row('SELECT id FROM participants WHERE id=?',claim.participant_id) : db.row("SELECT id FROM participants WHERE source='analytics' AND external_id=?",p.externalId);
      if(claim&&!claim.participant_id&&person&&db.row('SELECT 1 FROM form_claims WHERE participant_id=? AND token_hash<>? LIMIT 1',person.id,p.claimHash)){heldParticipants++;continue;}
      if (!person) {
        const id=randomUUID();db.run("INSERT INTO participants(id,name,source,external_id,created_at) VALUES(?,?,'analytics',?,?)",id,text(p.name,60),p.externalId,new Date().toISOString());person={id};
      }
      if(claim&&!claim.participant_id)db.run('UPDATE form_claims SET participant_id=? WHERE token_hash=?',person.id,p.claimHash);
      personRefs.set(p.externalId,person.id);
    }
    for (const r of snapshot.registrations) if(personRefs.has(r.participantExternalId)) db.run('INSERT OR IGNORE INTO registrations(event_id,participant_id) VALUES(?,?)',eventRefs.get(r.eventExternalId),personRefs.get(r.participantExternalId));
    db.audit(actor, "analytics_import", null, null);
    db.run(
      "INSERT INTO sync_runs(kind,status,detail,created_at) VALUES(?,?,?,?)",
      "import",
      "success",
      JSON.stringify({...counts,heldParticipants}),
      new Date().toISOString(),
    );
    return {...counts,heldParticipants};
  });
}
export async function fetchSnapshot(
  cfg: IntegrationConfig,
  fetcher: typeof fetch = fetch,
) {
  if (!cfg.analyticsSnapshotUrl || !cfg.analyticsToken)
    fail("analytics_disconnected", 503);
  return validateSnapshot(
    await readJSON(
      await fetcher(secureURL(cfg.analyticsSnapshotUrl), {
        headers: { Authorization: `Bearer ${cfg.analyticsToken}` },
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        cache: "no-store",
      }),
    ),
  );
}
let delivering = false;
export async function deliverOutbox(
  db: Store,
  cfg: IntegrationConfig,
  fetcher: typeof fetch = fetch,
) {
  if (!cfg.analyticsDeliveryUrl || !cfg.analyticsToken)
    return { connected: false, sent: 0, failed: 0 };
  const url = secureURL(cfg.analyticsDeliveryUrl);
  if (delivering) return { connected: true, sent: 0, failed: 0, busy: true };
  delivering = true;
  let sent = 0,
    failed = 0;
  try {
    for (const item of db.rows(
      `SELECT o.* FROM outbox o WHERE o.status!='sent' AND o.next_attempt<=? AND NOT EXISTS(
      SELECT 1 FROM outbox prior WHERE prior.status!='sent' AND prior.sequence<o.sequence AND prior.event_id=o.event_id
      AND json_extract(prior.payload,'$.participantId')=json_extract(o.payload,'$.participantId')) ORDER BY o.sequence LIMIT 50`,
      Date.now(),
    )) {
      try {
        const response = await fetcher(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfg.analyticsToken}`,
            "Content-Type": "application/json",
            "Idempotency-Key": item.id,
          },
          body: item.payload,
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
          cache: "no-store",
        });
        const result = await readJSON(response);
        if (result.accepted !== true || result.changeId !== item.id)
          fail("integration_failed", 502);
        db.run(
          "UPDATE outbox SET status='sent',attempts=attempts+1,last_error=NULL WHERE id=?",
          item.id,
        );
        sent++;
      } catch {
        db.run(
          "UPDATE outbox SET status='failed',attempts=attempts+1,next_attempt=?,last_error='delivery_failed' WHERE id=?",
          Date.now() +
            Math.min(3600_000, 2 ** Math.min(item.attempts, 10) * 30000),
          item.id,
        );
        failed++;
      }
    }
    db.run(
      "INSERT INTO sync_runs(kind,status,detail,created_at) VALUES(?,?,?,?)",
      "delivery",
      failed ? "failed" : "success",
      JSON.stringify({ sent, failed }),
      new Date().toISOString(),
    );
    return { connected: true, sent, failed };
  } finally {
    delivering = false;
  }
}
export async function verifyPass(
  cfg: IntegrationConfig,
  ticket: string,
  eventId: string,
  fetcher: typeof fetch = fetch,
) {
  if (!cfg.passVerifyUrl || !cfg.passToken) fail("pass_disconnected", 503);
  if (typeof ticket !== "string" || !ticket || ticket.length > 2048)
    fail("invalid_pass");
  const data = await readJSON(
    await fetcher(secureURL(cfg.passVerifyUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.passToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ version: 1, ticket, eventId }),
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    }),
  );
  if (
    data.version !== 1 ||
    typeof data.memberId !== "string" ||
    !data.memberId ||
    data.memberId.length > 100 ||
    data.eventId !== eventId ||
    !Number.isFinite(data.expiresAt) ||
    data.expiresAt <= Date.now() ||
    data.expiresAt > Date.now() + 86400_000
  )
    fail("invalid_pass");
  return { memberId: data.memberId, eventId };
}
