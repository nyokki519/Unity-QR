import type {ReceptionStore,Actor} from './store-core.js';
import {digest,fail,text} from './security.js';
import {japanDate} from './form-claims.js';
// Indexed immutable audit projection keeps schema4 backups fully compatible.
export function eventLifecycle(db:ReceptionStore,id:string){
 const state=db.row("SELECT action FROM audit WHERE event_id=? AND action IN ('event_archive','event_restore') ORDER BY id DESC LIMIT 1",id);
 const merge=db.row("SELECT reason FROM audit WHERE event_id=? AND action='event_merge' ORDER BY id DESC LIMIT 1",id);
 let mergedInto:string|null=null;if(merge){try{mergedInto=text(JSON.parse(merge.reason).targetId,128);}catch{fail('invalid_event_lifecycle',503);}}
 return {archived:state?.action==='event_archive'||!!mergedInto,mergedInto};
}
export function canonicalEvent(db:ReceptionStore,id:string){const seen=new Set<string>();for(let i=0;i<50;i++){if(seen.has(id))fail('invalid_event_lifecycle',503);seen.add(id);const target=eventLifecycle(db,id).mergedInto;if(!target)return id;id=target;}fail('invalid_event_lifecycle',503);}
export function archiveEvent(db:ReceptionStore,actor:Actor,id:string,reason:string,key:string,restore=false){db.admin(actor);id=text(id,128);reason=text(reason,240);return db.mutate(actor,key,digest(JSON.stringify([restore?'restore':'archive',id,reason])),()=>{const event=db.event(actor,id);if(event.mergedInto)fail('event_merged',409);db.audit(actor,restore?'event_restore':'event_archive',id,null,reason);return db.event(actor,id);});}
export function previewEventMerge(db:ReceptionStore,actor:Actor,sourceId:string,targetId:string){
 db.admin(actor);sourceId=text(sourceId,128);targetId=text(targetId,128);if(sourceId===targetId)fail('invalid_event_merge');
 const source=db.event(actor,sourceId),target=db.event(actor,targetId);if(source.archived||target.archived)fail('event_archived',409);
 if(japanDate(source.startsAt)!==japanDate(target.startsAt))fail('merge_date_mismatch',409);
 if(db.row('SELECT 1 FROM attendance WHERE event_id IN (?,?) LIMIT 1',sourceId,targetId))fail('merge_has_attendance',409);
 const regs=db.rows('SELECT event_id,participant_id,status FROM registrations WHERE event_id IN (?,?) ORDER BY event_id,participant_id',sourceId,targetId);
 const active=new Set<string>(),states=new Map<string,string>();for(const r of regs){if(states.has(r.participant_id)&&states.get(r.participant_id)!==r.status)fail('merge_registration_conflict',409);states.set(r.participant_id,r.status);if(r.status==='planned')active.add(r.participant_id);}
 if(active.size>target.capacity)fail('capacity_reached',409);
 const names=new Map<string,Set<string>>();for(const r of regs){const name=db.row('SELECT name FROM participants WHERE id=?',r.participant_id).name;const ids=names.get(name)||new Set<string>();ids.add(r.participant_id);names.set(name,ids);}
 return {source,target,sourceCount:regs.filter(r=>r.event_id===sourceId).length,targetCount:regs.filter(r=>r.event_id===targetId).length,resultCount:states.size,sameNameGroups:[...names.values()].filter(ids=>ids.size>1).length,fingerprint:digest(JSON.stringify([source,target,regs,[...names].map(([name,ids])=>[name,[...ids]])]))};
}
export function mergeEvent(db:ReceptionStore,actor:Actor,sourceId:string,targetId:string,fingerprint:string,key:string){
 db.admin(actor);return db.mutate(actor,key,digest(JSON.stringify(['merge',sourceId,targetId,fingerprint])),()=>{
 const preview=previewEventMerge(db,actor,sourceId,targetId);if(preview.fingerprint!==fingerprint)fail('merge_preview_changed',409);
 db.run('INSERT OR IGNORE INTO registrations(event_id,participant_id,status) SELECT ?,participant_id,status FROM registrations WHERE event_id=?',targetId,sourceId);
 db.run('UPDATE form_event_mappings SET event_id=? WHERE event_id=?',targetId,sourceId);
 if(preview.source.source==='analytics'&&preview.source.externalId){const mapped=db.row('SELECT event_id FROM form_event_mappings WHERE external_event_id=?',preview.source.externalId);if(mapped&&mapped.event_id!==targetId)fail('claim_event_mapping_conflict',409);db.run('INSERT OR IGNORE INTO form_event_mappings VALUES(?,?,?)',preview.source.externalId,targetId,japanDate(preview.source.startsAt));}
 db.audit(actor,'event_merge',sourceId,null,JSON.stringify({targetId}));db.audit(actor,'event_merge_receive',targetId,null,JSON.stringify({sourceId}));
 for(const source of db.rows("SELECT DISTINCT event_id FROM audit WHERE action='event_merge'"))canonicalEvent(db,source.event_id);
 return {ok:true,targetId,participants:preview.resultCount};
 });
}
