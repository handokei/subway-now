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
  const markers = nearbyStations
    .map((s) => {
      const isNearest = nearestStation?.id === s.id;
      const size = isNearest ? 36 : 24;
      const border = isNearest ? 3 : 2;
      const station = JSON.stringify(s);
      return `addMarker(map, ${s.lat}, ${s.lng}, "${s.lineColor}", ${size}, ${border}, "${s.name}", ${station});`;
    })
    .join('\n');

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
<script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=${apiKey}&autoload=false"></script>
<script>
kakao.maps.load(function(){
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

  function addMarker(map, lat, lng, color, size, border, name, station) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;cursor:pointer;';

    var circle = document.createElement('div');
    circle.style.cssText = 'width:'+size+'px;height:'+size+'px;border-radius:50%;background:'+color+';border:'+border+'px solid #fff;box-sizing:border-box;';
    wrap.appendChild(circle);

    var label = document.createElement('div');
    label.style.cssText = 'margin-top:2px;font-size:11px;color:#fff;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;white-space:nowrap;font-weight:bold;';
    label.textContent = name;
    wrap.appendChild(label);

    wrap.addEventListener('click', function(){
      if(window.ReactNativeWebView){
        window.ReactNativeWebView.postMessage(JSON.stringify({type:'stationPress',station:station}));
      }
    });

    new kakao.maps.CustomOverlay({
      position: new kakao.maps.LatLng(lat, lng),
      content: wrap,
      map: map,
      yAnchor: 1
    });
  }

  ${markers}
});
</script>
</body>
</html>`;
}
