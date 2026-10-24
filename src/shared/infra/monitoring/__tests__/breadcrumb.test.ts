import * as Sentry from '@sentry/react-native';
import {
  addDomainBreadcrumb,
  addLogBreadcrumb,
  recordEnvironmentTransition,
  recordFusionTierAdopted,
} from '../breadcrumb';
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

describe('recordEnvironmentTransition (S13 #1546)', () => {
  beforeEach(() => {
    setSentryEnabled(true);
  });

  it('prev === undefined (첫 관측)이면 no-op', () => {
    recordEnvironmentTransition(undefined, 'surface');
    expect(addBreadcrumbMock).not.toHaveBeenCalled();
  });

  it('prev === next (전환 없음)이면 no-op', () => {
    recordEnvironmentTransition('surface', 'surface');
    expect(addBreadcrumbMock).not.toHaveBeenCalled();
  });

  it.each([
    ['surface' as const, 'underground' as const],
    ['underground' as const, 'surface' as const],
    ['unknown' as const, 'underground' as const],
    ['surface' as const, 'unknown' as const],
  ])('%s → %s 전환 시 lifecycle breadcrumb 발사', (from, to) => {
    recordEnvironmentTransition(from, to);
    expect(addBreadcrumbMock).toHaveBeenCalledWith({
      level: 'info',
      category: 'lifecycle',
      message: 'environment-transition',
      data: { from, to },
    });
  });

  it('opt-in 비활성이면 no-op', () => {
    setSentryEnabled(false);
    recordEnvironmentTransition('surface', 'underground');
    expect(addBreadcrumbMock).not.toHaveBeenCalled();
  });
});

describe('recordFusionTierAdopted (#1936 G4)', () => {
  beforeEach(() => {
    setSentryEnabled(true);
  });

  it('prev === next 시 no-op (dedup)', () => {
    recordFusionTierAdopted('fused', 'fused', 'surface', 0.05);
    expect(addBreadcrumbMock).not.toHaveBeenCalled();
  });

  it('prev=null + next 첫 채택 시 breadcrumb 발사 (from=none)', () => {
    recordFusionTierAdopted(null, 'gps-fast-path', 'surface', 0.1);
    expect(addBreadcrumbMock).toHaveBeenCalledWith({
      level: 'info',
      category: 'lifecycle',
      message: 'fusion.tier_adopted',
      data: { from: 'none', to: 'gps-fast-path', environment: 'surface', distanceKm: 0.1 },
    });
  });

  it('tier 전환 시 breadcrumb 발사 + distanceKm round 보존', () => {
    recordFusionTierAdopted('fused', 'gps-fallback', 'underground', 0.123456);
    expect(addBreadcrumbMock).toHaveBeenCalledWith({
      level: 'info',
      category: 'lifecycle',
      message: 'fusion.tier_adopted',
      data: {
        from: 'fused',
        to: 'gps-fallback',
        environment: 'underground',
        distanceKm: 0.123,
      },
    });
  });

  it('distanceKm=null이면 data에서 누락', () => {
    recordFusionTierAdopted('position-train', 'wifi', 'underground', null);
    expect(addBreadcrumbMock).toHaveBeenCalledWith({
      level: 'info',
      category: 'lifecycle',
      message: 'fusion.tier_adopted',
      data: { from: 'position-train', to: 'wifi', environment: 'underground' },
    });
  });

  it('opt-in 비활성이면 no-op', () => {
    setSentryEnabled(false);
    recordFusionTierAdopted(null, 'fused', 'surface', 0.05);
    expect(addBreadcrumbMock).not.toHaveBeenCalled();
  });
});
