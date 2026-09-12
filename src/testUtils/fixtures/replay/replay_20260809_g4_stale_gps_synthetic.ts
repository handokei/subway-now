/**
 * #2241 (Epic #1927 G4 Phase 0, ADR-030 §Replay harness backbone P0-2a) —
 * **합성(synthetic) mechanism-demo fixture**. `replay_20260809_g4_env_lock.ts`(실기기 evidence)와
 * 달리 이 파일은 **실측이 아니다** — 명시적으로 그렇게 표기한다(CLAUDE.md 정직 제약).
 *
 * ## 왜 합성인가
 * 불변식 3("지하 5분+ stale GPS fix 채택 금지")은 GPS **수신** 타임스탬프(`fix=`)가 있어야
 * 검증 가능하다. 이 필드는 #2241 P0-1에서 신설됐다 — 이전에 수집된 모든 실기기 dump(오늘
 * 포함)는 `fix=` 토큰이 없다. 따라서 "실기기에서 stale GPS가 채택됐다"를 오늘 시점에 red로
 * 증명할 실측 evidence가 아직 없다(P0-1 배포 후 다음 trip부터 수집 가능 — PR 본문 "field data
 * 필요" 항목 참고).
 *
 * 이 fixture는 **replay 드라이버의 불변식 3 계산 로직 자체가 의도대로 동작**함을 보이는
 * mechanism-demo다 — 실기기 dump가 이 패턴(같은 `fixAtMs`가 5분 넘게 재사용)을 보이면
 * `findStaleGpsUndergroundViolations`가 정확히 잡아낸다는 것을 증명한다. 다음 실기기 dump가
 * 수집되면 이 fixture는 실측 red/green fixture로 교체·승격된다(#2239 §P3 ratchet 파이프라인).
 *
 * 지하 역(7-015 용마산, stations.json environment='underground') 3 cycle. 05:00:00 fix가
 * 05:06:00 cycle까지(6분, 임계 5분 초과) 그대로 재사용된다.
 */
export const SYNTHETIC_STALE_GPS_UNDERGROUND_DUMP_TEXT = `## Raw Signal (3)
05:06:00 | cycle | 7-015 | gps/gps-only | gps(20m/-) | - | sub=false | arvlCd=- | arc=- | cell=-/unknown | hpa=1005.3 | fix=05:00:00
05:03:00 | cycle | 7-015 | gps/gps-only | gps(20m/-) | - | sub=false | arvlCd=- | arc=- | cell=-/unknown | hpa=1005.3 | fix=05:00:00
05:00:00 | cycle | 7-015 | gps/gps-only | gps(20m/-) | - | sub=false | arvlCd=- | arc=- | cell=-/unknown | hpa=1005.3 | fix=05:00:00
`;
