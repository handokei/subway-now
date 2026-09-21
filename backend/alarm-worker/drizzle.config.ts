import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit 설정 (#2783).
 *
 * `src/db/schema.ts`가 SSoT. `migrations/`는 0001~0007이 이미 **손으로** 작성돼 있고
 * `wrangler d1 migrations apply`(북키핑 테이블 `d1_migrations`)로 적용 이력을 추적한다.
 *
 * **알려진 갭 — `drizzle-kit generate` 미채택 (2026-09-21 결정)**: `drizzle-kit generate`는
 * 자체 journal(`migrations/meta/_journal.json` + snapshot)로 이전 스키마 상태를 추적해 diff를
 * 낸다. 이 journal이 없는 채로 `generate`를 실행하면 "처음부터"로 간주해 `CREATE TABLE
 * trip_metrics ...` 전체를 새 마이그레이션(0000)으로 뱉는다 — 이미 존재하는 프로덕션 테이블에
 * 적용하면 충돌한다(요구사항 1 "스키마 재생성 금지" 정면 위반 위험). 기존 0001~0007을
 * 역산해 journal/snapshot을 안전하게 복원하는 것은 이 PR 스코프를 넘는 별도 검증 작업이라
 * 여기서 시도하지 않는다.
 *
 * 그래서 현재 절차는: 스키마 변경 시 `src/db/schema.ts`를 손으로 고치고, 대응하는
 * `migrations/NNNN_설명.sql`도 손으로 작성한다(0007이 그 예시) — `npm run db:migrate:local`/
 * `db:migrate:remote`(둘 다 `wrangler d1 migrations apply`를 `--config` 명시로 감싼다, #2698)로
 * 적용한다. `drizzle-kit generate` 자동화는 journal 부트스트랩이 별도로 검증된 뒤 후속 작업으로
 * 전환한다 — 이 config 파일은 그 전환 시점을 위해 미리 둔다(schema 경로만 사용).
 */
export default defineConfig({
  dialect: 'sqlite',
  driver: 'd1-http',
  schema: './src/db/schema.ts',
  out: './migrations',
});
