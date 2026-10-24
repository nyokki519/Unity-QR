export interface SqlDriver {
  prepare(sql: string): {
    get(...values: any[]): any;
    all(...values: any[]): any[];
    run(...values: any[]): any;
  };
  exec(sql: string): void;
  close(): void;
  transaction<T>(fn: () => T): T;
  getVersion(): number;
  setVersion(version: number): void;
}
