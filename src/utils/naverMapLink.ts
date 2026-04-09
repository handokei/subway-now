export function buildNaverMapAppUrl(lat: number, lng: number, name: string): string {
  return `nmap://place?lat=${lat}&lng=${lng}&name=${encodeURIComponent(name)}&appname=com.subwaynow.app`;
}

export function buildNaverMapWebUrl(lat: number, lng: number, name: string): string {
  return `https://map.naver.com/v5/search/${encodeURIComponent(name)}`;
}
