import { createLogger, setMinLevel } from '../logger';

describe('createLogger', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
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