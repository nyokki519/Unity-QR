// Local copies only. Never opens a network connection or constructs/migrates Store.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {checkPassword} from '../server/security.js';
import {hiddenInput} from './cloud-auth.js';
const names=['users','participants','events','attendance'] as const;
function flags(rows:Record<string,unknown>[],password?:string){
 const matches=rows.filter(r=>r.username==='operator'),row=matches.length===1?matches[0]:undefined;
 const valid=typeof row?.password_hash==='string'&&/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(row.password_hash);
 return {password_matches:password===undefined?undefined:valid?checkPassword(password,row!.password_hash as string):null,exists:matches.length>0,matching_rows:matches.length,enabled:row?.enabled===1,is_admin:row?.role==='Admin',password_hash_valid:typeof row?.password_hash==='string'&&/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(row.password_hash)};
}
export function diagnoseOperator(mode:'--sqlite'|'--snapshot',path:string,options:{password?:string}={}){
 if(!statSync(path).isFile())throw Error('invalid_source');
 if(mode==='--snapshot'){
  if(statSync(path).size>5*1024*1024)throw Error('invalid_source');
  const data=JSON.parse(readFileSync(path,'utf8'));
  if(data?.application!=='unity-qr'||data.version!==1||![2,3,4].includes(data.schemaVersion)||!data.tables||names.some(name=>!Array.isArray(data.tables[name])))throw Error('invalid_source');
  if(data.tables.users.some((r:unknown)=>!r||typeof r!=='object'||Array.isArray(r)))throw Error('invalid_source');
  return {ok:true,source:'existing_snapshot',live_production_verified:false,integrity_ok:null,counts:Object.fromEntries(names.map(name=>[name,data.tables[name].length])),operator:flags(data.tables.users,options.password)};
 }
 if(mode!=='--sqlite')throw Error('invalid_source');
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  db.exec('PRAGMA query_only=ON');
  const local=db.prepare('PRAGMA application_id').get()?.application_id===0x55515232;
  const hasMarker=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_unity_qr_meta'").get());
  const durable=hasMarker&&db.prepare("SELECT value FROM _unity_qr_meta WHERE key='application'").get()?.value==='unity-qr';
  if(!local&&!durable)throw Error('invalid_source');
  const integrity=db.prepare('PRAGMA quick_check').all();
  const integrity_ok=integrity.length===1&&integrity[0].quick_check==='ok'&&db.prepare('PRAGMA foreign_key_check').all().length===0;
  const rows=db.prepare("SELECT username,enabled,role,password_hash FROM users WHERE username='operator'").all();
  const counts=Object.fromEntries(names.map(name=>[name,db.prepare('SELECT COUNT(*) n FROM '+name).get()?.n]));
  return {ok:true,source:'existing_sqlite_copy',live_production_verified:false,integrity_ok,counts,operator:flags(rows,options.password)};
 }finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const [mode,path,...extra]=process.argv.slice(2);
  if(!['--sqlite','--snapshot'].includes(mode)||!path||(extra.length>0&&(extra.length!==1||extra[0]!=='--check-password')))throw Error('invalid_arguments');
  const password=extra[0]==='--check-password'?await hiddenInput('既存のパスワード（ローカル照合のみ・非表示）'):undefined;
  console.log(JSON.stringify(diagnoseOperator(mode as '--sqlite'|'--snapshot',path,{password})));
 }catch{
  console.error(JSON.stringify({ok:false,error:'operator_audit_unavailable'}));process.exitCode=1;
 }
}
