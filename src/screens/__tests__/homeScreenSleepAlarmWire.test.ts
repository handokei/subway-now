/**
 * #3100 — HomeScreen 배선 가드 (screens는 컴포넌트 테스트 대상이 아니라 소스 단언으로 고정한다).
 *  - 설정 hydrate / 등록 훅 전달
 *  - 오버레이 dismiss는 알람 이벤트만 비운다 (5분 전역 무음 설정 금지 — 다음 칸을 막는다)
 *  - LA 재전송 키가 같은 type의 다른 역·다른 칸에서도 갱신
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(join(__dirname, '..', 'HomeScreen.tsx'), 'utf8');

function overlayJsx(): string {
  const start = SOURCE.indexOf('<SleepAlarmOverlay');
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('/>', SOURCE.indexOf('onDismiss', start));
  return SOURCE.slice(start, end + 2);
}

describe('HomeScreen — 취침 알람 N역 전 배선 (#3100)', () => {
  it('설정 store를 selector로 읽어 useApnsTripRegistration에 넘긴다', () => {
    expect(SOURCE).toMatch(/const sleepAlarm = useSettingsStore\(\(s\) => s\.sleepAlarm\)/);
    const hookCall = SOURCE.slice(SOURCE.indexOf('useApnsTripRegistration({'));
    expect(hookCall.slice(0, hookCall.indexOf('});'))).toMatch(/\bsleepAlarm\b/);
  });

  it('마운트 시 loadSleepAlarm()으로 저장값을 복원한다 (loadSleepMode 옆)', () => {
    expect(SOURCE).toMatch(/loadSleepAlarm\(\)/);
  });

  it('오버레이 dismiss는 clearAlarmEvent만 — setDismissSilence(5분 전역 무음) 호출 없음', () => {
    const jsx = overlayJsx();
    expect(jsx).toContain('clearAlarmEvent()');
    expect(jsx).not.toContain('setDismissSilence');
    expect(SOURCE).not.toContain('setDismissSilence');
  });

  it('LA 재전송 effect 키에 type·stationName·band가 모두 든다', () => {
    const keyLine = SOURCE.split('\n').find((line) => line.includes('const key = `${effectiveOrigin.id}__'));
    expect(keyLine).toBeDefined();
    expect(keyLine).toContain('alarmEvent?.type');
    expect(keyLine).toContain('alarmEvent?.stationName');
    expect(keyLine).toContain('alarmEvent?.band');
  });
});
