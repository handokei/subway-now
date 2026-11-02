/**
 * #2851 — 실제 SQLite(sql.js, WASM)로 구동하는 최소 D1 test double.
 *
 * `makeFireLogDb`(bind 인자만 가로채는 mock)는 SQL 의미를 실행하지 않아 "직전 행 outcome과 같으면
 * INSERT 생략" 같은 SQL 내부 조건을 검증할 수 없다. 이 double은 `migrations/0005_trip_events.sql`
 * DDL을 그대로 적용한 in-memory DB에서 prepare/bind/run/first/all을 실제 실행한다.
 * (node:sqlite는 CI Node 20에 없고 vite가 `node:` 접두사를 벗겨 로드 실패하므로 sql.js를 쓴다.)
 */
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type SqlValue } from 'sql.js';

export interface TripEventRow {
  id: number;
  token_hash: string;
  ts: number;
  kind: string;
  station: string | null;
  line: string | null;
  meta: string | null;
}

export async function makeSqliteD1(): Promise<{ db: D1Database; rows: () => TripEventRow[] }> {
  const SQL = await initSqlJs();
  const sqlite = new SQL.Database();
  const ddl = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'migrations', '0005_trip_events.sql'),
    'utf8',
  );
  sqlite.exec(ddl);

  function select(sql: string, params: SqlValue[]): Array<Record<string, SqlValue>> {
    const stmt = sqlite.prepare(sql);
    try {
      stmt.bind(params);
      const out: Array<Record<string, SqlValue>> = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  }

  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        const params = args as SqlValue[];
        return {
          run: async () => {
            sqlite.run(sql, params);
            return { success: true };
          },
          first: async () => select(sql, params)[0] ?? null,
          all: async () => ({ results: select(sql, params) }),
        };
      },
    }),
  } as unknown as D1Database;

  const rows = (): TripEventRow[] =>
    select('SELECT * FROM trip_events ORDER BY id', []) as unknown as TripEventRow[];
  return { db, rows };
}
