import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { SqlDriver } from "../server/storage.js";
import { fail } from "../server/security.js";

export class DurableSqlDriver implements SqlDriver {
  constructor(private storage: DurableObjectStorage) {
    const tables = this.storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .toArray();
    if (
      tables.length &&
      !tables.some((table) => table.name === "_unity_qr_meta")
    )
      fail("foreign_database", 503);
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS _unity_qr_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
    const owner = this.prepare(
      "SELECT value FROM _unity_qr_meta WHERE key='application'",
    ).get();
    if (tables.length && (!owner || owner.value !== "unity-qr"))
      fail("foreign_database", 503);
    this.prepare(
      "INSERT OR IGNORE INTO _unity_qr_meta VALUES('application','unity-qr')",
    ).run();
  }
  prepare(sql: string) {
    return {
      get: (...values: any[]) =>
        this.storage.sql.exec(sql, ...values).toArray()[0],
      all: (...values: any[]) =>
        this.storage.sql.exec(sql, ...values).toArray(),
      run: (...values: any[]) => {
        const cursor = this.storage.sql.exec(sql, ...values);
        cursor.toArray();
        return { changes: cursor.rowsWritten };
      },
    };
  }
  exec(sql: string) {
    this.storage.sql.exec(sql).toArray();
  }
  close() {
    /* Cloudflare owns this database lifecycle. */
  }
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
  getVersion() {
    const version = Number(
      this.prepare("SELECT value FROM _unity_qr_meta WHERE key='version'").get()
        ?.value || 0,
    );
    if (!Number.isSafeInteger(version) || version < 0)
      fail("unsupported_schema", 503);
    return version;
  }
  setVersion(version: number) {
    this.prepare(
      "INSERT INTO _unity_qr_meta VALUES('version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(String(version));
  }
}
