/**
 * #2241 (Epic #1927 G4 Phase 0, ADR-030 §Replay harness backbone P0-2b) —
 * **positive fixture (stub)**. 명시적으로 합성(synthetic) — 실기기 evidence가 아니다(CLAUDE.md
 * 정직 제약). 지상 dead-zone(loose 게이트가 옳았던 케이스)의 골격만 제공한다.
 *
 * 목적: Phase 1(A+C, `inferEnvironment`/`pickFusionTier`를 지하 안전측으로 strict 강등)이
 * 적용됐을 때 **지상 dead-zone에서 miss가 늘어나지 않는지**를 이 harness로 계측하기 위한
 * 자리 — ADR-030 §트레이드오프("Phase 1-C가 지상 dead-zone에서 miss 소폭 증가 가능")의 측정
 * 대상. 지금은 현재(Phase 0) 코드가 이 케이스에서 이미 green임을 보장하는 회귀 가드로만
 * 쓰인다. 실기기 지상 dead-zone dump가 수집되면 이 fixture를 실측으로 교체한다.
 *
 * 지상 역(1-020 광운대 — stations.json environment='surface') 3 cycle, 같은 역에 정차 중인
 * dead-zone 시나리오 — station이 바뀌지 않아 off-route jump 불변식과는 무관하게 순수히
 * env 판정만 검증한다. barometer subsurface=false(raw 신뢰) 유지 — `inferEnvironment`
 * 우선순위 4 그대로 'surface' 채택돼야 한다(현재 코드에서 green).
 */
export const SYNTHETIC_SURFACE_DEADZONE_POSITIVE_DUMP_TEXT = `## Raw Signal (3)
09:12:20 | cycle | 1-020 | gps/gps-only | gps(15m/-) | - | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak | hpa=1013.1 | fix=09:12:20
09:12:00 | cycle | 1-020 | gps/gps-only | gps(15m/-) | - | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak | hpa=1013.1 | fix=09:12:00
09:11:40 | cycle | 1-020 | gps/gps-only | gps(15m/-) | - | sub=false | arvlCd=- | arc=- | cell=LTE/surface-weak | hpa=1013.1 | fix=09:11:40
`;
