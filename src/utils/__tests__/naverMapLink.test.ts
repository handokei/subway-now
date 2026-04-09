import { buildNaverMapAppUrl, buildNaverMapWebUrl } from '../naverMapLink';

describe('buildNaverMapAppUrl', () => {
  it('nmap:// scheme으로 URL을 생성한다', () => {
    const url = buildNaverMapAppUrl(37.4979, 127.0276, '강남');
    expect(url).toBe('nmap://place?lat=37.4979&lng=127.0276&name=%EA%B0%95%EB%82%A8&appname=com.subwaynow.app');
  });

  it('역 이름이 인코딩된다', () => {
    const url = buildNaverMapAppUrl(37.5, 127.0, '서울역');
    expect(url).toContain(encodeURIComponent('서울역'));
  });
});

describe('buildNaverMapWebUrl', () => {
  it('네이버 지도 웹 URL을 생성한다', () => {
    const url = buildNaverMapWebUrl(37.4979, 127.0276, '강남');
    expect(url).toBe('https://map.naver.com/v5/search/%EA%B0%95%EB%82%A8');
  });

  it('역 이름이 인코딩된다', () => {
    const url = buildNaverMapWebUrl(37.5, 127.0, '서울역');
    expect(url).toContain(encodeURIComponent('서울역'));
  });
});
