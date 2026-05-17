import { groupStationsByName } from '../groupStationsByName';
import type { Station } from '../../types/station';

const make = (overrides: Partial<Station> & Pick<Station, 'id' | 'name' | 'line'>): Station => ({
  lineColor: '#000',
  lat: 37.5,
  lng: 127,
  ...overrides,
});

describe('groupStationsByName', () => {
  it('빈 배열을 빈 배열로 반환한다', () => {
    expect(groupStationsByName([])).toEqual([]);
  });

  it('단일 호선 역은 stations 1개짜리 그룹', () => {
    const s = make({ id: '7-705', name: '용마산', line: '7', lat: 37.6, lng: 127.0 });
    const groups = groupStationsByName([s]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('용마산');
    expect(groups[0].stations).toEqual([s]);
    expect(groups[0].lat).toBe(37.6);
    expect(groups[0].lng).toBe(127.0);
    expect(groups[0].representativeName).toBe('용마산');
  });

  it('동일 이름 환승역은 한 그룹으로 묶고 호선 순(LINE_COLORS key 순)으로 정렬', () => {
    const l6 = make({ id: '6-636', name: '청구', line: '6', lat: 37.5605, lng: 127.0136 });
    const l5 = make({ id: '5-540', name: '청구', line: '5', lat: 37.5605, lng: 127.0136 });
    const groups = groupStationsByName([l6, l5]);
    expect(groups).toHaveLength(1);
    expect(groups[0].stations.map((s) => s.line)).toEqual(['5', '6']);
  });

  it('후행 괄호 부제는 정규화 키로 흡수한다', () => {
    const sangbong7 = make({ id: '7-722', name: '상봉', line: '7' });
    const sangbongK = make({
      id: 'gyeongui-001',
      name: '상봉(시외버스터미널)',
      line: 'gyeongui',
    });
    const groups = groupStationsByName([sangbong7, sangbongK]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('상봉');
    expect(groups[0].representativeName).toBe('상봉');
  });

  it('그룹 좌표는 멤버 평균', () => {
    const a = make({ id: 'a', name: '서울역', line: '1', lat: 37.554, lng: 126.971 });
    const b = make({ id: 'b', name: '서울역', line: '4', lat: 37.552, lng: 126.973 });
    const groups = groupStationsByName([a, b]);
    expect(groups[0].lat).toBeCloseTo(37.553, 3);
    expect(groups[0].lng).toBeCloseTo(126.972, 3);
  });

  it('representativeName은 그룹 내 가장 짧은 name', () => {
    const a = make({ id: 'a', name: '왕십리(성동구청)', line: '2' });
    const b = make({ id: 'b', name: '왕십리', line: '5' });
    const groups = groupStationsByName([a, b]);
    expect(groups[0].representativeName).toBe('왕십리');
  });

  it('서로 다른 정규화 이름은 별개 그룹', () => {
    const a = make({ id: 'a', name: '강남', line: '2' });
    const b = make({ id: 'b', name: '선릉', line: '2' });
    const groups = groupStationsByName([a, b]);
    expect(groups).toHaveLength(2);
  });

  it('이름이 닫는 괄호로 끝나지 않으면 정규화하지 않는다', () => {
    const s = make({ id: 'x', name: '강남', line: '2' });
    expect(groupStationsByName([s])[0].key).toBe('강남');
  });

  it('이름에 여는 괄호가 없으면 정규화하지 않는다 (방어적 케이스)', () => {
    // 닫는 괄호로 끝나지만 여는 괄호가 없는 비정상 이름 — 그대로 유지
    const s = make({ id: 'x', name: '이상한이름)', line: '2' });
    const groups = groupStationsByName([s]);
    expect(groups[0].key).toBe('이상한이름)');
  });

  it('단일 호선 + 괄호 부제만 있는 역(예: 광교(경기대))은 representativeName이 원본 그대로', () => {
    const s = make({ id: 'sinbundang-001', name: '광교(경기대)', line: 'sinbundang' });
    const groups = groupStationsByName([s]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('광교');
    expect(groups[0].representativeName).toBe('광교(경기대)');
    expect(groups[0].stations[0].id).toBe('sinbundang-001');
  });
});
