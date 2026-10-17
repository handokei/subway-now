/**
 * `trip_metrics` D1 엔티티 — Drizzle ORM (#2783).
 *
 * 배경
 * ====
 * D1 스키마(`migrations/*.sql`) · INSERT문(`d1TripMetrics.ts`) · TS 타입(`types.ts` 주석)이
 * 서로 모르는 채 손으로 3중 관리되어 왔다. 그 결과 `0001_initial.sql`이 만든 15개 데이터
 * 컬럼 중 2개(`silent_push_received`, `environment_distribution`)가 INSERT 목록에서 누락된
 * 채 #1835부터 한 번도 채워지지 않았다 — `DEFAULT` 값이 있어 타입/런타임 에러 없이 조용히
 * 항상 0/NULL로 남았다.
 *
 * 이 파일이 SSoT다. write 경로(`d1TripMetrics.ts`)는 반드시 이 엔티티를 거친다 — 컬럼을
 * 빠뜨리면 `TripMetricsInsertRow`(아래) 타입이 컴파일 에러로 드러낸다.
 *
 * 스코프 (#2783 — 결함1=PR1)
 * ==========================
 * `trip_metrics` 하나만 다룬다. `trip_events` / `push_failures` / `backend_errors`는 후속 PR.
 *
 * 컬럼 목록 — introspect 결과 대비 변경 (요구사항 3)
 * ===============================================
 * 원본 프로덕션 스키마(`0001_initial.sql`, 90행 실데이터, 2026-09-21 introspect 확인)는
 * 아래 2개 컬럼을 추가로 갖고 있었다. 둘 다 "채울 소스가 실제로 없음"이 확인되어
 * `migrations/0007_trip_metrics_drop_unfilled_columns.sql`로 제거한다 — 근거는 PR 본문 및
 * 해당 마이그레이션 파일 주석.
 *   - `silent_push_received` — 후보 소스(`baselineCheck.ts`의 KV `received:` prefix 집계)는
 *     trip 단위가 아니라 **전역 1h 윈도우** 집계이고, stamp 자체(`pendingPushes.ts:stampReceived`)가
 *     `tripToken`을 기록하지 않아 trip 창으로 좁힐 방법이 없다. write 경로(`stampReceived`)를
 *     바꾸는 것은 `#2784`(push 단일 관문)와 파일이 겹치는 별도 스코프.
 *   - `environment_distribution` — 유일한 후보 소스(`cellularEnvironmentVote`, positionSeries
 *     KV sample)는 최근 60s~30point ring buffer일 뿐 trip 전체 기간을 누적하지 않는다(#2765
 *     감사로 게이트 consumer도 이미 0건 확정). trip 단위 분포를 만들려면 새 누적 인프라가
 *     필요 — "동작 변경 금지"(신규 파이프라인 추가 아님) 범위를 벗어난다.
 *
 * `suppressed_count`는 반대로 소스가 이미 있다(`trip_events` kind='cron-fire-attempt',
 * outcome='skipped-reason') — `fired_count`(`countSentFireAttempts`, outcome='sent')와
 * 동일 패턴으로 채운다(`d1TripMetrics.ts`).
 */

import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const tripMetrics = sqliteTable('trip_metrics', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tripTokenHash: text('trip_token_hash').notNull(),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  endReason: text('end_reason'),
  originStation: text('origin_station'),
  destinationStation: text('destination_station'),
  lineList: text('line_list'),
  firedCount: integer('fired_count').notNull().default(0),
  suppressedCount: integer('suppressed_count').notNull().default(0),
  boardingPromptDisplayed: integer('boarding_prompt_displayed').notNull().default(0),
  boardingPromptResponded: integer('boarding_prompt_responded').notNull().default(0),
  lockAttached: integer('lock_attached').notNull().default(0),
  chainComplete: integer('chain_complete').notNull().default(0),
});

/**
 * `id`(auto-increment)를 제외한 모든 데이터 컬럼을 **명시적으로 필수**로 만드는 insert 타입.
 *
 * `$inferInsert`만 쓰면 `.default(0)`/nullable 컬럼이 전부 optional로 추론돼 "빠뜨려도 컴파일
 * 통과"가 재발한다(이 이슈의 원 결함과 동일한 함정) — `Required<Omit<...>>`로 감싸 SQL
 * DEFAULT와 무관하게 매 INSERT가 모든 컬럼 값을 의도적으로 명시하도록 강제한다.
 */
export type TripMetricsInsertRow = Required<Omit<typeof tripMetrics.$inferInsert, 'id'>>;
