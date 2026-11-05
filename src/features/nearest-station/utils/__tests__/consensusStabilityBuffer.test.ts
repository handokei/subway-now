/**
 * #1421 — PR-AutoLock-1 측정 인프라.
 *
 * consensusStabilityBuffer 단위 테스트. Ring buffer size=5, threshold=3 기본값 경계 +
 * stationId 변경/null reset / snapshot 조회 형태 검증.
 */

import { createConsensusStabilityBuffer } from '../consensusStabilityBuffer';

describe('createConsensusStabilityBuffer', () => {
  it('초기 snapshot은 stable=false, stationId=null, count=0', () => {
    const buf = createConsensusStabilityBuffer();
    expect(buf.snapshot()).toEqual({ stable: false, stationId: null, count: 0 });
  });

  it('동일 stationId 3건 연속 push 시 stable=true', () => {
    const buf = createConsensusStabilityBuffer();
    expect(buf.push('A').stable).toBe(false);
    expect(buf.push('A').stable).toBe(false);
    const third = buf.push('A');
    expect(third.stable).toBe(true);
    expect(third.stationId).toBe('A');
    expect(third.count).toBe(3);
  });

  it('size=5 ring buffer — 5번째 항목 push 후에도 마지막 5건만 보존', () => {
    const buf = createConsensusStabilityBuffer();
    buf.push('A');
    buf.push('A');
    buf.push('B');
    buf.push('B');
    buf.push('B');
    // 마지막 3건이 모두 B → stable=true(B)
    expect(buf.snapshot()).toEqual({ stable: true, stationId: 'B', count: 3 });
    // 6번째 push 시 가장 오래된 A가 밀려남.
    const sixth = buf.push('B');
    expect(sixth).toEqual({ stable: true, stationId: 'B', count: 4 });
  });

  it('majority vote — N=5 중 다수 station 결정', () => {
    const buf = createConsensusStabilityBuffer();
    buf.push('A');
    buf.push('B');
    buf.push('A');
    buf.push('B');
    buf.push('A'); // A=3, B=2 → stable(A)
    expect(buf.snapshot()).toEqual({ stable: true, stationId: 'A', count: 3 });
  });

  it('동수면 stable=false', () => {
    const buf = createConsensusStabilityBuffer();
    buf.push('A');
    buf.push('B');
    buf.push('A');
    buf.push('B');
    // A=2, B=2 → 가장 많은 항목이 2건이라 threshold=3 미달.
    expect(buf.snapshot().stable).toBe(false);
  });

  it('null push는 buffer에 기록되지 않는다 (신호 부재 = no-op)', () => {
    const buf = createConsensusStabilityBuffer();
    buf.push('A');
    buf.push(null);
    buf.push('A');
    buf.push(null);
    buf.push('A');
    expect(buf.snapshot()).toEqual({ stable: true, stationId: 'A', count: 3 });
  });

  it('reset()은 buffer 비움', () => {
    const buf = createConsensusStabilityBuffer();
    buf.push('A');
    buf.push('A');
    buf.push('A');
    buf.reset();
    expect(buf.snapshot()).toEqual({ stable: false, stationId: null, count: 0 });
  });

  it('size=5 / threshold=3 커스터마이즈 (테스트 결정성 확보용)', () => {
    const buf = createConsensusStabilityBuffer({ size: 3, threshold: 2 });
    buf.push('A');
    expect(buf.push('A').stable).toBe(true);
  });

  it('threshold=1이면 첫 push에서 stable=true', () => {
    const buf = createConsensusStabilityBuffer({ size: 3, threshold: 1 });
    expect(buf.push('A').stable).toBe(true);
  });

  it('size=1이면 마지막 1건만 보존', () => {
    const buf = createConsensusStabilityBuffer({ size: 1, threshold: 1 });
    buf.push('A');
    const r = buf.push('B');
    expect(r).toEqual({ stable: true, stationId: 'B', count: 1 });
  });
});
