/**
 * #875 — 기압계(Barometer) 보조 신호 상수.
 *
 * ADR-010 9단 게이트의 보조 신호로 사용 예정. 임계/윈도우는 spike 단계 제안값이며,
 * 실측(다양한 노선·기기·계절) 후 후속 sub-issue에서 튜닝한다. 변경 시 단위 테스트가
 * 깨지지 않도록 본 모듈 1곳에서만 수정한다 (CLAUDE.md 단일 출처 원칙).
 */

/**
 * 지하 진입 감지 임계 — 30초 동안 압력이 이 값 이상 상승하면 "지하 진입"으로 본다.
 *
 * 단위: hPa (hectopascals, ≈ mbar).
 *
 * 근거 (실측 후 튜닝):
 *   - 지상 → 깊이 10m 하강 시 약 1.2 hPa 상승 (대기 표준 모델, 9.81 m/s² × 1.225 kg/m³).
 *   - 서울 지하철 평균 진입 깊이 5~25m, 진입 소요 15~40s.
 *   - 0.3 hPa/30s = 약 2.5m/30s 하강 — 엘리베이터/계단 일반 보행은 임계 미달.
 *   - 빠른 엘리베이터(고층 빌딩)는 임계 초과 가능 → 시간 윈도우로 false positive 제한
 *     (탑승 prompt 시점 ±30s 안에서만 평가).
 */
export const BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA = 0.3;

/**
 * dP/dt 평가에 사용하는 시간 윈도우 — 최신 reading과 비교할 과거 reading의 최소 경과 시간.
 *
 * 단위: ms.
 *
 * 30s 이전 reading과 현재를 비교 → 일시적 spike (문 개폐, 터널 압력파)에 강건.
 */
export const BAROMETER_DPDT_WINDOW_MS = 30_000;

/**
 * Ring buffer 보관 기간 — 이 시간보다 오래된 reading은 자동 제거.
 *
 * 단위: ms.
 *
 * 60s는 dP/dt 평가 윈도우(30s)의 2배 — stale 검사 여유를 둔다. 동시에 메모리 부담도 작다
 * (1Hz 폴링 기준 최대 60 entry).
 */
export const BAROMETER_RING_BUFFER_TTL_MS = 60_000;

/**
 * 센서 폴링 주기 — Barometer.setUpdateInterval에 전달.
 *
 * 단위: ms.
 *
 * 1Hz로 충분 (지하 진입은 초 단위 이벤트, ms 단위 정밀도 불필요).
 * 더 높은 주기는 배터리 소모만 키운다.
 */
export const BAROMETER_SAMPLE_INTERVAL_MS = 1_000;
