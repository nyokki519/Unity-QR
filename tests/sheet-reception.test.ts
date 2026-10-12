import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import {importSnapshot} from '../server/integrations.js';
import {FormClaims,japanDate} from '../server/form-claims.js';
import {digest,keyedDigest} from '../server/security.js';
import {LineService} from '../server/line.js';
const admin:any={id:'fixture',role:'Admin',events:[]};
function fixture(){const db=new Store(':memory:');const opensAt=new Date(Date.now()-60000).toISOString(),closesAt=new Date(Date.now()+3600000).toISOString();return {db,event:{externalId:'sheet:event',title:'Test',startsAt:opensAt,opensAt,closesAt,venue:'Unknown',capacity:10000},person:{externalId:'sheet:registration',name:'申込テスト'}};}
test('sheet import reuses existing event without altering settings and binds accepted claim to one participant',()=>{
 const {db,event,person}=fixture();try{
 const ev=db.createEvent(admin,{...event,capacity:7},randomUUID());const raw='a'.repeat(64),claimHash=digest(raw),claims=new FormClaims(db);
 claims.accept({claimHash,receiptHash:digest('receipt'),name:person.name,eventId:'original-form-id',eventName:'Test',eventDate:japanDate(event.startsAt)});
 const snapshot={version:1,events:[{...event,receptionId:ev.id}],participants:[{...person,claimHash}],registrations:[{eventExternalId:event.externalId,participantExternalId:person.externalId}]};
 importSnapshot(db,admin,snapshot);importSnapshot(db,admin,snapshot);
 assert.equal(db.events(admin).length,1);assert.equal(db.event(admin,ev.id).capacity,7);
 const imported=db.participants(admin,ev.id)[0];const redeemed=claims.redeem(raw,'b'.repeat(64));assert.equal(redeemed.person.id,imported.id);
 assert.equal(db.summary(admin,ev.id).total,1);assert.throws(()=>claims.redeem(raw,'c'.repeat(64)),/claim_used/);
 }finally{db.close();}
});
test('private participant link is reusable only by its bearer and server validates event registration',()=>{
 const {db,event}=fixture();try{const ev=db.createEvent(admin,event,randomUUID()),p=db.register(admin,ev.id,{name:'テスト'},randomUUID());const service=new LineService(db,{origin:'https://qr.example',signingKey:'test-only-key'.repeat(5)});
 const one=service.issueParticipantLink(admin,ev.id,p.id,'test-key-1234567890');const two=service.issueParticipantLink(admin,ev.id,p.id,'test-key-1234567890');assert.deepEqual(one,two);const raw=one.url.split('#')[1];assert.equal(service.ticket(raw).name,'テスト');assert.throws(()=>service.ticket(raw+'a'),/ticket_not_found/);
 assert.throws(()=>service.issueParticipantLink({id:'v',role:'Viewer',events:[ev.id]},ev.id,p.id,'viewer-key-1234567890'),/forbidden/);
 assert.throws(()=>service.issueParticipantLink({id:'s',role:'Staff',events:[]},ev.id,p.id,'staff-key-1234567890'),/forbidden/);
 }finally{db.close();}
});
test('same-name existing forms are not merged without an accepted claim hash; unaccepted hashes are held',()=>{
 const {db,event,person}=fixture();try{
 const claims=new FormClaims(db);claims.accept({claimHash:digest('a'.repeat(64)),receiptHash:digest('receipt'),name:person.name,eventId:'form-id',eventName:event.title,eventDate:japanDate(event.startsAt)});
 const snapshot={version:1,events:[event],participants:[person],registrations:[{eventExternalId:event.externalId,participantExternalId:person.externalId}]};
 const result=importSnapshot(db,admin,snapshot);assert.equal(result.heldParticipants,1);assert.equal(JSON.parse(db.row("SELECT detail FROM sync_runs WHERE kind='import' ORDER BY id DESC LIMIT 1").detail).heldParticipants,1);assert.equal(db.row('SELECT count(*) n FROM participants').n,0);
 const pending=importSnapshot(db,admin,{...snapshot,participants:[{...person,name:'Other',claimHash:digest('unknown')}]});assert.equal(pending.heldParticipants,1);
 }finally{db.close();}
});
test('a claimed participant is reused for an existing LINE identity without changing that identity or another claim owner',()=>{
 const {db,event,person}=fixture();try{
 const existing=db.register(admin,db.createEvent(admin,{...event,title:'Other'},randomUUID()).id,{name:'Prior person'},randomUUID());const subject='c'.repeat(64);db.run('INSERT INTO line_identities VALUES(?,?,?)',subject,existing.id,new Date().toISOString());
 const claims=new FormClaims(db),raw='d'.repeat(64),claimHash=digest(raw);claims.accept({claimHash,receiptHash:digest('receipt'),name:person.name,eventId:'form-id',eventName:event.title,eventDate:japanDate(event.startsAt)});
 const snapshot={version:1,events:[event],participants:[{...person,claimHash}],registrations:[{eventExternalId:event.externalId,participantExternalId:person.externalId}]};importSnapshot(db,admin,snapshot);
 const ev=db.events(admin).find(e=>e.externalId===event.externalId)!;const imported=db.participants(admin,ev.id)[0];assert.equal(claims.redeem(raw,subject).person.id,imported.id);assert.equal(claims.redeem(raw,subject).person.id,imported.id);assert.equal(db.row('SELECT participant_id FROM line_identities WHERE subject_hash=?',subject).participant_id,existing.id);assert.equal(db.summary(admin,ev.id).total,1);
 importSnapshot(db,admin,snapshot);assert.equal(db.summary(admin,ev.id).total,1);
 assert.throws(()=>claims.redeem(raw,'e'.repeat(64)),/claim_used/);
 }finally{db.close();}
});
test('LINE reissue finds a claimed sheet event even without LINE signup settings and with an earlier LINE identity',()=>{
 const {db,event,person}=fixture();try{
 const cfg={origin:'https://qr.example',signingKey:'test-only-key'.repeat(5),lineChannelId:'1234567890'},service=new LineService(db,cfg),userId='U'+'f'.repeat(32),subject=keyedDigest(cfg.lineChannelId+":"+userId,cfg.signingKey);
 const prior=db.register(admin,db.createEvent(admin,{...event,title:'Prior'},randomUUID()).id,{name:'Prior'},randomUUID());db.run('INSERT INTO line_identities VALUES(?,?,?)',subject,prior.id,new Date().toISOString());
 const raw='e'.repeat(64),claimHash=digest(raw),claims=new FormClaims(db);claims.accept({claimHash,receiptHash:digest('receipt'),name:person.name,eventId:'form-id',eventName:event.title,eventDate:japanDate(event.startsAt)});
 importSnapshot(db,admin,{version:1,events:[event],participants:[{...person,claimHash}],registrations:[{eventExternalId:event.externalId,participantExternalId:person.externalId}]});
 const msg=(text:string):any=>({type:'message',source:{type:'user',userId},message:{type:'text',text}});
 assert.match(service.respond(msg('参加QR '+raw))[0].text,/申込テスト/);assert.match(service.respond(msg('QR再発行'))[0].text,/申込テスト/);assert.match(service.respond(msg('参加希望'))[0].text,/申込テスト/);assert.equal(db.row('SELECT count(*) n FROM registrations').n,2);
 }finally{db.close();}
});
test('a later distinct accepted receipt cannot claim an application already bound to another receipt',()=>{
 const {db,event,person}=fixture();try{
 const claims=new FormClaims(db),first='a'.repeat(64),second='b'.repeat(64);const accept=(raw:string)=>claims.accept({claimHash:digest(raw),receiptHash:digest('receipt:'+raw),name:person.name,eventId:'form-event',eventName:event.title,eventDate:japanDate(event.startsAt)});
 accept(first);const snapshot=(raw:string)=>({version:1,events:[event],participants:[{...person,claimHash:digest(raw)}],registrations:[{eventExternalId:event.externalId,participantExternalId:person.externalId}]});
 importSnapshot(db,admin,snapshot(first));const owner=claims.redeem(first,'c'.repeat(64));accept(second);
 const result=importSnapshot(db,admin,snapshot(second));assert.equal(result.heldParticipants,1);assert.equal(db.row('SELECT participant_id FROM form_claims WHERE token_hash=?',digest(second)).participant_id,null);assert.equal(db.row('SELECT count(*) n FROM participants').n,1);assert.equal(claims.redeem(first,'c'.repeat(64)).person.id,owner.person.id);
 }finally{db.close();}
});
