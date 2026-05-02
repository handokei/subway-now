import type { Station } from '../types/station';

interface BuildMapHtmlParams {
  apiKey: string;
  userLat: number;
  userLng: number;
  nearestStation: Station | null;
  nearbyStations: Station[];
}

export function buildMapHtml({
  apiKey,
  userLat,
  userLng,
  nearestStation,
  nearbyStations,
}: BuildMapHtmlParams): string {
  const stationsJson = JSON.stringify(
    nearbyStations.map((s) => ({
      ...s,
      isNearest: nearestStation?.id === s.id,
    })),
  );

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;}
#map{width:100%;height:100%;}
</style>
</head>
<body>
<div id="map"></div>
<script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${apiKey}&autoload=false&libraries=clusterer"></script>
<script>
window.onerror = function(msg) {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'error', message: String(msg) }));
  return true;
};

kakao.maps.load(function(){
  try {
    var map = new kakao.maps.Map(document.getElementById('map'), {
      center: new kakao.maps.LatLng(${userLat}, ${userLng}),
      level: 5
    });

    var userEl = document.createElement('div');
    userEl.style.cssText = 'width:14px;height:14px;border-radius:50%;background:#4A90D9;border:3px solid #fff;box-shadow:0 0 6px rgba(0,0,0,0.3);';
    new kakao.maps.CustomOverlay({
      position: new kakao.maps.LatLng(${userLat}, ${userLng}),
      content: userEl,
      map: map,
      zIndex: 10
    });

    var stations = ${stationsJson};
    var markers = stations.map(function(s) {
      var marker = new kakao.maps.Marker({
        position: new kakao.maps.LatLng(s.lat, s.lng)
      });
      kakao.maps.event.addListener(marker, 'click', function() {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'stationPress', station: s }));
        }
      });
      return marker;
    });

    new kakao.maps.MarkerClusterer({
      map: map,
      markers: markers,
      gridSize: 60,
      minLevel: 5,
      disableClickZoom: false
    });

    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'mapLoaded' }));
  } catch(e) {
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'error', message: e.message }));
  }
});
</script>
</body>
</html>`;
}
