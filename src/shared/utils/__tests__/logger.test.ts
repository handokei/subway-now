import * as Sentry from '@sentry/react-native';
import { setSentryEnabled } from '../../infra/monitoring/sentryState';
import { createLogger, setMinLevel } from '../logger';

const addBreadcrumbMock = Sentry.addBreadcrumb as jest.Mock;

describe('createLogger', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    addBreadcrumbMock.mockReset();
    setSentryEnabled(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setSentryEnabled(false);
  });

  it('debug 레벨은 console.log를 호출한다', () => {
    const logger = createLogger('TEST');
    logger.debug('메시지');
    expect(logSpy).toHaveBeenCalledWith('[TEST]', '메시지');
  });

  it('info 레벨은 console.log를 호출한다', () => {
    const logger = createLogger('TEST');
    logger.info('메시지');
    expect(logSpy).toHaveBeenCalledWith('[TEST]', '메시지');
  });

  it('warn 레벨은 console.warn을 호출한다', () => {
    const logger = createLogger('TEST');
    logger.warn('경고');
    expect(warnSpy).toHaveBeenCalledWith('[TEST]', '경고');
  });

  it('error 레벨은 console.error를 호출한다', () => {
    const logger = createLogger('TEST');
    logger.error('오류');
    expect(errorSpy).toHaveBeenCalledWith('[TEST]', '오류');
  });

  it('태그가 메시지에 포함된다', () => {
    const logger = createLogger('LiveActivity');
    logger.info('시작');
    expect(logSpy).toHaveBeenCalledWith('[LiveActivity]', '시작');
  });

  it('여러 인수를 전달할 수 있다', () => {
    const logger = createLogger('TEST');
    logger.info('상태:', 'granted', 42);
    expect(logSpy).toHaveBeenCalledWith('[TEST]', '상태:', 'granted', 42);
  });

  describe('Sentry breadcrumb wire', () => {
    it('opt-in 비활성 시 breadcrumb 호출 안 함', () => {
      const logger = createLogger('TAG');
      logger.info('메시지');
      expect(addBreadcrumbMock).not.toHaveBeenCalled();
    });

    it('opt-in 활성 + info → breadcrumb 호출', () => {
      setSentryEnabled(true);
      const logger = createLogger('TAG');
      logger.info('hi');
      expect(addBreadcrumbMock).toHaveBeenCalledWith({
        level: 'info',
        category: 'log',
        message: '[TAG] hi',
      });
    });

    it('minLevel 가드로 막힌 로그는 breadcrumb도 호출 안 함', () => {
      setSentryEnabled(true);
      setMinLevel('warn');
      const logger = createLogger('TAG');
      logger.debug('skip');
      logger.info('skip');
      expect(addBreadcrumbMock).not.toHaveBeenCalled();
      setMinLevel('debug');
    });
  });

  describe('setMinLevel', () => {
    afterEach(() => {
      setMinLevel('debug'); // 테스트 후 복원
    });

    it('minLevel 이하 로그는 출력하지 않는다', () => {
      setMinLevel('warn');
      const logger = createLogger('TEST');
      logger.debug('무시됨');
      logger.info('무시됨');
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('minLevel 이상 로그는 출력한다', () => {
      setMinLevel('warn');
      const logger = createLogger('TEST');
      logger.warn('경고');
      logger.error('오류');
      expect(warnSpy).toHaveBeenCalledWith('[TEST]', '경고');
      expect(errorSpy).toHaveBeenCalledWith('[TEST]', '오류');
    });
  });
});