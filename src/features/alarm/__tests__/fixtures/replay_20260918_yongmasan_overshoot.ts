/**
 * #2726 (ADR-039 close 조건 2·3 device 층 판정) — 2026-09-18 용마산 목적지 통과 라이드 evidence.
 *
 * 출처: `/Users/kimdohan/.claude/uploads/bc21a6d1-c784-4304-8458-dadc97a894ef/ed3e62ef-918-2.txt`.
 *   - Raw Signal: `fix=17:40:13` 건대입구(7)에서 GPS가 7분+ 고정(acc=74m 불변, lat/lng은
 *     `ride20260918PositionSeries.ts`(#2718, 머지됨)가 옮긴 동일 실측값 재사용).
 *   - Fusion log(`src=`/`conf=`/`d=`/`acc=`/`pt=`/`fu=`/`rt=`/`gp=` 열):
 *     - 17:40:31~17:46:37 창: `src=boarding-lock`/`position`/`position-train`(전부 강 source,
 *       fusionSourceStrength.ts STRONG_FUSION_SOURCE) — trainCode=7256 lock이 채택됨.
 *     - 17:46:57~17:53:41 창: `src=gps conf=gps-only`(약 source)로 반전 — position-train 후보
 *       자체가 fusion log의 `pt=` 열에서 사라짐(후보 소실, 원인 미확인 — 미공급 입력).
 *   - Alarm suppression log(`fg-evaluated | suppressed | <reason> | <destination>`):
 *     - `gate-phase-time-integration | 용마산` 이 라이드 내내 반복 관측되나, 17:40:31~17:46:37
 *       창(강 source 구간)에는 그 경계값(17:40:31) 1건 외 **관측되지 않는다** — 강 source 구간과
 *       억제 부재가 정합.
 *     - 17:46:57 이후(약 source 구간)부터 17:53:41까지 매 tick 반복 관측 — 약 source 반전과
 *       정합.
 *   - Aggregate(dump L86): `gate-phase-time-integration=39, gate-accuracy=21,
 *     movement-static-position=4` — 라이드 전체 집계.
 *   - 실제 열차(7256) 궤적(R2 확인): 건대입구17:40:29 → 어린이대공원17:42:29 → 군자17:44:29 →
 *     중곡17:47:29 → **용마산17:49:29** → 사가정17:51:29.
 *
 * 역 좌표/id는 전부 `findStationByNameAndLine`(stations.json SSOT)로 조회한 실좌표를 그대로
 * 쓴다 — 좌표를 직접 지어내지 않는다(CLAUDE.md 정직 제약). GPS raw fix 좌표만 별도 상수
 * (`FROZEN_GPS_FIX`)로 분리 — 얼어붙은 사용자 위치는 역 좌표와 다르다(evidence 그대로).
 *
 * 본 fixture는 두 개의 서로 다른 관측 창을 그대로 나눠 재현한다 — 하나로 뭉뚱그리면 조건 3의
 * 실제 판정(강 source 구간=OK, 약 source 구간=FAIL)이 가려진다.
 */

export const TRAIN_CODE_7256 = '7256';

/** evidence 불변값 — GPS accuracy는 얼어붙은 fix 내내 74m로 고정(isAccuracyAcceptable(74)=true, MAX_ACCURACY_M=200m). */
export const FROZEN_GPS_ACCURACY_M = 74;

/**
 * `fix=17:40:13` 건대입구(7) 동결 지점 raw GPS 좌표 — `ride20260918PositionSeries.ts`
 * (#2718 머지, 덤프 Raw Signal 옮김)와 동일 실측값. 역 좌표(`findStationByNameAndLine`)와는
 * 별개 — GPS는 역 근처지만 정확히 일치하지 않는다(정상 GPS jitter, evidence 그대로).
 */
export const FROZEN_GPS_FIX = { lat: 37.540373, lng: 127.069191 } as const;

/** 17:40:31~17:46:37 창 — 강 source(boarding-lock/position/position-train) 구간 라벨. */
export const STRONG_SOURCE_WINDOW_LABEL =
  '17:40:31~17:46:37 (src=boarding-lock/position/position-train)';

/**
 * 17:46:57~17:53:41 창 — 약 source(`src=gps conf=gps-only`) 반전 구간 라벨. dump에서 `pt=` 열이
 * 사라진다(후보 소실) — 이 fixture는 그 반전 "결과"(fusionSource=gps)만 재생한다. 왜 후보가
 * 사라졌는지(position-train API 응답 자체가 이 구간에서 7256을 더 이상 반환하지 않았는지 등)는
 * 이 fixture가 공급하지 않는 입력이다 — PR 본문 §미공급 입력 표 참고.
 */
export const WEAK_SOURCE_WINDOW_LABEL = '17:46:57~17:53:41 (src=gps conf=gps-only)';
