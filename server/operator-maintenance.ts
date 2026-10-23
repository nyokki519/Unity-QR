import {timingSafeEqual} from 'node:crypto';
import {digest} from './security.js';
import type {ReceptionStore} from './store-core.js';
import {exportSnapshot} from './migration.js';
// Optional, short-lived deployment credential for the Cloudflare account owner.
// No user/password edits and no session/authentication bypass for normal routes.
export function handleOperatorMaintenance(request:Request,db:ReceptionStore,token:string|undefined,expiresAt?:string,now=Date.now()):Response{
 const json=(value:unknown,status=200,extra:Record<string,string>={})=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...extra}});
 const deadline=Number(expiresAt);
 if(!Number.isSafeInteger(deadline)||deadline<=now||deadline>now+900000)return json({error:'not_found'},404);
 if(!token||!/^[a-f0-9]{64}$/.test(token))return json({error:'not_found'},404);
 const supplied=request.headers.get('authorization')??'';
 if(supplied.length>512||!timingSafeEqual(Buffer.from(digest(supplied)),Buffer.from(digest('Bearer '+token))))return json({error:'unauthorized'},401);
 const url=new URL(request.url);
 if(request.headers.has('Origin')&&request.headers.get('Origin')!==url.origin)return json({error:'forbidden'},403);
 if(request.method!=='GET')return json({error:'method_not_allowed'},405);
 if(url.pathname==='/api/v2/maintenance/login-state'){
  const row=db.row("SELECT enabled,role,password_hash FROM users WHERE username='operator'");
  return json({account_exists:Boolean(row),account_enabled:row?.enabled===1,account_is_admin:row?.role==='Admin',password_hash_valid:typeof row?.password_hash==='string'&&/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(row.password_hash)});
 }
 if(url.pathname==='/api/v2/maintenance/backup')return json(exportSnapshot(db),200,{'Content-Disposition':'attachment; filename="unity-qr-backup.json"'});
 return json({error:'not_found'},404);
}
