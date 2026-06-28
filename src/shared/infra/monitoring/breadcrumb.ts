import * as Sentry from '@sentry/react-native';
import { isSentryEnabled } from './sentryState';

/**
 * #1040 follow-up — logger / 도메인 이벤트를 Sentry breadcrumb로 전달.
 *
 * Privacy:
 *   - opt-in 비활성(`isSentryEnabled() === false`) 시 no-op.
 *   - Sentry SDK 자체도 init 안 됐으면 무시하지만, 명시 가드로 이중 안전.
 *
 * PII 주의: logger 메시지에 사용자 위치/역 이름 등이 포함될 수 있다.
 * opt-in 토글로 사용자가 명시 동의 후만 전송된다. 마스킹은 별도 PR 후보.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_TO_SENTRY: Record<LogLevel, Sentry.SeverityLevel> = {
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  error: 'error',
};

function serializeArg(arg: unknown): string {
  if (arg instanceof Error) return arg.message;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * logger 호출 시 Sentry breadcrumb 추가.
 * `level === 'error'` + 첫 인자가 Error 인스턴스면 `Sentry.captureException`도 호출.
 */
export function addLogBreadcrumb(level: LogLevel, tag: string, args: unknown[]): void {
  if (!isSentryEnabled()) return;

  const message = `[${tag}] ${args.map(serializeArg).join(' ')}`.trim();
  Sentry.addBreadcrumb({
    level: LEVEL_TO_SENTRY[level],
    category: 'log',
    message,
  });

  if (level === 'error') {
    const first = args[0];
    if (first instanceof Error) {
      Sentry.captureException(first);
    }
  }
}

/**
 * 도메인 이벤트 breadcrumb 카테고리 (#1087 follow-up).
 *
 *  - `alarm`: 알람 fire / cleared
 *  - `trip`: trip start / end
 *  - `boarding`: BoardingLock 생성 / 해제
 *  - `lifecycle`: BG/FG transition (앱 상태 전이)
 *  - `push`: silent push 수신
 *  - `permission`: 권한 변경(요청/허용/거부)
 */
export type DomainBreadcrumbCategory =
  | 'alarm'
  | 'trip'
  | 'boarding'
  | 'lifecycle'
  | 'push'
  | 'permission';

/**
 * 도메인 이벤트 breadcrumb 추가.
 *
 * - opt-in 비활성(`isSentryEnabled() === false`) 시 no-op.
 * - PII 정책:
 *    - 역 이름은 공개 정보로 허용.
 *    - GPS 좌표는 호출자가 100m 단위로 round 후 전달.
 *    - 사용자 식별자/푸시 토큰 전체는 전달 금지 (필요 시 앞 8자 등 축약).
 */
export function addDomainBreadcrumb(
  category: DomainBreadcrumbCategory,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!isSentryEnabled()) return;
  Sentry.addBreadcrumb({
    level: 'info',
    category,
    message,
    ...(data ? { data } : {}),
  });
}

/**
 * S13(#1546) — 환경 전환 breadcrumb. delta-only 발사.
 *
 * `prev === next`(전환 없음) 또는 `prev === undefined`(첫 관측, 비교 기준 없음)이면 no-op.
 * 호출자는 이전 환경을 ref/state로 보존하고 매 폴링마다 호출하면 된다 — 본 함수가 dedup 책임.
 *
 * 예: `surface → underground` 전환은 silent push polling 주기 변화 / boardingPrompt 게이트
 * 활성화 / GPS gating downgrade 등 여러 downstream 효과를 가져온다. Sentry trail에서
 * "정확히 언제 지하 진입을 감지했는가"를 보기 위함.
 */
export function recordEnvironmentTransition(
  prev: 'surface' | 'underground' | 'unknown' | undefined,
  next: 'surface' | 'underground' | 'unknown',
): void {
  if (prev === undefined) return;
  if (prev === next) return;
  addDomainBreadcrumb('lifecycle', 'environment-transition', { from: prev, to: next });
}

/**
 * #1936 (Epic #1927 G4) — cascade tier 채택 breadcrumb. delta-only 발사.
 *
 * `prev === next`(같은 tier 연속 채택)이면 no-op. 호출자는 이전 tier를 ref로 보존하고 매 cycle
 * 결과를 본 함수에 전달 — 본 함수가 dedup 책임.
 *
 * cascade picker의 tier 분포(어떤 tier가 cascade 결정에 가장 많이 기여했는지) 1주 측정용.
 * V7 (지하 station-passed 정확) + X10 (fusion picker output ≠ input) acceptance 분석 인프라.
 *
 * data payload는 PII 정책 준수 — station 좌표 X, station name X (tier + environment + distanceKm만).
 */
export function recordFusionTierAdopted(
  prev: string | null,
  next: string,
  environment: 'surface' | 'underground' | 'unknown',
  distanceKm: number | null,
): void {
  if (prev === next) return;
  addDomainBreadcrumb('lifecycle', 'fusion.tier_adopted', {
    from: prev ?? 'none',
    to: next,
    environment,
    ...(distanceKm != null ? { distanceKm: Math.round(distanceKm * 1000) / 1000 } : {}),
  });
}
