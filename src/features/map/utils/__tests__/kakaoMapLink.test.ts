import { buildKakaoMapAppUrl, buildKakaoMapWebUrl } from '../kakaoMapLink';

describe('buildKakaoMapAppUrl', () => {
  it('카카오맵 앱 딥링크 URL을 반환한다', () => {
    const url = buildKakaoMapAppUrl(37.4979, 127.0276);
    expect(url).toBe('kakaomap://look?p=37.4979,127.0276');
  });
});

describe('buildKakaoMapWebUrl', () => {
  it('카카오맵 웹 URL을 반환한다', () => {
    const url = buildKakaoMapWebUrl('강남', 37.4979, 127.0276);
    expect(url).toBe('https://map.kakao.com/link/map/%EA%B0%95%EB%82%A8,37.4979,127.0276');
  });

  it('역 이름에 공백이 있으면 인코딩한다', () => {
    const url = buildKakaoMapWebUrl('신도림 역', 37.5085, 126.8913);
    expect(url).toContain('%EC%8B%A0%EB%8F%84%EB%A6%BC%20%EC%97%AD');
  });
});
