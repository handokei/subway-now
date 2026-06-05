import { saveStationToWidget, clearWidgetStation } from '../widgetStorage.web';
import { Station } from '../../shared/types/station';

const mockStation: Station = {
  id: '2-001',
  name: '강남',
  line: '2',
  lineColor: '#009933',
  lat: 37.4979,
  lng: 127.0276,
};

describe('widgetStorage.web (no-op)', () => {
  it('saveStationToWidget은 아무 작업도 하지 않고 완료된다', async () => {
    await expect(saveStationToWidget(mockStation, 0.12)).resolves.toBeUndefined();
  });

  it('clearWidgetStation은 아무 작업도 하지 않고 완료된다', async () => {
    await expect(clearWidgetStation()).resolves.toBeUndefined();
  });
});