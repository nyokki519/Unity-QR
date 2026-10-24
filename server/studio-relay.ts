import { createHmac, randomUUID } from "node:crypto";
import type { ReceptionStore } from "./store-core.js";
import { digest, fail } from "./security.js";
export type StudioRelayConfig = {
  studioRelayEnabled?: boolean;
  studioAllowedGroupIds?: string;
  lineChannelSecret?: string;
};
const endpoint = "https://unity-auto-studio.kukki519.workers.dev/webhooks/line";
const day = 86400000;
function groups(cfg: StudioRelayConfig) {
  return new Set(
    (cfg.studioAllowedGroupIds ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^C[a-f0-9]{32}$/.test(s)),
  );
}
export function enqueueStudioEvents(
  db: ReceptionStore,
  cfg: StudioRelayConfig,
  events: any[],
  now = Date.now(),
) {
  const allowed = groups(cfg);
  const selected = events.filter((e) => {
    const group = e?.source?.groupId;
    if (
      e?.source?.type !== "group" ||
      typeof group !== "string" ||
      !/^C[a-f0-9]{32}$/.test(group)
    )
      return false;
    if (e.type === "unsend")
      return (
        allowed.has(group) ||
        Boolean(
          db.row(
            "SELECT group_hash FROM studio_relay_groups WHERE group_hash=?",
            digest(group),
          ),
        )
      );
    return (
      cfg.studioRelayEnabled &&
      allowed.has(group) &&
      e.type === "message" &&
      ["image", "video"].includes(e.message?.type)
    );
  });
  const rows = selected.map((e) => {
    const kind = e.type === "unsend" ? "unsend" : "media",
      message = kind === "unsend" ? e.unsend?.messageId : e.message?.id;
    if (
      typeof e.webhookEventId !== "string" ||
      !/^[\w-]{1,128}$/.test(e.webhookEventId) ||
      !Number.isSafeInteger(e.timestamp) ||
      e.timestamp < 0 ||
      typeof message !== "string" ||
      !/^\d{1,64}$/.test(message) ||
      (kind === "media" && e.message.contentProvider?.type !== "line")
    )
      fail("invalid_studio_event");
    const group = e.source.groupId,
      groupHash = digest(group),
      id = digest(group + ":" + e.webhookEventId);
    const event = {
      type: e.type,
      webhookEventId: e.webhookEventId,
      timestamp: e.timestamp,
      source: { type: "group", groupId: group },
      ...(kind === "unsend"
        ? { unsend: { messageId: message } }
        : {
            message: {
              id: message,
              type: e.message.type,
              contentProvider: { type: "line" },
            },
          }),
    };
    return {
      id,
      kind,
      message,
      groupHash,
      payload: JSON.stringify({ events: [event] }),
    };
  });
  const commit=(batch:typeof rows)=>db.sql.transaction(() => {
    db.run("DELETE FROM studio_relay_outbox WHERE retain_until<=?", now);
    for (const row of batch) {
      if (db.row("SELECT id FROM studio_relay_outbox WHERE id=?", row.id))
        continue;
      const cancellation = db.row(
        "SELECT id FROM studio_relay_outbox WHERE kind='unsend' AND group_hash=? AND message_id=?",
        row.groupHash,row.message,
      );
      // Different webhook IDs for the same cancellation share one durable slot.
      if(row.kind==='media'&&cancellation)continue;
      if(row.kind==='unsend'){
        db.run("UPDATE studio_relay_outbox SET status='cancelled',payload=NULL,lease_token=NULL,lease_until=0 WHERE kind='media' AND group_hash=? AND message_id=? AND status IN ('pending','sending')",row.groupHash,row.message);
        if(cancellation)continue;
      }
      const knownMedia=Boolean(db.row("SELECT id FROM studio_relay_outbox WHERE kind='media' AND group_hash=? AND message_id=?",row.groupHash,row.message));
      const retained=db.row("SELECT COUNT(*) n FROM studio_relay_outbox").n;
      const reserved=db.row(`SELECT COUNT(*) n FROM (
        SELECT m.group_hash,m.message_id FROM studio_relay_outbox m WHERE m.kind='media'
        AND NOT EXISTS(SELECT 1 FROM studio_relay_outbox u WHERE u.kind='unsend' AND u.group_hash=m.group_hash AND u.message_id=m.message_id)
        GROUP BY m.group_hash,m.message_id)`).n;
      // Every admitted source reserves a future cancellation row. Unrelated
      // unsends cannot consume that reservation, and source unsends release it.
      const reserveDelta=row.kind==='media'?(knownMedia?0:1):(knownMedia?-1:0);
      if(retained+reserved+1+reserveDelta>1000 ||
        row.kind==='media'&&db.row("SELECT COUNT(*) n FROM studio_relay_outbox WHERE kind='media' AND created_at>=?",Math.floor(now/day)*day).n>=100)
        fail("studio_relay_capacity",503);
      if (row.kind === "media")
        db.run(
          "INSERT OR IGNORE INTO studio_relay_groups(group_hash) VALUES(?)",
          row.groupHash,
        );
      db.run(
        "INSERT INTO studio_relay_outbox(id,kind,group_hash,message_id,payload,status,created_at,expires_at,retain_until,next_attempt) VALUES(?,?,?,?,?,'pending',?,?,?,?)",
        row.id,
        row.kind,
        row.groupHash,
        row.message,
        row.payload,
        now,
        now + (row.kind === "unsend" ? 7 * day : day),
        now + 7 * day,
        now,
      );
    }
  });
  // Revocations survive another event's capacity failure. LINE may redeliver
  // the batch, but an accepted source must not keep forwarding while waiting.
  let cancellationFailure:unknown;
  for(const row of rows.filter(r=>r.kind==='unsend')){
    try{commit([row]);}catch(error){cancellationFailure??=error;}
  }
  if(cancellationFailure)throw cancellationFailure;
  commit(rows.filter(r=>r.kind==='media'));
}
export function nextStudioDelivery(
  db: ReceptionStore,
  cfg: StudioRelayConfig,
): number | null {
  const maintenance =
    db.row(
      "SELECT MIN(CASE WHEN payload IS NOT NULL THEN MIN(expires_at,retain_until) ELSE retain_until END) next FROM studio_relay_outbox",
    ).next ?? null;
  if (!cfg.lineChannelSecret) return maintenance;
  const delivery =
    db.row(
      "SELECT MIN(CASE WHEN status='sending' THEN lease_until ELSE next_attempt END) next FROM studio_relay_outbox WHERE status IN ('pending','sending') AND (?=1 OR kind='unsend')",
      cfg.studioRelayEnabled ? 1 : 0,
    ).next ?? null;
  return delivery === null
    ? maintenance
    : maintenance === null
      ? delivery
      : Math.min(delivery, maintenance);
}
export async function deliverStudioRelay(
  db: ReceptionStore,
  cfg: StudioRelayConfig,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  db.run("DELETE FROM studio_relay_outbox WHERE retain_until<=?", now);
  db.run(
    "UPDATE studio_relay_outbox SET status='expired',payload=NULL,lease_token=NULL,lease_until=0,last_error='delivery_expired' WHERE status IN ('pending','sending') AND (expires_at<=? OR attempts>=12 AND lease_until<=?)",
    now,
    now,
  );
  if (!cfg.lineChannelSecret) return;
  const allowed = new Set([...groups(cfg)].map(digest));
  for (let n = 0; n < 4; n++) {
    const token = randomUUID();
    const row = db.sql.transaction(() => {
      const item = db.row(
        "SELECT * FROM studio_relay_outbox WHERE (status='pending' AND next_attempt<=? OR status='sending' AND lease_until<=?) AND payload IS NOT NULL AND (?=1 OR kind='unsend') ORDER BY CASE kind WHEN 'unsend' THEN 0 ELSE 1 END,created_at,id LIMIT 1",
        now,
        now,
        cfg.studioRelayEnabled ? 1 : 0,
      );
      if (!item) return null;
      db.run(
        "UPDATE studio_relay_outbox SET status='sending',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?",
        token,
        now + 60000,
        item.id,
      );
      return item;
    });
    if (!row) break;
    if (
      !allowed.has(row.group_hash) &&
      !(
        row.kind === "unsend" &&
        db.row(
          "SELECT group_hash FROM studio_relay_groups WHERE group_hash=?",
          row.group_hash,
        )
      )
    ) {
      db.run(
        "UPDATE studio_relay_outbox SET status='cancelled',payload=NULL,lease_token=NULL,lease_until=0,last_error='group_removed' WHERE id=? AND lease_token=?",
        row.id,
        token,
      );
      continue;
    }
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: {
          "Content-Type": "application/json",
          "x-line-signature": createHmac("sha256", cfg.lineChannelSecret)
            .update(row.payload)
            .digest("base64"),
        },
        body: row.payload,
      });
      await response.body?.cancel();
      if (!response.ok) throw Error("delivery_unavailable");
      db.run(
        "UPDATE studio_relay_outbox SET status='sent',payload=NULL,lease_token=NULL,lease_until=0,last_error=NULL WHERE id=? AND status='sending' AND lease_token=?",
        row.id,
        token,
      );
    } catch {
      db.run(
        "UPDATE studio_relay_outbox SET status='pending',next_attempt=?,lease_token=NULL,lease_until=0,last_error='delivery_unavailable' WHERE id=? AND status='sending' AND lease_token=?",
        now + Math.min(3600000, 60000 * 2 ** Math.min(row.attempts, 6)),
        row.id,
        token,
      );
    }
  }
}
