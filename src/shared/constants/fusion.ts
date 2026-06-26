/**
 * #1884 (ADR-015 RC-3) — Weighted vote fusion 신호별 가중치.
 *
 * 배경:
 *   `undergroundSSOTConsensus`가 기존 2-of-N quorum + station pair ≥ 1 게이트로 동작.
 *   T3 (2026-06-26 충정로→용마산) 회귀에서 lockless trip + 지하 환경에서 station pair가
 *   warmup 60s 이후 끊기면 `env-consensus-fail`로 26분 stuck 발생.
 *   사용자 결정 (https://github.com/handokei/subway-now/issues/1884#issuecomment-4806744470):
 *   Option A — 4신호(GPS / accel / cellular / time) 가중치 vote.
 *
 * 핵심 원칙:
 *   - **device self-contained** (`memory:feedback-device-self-contained-fusion`): backend
 *     push가 없어도 device가 자체 신호로 판정. 본 weight 표는 device 측 평가 기준.
 *   - **신호 1개 죽어도 진행**: 부재 신호는 weight 0 누적. 나머지 신호의 합이 임계를 넘으면
 *     accept. 기존 AND 게이트의 single-point-of-failure 제거.
 *   - **사용자 명시 의향 동급 보호** (`memory:feedback-user-intent-equal-protection`): lockless
 *     trip(사용자 의향 표명 X)도 동일 weight 적용. "정보용 trip이라 낮은 weight" 같은 분기 X.
 *   - **GPS-only 결정 금지** (`memory:feedback-no-gps-for-decision`): GPS 카테고리 가중치는
 *     지상 환경의 surfaceSSOT 경로에서만 의미가 있음. underground 경로에서는 GPS 자체가
 *     입력에서 reject되며, 본 표는 평가 카테고리 식별자 역할만 한다.
 *
 * 카테고리 — fusion paradigm taxonomy:
 *   - `positional` : station을 직접 가리키는 신호. GPS / position-train (track-1D) / wifi-ssid.
 *                    가장 강한 신호이므로 weight 최대. 단, 어떤 carrier(GPS vs position-train)가
 *                    들어와도 동일 카테고리로 합산 (paradigm).
 *   - `radio`      : cellular / wifi 환경 vote. station 정보는 없으나 환경(지상/지하) 확정으로
 *                    positional 신호의 noise 거름. 중간 weight.
 *   - `motion`     : accelerometer pattern (automotive / stationary). 환경 vote에 가까우나
 *                    "train 진행 중" 정보를 별도로 추가하므로 별 카테고리. 중간 weight.
 *   - `time`       : barometer-stop (정착 패턴) 등 시간/물리 신호. station은 못 가리키나 정착
 *                    상태 확정 vote. 최소 weight (false positive 빈도가 가장 높음).
 *
 * Weight 수치 근거 — 1.0 scale:
 *   - positional `1.0` : station을 직접 가리키는 유일한 카테고리. 단독 채택 가능 강도.
 *   - radio `0.5`      : 환경만 확정. positional과 합쳐야 의미. 단독 채택 임계 미달.
 *   - motion `0.4`     : radio보다 약간 약함. iOS BG에서 RMS window 60s warmup 필요(#1542).
 *   - time `0.3`       : 가장 약함. barometer dP/dt 정착은 false positive 빈도 ↑.
 *
 * 임계값 — `STATION_ACCEPT_THRESHOLD = 1.1` (기본 underground 환경):
 *   - positional 1.0 단독 만으로는 임계 미달 → reject (steady quorum=2와 동등 정책 유지).
 *   - radio 0.5 + motion 0.4 + time 0.3 = 1.2 합산 만으로는 station이 없으므로 reject
 *     (station 채택 후보 필요 — 기존 `stationPairs ≥ 1` 게이트와 동일 원칙).
 *   - positional 1.0 + radio 0.5 = 1.5 → strong accept (multi-source confirm).
 *   - positional 부분 0.6 (arrival 미매칭) + radio 0.5 = 1.1 → accept (T3 stuck 해소).
 *   - positional 부분 0.6 + time 0.3 = 0.9 → reject (단일 약 vote만으로는 부족).
 *   - positional 0(부재) + 나머지 합 = station 채택 불가 → reject.
 *
 * 임계값 — `STATION_ACCEPT_THRESHOLD_SURFACE_WEAK = 1.6` (D+A hybrid, #1876 cross-impact):
 *   - `cellularEnvironmentVote === 'surface-weak'` (LTE/NRNSA 지상 가능성)에서 강한 신호
 *     조합만 station 채택. #1876 primary path `envVotes −1` 보수 처리 의도를 weighted vote
 *     fallback에서도 보존.
 *   - positional full(1.0) 단독으로는 미달 → reject (#1876 primary 의도와 동일 보수성).
 *   - positional full(1.0) + barometer(0.3) = 1.3 < 1.6 → reject (약 신호 하나로는 부족).
 *   - positional full(1.0) + barometer(0.3) + motion(0.4) = 1.7 ≥ 1.6 → accept
 *     (지상 가능성 있어도 정착+train 진동 두 환경 신호로 보강).
 *   - positional partial(0.6) + radio(0.5) + motion(0.4) + time(0.3) = 1.8 ≥ 1.6 → accept.
 *   - radio 카테고리는 surface-weak 자체이므로 `weightedVoteFusion`에서 radio vote 미참여.
 *     (cellular surface-weak를 underground vote로 동시에 사용하는 모순 차단.)
 *
 * 1.6 선정 사유:
 *   - `1.1` (기본) → surface-weak 시 positional 1.0 + time 0.3 = 1.3으로 통과 → #1876 의도 무효화.
 *   - `1.6` 이상 → 정착(time) + 환경(motion or radio) 둘 중 하나 + positional full 필요.
 *     강한 신호 multi-source 조합 강제. lockless 진행은 보존(barometer+motion 결합 가능).
 *   - `1.8` 이상 → motion + time + positional full = 1.7도 fail. 너무 보수.
 *
 * 데이터 주도(CLAUDE.md §3):
 *   - 새 신호 추가는 본 상수에 한 항목 추가만으로 vote에 참여.
 *   - vote 함수(`weightedVoteFusion`)는 `Object.values(FUSION_SIGNAL_WEIGHTS)` 순회 — 카테고리
 *     하드코딩 X.
 *   - 신규 환경 vote 분기는 `selectAcceptThreshold` 데이터 표(`THRESHOLD_BY_ENV`)에 추가.
 *
 * 옵션 D 연계:
 *   본 weights는 옵션 D ("정확성 게이트 보강 신규") 별도 epic으로 진화할 base. 환경별 가변
 *   가중치(underground 시 radio↑, surface 시 positional↑)는 미래 PR. 본 PR은 고정 weight +
 *   환경별 가변 임계(D+A hybrid).
 */

/**
 * Fusion 신호 카테고리 — 4 paradigm taxonomy.
 *
 * 새 카테고리 추가 시 본 union과 `FUSION_SIGNAL_WEIGHTS` 둘 다 갱신.
 */
export type FusionSignalCategory = 'positional' | 'radio' | 'motion' | 'time';

/**
 * 카테고리별 가중치 — 합산 vote에 사용.
 * 변경 시 `STATION_ACCEPT_THRESHOLD`와 함께 재조정(임계값 의미 보존).
 */
export const FUSION_SIGNAL_WEIGHTS: Readonly<Record<FusionSignalCategory, number>> = {
  positional: 1.0,
  radio: 0.5,
  motion: 0.4,
  time: 0.3,
};

/**
 * Station 채택 임계 (기본 underground 환경) — 누적 weight ≥ 임계 + station 후보 ≥ 1 이면 accept.
 *
 * 1.1 선정 사유:
 *   - `positional` 단독(1.0)으로는 미달 → 다중 vote 필수 (steady quorum=2와 동등 정책).
 *   - `positional` partial 0.6 + 어떤 env vote ≥ 0.5(radio) 또는 0.4+0.3 → accept.
 *   - `positional` 부재 시 어떤 env 누적도 1.1 미달 → 항상 reject.
 *   - 1.0 이하로 낮추면 positional 단독 채택 가능해져 기존 steady quorum=2 정책 회귀.
 *   - 1.2 이상으로 높이면 partial positional + radio 만으로 부족 → T3 stuck 재발.
 */
export const STATION_ACCEPT_THRESHOLD = 1.1;

/**
 * Station 채택 임계 (`'surface-weak'` cellular = 지상 가능성).
 *
 * #1876 cross-impact (D+A hybrid): `cellularEnvironmentVote === 'surface-weak'`일 때 weighted
 * vote fallback이 #1876 `envVotes -= 1` 보수 처리를 무효화하지 않도록 임계를 1.1 → 1.6으로 상향.
 * "신호 1개 죽어도 진행" 원칙은 유지되나, 지상 가능성이 있을 때는 강한 신호 multi-source 조합 강제.
 *
 * 1.6 선정 사유 — 자세히는 `STATION_ACCEPT_THRESHOLD` 위 docblock 참고.
 *   - positional full(1.0) + barometer(0.3) = 1.3 → reject (단일 약 신호로는 부족, 의도된 보수).
 *   - positional full(1.0) + motion(0.4) + time(0.3) = 1.7 → accept (multi-source).
 *   - radio 카테고리는 입력 자체가 `surface-weak`이므로 weightedVoteFusion에서 vote 미참여.
 */
export const STATION_ACCEPT_THRESHOLD_SURFACE_WEAK = 1.6;
