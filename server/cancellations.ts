import type {Actor,ReceptionStore} from './store-core.js';
import {japanDate} from './form-claims.js';
import {fail} from './security.js';

// Complete snapshot, not incremental changes: restoration removes a cancellation.
export function cancellationSnapshot(db:ReceptionStore,actor:Actor){
 db.admin(actor);
 const rows=db.rows(`SELECT r.event_id,r.participant_id,p.source,p.external_id FROM registrations r JOIN participants p ON p.id=r.participant_id WHERE r.status='cancelled' ORDER BY r.event_id,r.participant_id LIMIT 5001`);
 if(rows.length>5000)fail('cancellation_snapshot_too_large',503);
 const registrations=[];
 for(const row of rows){
  if(db.canonicalEvent(row.event_id)!==row.event_id)continue;
  const event=db.event(actor,row.event_id),eventDate=japanDate(event.startsAt);
  const claims=db.rows(`SELECT c.token_hash,coalesce(m.event_id,e.id) event_id FROM form_claims c LEFT JOIN form_event_mappings m ON m.external_event_id=c.external_event_id AND m.event_date=c.event_date LEFT JOIN events e ON e.source='analytics' AND e.external_id=c.external_event_id WHERE c.participant_id=? AND c.event_date=?`,row.participant_id,eventDate);
  const claimHashes=[...new Set(claims.filter(c=>c.event_id&&db.canonicalEvent(c.event_id)===row.event_id).map(c=>c.token_hash))];
  registrations.push({eventId:row.event_id,eventDate,participantId:row.participant_id,externalParticipantId:row.source==='analytics'?row.external_id:null,claimHashes,status:'cancelled'});
 }
 return {version:1,complete:true,registrations};
}
