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

/**
 * #920 — 깊이(m) → 압력 변화(hPa) 환산 상수.
 *
 * 단위: hPa / m.
 *
 * 표준 대기 모델(ISA, 해수면 부근)에서 고도 1m 하강 시 약 0.12 hPa 상승한다.
 * `avgPressure_hPa = surfacePressure + (depth_m × DEPTH_TO_PRESSURE_HPA_PER_M)`.
 *
 * 데이터 파일에 absolute pressure가 명시되지 않은 역은 이 상수로 추정한다
 * (CLAUDE.md §3 데이터 주도 — 새 역 추가 시 코드 수정 없이 깊이만 채우면 됨).
 */
export const DEPTH_TO_PRESSURE_HPA_PER_M = 0.12;

/**
 * #920 — F3 절대값 narrow에 사용하는 압력 일치 tolerance.
 *
 * 단위: hPa.
 *
 * 근거:
 *   - 일별 기압 변동(고/저기압) ±5 hPa 수준 → 단일 기준치로는 매칭 불가.
 *     본 PR에서는 surfacePressure를 외부에서 주입받는 형태로 일반화하여 변동을 흡수.
 *   - 센서 정밀도 ≈ 0.1 hPa, 깊이 ±5m(약 0.6 hPa) 오차 고려해 1.0 hPa 허용.
 *   - 깊이 차이 약 8m 이내 역은 후보로 같이 잡힘 → ±2역 narrow 목표에 부합.
 */
export const BAROMETER_ABS_TOLERANCE_HPA = 1.0;

/**
 * #921 — "기압계 정차" 신호 임계 — 30s 윈도우에서 |dP|가 이 값 이하면 stop=true.
 *
 * 단위: hPa.
 *
 * 근거:
 *   - 지하철이 정차하면 깊이 변화 없음 → 압력 변화도 작음.
 *   - 센서 정밀도(약 0.1 hPa)와 자연 기상 변동(분 단위 ±0.01) 사이에서 0.05 hPa 선택.
 *   - subsurface 임계(0.3 hPa)와 직교적 — 한쪽은 "큰 변화"(이동/진입), 본 임계는 "작은 변화"(정차).
 *   - 둘 다 false인 중간 영역(0.05 < |dP| < 0.3)은 ambient/지상 보행 — 정차 신호로 부적합.
 *
 * 신호 의미 (B1 fusion 'barometer-stop'):
 *   - 정차 패턴 = readings가 30s 윈도우를 채울 만큼 있고 |dP| < 임계.
 *   - readings 부족(<30s) → null (unavailable, fusion 입력 미제공).
 */
export const BAROMETER_STOP_DP_THRESHOLD_HPA = 0.05;

/**
 * #903 — subsurface verdict의 hysteresis 확인 샘플 수.
 *
 * 임계(0.3hPa) 부근에서 센서 noise로 verdict가 1Hz 토글되면 useBarometer가 setSubsurface을
 * 매초 반전해 상위 hook re-render 폭주(useApnsTripRegistration register effect, alarmBackend
 * dedup hash churn)를 일으킨다. N회 연속 동일 verdict를 확인한 후에만 state를 flip해 진동을
 * 흡수. 3회 × 1초 = 3초 grace는 지하 진입 응답성과 false toggle 차단의 균형.
 */
export const BAROMETER_SUBSURFACE_CONFIRM_SAMPLES = 3;
