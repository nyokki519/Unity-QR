import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {FormClaims,japanDate} from '../server/form-claims.js';
import {LineService} from '../server/line.js';
import {digest} from '../server/security.js';
import {cancellationSnapshot} from '../server/cancellations.js';
const admin:any={id:'fixture',role:'Admin',events:[]};
function fixture(){const db=new Store(':memory:');return {db,forms:new FormClaims(db),line:new LineService(db,{origin:'https://fixture.example',signingKey:'fixture-key-'.repeat(4),lineChannelId:'1234567890'})};}
const msg=(text:string,user='a'):any=>({type:'message',source:{type:'user',userId:'U'+user.repeat(32)},message:{type:'text',text}});
const button=(data:string,user='a'):any=>({...msg('',user),type:'postback',postback:{data}});
function accept(s:ReturnType<typeof fixture>,seed:string,day=japanDate(new Date().toISOString())){const raw=digest(seed);s.forms.accept({claimHash:digest(raw),receiptHash:digest('receipt'+seed),eventId:'public-'+day,eventName:'同じ会',eventDate:day,name:'Fixture Person'});return raw;}
test('reapplication reserves a choice without inflating people; reuse and replay keep a single participant',()=>{
 const s=fixture();try{const a=accept(s,'first'),b=accept(s,'second');s.line.respond(msg('参加QR '+a));const choice=s.line.respond(msg('参加QR '+b))[0];assert.match(choice.text,/既存の申込/);assert.equal(s.db.row('SELECT count(*) n FROM participants').n,1);
 const data=choice.quickReply!.items[0].action.data;assert.match(s.line.respond(button(data,'b'))[0].text,/別のLINE/);assert.equal(s.db.row('SELECT count(*) n FROM registrations').n,1);
 assert.match(s.line.respond(button(data))[0].text,/\/ticket\/#/);assert.match(s.line.respond(button(data))[0].text,/\/ticket\/#/);assert.equal(s.db.row('SELECT count(*) n FROM registrations').n,1);assert.equal(s.db.row('SELECT count(DISTINCT participant_id) n FROM form_claims').n,1);
 }finally{s.db.close();}
});
test('explicit guests stay distinct, can choose their QR and cancel only the selected own person',()=>{
 const s=fixture();try{const a=accept(s,'guest-a'),b=accept(s,'guest-b');s.line.respond(msg('参加QR '+a));const c=s.line.respond(msg('参加QR '+b))[0];const add=c.quickReply!.items.at(-1).action.data;assert.match(s.line.respond(button(add))[0].text,/\/ticket\/#/);assert.equal(s.db.row('SELECT count(*) n FROM participants').n,2);
 const qr=s.line.respond(msg('参加QR'))[0];assert.equal(qr.quickReply!.items.length,2);assert.match(s.line.respond(button(qr.quickReply!.items[1].action.data))[0].text,/\/ticket\/#/);
 const people=s.line.respond(msg('キャンセル'))[0];const confirmation=s.line.respond(button(people.quickReply!.items[1].action.data))[0];assert.match(confirmation.text,/\d{4}\/\d{2}\/\d{2}/);const cancel=confirmation.quickReply!.items[0].action.data;
 assert.match(s.line.respond(button(cancel.replace(/:[^:]+$/,':forged')))[0].text,/権限/);
 s.line.respond(button(cancel));assert.equal(s.db.row("SELECT count(*) n FROM registrations WHERE status='cancelled'").n,1);assert.equal(s.db.row("SELECT count(*) n FROM registrations WHERE status='planned'").n,1);assert.match(s.line.respond(msg('参加QR'))[0].text,/\/ticket\/#/);
 const snapshot=cancellationSnapshot(s.db,admin);assert.equal(snapshot.registrations.length,1);assert.deepEqual(snapshot.registrations[0].claimHashes,[digest(b)]);assert.throws(()=>cancellationSnapshot(s.db,{...admin,role:'Staff'}),/forbidden/);
 const row=snapshot.registrations[0];s.db.restore(admin,row.eventId,row.participantId,'fixture restore',crypto.randomUUID());assert.equal(cancellationSnapshot(s.db,admin).registrations.length,0);assert.equal(s.db.outbox().length,0);
 }finally{s.db.close();}
});
test('same-title sessions include distinct dates in choices and confirmation',()=>{
 const s=fixture();try{const days=[1,2].map(n=>japanDate(new Date(Date.now()+n*86400000).toISOString()));for(const [i,d] of days.entries())s.line.respond(msg('参加QR '+accept(s,'day'+i,d)));const result=s.line.respond(msg('キャンセル'))[0];const labels=result.quickReply!.items.map((i:any)=>i.action.label);assert.notEqual(labels[0],labels[1]);assert.match(result.text,new RegExp(days[0].replaceAll('-','/')));assert.match(result.text,new RegExp(days[1].replaceAll('-','/')));const confirm=s.line.respond(button(result.quickReply!.items[0].action.data))[0];assert.match(confirm.text,new RegExp(days[0].replaceAll('-','/')));
 }finally{s.db.close();}
});
test('preimported reapplication still requires a choice and safely retires only the unused import on reuse',()=>{
 for(const reuse of [true,false]){const s=fixture();try{
  s.line.respond(msg('参加QR '+accept(s,'import-first')));const raw=accept(s,'import-second');
  const event=s.db.row('SELECT id FROM events');const id=crypto.randomUUID();
  s.db.run("INSERT INTO participants(id,name,source,external_id,created_at) VALUES(?,?,'analytics',?,?)",id,'Fixture Person','fixture-import',new Date().toISOString());
  s.db.run("INSERT INTO registrations VALUES(?,?,'planned')",event.id,id);s.db.run('UPDATE form_claims SET participant_id=? WHERE token_hash=?',id,digest(raw));
  const choice=s.line.respond(msg('参加QR '+raw))[0];assert.match(choice.text,/既存の申込/);
  assert.match(s.line.respond(msg('参加QR '+raw))[0].text,/既存の申込/);
  const decision=choice.quickReply!.items[reuse?0:choice.quickReply!.items.length-1].action.data;
  assert.match(s.line.respond(button(decision))[0].text,/\/ticket\/#/);assert.match(s.line.respond(button(decision))[0].text,/\/ticket\/#/);
  assert.equal(s.db.row("SELECT count(*) n FROM registrations WHERE status='planned'").n,reuse?1:2);
  assert.equal(s.db.row('SELECT count(*) n FROM participants').n,2);
  assert.equal(s.db.row('SELECT count(DISTINCT participant_id) n FROM form_claims').n,reuse?1:2);
 }finally{s.db.close();}}
});
