import type {ReceptionStore} from './store-core.js';
// Operator-controlled deployment setting, never accepted from a public request.
export function resetLoginLimitOnce(db:ReceptionStore,revision:string|undefined){
 if(!revision||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(revision))return false;
 db.sql.exec('CREATE TABLE IF NOT EXISTS _qr_login_reset(revision TEXT PRIMARY KEY,completed_at INTEGER NOT NULL)');
 return db.sql.transaction(()=>{
  if(db.row('SELECT revision FROM _qr_login_reset WHERE revision=?',revision))return false;
  db.run('DELETE FROM _qr_login_attempts');
  db.run('INSERT INTO _qr_login_reset(revision,completed_at) VALUES(?,?)',revision,Date.now());
  return true;
 });
}
