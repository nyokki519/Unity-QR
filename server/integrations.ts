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
  };
  if (preview) return counts;
  return db.sql.transaction(() => {
    for (const e of snapshot.events)
      db.run(
        "INSERT OR IGNORE INTO events(id,title,starts_at,opens_at,closes_at,venue,capacity,source,external_id) VALUES(?,?,?,?,?,?,?,'analytics',?)",
        randomUUID(),
        text(e.title),
        new Date(e.startsAt).toISOString(),
        new Date(e.opensAt).toISOString(),
        new Date(e.closesAt).toISOString(),
        text(e.venue),
        e.capacity,
        e.externalId,
      );
    for (const p of snapshot.participants)
      db.run(
        "INSERT OR IGNORE INTO participants(id,name,source,external_id,created_at) VALUES(?,?,'analytics',?,?)",
        randomUUID(),
        text(p.name, 60),
        p.externalId,
        new Date().toISOString(),
      );
    for (const r of snapshot.registrations) {
      const event = db.row(
        "SELECT id FROM events WHERE source='analytics' AND external_id=?",
        r.eventExternalId,
      );
      const person = db.row(
        "SELECT id FROM participants WHERE source='analytics' AND external_id=?",
        r.participantExternalId,
      );
      db.run(
        "INSERT OR IGNORE INTO registrations(event_id,participant_id) VALUES(?,?)",
        event.id,
        person.id,
      );
    }
    db.audit(actor, "analytics_import", null, null);
    db.run(
      "INSERT INTO sync_runs(kind,status,detail,created_at) VALUES(?,?,?,?)",
      "import",
      "success",
      JSON.stringify(counts),
      new Date().toISOString(),
    );
    return counts;
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
        redirect: "error",
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
          redirect: "error",
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
      redirect: "error",
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
