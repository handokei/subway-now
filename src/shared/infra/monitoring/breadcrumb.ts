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
