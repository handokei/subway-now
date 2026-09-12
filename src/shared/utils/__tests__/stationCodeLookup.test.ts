import { getStationCode } from '../stationCodeLookup';

jest.mock('../../../data/stationCodes.json', () => ({
  '2-009': { stationCd: '0228', frCode: '210' },
  '5-026': { stationCd: '2525', frCode: '524' },
}));

describe('getStationCode', () => {
  it('returns the matched entry for a known stationsJsonId', () => {
    expect(getStationCode('2-009')).toEqual({ stationCd: '0228', frCode: '210' });
  });

  it('returns the second mock entry to cover multi-line indexing', () => {
    expect(getStationCode('5-026')).toEqual({ stationCd: '2525', frCode: '524' });
  });

  it('returns null when the stationsJsonId is not mapped', () => {
    expect(getStationCode('99-999')).toBeNull();
  });

  it('returns null for an empty string id', () => {
    expect(getStationCode('')).toBeNull();
  });
});
