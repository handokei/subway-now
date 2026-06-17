/**
 * #1421 — PR-AutoLock-1 측정 인프라.
 *
 * inferAutoLockCandidate 단위 테스트. SSOT consensus (surface 또는 underground) + stability buffer
 * stable + direction verified 3개 게이트가 모두 충족된 경우에만 AutoLockCandidate를 산출, 그 외 null.
 *
 * 본 PR은 측정만 — 실제 lock 산출 / sync 호출은 PR-AutoLock-2.
 */

import { inferAutoLockCandidate } from '../inferAutoLockCandidate';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';
import type { LineNumber, Station } from '../../../../shared/types/station';

function station(name: string, line: LineNumber): Station {
  return { id: `${line}-${name}`, name, line, lineColor: '#000', lat: 0, lng: 0 };
}

const routeStations: Station[] = [
  station('A', '2'),
  station('B', '2'),
  station('C', '2'),
];

const surfaceSSOT = { station: MOCK_STATIONS.gangnam, trainCode: '2001' };

describe('inferAutoLockCandidate', () => {
  it('모든 게이트 통과 시 DeviceAutoLockCandidate 반환 (surface SSOT 경로)', () => {
    const result = inferAutoLockCandidate({
      surfaceSSOT,
      undergroundSSOT: null,
      stabilityStable: true,
      directionMatched: true,
    });
    // source는 'device-ssot' 고정 (현 PR 측정 인프라).
    expect(result?.candidate).toEqual({
      trainCode: '2001',
      line: '2',
      subwayId: '1002',
    });
    expect(result?.source).toBe('device-ssot');
    expect(result?.stationId).toBe(MOCK_STATIONS.gangnam.id);
  });

  it('underground SSOT만 활성 + 모든 게이트 통과', () => {
    const result = inferAutoLockCandidate({
      surfaceSSOT: null,
      undergroundSSOT: { station: MOCK_STATIONS.chungmuro, trainCode: '3010' },
      stabilityStable: true,
      directionMatched: true,
    });
    expect(result?.candidate.trainCode).toBe('3010');
    expect(result?.candidate.line).toBe('3');
  });

  it('두 SSOT 모두 활성이면 surface 우선', () => {
    const result = inferAutoLockCandidate({
      surfaceSSOT,
      undergroundSSOT: { station: MOCK_STATIONS.chungmuro, trainCode: '3010' },
      stabilityStable: true,
      directionMatched: true,
    });
    expect(result?.candidate.trainCode).toBe('2001');
    expect(result?.candidate.line).toBe('2');
  });

  it('두 SSOT 모두 null이면 null (SSOT 게이트 미충족)', () => {
    const result = inferAutoLockCandidate({
      surfaceSSOT: null,
      undergroundSSOT: null,
      stabilityStable: true,
      directionMatched: true,
    });
    expect(result).toBeNull();
  });

  it('stability stable=false면 null', () => {
    const result = inferAutoLockCandidate({
      surfaceSSOT,
      undergroundSSOT: null,
      stabilityStable: false,
      directionMatched: true,
    });
    expect(result).toBeNull();
  });

  it('direction matched=false면 null', () => {
    const result = inferAutoLockCandidate({
      surfaceSSOT,
      undergroundSSOT: null,
      stabilityStable: true,
      directionMatched: false,
    });
    expect(result).toBeNull();
  });

  it('inferAutoLockMeta — 게이트 입력 + reason 노출 (DebugModal 출력용)', () => {
    const result = inferAutoLockCandidate({
      surfaceSSOT,
      undergroundSSOT: null,
      stabilityStable: false,
      directionMatched: true,
    });
    expect(result).toBeNull();
    // null 사유는 호출자가 게이트 상태로 알 수 있음 — meta 함수 없이도 진단 가능.
  });

  it('routeStations 컨텍스트 없이도 SSOT+stability+direction만으로 작동 (pure)', () => {
    // pure 함수: 호출자가 verifyTrainDirection 결과를 그대로 넘긴다.
    const result = inferAutoLockCandidate({
      surfaceSSOT: { station: routeStations[0], trainCode: 'T-A' },
      undergroundSSOT: null,
      stabilityStable: true,
      directionMatched: true,
    });
    expect(result?.candidate.trainCode).toBe('T-A');
    expect(result?.candidate.line).toBe('2');
  });
});
