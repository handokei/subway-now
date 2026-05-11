import { findNearestStation, findNearestStations } from '../findNearestStation';

// haversine을 모킹하여 어떤 역이 가장 가깝게 계산되는지 완전히 제어한다.
// stations.json 데이터가 크므로 haversine 결과를 고정하여 루프 분기를 독립적으로 검증한다.
const mockHaversine = jest.fn();
jest.mock('../haversine', () => ({
  haversine: (...args: unknown[]) => mockHaversine(...args),
}));

describe('findNearestStation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return the station with minimum haversine distance', () => {
    // 모든 역에 대해 큰 값을 반환하다가 특정 호출에서만 작은 값을 반환
    // stations.json 에는 528개 역이 있으므로 첫 번째 역만 0.1 km로 설정
    mockHaversine.mockReturnValue(5); // 기본값: 모든 역 5km
    // 첫 번째 호출만 0.1km — 소요산(1-001)
    mockHaversine.mockReturnValueOnce(0.1);

    const result = findNearestStation(37.9481, 127.061034);

    expect(result).not.toBeNull();
    expect(result!.station.id).toBe('1-001'); // 소요산
    expect(result!.distanceKm).toBe(0.1);
  });

  it('should return null when stations array is empty (mocked via module reset)', () => {
    // stations.json을 빈 배열로 모킹하려면 모듈을 재설정해야 한다.
    // jest.resetModules를 활용한 격리 테스트
    jest.resetModules();

    jest.doMock('../haversine', () => ({ haversine: jest.fn() }));
    jest.doMock('../../data/stations.json', () => []);

    const { findNearestStation: fn } = require('../findNearestStation');
    const result = fn(37.5, 127.0);
    expect(result).toBeNull();

    jest.resetModules();
  });

  it('should update nearest when a later station has smaller distance', () => {
    // 두 번째 역이 더 가까운 경우를 시뮬레이션
    // 첫 호출: 3km, 두 번째 호출: 1km, 이후 모두 5km
    mockHaversine
      .mockReturnValueOnce(3) // 첫 번째 역 3km
      .mockReturnValueOnce(1) // 두 번째 역 1km (동두천 1-002)
      .mockReturnValue(5);    // 나머지 모두 5km

    const result = findNearestStation(37.927878, 127.05479);

    expect(result).not.toBeNull();
    expect(result!.station.id).toBe('1-002'); // 동두천
    expect(result!.distanceKm).toBe(1);
  });

  it('should return the last station if it is the closest', () => {
    // 마지막 역에 가장 작은 거리를 배정
    // 528개 역 중 마지막 역(sinbundang-016: 광교)이 가장 가깝도록 설정
    mockHaversine.mockReturnValue(10); // 기본값: 10km
    // 마지막 호출(528번째)만 0.05km
    let callCount = 0;
    mockHaversine.mockImplementation(() => {
      callCount++;
      return callCount === 528 ? 0.05 : 10;
    });

    const result = findNearestStation(37.28, 127.04);
    expect(result).not.toBeNull();
    expect(result!.distanceKm).toBe(0.05);
  });

  it('should return nearest result with correct distanceKm value', () => {
    const distanceKm = 0.3;
    mockHaversine.mockReturnValueOnce(distanceKm).mockReturnValue(5);

    const result = findNearestStation(37.9481, 127.061034);

    expect(result).not.toBeNull();
    expect(result!.distanceKm).toBe(distanceKm);
    expect(result!.station).toBeDefined();
    expect(result!.station.id).toBeDefined();
    expect(result!.station.name).toBeDefined();
    expect(result!.station.line).toBeDefined();
    expect(result!.station.lat).toBeDefined();
    expect(result!.station.lng).toBeDefined();
  });

  it('should call haversine with correct lat/lng arguments', () => {
    mockHaversine.mockReturnValue(1);
    const lat = 37.5;
    const lng = 127.0;

    findNearestStation(lat, lng);

    // 첫 호출에 lat/lng가 정확히 전달됐는지 확인
    expect(mockHaversine).toHaveBeenCalledWith(lat, lng, expect.any(Number), expect.any(Number));
    // 528개 역 전체 순회
    expect(mockHaversine).toHaveBeenCalledTimes(528);
  });

  it('should not update nearest when later station distance equals current minimum (strict less-than)', () => {
    // 두 역이 같은 거리일 때 먼저 설정된 역(첫 번째)이 유지된다
    mockHaversine.mockReturnValue(2); // 모든 역이 2km 동일

    const result = findNearestStation(37.5, 127.0);

    expect(result).not.toBeNull();
    // 첫 번째 역(소요산)이 반환되어야 한다 (거리가 같으면 갱신 안 됨)
    expect(result!.station.id).toBe('1-001');
    expect(result!.distanceKm).toBe(2);
  });

  it('maxDistanceKm을 초과하면 null을 반환한다', () => {
    mockHaversine.mockReturnValue(5); // 모든 역 5km

    const result = findNearestStation(37.5, 127.0, 1.0);

    expect(result).toBeNull();
  });

  it('maxDistanceKm 이내일 때 정상적으로 역을 반환한다', () => {
    mockHaversine.mockReturnValueOnce(0.5).mockReturnValue(5);

    const result = findNearestStation(37.5, 127.0, 1.0);

    expect(result).not.toBeNull();
    expect(result!.distanceKm).toBe(0.5);
  });

  it('maxDistanceKm 미지정 시 기존 동작 유지 (거리 무관 반환)', () => {
    mockHaversine.mockReturnValue(100); // 100km (매우 멀음)

    const result = findNearestStation(37.5, 127.0);

    expect(result).not.toBeNull();
    expect(result!.distanceKm).toBe(100);
  });
});

describe('findNearestStations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('가장 가까운 역과 동일 이름 환승역 variants를 반환한다', () => {
    mockHaversine.mockReturnValueOnce(0.1).mockReturnValue(5);

    const result = findNearestStations(37.9481, 127.061034);

    expect(result).not.toBeNull();
    expect(result!.primary.id).toBe('1-001');
    expect(result!.distanceKm).toBe(0.1);
    expect(result!.variants.length).toBeGreaterThanOrEqual(1);
    expect(result!.variants.every((v) => v.name === result!.primary.name)).toBe(true);
  });

  it('빈 stations에서 null을 반환한다', () => {
    jest.resetModules();
    jest.doMock('../haversine', () => ({ haversine: jest.fn() }));
    jest.doMock('../../data/stations.json', () => []);

    const { findNearestStations: fn } = require('../findNearestStation');
    expect(fn(37.5, 127.0)).toBeNull();

    jest.resetModules();
  });

  it('maxDistanceKm을 초과하면 null을 반환한다', () => {
    mockHaversine.mockReturnValue(5);

    const result = findNearestStations(37.5, 127.0, 1.0);

    expect(result).toBeNull();
  });

  it('maxDistanceKm 이내일 때 variants와 함께 반환한다', () => {
    mockHaversine.mockReturnValueOnce(0.2).mockReturnValue(5);

    const result = findNearestStations(37.5, 127.0, 1.0);

    expect(result).not.toBeNull();
    expect(result!.distanceKm).toBe(0.2);
    expect(result!.variants.length).toBeGreaterThanOrEqual(1);
  });
});
