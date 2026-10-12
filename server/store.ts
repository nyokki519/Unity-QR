import { DatabaseSync, backup } from "node:sqlite";
import { chmodSync } from "node:fs";
import { fail } from "./security.js";
import { ReceptionStore } from "./store-core.js";
import type { SqlDriver } from "./storage.js";
export type { Actor } from "./store-core.js";
class NodeDriver implements SqlDriver {
  native: DatabaseSync;
  constructor(path: string) {
    this.native = new DatabaseSync(path);
    try {
      const id = (this.native.prepare("PRAGMA application_id").get() as any)
        .application_id;
      const count = (
        this.native
          .prepare(
            "SELECT count(*) count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .get() as any
      ).count;
      if (id !== 0x55515232 && (count > 0 || id !== 0))
        fail("foreign_database", 503);
      if (this.getVersion() > 2) fail("unsupported_schema", 503);
      this.native.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
      );
    } catch (error) {
      this.native.close();
      throw error;
    }
  }
  prepare(sql: string) {
    return this.native.prepare(sql);
  }
  exec(sql: string) {
    this.native.exec(sql);
  }
  close() {
    this.native.close();
  }
  getVersion() {
    return (this.native.prepare("PRAGMA user_version").get() as any)
      .user_version as number;
  }
  setVersion(version: number) {
    this.native.exec(
      `PRAGMA application_id=${0x55515232}; PRAGMA user_version=${version};`,
    );
  }
  transaction<T>(fn: () => T): T {
    this.native.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.native.exec("COMMIT");
      return result;
    } catch (error) {
      this.native.exec("ROLLBACK");
      throw error;
    }
  }
}
export class Store extends ReceptionStore {
  constructor(path: string) {
    const driver = new NodeDriver(path);
    try {
      super(driver);
    } catch (error) {
      driver.close();
      throw error;
    }
  }
  async backup(path: string) {
    await backup((this.sql as NodeDriver).native, path);
    chmodSync(path, 0o600);
  }
}
