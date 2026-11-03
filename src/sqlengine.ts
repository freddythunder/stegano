import initSqlJs, { type Database, type SqlValue, type Statement } from "sql.js/dist/sql-wasm-browser.js";
import wasmUrl from "sql.js/dist/sql-wasm-browser.wasm?url";

const SQL_SHOW = 200;

export type SqlResultSet = {
  columns: string[];
  values: SqlValue[][];
  total: number;
};

export type SqlRun = {
  ok: boolean;
  error: string;
  sets: SqlResultSet[];
  rowsModified: number;
  applied: number;
  bytes: Uint8Array;
};

export type MemoryDb = {
  name: string;
  run(sql: string): SqlRun;
  export(): Uint8Array;
  close(): void;
};

type SqlJs = Awaited<ReturnType<typeof initSqlJs>>;

let pending: Promise<SqlJs> | null = null;

function engine(): Promise<SqlJs> {
  if (!pending) {
    pending = initSqlJs({ locateFile: () => wasmUrl }).catch((error: unknown) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function copySqlValue(value: SqlValue): SqlValue {
  return value instanceof Uint8Array ? value.slice() : value;
}

function runStatements(db: Database, sql: string): SqlRun {
  const sets: SqlResultSet[] = [];
  let applied = 0;
  let current: Statement | null = null;
  try {
    for (current of db.iterateStatements(sql)) {
      const columns = current.getColumnNames();
      if (columns.length) {
        const values: SqlValue[][] = [];
        let total = 0;
        while (current.step()) {
          total += 1;
          if (values.length < SQL_SHOW) values.push(current.get().map(copySqlValue));
        }
        sets.push({ columns, values, total });
      } else {
        current.step();
      }
      current.free();
      current = null;
      applied += 1;
    }
    return {
      ok: true,
      error: "",
      sets,
      rowsModified: db.getRowsModified(),
      applied,
      bytes: copyBytes(db.export()),
    };
  } catch (error) {
    try {
      current?.free();
    } catch {
      /* statement already finalized */
    }
    const detail = error instanceof Error ? error.message : "SQL FAILED";
    let rowsModified = 0;
    try {
      rowsModified = db.getRowsModified();
    } catch {
      rowsModified = 0;
    }
    return {
      ok: false,
      error: detail,
      sets,
      rowsModified,
      applied,
      bytes: copyBytes(db.export()),
    };
  }
}

export async function openMemoryDb(name: string, bytes?: Uint8Array): Promise<MemoryDb> {
  const SQL = await engine();
  let db: Database;
  try {
    db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "OPEN FAILED";
    throw new Error(`SQLITE OPEN FAILED · ${detail}`);
  }
  const safe = name.replace(/[\r\n]/g, " ").trim() || "payload.sqlite";
  return {
    name: safe,
    run(sql: string) {
      return runStatements(db, sql);
    },
    export() {
      return copyBytes(db.export());
    },
    close() {
      db.close();
    },
  };
}
