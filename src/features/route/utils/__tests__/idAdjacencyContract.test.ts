/**
 * #2954 K-2 — 방향 판정이 "station id 순서 = 노선 물리적 순서"(`stationRoute.ts:94`
 * `getLineStationsCached`의 `sort((a,b)=>a.id.localeCompare(b.id))`)를 암묵 전제한다는 걸
 * 두 실측 쌍으로 계약 고정한다. `../../../../data/__tests__/stationIdAdjacency.contract.test.ts`가
 * 전제 자체(id 상대 순서)를 고정하고, 본 파일은 그 전제 위에서 실제 방향 판정 함수가
 * **지금** 무엇을 반환하는지를 고정한다 — 추측이 아니라 실행 결과를 그대로 박았다
 * (`directionOnLine`/`resolveTripDirection` 호출 결과, 2026-10-11 probe).
 *
 * 쌍 1 — 1호선 구로(1-042) ↔ 가산디지털단지(1-100), 공식 인접(idx 차 21):
 *   두 역 모두 closed-loop 본선이 아니므로 `shortestLinePathIndices`는 단순 forward slice를
 *   쓴다. 그 slice가 만드는 경로는 **물리적으로 틀렸다**(실제로는 구로→가산디지털단지 직행
 *   1 hop인데, forward slice는 id가 그 사이에 있는 다른 역들, 사실상 인천행 분기를 경유하는
 *   경로를 만든다 — `legDirection.ts` 상단 doc, #2943 ⓓ 검증). 그런데도 방향 **부호**는
 *   맞는다 — forward slice의 첫 step이 항상 fromIdx보다 크기 때문에(가산디지털단지가
 *   구로보다 id가 큼) `firstStepIdx > fromIdx` 판정 자체는 우연히 참이다. **이 값은 우연히
 *   맞다.** 역 추가/재번호로 "분기 양쪽 모두 구로보다 id가 크다"는 배치가 깨지면(예: 구로와
 *   가산디지털단지 사이에 다른 분기 역이 새 id로 끼어들면) 이 테스트가 깨지고, 그때는
 *   기대값을 바꾸지 말고 **방향 판정 알고리즘(분기 인식)을 고쳐야 한다.**
 *
 * 쌍 2 — 2호선 시청(2-001) ↔ 충정로(2-043), 공식 인접(순환선 seam, idx 차 42):
 *   **이 값은 오답이다 — "정확하다"가 아니다.** wraparound seam에서 `firstStepIdx > fromIdx`
 *   부호 비교가 wrap을 "idx 증가"로 오해해 방향이 뒤집힌다(`directionOnLine`/`resolveTripDirection`
 *   공유 결함, **#2949** OPEN — "2호선 seam wraparound 방향 오판"). #2949 본문 실측:
 *   시청→충정로는 물리적으로 **외선**인데 `down`이 정답이고, 지금은 `up`을 반환한다(반대).
 *   2호선 `up`=내선/`down`=외선(`seoul.ts:18` `UP_DIRECTION_VALUES=['상행','내선']`).
 *   본 테스트는 **그 오답을 현재 거동으로 고정**한다 — 목적은 두 가지: ①역 추가/재번호로
 *   id 배치가 바뀌면 감지, ②#2949가 알고리즘을 고치면 감지. **#2949가 고쳐서 이 테스트가
 *   깨지면, 그때는 기대값을 정답(`down`/`up`)으로 바꿔라 — #2949의 fix를 "회귀"로 보고
 *   되돌리지 마라.** (lessons L18 — 알려진 결함은 공개 green + 결함 명시로 두고, "정확하다"는
 *   서술로 가리지 않는다.)
 *
 * 2호선 seam 공유 버그(wraparound 분기 자체의 결함) fix는 **#2949**가 담당 — 본 PR은 그
 * 이슈를 침범하지 않고 "지금(오답) 반환값"만 고정한다.
 */

import { directionOnLine } from '../directionOnLine';
import { resolveTripDirection } from '../tripDirection';
import type { DirectRoute } from '../../../../shared/utils/stationRoute';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';

describe('directionOnLine — id 배치 우연/배치 의존 계약 (#2954 K-2)', () => {
  it('1호선 구로(1-042) → 가산디지털단지(1-100) → down (forward slice 경로는 틀리지만 부호는 우연히 맞음)', () => {
    expect(directionOnLine('1', '1-042', '1-100')).toBe('down');
  });

  it('1호선 가산디지털단지(1-100) → 구로(1-042) → up (역방향도 동일 우연 의존)', () => {
    expect(directionOnLine('1', '1-100', '1-042')).toBe('up');
  });

  it('2호선 시청(2-001) → 충정로(2-043) → 현재 up [오답, 정답 down(외선) — #2949 추적]', () => {
    expect(directionOnLine('2', '2-001', '2-043')).toBe('up');
  });

  it('2호선 충정로(2-043) → 시청(2-001) → 현재 down [오답, 정답 up(내선) — #2949 추적]', () => {
    expect(directionOnLine('2', '2-043', '2-001')).toBe('down');
  });
});

describe('resolveTripDirection — 동일 쌍, Route 경유 호출 계약 (#2954 K-2)', () => {
  it('1호선 구로 → 가산디지털단지 direct route → down', () => {
    const route: DirectRoute = { type: 'direct', stops: 1, line: '1', travelSeconds: 0 };
    expect(resolveTripDirection(route, canonicalStationName('가산디지털단지', '1'), '1-042')).toBe('down');
  });

  it('1호선 가산디지털단지 → 구로 direct route → up', () => {
    const route: DirectRoute = { type: 'direct', stops: 1, line: '1', travelSeconds: 0 };
    expect(resolveTripDirection(route, canonicalStationName('구로', '1'), '1-100')).toBe('up');
  });

  it('2호선 시청 → 충정로 direct route → 현재 up [오답, 정답 down(외선) — #2949 추적]', () => {
    const route: DirectRoute = { type: 'direct', stops: 1, line: '2', travelSeconds: 0 };
    expect(resolveTripDirection(route, canonicalStationName('충정로(경기대입구)', '2'), '2-001')).toBe('up');
  });

  it('2호선 충정로 → 시청 direct route → 현재 down [오답, 정답 up(내선) — #2949 추적]', () => {
    const route: DirectRoute = { type: 'direct', stops: 1, line: '2', travelSeconds: 0 };
    expect(resolveTripDirection(route, canonicalStationName('시청', '2'), '2-043')).toBe('down');
  });
});
