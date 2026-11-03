declare module "sql.js" {
  export type SqlValue = string | number | Uint8Array | null;

  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }

  export interface Statement {
    step(): boolean;
    get(): SqlValue[];
    getColumnNames(): string[];
    getSQL(): string;
    free(): void;
  }

  export interface Database {
    run(sql: string, params?: ReadonlyArray<SqlValue>): Database;
    exec(sql: string): QueryExecResult[];
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
    iterateStatements(sql: string): Iterable<Statement>;
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database;
  }

  export interface SqlJsConfig {
    locateFile?: (file: string, prefix?: string) => string;
    wasmBinary?: ArrayBuffer | Uint8Array;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}

declare module "sql.js/dist/sql-wasm-browser.js" {
  export {
    type Database,
    type QueryExecResult,
    type SqlJsConfig,
    type SqlJsStatic,
    type SqlValue,
    type Statement,
    default,
  } from "sql.js";
}
