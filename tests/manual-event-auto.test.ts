import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {FormClaims,japanDate} from '../server/form-claims.js';
import {digest} from '../server/security.js';
import {LineService} from '../server/line.js';
import {importSnapshot} from '../server/integrations.js';
const actor:any={id:'fixture',role:'Admin',events:[]};
function application(db:Store,title:string,day=japanDate(new Date().toISOString()),id?:string){
 const raw=digest(Math.random().toString()),external='sheet-event:'+digest(JSON.stringify([day,title.normalize('NFKC').trim().replace(/^unity[\s・:：-]*/i,'').replace(/[\s・:：-]/g,'').toLowerCase()]));
 new FormClaims(db).accept({claimHash:digest(raw),receiptHash:digest('receipt:'+raw),eventId:id||external,eventDate:day,eventName:title,name:'Fixture '+raw.slice(0,4)});return {raw,external,day};
}
test('first accepted free-input claim creates whole-day event and LINE QR without Analytics sync',()=>{
 const db=new Store(':memory:');try{const app=application(db,'リピーター会');const line=new LineService(db,{origin:'https://qr.example',signingKey:'fixture-key'.repeat(5),lineChannelId:'1234567890'});
 const message=line.respond({type:'message',source:{type:'user',userId:'U'+'a'.repeat(32)},message:{type:'text',text:'参加QR '+app.raw}} as any);
 assert.match(message[0].text,/参加申込を確認できました/);assert.match(message[0].text,/\/ticket\/#/);
 const event=db.events(actor)[0];assert(event);assert.equal(event.opensAt,new Date(app.day+'T00:00:00+09:00').toISOString());assert.equal(Date.parse(event.closesAt)-Date.parse(event.opensAt),86400000);
 assert.deepEqual(line.respond({type:'message',source:{type:'user',userId:'U'+'a'.repeat(32)},message:{type:'text',text:'参加QR '+app.raw}} as any)[0].type,'text');assert.equal(db.events(actor).length,1);
 }finally{db.close();}
});
test('same-day variants reuse event and keep individual people; next day and different topic stay separate',()=>{
 const db=new Store(':memory:');try{const claims=new FormClaims(db),a=application(db,'リピーター会'),b=application(db,'リピーター交流会');
 const first=claims.redeem(a.raw,'a'.repeat(64)),second=claims.redeem(b.raw,'b'.repeat(64));assert.equal(first.event.id,second.event.id);assert.notEqual(first.person.id,second.person.id);assert.equal(db.summary(actor,first.event.id).total,2);
 const tomorrow=new Date(Date.now()+86400000).toISOString(),c=application(db,'リピーター会',japanDate(tomorrow)),d=application(db,'ラテアート会');claims.redeem(c.raw,'c'.repeat(64));claims.redeem(d.raw,'d'.repeat(64));assert.equal(db.events(actor).length,3);
 const snapshot={version:1,events:[{externalId:b.external,aliases:[a.external,b.external],receptionId:first.event.id,title:'リピーター会',startsAt:first.event.startsAt,opensAt:first.event.opensAt,closesAt:first.event.closesAt,venue:'Unknown',capacity:10000}],participants:[{externalId:'sheet-person',name:second.person.name,claimHash:digest(b.raw)}],registrations:[{eventExternalId:b.external,participantExternalId:'sheet-person'}]};importSnapshot(db,actor,snapshot);assert.equal(db.summary(actor,first.event.id).total,2);
 }finally{db.close();}
});
test('ambiguous and transitive variants never create or bind another reception',()=>{
 const db=new Store(':memory:');try{const claims=new FormClaims(db),a=application(db,'abcd'),b=application(db,'abde');claims.redeem(a.raw,'a'.repeat(64));claims.redeem(b.raw,'b'.repeat(64));const c=application(db,'abcde');assert.throws(()=>claims.redeem(c.raw,'c'.repeat(64)),/claim_event_ambiguous/);assert.equal(db.events(actor).length,2);
 const d=application(db,'ABCDE',japanDate(new Date(Date.now()+86400000).toISOString())),e=application(db,'ABCDF',d.day),f=application(db,'ABXDF',d.day);claims.redeem(d.raw,'d'.repeat(64));claims.redeem(e.raw,'e'.repeat(64));assert.throws(()=>claims.redeem(f.raw,'f'.repeat(64)),/claim_event_ambiguous/);assert.equal(db.events(actor).length,3);
 }finally{db.close();}
});
test('unaccepted and forged internal keys never auto-create events',()=>{
 const db=new Store(':memory:');try{const claims=new FormClaims(db);assert.throws(()=>claims.redeem('a'.repeat(64),'b'.repeat(64)),/claim_pending/);
 const bad=application(db,'リピーター会',undefined,'sheet-event:'+'f'.repeat(64));assert.throws(()=>claims.redeem(bad.raw,'b'.repeat(64)),/claim_event_pending/);
 assert.equal(db.events(actor).length,0);
 }finally{db.close();}
});
test('accepted published applications create reception and issue QR for either keyword, then reuse it',()=>{
 const db=new Store(':memory:');try{const app=application(db,'公開イベント',undefined,'public-event-fixture');const line=new LineService(db,{origin:'https://qr.example',signingKey:'fixture-key'.repeat(5),lineChannelId:'1234567890'});
 for(const keyword of ['参加希望','参加QR']){const result=line.respond({type:'message',source:{type:'user',userId:'U'+'a'.repeat(32)},message:{type:'text',text:keyword+' '+app.raw}} as any)[0].text;assert.match(result,/公開イベント/);assert.match(result,/\/ticket\/#/);}
 assert.equal(db.events(actor).length,1);assert.equal(db.row('SELECT count(*) n FROM registrations').n,1);
 const another=application(db,'公開イベント',app.day,'second-public-fixture');new FormClaims(db).redeem(another.raw,'b'.repeat(64));assert.equal(db.events(actor).length,1);
 }finally{db.close();}
});
test('accepted long free-input titles still issue QR and numbered sessions remain separate',()=>{
 const db=new Store(':memory:');try{const claims=new FormClaims(db),long=application(db,'ラテアート'.repeat(20));assert(claims.redeem(long.raw,'a'.repeat(64)).event.id);
 const one=application(db,'初心者ヨガ1'),two=application(db,'初心者ヨガ2');assert.notEqual(claims.redeem(one.raw,'b'.repeat(64)).event.id,claims.redeem(two.raw,'c'.repeat(64)).event.id);
 const first=application(db,'初心者ヨガ第一回'),second=application(db,'初心者ヨガ第二回');assert.notEqual(claims.redeem(first.raw,'d'.repeat(64)).event.id,claims.redeem(second.raw,'e'.repeat(64)).event.id);
 }finally{db.close();}
});
test('a new accepted application uses its submitted name rather than the prior LINE identity',()=>{
 const db=new Store(':memory:');try{const cfg={origin:'https://qr.example',signingKey:'fixture-key'.repeat(5),lineChannelId:'1234567890'},line=new LineService(db,cfg),user='U'+'a'.repeat(32);
 const first=application(db,'初回テスト'),second=application(db,'新規受付確認');const msg=(raw:string):any=>({type:'message',source:{type:'user',userId:user},message:{type:'text',text:'参加QR '+raw}});
 const initial=line.respond(msg(first.raw))[0].text,firstPerson=db.participants(actor,db.events(actor).find(e=>e.title==='初回テスト')!.id)[0];
 const expected=db.row('SELECT name FROM form_claims WHERE token_hash=?',digest(second.raw)).name;
 const result=line.respond(msg(second.raw))[0].text;assert.match(result,new RegExp(expected));const rawTicket=result.match(/\/ticket\/#([a-f0-9]{64})/)![1];assert.equal(line.ticket(rawTicket).name,expected);
 assert.equal(db.person(actor,db.events(actor).find(e=>e.title==='初回テスト')!.id,firstPerson.id).name,firstPerson.name);assert.equal(db.row('SELECT participant_id FROM line_identities').participant_id,firstPerson.id);
 assert.match(line.respond(msg(second.raw))[0].text,new RegExp(expected));assert.equal(db.summary(actor,db.events(actor).find(e=>e.title==='新規受付確認')!.id).total,1);assert(initial.includes(firstPerson.name));
 }finally{db.close();}
});
