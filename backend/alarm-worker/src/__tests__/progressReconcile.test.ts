import { describe, expect, it } from 'vitest';
import { reconcileTripWithProgress, type TripProgress } from '../progress';
import { waypointSignatureKey } from '../trips';
import type { Trip, Waypoint } from '../types';

// #2308 PR-2 — cron 맞춤(reconcile): progress KV가 진행 위치의 권위, trip.waypoints는 노선 정의 사본.
// 순수 판정: "앞으로만" 맞추고, head는 hopIndex가 아니라 내용 키(waypointSignatureKey)로 식별한다.
describe('reconcileTripWithProgress (#2308)', () => {
  const wp = (stationName: string, hopIndex: number, kind: Waypoint['kind'] = 'intermediate'): Waypoint => ({
    stationName,
    line: '7',
    kind,
    hopIndex,
  });
  const lockedTrip = (waypoints: Waypoint[], trainCode = 'T1'): Trip =>
    ({
      token: 'tok',
      waypoints,
      boardingLock: { trainCode, line: '7', subwayId: '1007', selectedDepartureTime: 0, segmentStations: [], expiresAt: 1 },
      lastTrackedArrivalEpoch: 1,
      lastLaPushEpoch: 2,
      lastLaPushAt: 3,
      consecutiveEtaMissing: 4,
    }) as unknown as Trip;
  const progressAt = (head: Waypoint, overrides: Partial<TripProgress> = {}): TripProgress => ({
    trainCode: 'T1',
    shiftedCount: 0,
    headKey: waypointSignatureKey(head),
    lastTrackedArrivalEpoch: 11,
    lastLaPushEpoch: 22,
    lastLaPushAt: 33,
    consecutiveEtaMissing: 0,
    ...overrides,
  });
  const names = (decision: { waypoints: Waypoint[] } | null) => decision?.waypoints.map((w) => w.stationName);

  it('progress head가 trip.waypoints[i>0]이면 i만큼 앞으로 자르고 기준값을 progress 값으로 덮는다 (10/31 되돌림 복구)', () => {
    const route = [wp('강남구청', 6), wp('학동', 7), wp('논현', 8, 'destination')];
    const decision = reconcileTripWithProgress(lockedTrip(route), progressAt(route[1]));
    expect(names(decision)).toEqual(['학동', '논현']);
    expect(decision).toMatchObject({
      advancedBy: 1,
      baseline: { lastTrackedArrivalEpoch: 11, lastLaPushEpoch: 22, lastLaPushAt: 33, consecutiveEtaMissing: 0 },
    });
  });

  it('head가 이미 trip의 첫 waypoint면(i=0) 자르지 않고 기준값만 덮는다 (재등록이 undefined로 지운 LA 기준값 복원)', () => {
    const route = [wp('학동', 7), wp('논현', 8, 'destination')];
    const decision = reconcileTripWithProgress(lockedTrip(route), progressAt(route[0]));
    expect(decision).toMatchObject({ advancedBy: 0, baseline: { lastLaPushEpoch: 22, lastLaPushAt: 33 } });
    expect(names(decision)).toEqual(['학동', '논현']);
  });

  it('trip이 progress보다 앞서 있으면(i=-1, sync 전진) null — 뒤로 가지 않고 기준값도 덮지 않는다', () => {
    const route = [wp('강남구청', 6), wp('학동', 7), wp('논현', 8, 'destination')];
    expect(reconcileTripWithProgress(lockedTrip(route.slice(2)), progressAt(route[0]))).toBeNull();
  });

  it('hopIndex가 서로 달라도(device 재등록이 배열 위치로 다시 매김) 내용 키로 같은 역을 식별한다', () => {
    const progressHead = wp('군자', 3);
    const reindexed = [wp('어린이대공원', 0), wp('군자', 1), wp('중곡', 2), wp('용마산', 3, 'destination')];
    const decision = reconcileTripWithProgress(lockedTrip(reindexed), progressAt(progressHead));
    expect(names(decision)).toEqual(['군자', '중곡', '용마산']);
  });

  it('같은 hopIndex의 다른 역은 head로 보지 않는다 (hopIndex 우연 일치가 군자를 건너뛰던 11/02 결함의 반례)', () => {
    const reindexed = [wp('건대입구', 0), wp('어린이대공원', 1), wp('군자', 2), wp('중곡', 3), wp('용마산', 4, 'destination')];
    const progressHeadWithHop3 = wp('군자', 3);
    const decision = reconcileTripWithProgress(lockedTrip(reindexed), progressAt(progressHeadWithHop3));
    expect(names(decision)).toEqual(['군자', '중곡', '용마산']);
    expect(names(decision)).not.toContain('어린이대공원');
  });

  it.each([
    ['trainCode 불일치', { trainCode: 'OTHER' }],
    ['headKey 없는 legacy progress', { headKey: undefined }],
    ['lockless progress(trainCode 없음)', { trainCode: undefined, lockless: true as const }],
  ])('%s -> null (추측 slice 금지)', (_label, patch) => {
    const route = [wp('강남구청', 6), wp('학동', 7), wp('논현', 8, 'destination')];
    const progress = { ...progressAt(route[1]), ...patch } as TripProgress;
    expect(reconcileTripWithProgress(lockedTrip(route), progress)).toBeNull();
  });

  it('lock 없는 trip -> null', () => {
    const route = [wp('강남구청', 6), wp('학동', 7)];
    const trip = { ...lockedTrip(route), boardingLock: undefined } as Trip;
    expect(reconcileTripWithProgress(trip, progressAt(route[1]))).toBeNull();
  });

  it('progress 없음 -> null', () => {
    expect(reconcileTripWithProgress(lockedTrip([wp('학동', 7)]), null)).toBeNull();
  });

  it('입력 trip/progress를 변경하지 않는다(순수)', () => {
    const route = [wp('강남구청', 6), wp('학동', 7), wp('논현', 8, 'destination')];
    const trip = lockedTrip(route);
    const before = JSON.stringify(trip);
    reconcileTripWithProgress(trip, progressAt(route[1]));
    expect(JSON.stringify(trip)).toBe(before);
  });
});
