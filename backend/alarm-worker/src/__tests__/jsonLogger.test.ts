/**
 * #2653 — SonarCloud MINOR "Log Injection via unsanitized user input"(index.ts:2364 부근,
 * 2026-09-15) fix. 이 파일의 `(msg, meta) => console.log(JSON.stringify({ msg, ...meta }))`
 * 패턴이 4곳 중복돼 있었다 — 공용 헬퍼(`createJsonLogger`)로 추출하며 함께 해소한다.
 *
 * 정규화 범위는 최소(제어문자 개행/캐리지리턴 제거)로 고정 — `JSON.stringify`가 이미 하는
 * 따옴표/이스케이프 처리는 중복하지 않는다. 역명에 쓰이는 한글/괄호/중점 등 정상 문자는
 * 훼손하지 않음을 회귀로 고정한다.
 */
import { describe, expect, it, vi } from 'vitest';
import { createJsonLogger, sanitizeLogMeta } from '../index';

describe('sanitizeLogMeta (#2653)', () => {
  it('개행/캐리지리턴 제어문자를 제거한다(log forging 방지)', () => {
    const out = sanitizeLogMeta({ station: '건대입구\n{"msg":"forged-log-line"}' });
    expect(out.station).toBe('건대입구{"msg":"forged-log-line"}');
    expect(String(out.station)).not.toContain('\n');
  });

  it('캐리지리턴(\\r)도 제거한다', () => {
    const out = sanitizeLogMeta({ station: '성수\r\n다음역' });
    expect(out.station).toBe('성수다음역');
  });

  it('정상 역명(한글·괄호·중점)은 훼손하지 않는다', () => {
    const stations = ['군자(능동)', '어린이대공원(세종대)', '동대문역사문화공원(DDP)', '이수·총신대입구'];
    for (const station of stations) {
      expect(sanitizeLogMeta({ station }).station).toBe(station);
    }
  });

  it('문자열이 아닌 값(숫자/불리언/객체/배열/null)은 그대로 통과시킨다', () => {
    const out = sanitizeLogMeta({
      count: 3,
      ok: true,
      nested: { a: 1 },
      list: [1, 2],
      missing: null,
    });
    expect(out).toEqual({ count: 3, ok: true, nested: { a: 1 }, list: [1, 2], missing: null });
  });

  it('빈 객체는 빈 객체를 반환한다', () => {
    expect(sanitizeLogMeta({})).toEqual({});
  });
});

describe('createJsonLogger (#2653)', () => {
  it('meta 없이 호출하면 기존 포맷({ msg })과 바이트 단위로 동일하다', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createJsonLogger()('hello');
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ msg: 'hello' }));
    spy.mockRestore();
  });

  it('meta가 있으면 기존 포맷({ msg, ...meta })과 바이트 단위로 동일하다(제어문자 없을 때)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createJsonLogger()('boarding-lock: waypoint advanced', { station: '건대입구', kind: 'transfer' });
    expect(spy).toHaveBeenCalledWith(
      JSON.stringify({ msg: 'boarding-lock: waypoint advanced', station: '건대입구', kind: 'transfer' }),
    );
    spy.mockRestore();
  });

  it('extraContext가 있으면 스프레드 순서(msg, meta, extraContext)를 그대로 보존한다', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createJsonLogger({ archFlag: 'off', killSwitchLocklessIntermediate: false })('cron: tick', {
      station: '중곡',
    });
    expect(spy).toHaveBeenCalledWith(
      JSON.stringify({
        msg: 'cron: tick',
        station: '중곡',
        archFlag: 'off',
        killSwitchLocklessIntermediate: false,
      }),
    );
    spy.mockRestore();
  });

  it('meta 값에 개행이 섞여 있어도 JSON 한 줄로만 출력된다(log forging 차단 확인)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    createJsonLogger()('boarding-lock: sync', {
      observedStationName: '건대입구\n{"msg":"fake-admin-event"}',
    });
    const printed = spy.mock.calls[0]?.[0] as string;
    expect(printed.split('\n')).toHaveLength(1);
    expect(JSON.parse(printed)).toEqual({
      msg: 'boarding-lock: sync',
      observedStationName: '건대입구{"msg":"fake-admin-event"}',
    });
    spy.mockRestore();
  });
});
