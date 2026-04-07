import { Station } from '../types/station';

interface BuildMapHtmlParams {
  userLat: number;
  userLng: number;
  nearestStation: Station | null;
  nearbyStations: Station[];
  kakaoKey: string;
}

export function buildMapHtml({
  userLat,
  userLng,
  nearestStation,
  nearbyStations,
  kakaoKey,
}: BuildMapHtmlParams): string {
  if (!kakaoKey) {
    return `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;color:#666;"><p>카카오맵 API 키가 필요합니다.</p></body></html>`;
  }

  const stationsJson = JSON.stringify(
    nearbyStations.map((s) => ({
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      color: s.lineColor,
      isNearest: nearestStation?.id === s.id,
    }))
  );

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body, #map { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script type="text/javascript" src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${kakaoKey}"></script>
  <script>
    var container = document.getElementById('map');
    var options = {
      center: new kakao.maps.LatLng(${userLat}, ${userLng}),
      level: 4
    };
    var map = new kakao.maps.Map(container, options);

    // 현재 위치 마커 (파란 원)
    var userCircle = new kakao.maps.Circle({
      center: new kakao.maps.LatLng(${userLat}, ${userLng}),
      radius: 15,
      strokeWeight: 3,
      strokeColor: '#1a73e8',
      strokeOpacity: 1,
      fillColor: '#4a90d9',
      fillOpacity: 0.9
    });
    userCircle.setMap(map);

    // 주변 역 마커
    var stations = ${stationsJson};
    stations.forEach(function(s) {
      var markerSize = s.isNearest
        ? new kakao.maps.Size(36, 36)
        : new kakao.maps.Size(24, 24);
      var markerImage = new kakao.maps.MarkerImage(
        'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36">' +
          '<circle cx="18" cy="18" r="' + (s.isNearest ? '16' : '10') + '" fill="' + s.color + '" stroke="white" stroke-width="' + (s.isNearest ? '3' : '2') + '"/>' +
          (s.isNearest ? '<text x="18" y="23" text-anchor="middle" font-size="11" font-weight="bold" fill="white">&#9655;</text>' : '') +
          '</svg>'
        ),
        markerSize
      );
      var marker = new kakao.maps.Marker({
        position: new kakao.maps.LatLng(s.lat, s.lng),
        image: markerImage
      });
      marker.setMap(map);

      var infowindow = new kakao.maps.InfoWindow({
        content: '<div style="padding:4px 8px;font-size:12px;font-weight:bold;white-space:nowrap;">' + s.name + '</div>'
      });
      kakao.maps.event.addListener(marker, 'click', function() {
        infowindow.open(map, marker);
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(s.name);
        }
      });
    });
  </script>
</body>
</html>`;
}
