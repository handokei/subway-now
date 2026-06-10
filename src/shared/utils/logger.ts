import { addLogBreadcrumb } from '../infra/monitoring/breadcrumb';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// 기본값은 debug. 프로덕션 빌드에서는 앱 초기화 시 setMinLevel('warn') 호출
let minLevel: LogLevel = 'debug';

export function setMinLevel(level: LogLevel): void {
  minLevel = level;
}

function log(level: LogLevel, tag: string, ...args: unknown[]): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;

  // Sentry breadcrumb forward — opt-in 비활성 시 내부에서 no-op.
  addLogBreadcrumb(level, tag, args);

  const message = `[${tag}]`;
  switch (level) {
    case 'debug':
    case 'info':
      console.log(message, ...args);
      break;
    case 'warn':
      console.warn(message, ...args);
      break;
    case 'error':
      console.error(message, ...args);
      break;
  }
}

export function createLogger(tag: string) {
  return {
    debug: (...args: unknown[]) => log('debug', tag, ...args),
    info: (...args: unknown[]) => log('info', tag, ...args),
    warn: (...args: unknown[]) => log('warn', tag, ...args),
    error: (...args: unknown[]) => log('error', tag, ...args),
  };
}
