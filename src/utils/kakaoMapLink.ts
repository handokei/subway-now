/**
 * 카카오맵 앱 딥링크 및 웹 URL 생성 유틸리티
 */

/**
 * 카카오맵 앱 딥링크 URL 반환
 * 앱 설치 여부는 호출 측에서 Linking.canOpenURL로 확인
 */
export function buildKakaoMapAppUrl(lat: number, lng: number): string {
  return `kakaomap://look?p=${lat},${lng}`;
}

/**
 * 카카오맵 웹 URL 반환 (앱 미설치 fallback)
 */
export function buildKakaoMapWebUrl(name: string, lat: number, lng: number): string {
  return `https://map.kakao.com/link/map/${encodeURIComponent(name)},${lat},${lng}`;
}
