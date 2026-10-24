import {timingSafeEqual} from 'node:crypto';
import {digest} from './security.js';
type ResetStorage={sql:{exec(query:string,...values:any[]):{toArray():Record<string,any>[];rowsWritten:number}},transactionSync<T>(fn:()=>T):T};
// Deployment-owner capability only; never a public account-recovery or password-guessing API.
export function handleOperatorPasswordReset(request:Request,storage:ResetStorage,token?:string,expiresAt?:string,encodedPlan?:string):Response{
 const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
 const now=Date.now(),until=Number(expiresAt);
 if(!encodedPlan||!token||!/^[a-f0-9]{64}$/.test(token)||!Number.isSafeInteger(until)||until<=now||until>now+900000)return json({error:'not_found'},404);
 const supplied=request.headers.get('authorization')??'';
 if(supplied.length>512||!timingSafeEqual(Buffer.from(digest(supplied)),Buffer.from(digest('Bearer '+token))))return json({error:'unauthorized'},401);
 const url=new URL(request.url);
 if(request.headers.get('origin')!==url.origin)return json({error:'forbidden'},403);
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 if(url.pathname!=='/api/v2/maintenance/reset-operator')return json({error:'not_found'},404);
 try{
  if(encodedPlan.length>2048)throw Error('invalid_plan');
  const plan=JSON.parse(encodedPlan),format=/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/;
  if(typeof plan?.userId!=='string'||!plan.userId||plan.userId.length>128||typeof plan.expectedHash!=='string'||typeof plan.newHash!=='string'||!format.test(plan.expectedHash)||!format.test(plan.newHash)||plan.newHash===plan.expectedHash)throw Error('invalid_plan');
  const result=storage.transactionSync(()=>{
   if(storage.sql.exec("SELECT value FROM _unity_qr_meta WHERE key='application'").toArray()[0]?.value!=='unity-qr')throw Error('foreign_database');
   const rows=storage.sql.exec("SELECT id,enabled,role,password_hash FROM users WHERE username='operator'").toArray();
   if(rows.length!==1||rows[0].id!==plan.userId||rows[0].enabled!==1||rows[0].role!=='Admin')throw Error('account_changed');
   if(rows[0].password_hash===plan.newHash)return {ok:true,changed:false};
   if(rows[0].password_hash!==plan.expectedHash)throw Error('account_changed');
   const update=storage.sql.exec("UPDATE users SET password_hash=? WHERE id=? AND username='operator' AND password_hash=? AND enabled=1 AND role='Admin'",plan.newHash,plan.userId,plan.expectedHash);update.toArray();
   if(update.rowsWritten!==1)throw Error('unexpected_update_count');
   storage.sql.exec('DELETE FROM sessions WHERE user_id=?',plan.userId).toArray();
   return {ok:true,changed:true};
  });
  return json(result);
 }catch{return json({error:'operator_reset_not_applied'},409);}
}
