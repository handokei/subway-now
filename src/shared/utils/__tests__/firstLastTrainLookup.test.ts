import { getFirstLastTrainTime } from '../firstLastTrainLookup';

jest.mock('../../../data/firstLastTrainTimes.json', () => ({
  '2-009': {
    weekday: {
      up: { first: '05:18', last: '00:48' },
      down: { first: '05:33', last: '23:50' },
    },
    saturday: {
      up: { first: '05:30', last: '00:30' },
    },
    sunday: {},
  },
  '1-001': {
    weekday: {
      up: { first: '05:53', last: '00:36' },
      down: { first: '05:46', last: '23:47' },
    },
  },
}));

describe('getFirstLastTrainTime', () => {
  it('returns up/down times for a known weekday', () => {
    expect(
      getFirstLastTrainTime({ stationsJsonId: '2-009', dayType: 'weekday', direction: 'up' }),
    ).toEqual({ first: '05:18', last: '00:48' });
  });

  it('returns down times for a known weekday', () => {
    expect(
      getFirstLastTrainTime({ stationsJsonId: '2-009', dayType: 'weekday', direction: 'down' }),
    ).toEqual({ first: '05:33', last: '23:50' });
  });

  it('returns null when the dayType is undefined in the dataset', () => {
    expect(
      getFirstLastTrainTime({ stationsJsonId: '1-001', dayType: 'saturday', direction: 'up' }),
    ).toBeNull();
  });

  it('returns null when the direction is not running on a given day', () => {
    expect(
      getFirstLastTrainTime({ stationsJsonId: '2-009', dayType: 'saturday', direction: 'down' }),
    ).toBeNull();
  });

  it('returns null when the dayType key exists but has no directions', () => {
    expect(
      getFirstLastTrainTime({ stationsJsonId: '2-009', dayType: 'sunday', direction: 'up' }),
    ).toBeNull();
  });

  it('returns null when the station is not in the dataset', () => {
    expect(
      getFirstLastTrainTime({ stationsJsonId: '99-999', dayType: 'weekday', direction: 'up' }),
    ).toBeNull();
  });
});
