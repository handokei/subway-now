import { readStoredRoute } from '../storedRoute';
import { canonicalStationName } from '../../../testUtils/canonicalStationName';

const mockLogMigrationFailed = jest.fn();
jest.mock('../../../features/alarm/utils/alarmLog', () => ({
  logStoredRouteMigrationFailed: (...args: unknown[]) => mockLogMigrationFailed(...args),
}));

const SADANG_2 = '2-026';
const SADANG_4 = '4-025';

const DEST_SADANG_4 = JSON.stringify({
  id: SADANG_4,
  name: canonicalStationName('사당', '4'),
  line: '4',
});

beforeEach(() => {
  mockLogMigrationFailed.mockReset();
});

describe('readStoredRoute (#3177 PR-2a)', () => {
  it('id 없는 구버전 환승 경로가 사당 2-026 / 4-025로 채워진다', () => {
    const legacy = {
      type: 'transfer',
      transferName: canonicalStationName('사당', '2'),
      fromLine: '2',
      toLine: '4',
      stopsToTransfer: 5,
      stopsFromTransfer: 3,
      secondsToTransfer: 600,
      secondsFromTransfer: 400,
    };
    const route = readStoredRoute(JSON.stringify(legacy), DEST_SADANG_4);
    expect(route).toEqual({ ...legacy, transferStationId: SADANG_2, destinationStationId: SADANG_4 });
    expect(mockLogMigrationFailed).not.toHaveBeenCalled();
  });

  it('id 없는 구버전 직행 경로는 destinationStationId만 채워진다', () => {
    const legacy = { type: 'direct', stops: 3, line: '4', travelSeconds: 300 };
    const route = readStoredRoute(JSON.stringify(legacy), DEST_SADANG_4);
    expect(route).toEqual({ ...legacy, destinationStationId: SADANG_4 });
  });

  it('다중 환승은 각 transfers[]에 transferStationId, 말단에 destinationStationId가 채워진다', () => {
    const legacy = {
      type: 'multi-transfer',
      transfers: [
        {
          transferName: canonicalStationName('사당', '2'),
          fromLine: '2',
          toLine: '4',
          stopsToTransfer: 5,
          secondsToTransfer: 600,
        },
      ],
      stopsAfterLastTransfer: 3,
      secondsAfterLastTransfer: 400,
    };
    const route = readStoredRoute(JSON.stringify(legacy), DEST_SADANG_4);
    expect(route).toEqual({
      ...legacy,
      transfers: [{ ...legacy.transfers[0], transferStationId: SADANG_2 }],
      destinationStationId: SADANG_4,
    });
  });

  it('이미 id가 있으면 덮어쓰지 않는다 (신버전 저장분 보존)', () => {
    const modern = {
      type: 'transfer',
      transferName: canonicalStationName('사당', '2'),
      transferStationId: 'KEEP-T',
      destinationStationId: 'KEEP-D',
      fromLine: '2',
      toLine: '4',
      stopsToTransfer: 5,
      stopsFromTransfer: 3,
      secondsToTransfer: 600,
      secondsFromTransfer: 400,
    };
    expect(readStoredRoute(JSON.stringify(modern), DEST_SADANG_4)).toEqual(modern);
  });

  it('route raw가 null이면 null (로그 없음)', () => {
    expect(readStoredRoute(null, DEST_SADANG_4)).toBeNull();
    expect(mockLogMigrationFailed).not.toHaveBeenCalled();
  });

  it('JSON 문자열 "null"이면 null', () => {
    expect(readStoredRoute('null', DEST_SADANG_4)).toBeNull();
  });

  it('깨진 route JSON은 null', () => {
    expect(readStoredRoute('not-json{{', DEST_SADANG_4)).toBeNull();
  });

  it('환승역 조회 실패는 null + route-migration-failed 로그', () => {
    const legacy = {
      type: 'transfer',
      transferName: '없는역이름XYZ',
      fromLine: '2',
      toLine: '4',
      stopsToTransfer: 5,
      stopsFromTransfer: 3,
      secondsToTransfer: 600,
      secondsFromTransfer: 400,
    };
    expect(readStoredRoute(JSON.stringify(legacy), DEST_SADANG_4)).toBeNull();
    expect(mockLogMigrationFailed).toHaveBeenCalledTimes(1);
    expect(mockLogMigrationFailed).toHaveBeenCalledWith('없는역이름XYZ');
  });

  it('다중 환승 중 한 구간 조회 실패도 null + 로그', () => {
    const legacy = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '없는역이름XYZ', fromLine: '2', toLine: '4', stopsToTransfer: 1, secondsToTransfer: 1 },
      ],
      stopsAfterLastTransfer: 3,
      secondsAfterLastTransfer: 400,
    };
    expect(readStoredRoute(JSON.stringify(legacy), DEST_SADANG_4)).toBeNull();
    expect(mockLogMigrationFailed).toHaveBeenCalledWith('없는역이름XYZ');
  });

  it.each([
    ['목적지 raw null', null],
    ['목적지 깨진 JSON', 'not-json{{'],
    ['목적지에 id 없음', JSON.stringify({ name: '사당' })],
    ['목적지 JSON null', 'null'],
  ])('destinationStationId를 채울 수 없으면(%s) null + 로그', (_label, destRaw) => {
    const legacy = { type: 'direct', stops: 3, line: '4', travelSeconds: 300 };
    expect(readStoredRoute(JSON.stringify(legacy), destRaw)).toBeNull();
    expect(mockLogMigrationFailed).toHaveBeenCalledTimes(1);
  });

  it('목적지 id가 이미 경로에 있으면 목적지 raw가 없어도 통과한다', () => {
    const modern = { type: 'direct', stops: 3, line: '4', travelSeconds: 300, destinationStationId: SADANG_4 };
    expect(readStoredRoute(JSON.stringify(modern), null)).toEqual(modern);
  });
});
