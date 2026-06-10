import { ServiceWindowBanner } from '../ServiceWindowBanner';
import { renderWithTheme } from '../../../testUtils/renderWithTheme';
import * as serviceWindowModule from '../../../features/route/utils/serviceWindow';

/**
 * #1066 — getServiceWindow 4개 분기(pre-first / in-service / post-last / unknown)별
 * 렌더링 동작을 검증한다. now 주입으로 시각을 통제하고, 소요산(1호선) timetable을
 * fixture로 사용한다(weekday first ~05:53, last 익일 00:36).
 */
describe('ServiceWindowBanner', () => {
  // 토요일(2026-06-06) 시청(2호선): first=05:31, last=23:58 (overnight 없음 → pre-first 분기 도달 가능)
  const PRE_FIRST_SAT_KST_04_00 = new Date('2026-06-06T04:00:00+09:00');
  // 월요일(2026-06-08) 평일 KST 10:00 — 어느 역이든 운행 중
  const IN_SERVICE_KST_10_00 = new Date('2026-06-08T10:00:00+09:00');

  it('pre-first 상태에서 배너와 첫차 시각을 노출한다', () => {
    const { getByTestId } = renderWithTheme(
      <ServiceWindowBanner stationName="시청" line="2" now={PRE_FIRST_SAT_KST_04_00} />,
    );
    const text = getByTestId('service-window-banner-text').props.children as string;
    expect(text).toContain('첫차 전');
    expect(text).toContain('05:31');
  });

  it('post-last 상태에서 배너와 첫차 시각을 노출한다', () => {
    // 소요산(1호선) weekday: last 24:36 → KST 02:00 = post-last (>00:36 그리고 <첫차 05:46)
    const POST_LAST_MON_KST_02_00 = new Date('2026-06-08T02:00:00+09:00');
    const { getByTestId } = renderWithTheme(
      <ServiceWindowBanner stationName="소요산" line="1" now={POST_LAST_MON_KST_02_00} />,
    );
    const text = getByTestId('service-window-banner-text').props.children as string;
    expect(text).toContain('막차 후');
    expect(text).toContain('05:46');
  });

  it('in-service 상태에서는 아무것도 렌더하지 않는다(null)', () => {
    const { queryByTestId } = renderWithTheme(
      <ServiceWindowBanner stationName="소요산" line="1" now={IN_SERVICE_KST_10_00} />,
    );
    expect(queryByTestId('service-window-banner')).toBeNull();
  });

  it('unknown 상태(timetable 없는 노선)에서는 null', () => {
    const { queryByTestId } = renderWithTheme(
      <ServiceWindowBanner stationName="청량리" line="bundang" now={IN_SERVICE_KST_10_00} />,
    );
    expect(queryByTestId('service-window-banner')).toBeNull();
  });

  it('now 미지정 시 현재 시각으로 fallback (smoke)', () => {
    // 분기 결과는 시각 의존이라 단정하지 않고, 호출이 throw 없이 끝나는지만 확인.
    expect(() =>
      renderWithTheme(<ServiceWindowBanner stationName="소요산" line="1" />),
    ).not.toThrow();
  });

  it('getServiceWindow가 throw해도 화면을 크래시시키지 않고 null을 반환한다 (#1083)', () => {
    // Hermes/iOS Intl 구현에서 timeZone+formatToParts(weekday)가 part를 누락해
    // TypeError를 던지는 회귀가 관측됐다. 배너는 보조 UI이므로 안전망이 필요하다.
    const spy = jest.spyOn(serviceWindowModule, 'getServiceWindow').mockImplementation(() => {
      throw new TypeError("Cannot read property 'value' of undefined");
    });
    try {
      const { queryByTestId } = renderWithTheme(
        <ServiceWindowBanner stationName="강남" line="2" now={IN_SERVICE_KST_10_00} />,
      );
      expect(queryByTestId('service-window-banner')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
