import { describe, expect, it } from 'vitest';
import { planLockReanchor } from '../lockReanchor';
import type { TripProgress } from '../progress';
import { waypointSignatureKey } from '../trips';
import type { BoardingLockMeta, Trip, Waypoint } from '../types';

// #2308 PR-2 — lock 시작 재고정: lock이 붙는 순간 trip.waypoints가 이미 탑승역보다 앞서 잘려 있으면
// (lockless cron 전진 / register 점프) 그 사이 역이 segment에서도 waypoints에서도 사라진다 -> 영구 무발사.
// 세션 노선 원본(routeWaypoints)에서 탑승역 다음부터 다시 깐다. 11/02 실측: 어린이대공원·군자 무발사.
describe('planLockReanchor (#2308)', () => {
  const wp = (stationName: string, line: string, kind: Waypoint['kind'], hopIndex: number): Waypoint => ({
    stationName,
    line,
    kind,
    hopIndex,
  });
  /** D1 1956 existingSig(11/02): 성수(2) -> 건대입구(2, transfer) -> 7호선 어대·군자·중곡 -> 용마산. */
  const ROUTE: Waypoint[] = [
    wp('성수', '2', 'intermediate', 0),
    wp('건대입구', '2', 'transfer', 1),
    wp('어린이대공원(세종대)', '7', 'intermediate', 2),
    wp('군자(능동)', '7', 'intermediate', 3),
    wp('중곡', '7', 'intermediate', 4),
    wp('용마산', '7', 'destination', 5),
  ];
  const lock = (segmentStations: string[], overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta => ({
    trainCode: '7320',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: 0,
    segmentStations,
    expiresAt: 1,
    ...overrides,
  });
  const tripOf = (waypoints: Waypoint[], boardingLock: BoardingLockMeta, routeWaypoints: Waypoint[] | undefined = ROUTE): Trip =>
    ({ token: 'tok', waypoints, boardingLock, ...(routeWaypoints ? { routeWaypoints } : {}) }) as unknown as Trip;

  it('11/02: 탑승역(건대입구) 다음이 아니라 head가 점프해 있으면 routeWaypoints로 어대부터 다시 깔고 segmentStations를 재생성한다', () => {
    const jumped = [ROUTE[4], ROUTE[5]]; // [중곡, 용마산] — 어대·군자가 지워진 상태
    const trip = tripOf(jumped, lock(['건대입구', '중곡', '용마산']));
    const decision = planLockReanchor(trip, null);
    expect(decision).not.toBeNull();
    expect(decision?.waypoints.map((w) => w.stationName)).toEqual(['어린이대공원(세종대)', '군자(능동)', '중곡', '용마산']);
    expect(decision?.segmentStations).toEqual(['건대입구', '어린이대공원(세종대)', '군자(능동)', '중곡', '용마산']);
    expect(decision).toMatchObject({ fromKey: waypointSignatureKey(ROUTE[4]), toKey: waypointSignatureKey(ROUTE[2]) });
  });

  it('progress가 같은 trainCode로 이미 있으면(진행 중인 lock) epoch 시작이 아니므로 null', () => {
    const progress: TripProgress = { trainCode: '7320', shiftedCount: 0, headKey: waypointSignatureKey(ROUTE[4]) };
    expect(planLockReanchor(tripOf([ROUTE[4], ROUTE[5]], lock(['건대입구', '중곡', '용마산'])), progress)).toBeNull();
  });

  it('progress가 다른 trainCode의 것이면(번호 변경/새 lock) epoch 시작으로 본다', () => {
    const stale: TripProgress = { trainCode: 'OLD', shiftedCount: 0, headKey: waypointSignatureKey(ROUTE[4]) };
    expect(planLockReanchor(tripOf([ROUTE[4], ROUTE[5]], lock(['건대입구', '중곡', '용마산'])), stale)).not.toBeNull();
  });

  it('head가 이미 탑승역 바로 다음(start)이면 null — 정상 lock은 건드리지 않는다', () => {
    const normal = ROUTE.slice(2);
    expect(planLockReanchor(tripOf(normal, lock(['건대입구', ...normal.map((w) => w.stationName)])), null)).toBeNull();
  });

  it('head가 탑승역 기준으로 뒤쪽(trip이 뒤)이면 null — 앞으로만 움직인다(전진 방향 재고정만)', () => {
    const behind = ROUTE.slice(1); // head = 건대입구 transfer (탑승역 자신, start보다 앞)
    expect(planLockReanchor(tripOf(behind, lock(['건대입구', '어린이대공원(세종대)'])), null)).toBeNull();
  });

  it('routeWaypoints가 없으면(구 trip) null — fail-closed', () => {
    expect(planLockReanchor(tripOf([ROUTE[4], ROUTE[5]], lock(['건대입구', '중곡', '용마산']), undefined), null)).toBeNull();
  });

  it('탑승역이 노선에 없으면(leg-1 출발역) start=0 — 첫 waypoint가 lock 노선이고 head가 그보다 앞서 있을 때만 재고정', () => {
    const leg1Route = [ROUTE[0], ROUTE[1]];
    const lockLeg1 = lock(['뚝섬', '성수', '건대입구'], { line: '2' });
    // head가 성수(첫 waypoint)면 이미 정상 -> null
    expect(planLockReanchor(tripOf([ROUTE[0], ROUTE[1]], lockLeg1, leg1Route), null)).toBeNull();
    // head가 건대입구로 점프해 성수가 지워졌으면 성수부터 다시 깐다
    const decision = planLockReanchor(tripOf([ROUTE[1]], lockLeg1, leg1Route), null);
    expect(decision?.waypoints.map((w) => w.stationName)).toEqual(['성수', '건대입구']);
    expect(decision?.segmentStations).toEqual(['뚝섬', '성수', '건대입구']);
  });

  it('탑승역 다음 waypoint의 노선이 lock 노선과 다르면 null (노선 불일치 재고정 금지)', () => {
    // 건대입구(2호선 transfer) 다음이 7호선인데 lock이 2호선이라면 start 노선 불일치
    expect(planLockReanchor(tripOf([ROUTE[4], ROUTE[5]], lock(['건대입구', '중곡', '용마산'], { line: '2' })), null)).toBeNull();
  });

  it('head가 routeWaypoints에 없으면(다른 노선 데이터) null', () => {
    const foreign = [wp('강남', '2', 'destination', 0)];
    expect(planLockReanchor(tripOf(foreign, lock(['건대입구', '강남'])), null)).toBeNull();
  });

  it('번호 변경 lock(segmentStations[0]이 현재 head)이면 head가 start보다 뒤가 아니므로 null', () => {
    // vanish-swap lock: segmentStations[0] = swap 시점의 현재 waypoint(중곡), 탑승역 prepend 없음.
    expect(planLockReanchor(tripOf([ROUTE[4], ROUTE[5]], lock(['중곡', '용마산'])), null)).toBeNull();
  });

  it('탑승역이 노선에 여러 번 나오면(순환/회차) 마지막 일치 위치 기준', () => {
    const loop: Waypoint[] = [
      wp('A', '2', 'intermediate', 0),
      wp('B', '2', 'intermediate', 1),
      { ...wp('A', '2', 'intermediate', 2), occurrenceIdx: 1 },
      wp('C', '2', 'intermediate', 3),
      wp('D', '2', 'destination', 4),
    ];
    const decision = planLockReanchor(tripOf([loop[4]], lock(['A', 'C', 'D'], { line: '2' }), loop), null);
    expect(decision?.waypoints.map((w) => w.stationName)).toEqual(['C', 'D']);
  });

  it('입력 trip을 변경하지 않는다(순수)', () => {
    const trip = tripOf([ROUTE[4], ROUTE[5]], lock(['건대입구', '중곡', '용마산']));
    const before = JSON.stringify(trip);
    planLockReanchor(trip, null);
    expect(JSON.stringify(trip)).toBe(before);
  });
});
