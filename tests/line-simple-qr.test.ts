import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {FormClaims,japanDate} from '../server/form-claims.js';
import {LineService} from '../server/line.js';
import {digest} from '../server/security.js';
import {createHmac} from 'node:crypto';
const actor:any={id:'fixture',role:'Admin',events:[]};
function setup(){const db=new Store(':memory:'),forms=new FormClaims(db);forms.configure({entry:'entry.123456',enabled:true});const service=new LineService(db,{origin:'https://qr.example',signingKey:'test-key'.repeat(8),lineChannelId:'1234567890'});return {db,forms,service};}
function msg(text:string,user='a'):any{return {type:'message',source:{type:'user',userId:'U'+user.repeat(32)},message:{type:'text',text}};}
test('signed webhook records unrelated messages as ignored without calling LINE',async()=>{
 const db=new Store(':memory:');try{
  const service=new LineService(db,{origin:'https://qr.example',signingKey:'test-key'.repeat(8),lineChannelId:'1234567890',lineChannelSecret:'fixture-secret',lineAccessToken:'fixture-not-real'});
  const events=['今日はありがとうございました。','遅れます','参加希望について質問です'].map((text,i)=>({...msg(text),webhookEventId:'silent-fixture-'+i,replyToken:'fixture-reply-token'}));
  const raw=Buffer.from(JSON.stringify({destination:'U'+'d'.repeat(32),events}));
  await service.webhook(raw,createHmac('sha256','fixture-secret').update(raw).digest('base64'),async()=>{throw Error('must not call LINE');});
  assert.equal(db.row("SELECT count(*) n FROM line_webhooks WHERE status='ignored'").n,events.length);
 }finally{db.close();}
});
test('unrelated messages remain silent even while a legacy name is pending',()=>{
 const s=setup();try{
 for(const pending of [false,true]){
  if(pending){
   s.forms.configure({entry:'entry.123456',enabled:false});
   const ev=s.db.createEvent(actor,{title:'名前入力テスト',venue:'Test',capacity:10,startsAt:new Date().toISOString(),opensAt:new Date(Date.now()-60000).toISOString(),closesAt:new Date(Date.now()+3600000).toISOString()},crypto.randomUUID());
   s.service.configure(actor,{eventId:ev.id,enabled:true,opensAt:ev.opensAt,closesAt:ev.closesAt},crypto.randomUUID());
   assert.match(s.service.respond(msg('参加希望'))[0].text,/お名前/);
  }
  for(const text of ['今日はありがとうございました。','10分ほど遅れます','参加希望について相談です','参加QR 教えてください','こんにちは','名前ではない連絡','a'.repeat(501)])assert.deepEqual(s.service.respond(msg(text)),[]);
  assert.deepEqual(s.service.respond({...msg(''),message:{type:'sticker',stickerId:'1'}}),[]);
  assert.equal(s.db.row('SELECT count(*) n FROM participants').n,0);
 }
 assert.match(s.service.respond(msg('参加QR'))[0].text,/紐づけ/);
 }finally{s.db.close();}
});
function claim(s:ReturnType<typeof setup>,title:string,n:string){const day=japanDate(new Date().toISOString()),raw=digest('code'+n);s.forms.accept({claimHash:digest(raw),receiptHash:digest('receipt'+n),eventId:'sheet-event:'+digest(JSON.stringify([day,title.toLowerCase()])),eventDate:day,eventName:title,name:'Fixture '+n});assert.match(s.service.respond(msg('参加QR '+raw))[0].text,/\/ticket\/#/);return s.db.events(actor).find(e=>e.title===title)!;}
test('both short commands reissue the single owned QR without registering another event',()=>{
 const s=setup();try{claim(s,'テスト受付','one');const extra=s.db.createEvent(actor,{title:'Unrelated',venue:'Test',capacity:10,startsAt:new Date().toISOString(),opensAt:new Date().toISOString(),closesAt:new Date(Date.now()+3600000).toISOString()},crypto.randomUUID());s.service.configure(actor,{eventId:extra.id,enabled:true,opensAt:new Date(Date.now()-60000).toISOString(),closesAt:extra.closesAt},crypto.randomUUID());
 for(const command of ['参加QR','参加希望']){const message=s.service.respond(msg(command))[0];assert.match(message.text,/テスト受付/);assert.match(message.text,/\/ticket\/#/);assert(!message.quickReply);}
 assert.equal(s.db.row('SELECT count(*) n FROM registrations').n,1);
 }finally{s.db.close();}
});
test('multiple owned applications offer ticket choices for both keywords',()=>{
 const s=setup();try{claim(s,'テスト受付','one');claim(s,'ボードゲーム','two');for(const command of ['参加QR','参加希望']){const reply=s.service.respond(msg(command))[0];assert.equal(reply.quickReply?.items.length,2);assert(reply.quickReply.items.every((i:any)=>i.action.data.startsWith('ticket:')));const item=reply.quickReply.items[0];assert.match(s.service.respond({type:'postback',source:msg('').source,postback:{data:item.action.data}})[0].text,/\/ticket\/#/);}
 assert.equal(s.db.row('SELECT count(*) n FROM registrations').n,2);
 }finally{s.db.close();}
});
test('unlinked users receive code instructions for both commands, not someone else QR',()=>{
 const s=setup();try{claim(s,'テスト受付','one');for(const command of ['参加QR','参加希望']){const text=s.service.respond(msg(command,'b'))[0].text;assert.match(text,/申込完了画面/);assert(!text.includes('/ticket/#'));}assert.equal(s.db.row('SELECT count(*) n FROM participants').n,1);}finally{s.db.close();}
});
test('cancelled owned application is never silently reactivated by short commands',()=>{
 const s=setup();try{const event=claim(s,'テスト受付','one');s.db.run("UPDATE registrations SET status='cancelled' WHERE event_id=?",event.id);for(const command of ['参加QR','参加希望'])assert(!s.service.respond(msg(command))[0].text.includes('/ticket/#'));assert.equal(s.db.row('SELECT status FROM registrations').status,'cancelled');}finally{s.db.close();}
});
test('short participation request does not reactivate a cancelled legacy LINE registration',()=>{
 const s=setup();try{s.forms.configure({entry:'entry.123456',enabled:false});const ev=s.db.createEvent(actor,{title:'Legacy event',venue:'Test',capacity:10,startsAt:new Date().toISOString(),opensAt:new Date(Date.now()-60000).toISOString(),closesAt:new Date(Date.now()+3600000).toISOString()},crypto.randomUUID());s.service.configure(actor,{eventId:ev.id,enabled:true,opensAt:new Date(Date.now()-60000).toISOString(),closesAt:ev.closesAt},crypto.randomUUID());
 assert.match(s.service.respond(msg('参加希望'),'Legacy fixture')[0].text,/\/ticket\/#/);s.db.run("UPDATE registrations SET status='cancelled' WHERE event_id=?",ev.id);
 const reply=s.service.respond(msg('参加希望'))[0].text;assert.match(reply,/キャンセル済み/);assert(!reply.includes('/ticket/#'));assert.equal(s.db.row('SELECT status FROM registrations').status,'cancelled');
 }finally{s.db.close();}
});
