/**
 * #1421 — PR-AutoLock-1 측정 인프라.
 * #1526 — 출발역 strong-stability 예외 추가.
 *
 * inferAutoLockCandidate 단위 테스트. SSOT consensus (surface 또는 underground) + stability buffer
 * stable + direction verified 3개 게이트가 모두 충족된 경우, 또는 direction judge-impossible
 * + strong stability(count >= 5) 출발역 예외 케이스에 한해 DeviceAutoLockCandidate 산출.
 *
 * 본 PR은 측정만 — 실제 lock 산출 / sync 호출은 PR-AutoLock-2.
 */

import {
  inferAutoLockCandidate,
  DEPARTURE_STRONG_STABILITY_THRESHOLD,
} from '../inferAutoLockCandidate';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';
import type { LineNumber, Station } from '../../../../shared/types/station';
import type { VerifyTrainDirectionReason } from '../verifyTrainDirection';

function station(name: string, line: LineNumber): Station {
  return { id: `${line}-${name}`, name, line, lineColor: '#000', lat: 0, lng: 0 };
}

const routeStations: Station[] = [
  station('A', '2'),
  station('B', '2'),
  station('C', '2'),
];

const surfaceSSOT = { station: MOCK_STATIONS.gangnam, trainCode: '2001' };

const baseInput = {
  surfaceSSOT,
  undergroundSSOT: null,
  stabilityStable: true,
  stabilityCount: 3,
  directionMatched: true,
  directionReason: 'forward' as VerifyTrainDirectionReason,
};

describe('inferAutoLockCandidate', () => {
  it('모든 게이트 통과 시 DeviceAutoLockCandidate 반환 (surface SSOT 경로)', () => {
    const result = inferAutoLockCandidate(baseInput);
    expect(result?.candidate).toEqual({
      trainCode: '2001',
      line: '2',
      subwayId: '1002',
    });
    expect(result?.source).toBe('device-ssot');
    expect(result?.stationId).toBe(MOCK_STATIONS.gangnam.id);
    expect(result?.path).toBe('direction-matched');
  });

  it('underground SSOT만 활성 + 모든 게이트 통과', () => {
    const result = inferAutoLockCandidate({
      ...baseInput,
      surfaceSSOT: null,
      undergroundSSOT: { station: MOCK_STATIONS.chungmuro, trainCode: '3010' },
    });
    expect(result?.candidate.trainCode).toBe('3010');
    expect(result?.candidate.line).toBe('3');
    expect(result?.path).toBe('direction-matched');
  });

  it('두 SSOT 모두 활성이면 surface 우선', () => {
    const result = inferAutoLockCandidate({
      ...baseInput,
      undergroundSSOT: { station: MOCK_STATIONS.chungmuro, trainCode: '3010' },
    });
    expect(result?.candidate.trainCode).toBe('2001');
    expect(result?.candidate.line).toBe('2');
  });

  it('두 SSOT 모두 null이면 null (SSOT 게이트 미충족)', () => {
    const result = inferAutoLockCandidate({
      ...baseInput,
      surfaceSSOT: null,
      undergroundSSOT: null,
    });
    expect(result).toBeNull();
  });

  it('stability stable=false면 null', () => {
    const result = inferAutoLockCandidate({ ...baseInput, stabilityStable: false });
    expect(result).toBeNull();
  });

  it('direction matched=false + reason=reverse면 null (실제로 잘못된 방향은 strong-stability에서도 reject)', () => {
    const result = inferAutoLockCandidate({
      ...baseInput,
      directionMatched: false,
      directionReason: 'reverse',
      stabilityCount: 99,
    });
    expect(result).toBeNull();
  });

  it('direction matched=false + reason=terminal-out-of-route면 null (judge-wrong은 reject)', () => {
    const result = inferAutoLockCandidate({
      ...baseInput,
      directionMatched: false,
      directionReason: 'terminal-out-of-route',
      stabilityCount: 99,
    });
    expect(result).toBeNull();
  });

  it('#1526 — direction reason=no-route + stability count >= THRESHOLD면 출발역 예외로 통과', () => {
    const result = inferAutoLockCandidate({
      ...baseInput,
      directionMatched: false,
      directionReason: 'no-route',
      stabilityCount: DEPARTURE_STRONG_STABILITY_THRESHOLD,
    });
    expect(result?.path).toBe('departure-strong-stability');
    expect(result?.candidate.trainCode).toBe('2001');
  });

  it('#1526 — direction reason=no-terminal + stability count >= THRESHOLD도 출발역 예외 적용', () => {
    const result = inferAutoLockCandidate({
      ...baseInput,
      directionMatched: false,
      directionReason: 'no-terminal',
      stabilityCount: DEPARTURE_STRONG_STABILITY_THRESHOLD + 2,
    });
    expect(result?.path).toBe('departure-strong-stability');
  });

  it('#1526 — direction reason=no-route인데 stability count < THRESHOLD면 null (예외 미발동)', () => {
    const result = inferAutoLockCandidate({
      ...baseInput,
      directionMatched: false,
      directionReason: 'no-route',
      stabilityCount: DEPARTURE_STRONG_STABILITY_THRESHOLD - 1,
    });
    expect(result).toBeNull();
  });

  it('#1526 — direction reason=null (verify 결과 부재) + strong stability면 null (judge-impossible 라벨 명시 필요)', () => {
    // direction verify 자체를 호출 안 한 경우 (예: SSOT 미활성으로 호출자가 verify skip).
    // judge-impossible 라벨을 명시하지 못한 상태는 strong-stability 예외에서도 reject — false positive 차단.
    const result = inferAutoLockCandidate({
      ...baseInput,
      directionMatched: false,
      directionReason: null,
      stabilityCount: 99,
    });
    expect(result).toBeNull();
  });

  it('#1526 — 출발역 예외 발동 시에도 SSOT 미활성이면 null', () => {
    const result = inferAutoLockCandidate({
      ...baseInput,
      surfaceSSOT: null,
      undergroundSSOT: null,
      directionMatched: false,
      directionReason: 'no-route',
      stabilityCount: DEPARTURE_STRONG_STABILITY_THRESHOLD,
    });
    expect(result).toBeNull();
  });

  it('#1526 — 출발역 예외 + underground SSOT만 활성', () => {
    const result = inferAutoLockCandidate({
      ...baseInput,
      surfaceSSOT: null,
      undergroundSSOT: { station: MOCK_STATIONS.chungmuro, trainCode: '3010' },
      directionMatched: false,
      directionReason: 'no-route',
      stabilityCount: DEPARTURE_STRONG_STABILITY_THRESHOLD,
    });
    expect(result?.path).toBe('departure-strong-stability');
    expect(result?.candidate.trainCode).toBe('3010');
  });

  it('routeStations 컨텍스트 없이도 SSOT+stability+direction만으로 작동 (pure)', () => {
    const result = inferAutoLockCandidate({
      ...baseInput,
      surfaceSSOT: { station: routeStations[0], trainCode: 'T-A' },
    });
    expect(result?.candidate.trainCode).toBe('T-A');
    expect(result?.candidate.line).toBe('2');
  });
});
