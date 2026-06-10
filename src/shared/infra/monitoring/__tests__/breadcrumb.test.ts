import * as Sentry from '@sentry/react-native';
import { addDomainBreadcrumb, addLogBreadcrumb } from '../breadcrumb';
import { setSentryEnabled } from '../sentryState';

const addBreadcrumbMock = Sentry.addBreadcrumb as jest.Mock;
const captureExceptionMock = Sentry.captureException as jest.Mock;

beforeEach(() => {
  addBreadcrumbMock.mockReset();
  captureExceptionMock.mockReset();
});

afterEach(() => {
  setSentryEnabled(false);
});

describe('addLogBreadcrumb', () => {
  it('opt-in 비활성 시 no-op', () => {
    addLogBreadcrumb('info', 'TEST', ['메시지']);
    expect(addBreadcrumbMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it.each([
    ['info' as const, 'info', 'TEST', ['hello'], '[TEST] hello'],
    ['warn' as const, 'warning', 'TAG', ['주의'], '[TAG] 주의'],
    ['debug' as const, 'debug', 'TAG', ['dbg'], '[TAG] dbg'],
  ])('%s → level "%s"', (logLevel, sentryLevel, tag, args, message) => {
    setSentryEnabled(true);
    addLogBreadcrumb(logLevel, tag, args);
    expect(addBreadcrumbMock).toHaveBeenCalledWith({
      level: sentryLevel,
      category: 'log',
      message,
    });
  });

  it('error + 첫 인자가 Error → captureException 호출', () => {
    setSentryEnabled(true);
    const err = new Error('boom');
    addLogBreadcrumb('error', 'TAG', [err, 'extra']);
    expect(addBreadcrumbMock).toHaveBeenCalledWith({
      level: 'error',
      category: 'log',
      message: '[TAG] boom extra',
    });
    expect(captureExceptionMock).toHaveBeenCalledWith(err);
  });

  it('error지만 첫 인자가 Error가 아니면 captureException 안 함', () => {
    setSentryEnabled(true);
    addLogBreadcrumb('error', 'TAG', ['just a string error']);
    expect(addBreadcrumbMock).toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('인자가 객체면 JSON 직렬화', () => {
    setSentryEnabled(true);
    addLogBreadcrumb('info', 'TAG', [{ foo: 1 }, 42]);
    expect(addBreadcrumbMock).toHaveBeenCalledWith({
      level: 'info',
      category: 'log',
      message: '[TAG] {"foo":1} 42',
    });
  });

  it('순환참조 객체는 String() fallback', () => {
    setSentryEnabled(true);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    addLogBreadcrumb('info', 'TAG', [circular]);
    expect(addBreadcrumbMock).toHaveBeenCalledWith({
      level: 'info',
      category: 'log',
      message: '[TAG] [object Object]',
    });
  });

  it('인자 없으면 태그만 메시지', () => {
    setSentryEnabled(true);
    addLogBreadcrumb('info', 'TAG', []);
    expect(addBreadcrumbMock).toHaveBeenCalledWith({
      level: 'info',
      category: 'log',
      message: '[TAG]',
    });
  });
});

describe('addDomainBreadcrumb', () => {
  it('opt-in 비활성 시 no-op', () => {
    addDomainBreadcrumb('alarm', 'fire', { station: '강남' });
    expect(addBreadcrumbMock).not.toHaveBeenCalled();
  });

  it('category/message/data를 그대로 전달', () => {
    setSentryEnabled(true);
    addDomainBreadcrumb('alarm', 'fire', { station: '강남', phase: 'early' });
    expect(addBreadcrumbMock).toHaveBeenCalledWith({
      level: 'info',
      category: 'alarm',
      message: 'fire',
      data: { station: '강남', phase: 'early' },
    });
  });

  it('data 미지정 시 data 키 자체를 누락', () => {
    setSentryEnabled(true);
    addDomainBreadcrumb('lifecycle', 'foreground');
    expect(addBreadcrumbMock).toHaveBeenCalledWith({
      level: 'info',
      category: 'lifecycle',
      message: 'foreground',
    });
  });
});
