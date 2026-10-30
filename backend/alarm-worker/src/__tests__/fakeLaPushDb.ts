/** #2747 PR-2 테스트 공용 — trip_events INSERT/SELECT(`la-push` 직전 행)만 흉내내는 in-memory D1. */
export interface FakeEventRow {
  id: number;
  tokenHash: string;
  ts: number;
  kind: string;
  station: string | null;
  line: string | null;
  meta: string | null;
}

export function makeFakeLaPushDb(opts: { failSelect?: boolean } = {}) {
  const rows: FakeEventRow[] = [];
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              const [tokenHash, ts, kind, station, line, meta] = args as [string, number, string, string | null, string | null, string | null];
              rows.push({ id: rows.length + 1, tokenHash, ts, kind, station, line, meta });
              return { success: true };
            },
            async first() {
              if (opts.failSelect) throw new Error('select boom');
              const [tokenHash] = args as [string];
              const last = rows.filter((r) => r.tokenHash === tokenHash && r.kind === 'la-push').pop();
              return last ? { meta: last.meta } : null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, rows, statements, laPushRows: () => rows.filter((r) => r.kind === 'la-push') };
}
