import type { Station } from '../types/station';

interface MapConfig {
  apiKey: string;
  userLat: number;
  userLng: number;
  stations: (Station & { isNearest: boolean })[];
}

export function buildMapConfig({
  apiKey,
  userLat,
  userLng,
  nearestStation,
  nearbyStations,
}: {
  apiKey: string;
  userLat: number;
  userLng: number;
  nearestStation: Station | null;
  nearbyStations: Station[];
}): MapConfig {
  return {
    apiKey,
    userLat,
    userLng,
    stations: nearbyStations.map((s) => ({
      ...s,
      isNearest: nearestStation?.id === s.id,
    })),
  };
}

/**
 * WebView에 주입할 JS 문자열 생성.
 * SDK script src 설정 + initMap 호출.
 */
export function buildInjectedJS(config: MapConfig): string {
  const { apiKey, ...rest } = config;
  return `
    (function() {
      var sdk = document.getElementById('kakao-sdk');
      if (sdk) {
        sdk.src = 'https://dapi.kakao.com/v2/maps/sdk.js?appkey=${apiKey}&autoload=false&libraries=clusterer';
      }
      var waitSdk = setInterval(function() {
        if (typeof kakao !== 'undefined' && kakao.maps) {
          clearInterval(waitSdk);
          window.initMap(${JSON.stringify(rest)});
        }
      }, 100);
      setTimeout(function() { clearInterval(waitSdk); }, 10000);
    })();
    true;
  `;
}
