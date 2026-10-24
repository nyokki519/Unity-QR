-- Run only against an existing, correctly identified QR SQLite copy or an
-- already-authorized read-only SQL connection. This is NOT a D1 database.
-- No passwords, hashes, names, IDs or tokens are returned.
PRAGMA query_only=ON;
SELECT COUNT(*) AS matching_rows,
       COUNT(*) > 0 AS account_exists,
       CASE WHEN COUNT(*)=1 THEN MAX(enabled=1) ELSE 0 END AS account_enabled,
       CASE WHEN COUNT(*)=1 THEN MAX(role='Admin') ELSE 0 END AS account_is_admin,
       CASE WHEN COUNT(*)=1 THEN MAX(
         typeof(password_hash)='text' AND length(password_hash)=168
         AND substr(password_hash,1,7)='scrypt$'
         AND substr(password_hash,40,1)='$'
         AND substr(password_hash,8,32) NOT GLOB '*[^0-9a-f]*'
         AND substr(password_hash,41,128) NOT GLOB '*[^0-9a-f]*'
       ) ELSE 0 END AS password_hash_valid
FROM users WHERE username='operator';
SELECT (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM participants) AS participants,
       (SELECT COUNT(*) FROM events) AS events,
       (SELECT COUNT(*) FROM attendance) AS attendance;
