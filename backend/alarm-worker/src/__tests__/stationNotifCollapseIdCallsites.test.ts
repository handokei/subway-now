/**
 * #2909 (ADR-040 0단계) — 매역 알림(station-notif) collapseId는 반드시 역 단위
 * (`stationNotifCollapseId(trip.token, <station>)`)여야 한다. trip 단위(station 생략) 호출이
 * 하나라도 남아 있으면 같은 trip의 역A 배너가 역B 배너에 덮여 알림센터에서 사라진다(10/7 사용자
 * 피드백 → 역 단위로 통일 결정).
 *
 * 이 테스트는 `scheduled.ts` 소스를 정적으로 스캔해 `stationNotifCollapseId(` 호출부가
 * 전부 2-argument(station 포함) 형태인지 검증한다 — 향후 새 호출부가 station 인자를
 * 빠뜨리고 추가되는 회귀를 단위 테스트 레벨에서 즉시 잡는다(유닛 테스트로는 모든 호출부를
 * 일일이 exercise하기 어렵기 때문에 소스 스캔으로 보완).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCHEDULED_SOURCE = readFileSync(join(__dirname, '../scheduled.ts'), 'utf8');

/** `stationNotifCollapseId(` 호출 전체를 괄호 매칭으로 추출(인자에 중첩 괄호가 없으므로 단순 스캔으로 충분). */
function extractStationNotifCollapseIdCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = 'stationNotifCollapseId(';
  let fromIndex = 0;
  for (;;) {
    const start = source.indexOf(marker, fromIndex);
    if (start === -1) break;
    const close = source.indexOf(')', start);
    calls.push(source.slice(start, close + 1));
    fromIndex = close + 1;
  }
  return calls;
}

describe('#2909 stationNotifCollapseId 호출부 — 전부 역 단위(2-argument)여야 한다', () => {
  it('scheduled.ts의 모든 stationNotifCollapseId(...) 호출이 station 인자를 포함한다', () => {
    const calls = extractStationNotifCollapseIdCalls(SCHEDULED_SOURCE);
    // import 구문(`stationNotifCollapseId,` 등)은 `(` 가 없어 extractStationNotifCollapseIdCalls가
    // 잡지 않는다 — 실제 호출부만 추출됐는지 최소 1개 이상 존재로 sanity 확인.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // 2-argument 형태: `stationNotifCollapseId(trip.token, waypoint.stationName)` 류 — 쉼표 포함.
      expect(call).toContain(',');
    }
  });

  it('호출부가 최소 4곳(arvlcd 본류 / mid-cycle / sync catch-up / vanish-fallback) 존재한다', () => {
    const calls = extractStationNotifCollapseIdCalls(SCHEDULED_SOURCE);
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });
});
