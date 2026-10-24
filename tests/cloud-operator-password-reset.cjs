const test=require('node:test'),assert=require('node:assert/strict');const {Miniflare,convertV4MiniflareOptions}=require('miniflare');const {mkdtempSync,rmSync}=require('node:fs');const {join,resolve}=require('node:path');const {tmpdir}=require('node:os');const {randomUUID}=require('node:crypto');
test('real workerd reset preserves reception data, rejects stale plan and keeps other admin sessions',async()=>{
 const {Store}=await import('../dist/server/store.js'),{exportSnapshot}=await import('../dist/server/migration.js'),{hashPassword}=await import('../dist/server/security.js');
 const dir=mkdtempSync(join(tmpdir(),'qr-reset-')),origin='https://qr.example',token='a'.repeat(64),oldPassword='fixture-old-password-123',newPassword='fixture-new-password-456',oldHash=hashPassword(oldPassword),newHash=hashPassword(newPassword);let mf;const db=new Store(':memory:');
 let snapshot,plan;
 try{const id=db.addUser('operator',oldHash,'Admin'),actor={id,role:'Admin',events:[]};db.addUser('other-admin',hashPassword(oldPassword),'Admin');const event=db.createEvent(actor,{title:'Fixture',venue:'Test',capacity:10,startsAt:new Date().toISOString(),opensAt:new Date(Date.now()-60000).toISOString(),closesAt:new Date(Date.now()+600000).toISOString()},randomUUID());const person=db.register(actor,event.id,{name:'Fixture participant'},randomUUID());db.checkin(actor,event.id,person.id,randomUUID(),'qr');snapshot=JSON.parse(JSON.stringify(exportSnapshot(db)));plan={userId:id,expectedHash:oldHash,newHash};}finally{db.close();}
 const start=reset=>new Miniflare(convertV4MiniflareOptions({name:'qr-reset',modules:true,scriptPath:resolve('dist/cloudflare-worker/worker.js'),compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],bindings:{QR_SIGNING_KEY:'fixture-signing-key-'.repeat(3),QR_SETUP_TOKEN:token,...(reset?{QR_MAINTENANCE_TOKEN:token,QR_MAINTENANCE_EXPIRES_AT:String(Date.now()+600000),QR_OPERATOR_RESET_PLAN:JSON.stringify(plan)}:{})},durableObjects:{QR_DB:{className:'QRReception',useSQLite:true}},resourcePersistencePath:dir,telemetry:{enabled:false}}));
 const call=(path,method='GET',body,headers={})=>mf.dispatchFetch(origin+'/api/v2/'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 try{
 mf=start(false);assert.equal((await call('setup','POST',snapshot,{Authorization:'Bearer '+token})).status,200);
 const login=async(username,password)=>{const r=await call('login','POST',{username,password});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
 const oldCookie=await login('operator',oldPassword),otherCookie=await login('other-admin',oldPassword);await mf.dispose();mf=start(true);
 assert.equal((await call('maintenance/reset-operator','POST',{}, {Authorization:'Bearer wrong'})).status,401);
 assert.deepEqual(await (await call('maintenance/reset-operator','POST',{}, {Authorization:'Bearer '+token})).json(),{ok:true,changed:true});
 const backup=await (await call('maintenance/backup','GET',undefined,{Authorization:'Bearer '+token})).json();
 for(const table of Object.keys(snapshot.tables)){const expected=snapshot.tables[table].map(r=>table==='users'&&r.username==='operator'?{...r,password_hash:newHash}:r);assert.deepEqual(backup.tables[table],expected);}
 assert.equal((await call('session','GET',undefined,{Cookie:oldCookie})).status,401);
 assert.equal((await call('session','GET',undefined,{Cookie:otherCookie})).status,200);
 const newCookie=await login('operator',newPassword);
 assert.deepEqual(await (await call('maintenance/reset-operator','POST',{}, {Authorization:'Bearer '+token})).json(),{ok:true,changed:false});
 assert.equal((await call('session','GET',undefined,{Cookie:newCookie})).status,200);
 assert.equal((await call('login','POST',{username:'operator',password:oldPassword})).status,401);
 await mf.dispose();mf=start(false);assert.equal((await call('maintenance/reset-operator','POST',{})).status,404);assert.equal((await call('session','GET',undefined,{Cookie:newCookie})).status,200);
 }finally{await mf?.dispose();rmSync(dir,{recursive:true,force:true});}
});
