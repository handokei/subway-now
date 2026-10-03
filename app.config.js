const pkg = require('./package.json');

// #696 — Silent push 디바이스 도달 0%(BadDeviceToken) root cause 차단.
// production 빌드는 APNS production host(`api.push.apple.com`)를 사용하므로
// entitlement `aps-environment`도 `production`이어야 한다. 그 외(development/preview)는
// sandbox(`api.sandbox.push.apple.com`)이므로 `development` 유지.
const isProductionApns =
  process.env.EAS_BUILD_PROFILE === 'production' ||
  process.env.EXPO_PUBLIC_APNS_ENV === 'production';
const apsEnvironment = isProductionApns ? 'production' : 'development';

module.exports = {
  expo: {
    name: 'subway-now',
    slug: 'subway-now',
    version: pkg.version,
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'automatic',
    newArchEnabled: false,
    locales: {
      ko: './locales/ko.json',
      en: './locales/en.json',
      ja: './locales/ja.json',
      zh: './locales/zh.json',
    },
    splash: {
      image: './assets/splash/splash-ko-1284x2778.png',
      resizeMode: 'cover',
      backgroundColor: '#CDEBF7',
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'com.subwaynow.app',
      appleTeamId: '4755N5H4T4',
      entitlements: {
        'aps-environment': apsEnvironment,
        // #1508 — Apple Developer Portal "Access WiFi Information" Capability 활성(2026-06-19) 후속.
        // NEHotspotNetwork.fetchCurrent()가 SSID/BSSID를 노출하려면 본 entitlement 필요.
        // B3-native(#1476) bridge가 이 값을 읽어 F2 SSID lookup(`lookupStationBySsid`)에 공급.
        'com.apple.developer.networking.wifi-info': true,
      },
      infoPlist: {
        NSAppTransportSecurity: {
          NSExceptionDomains: {
            'swopenapi.seoul.go.kr': {
              NSExceptionAllowsInsecureHTTPLoads: true,
            },
          },
        },
        UIBackgroundModes: ['location', 'fetch', 'remote-notification'],
        ITSAppUsesNonExemptEncryption: false,
        // #728 — CMMotionActivity 권한 사용 설명. 정적 misfire 가드(motionStationary 신호)로
        // 정지 상태에서의 잘못된 알람 발사를 차단.
        NSMotionUsageDescription:
          '정지 상태에서 잘못된 알람이 울리지 않도록 움직임 감지를 사용합니다.',
        // #913 (F2) — NEHotspotNetwork.fetchCurrent로 현재 wifi SSID를 조회해 지하철 SSID
        // 패턴 매칭(`lookupStationBySsid`)으로 지하에서 현재 역을 100% 확정한다.
        // 별도 entitlement(`HotspotConfiguration`) 대신 기존 WhileInUse Location 권한을 재사용.
        // 별도 prompt 없이 동작하지만 Apple Privacy nutrition label은 "Wifi connection" 카테고리로 분류 필요.
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        backgroundColor: '#ffffff',
      },
      permissions: [
        'ACCESS_FINE_LOCATION',
        'ACCESS_BACKGROUND_LOCATION',
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.ACCESS_FINE_LOCATION',
        // #913 (F2) — WifiManager.connectionInfo.ssid 조회용. ACCESS_FINE_LOCATION과 함께 필요.
        'android.permission.ACCESS_WIFI_STATE',
      ],
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      package: 'com.subwaynow.app',
    },
    web: {
      favicon: './assets/favicon.png',
    },
    plugins: [
      [
        'expo-location',
        {
          locationAlwaysAndWhenInUsePermission: '현재 위치한 지하철역을 감지하기 위해 위치 권한이 필요합니다.',
          locationAlwaysPermission: '백그라운드에서 지하철역을 지속적으로 감지하기 위해 항상 위치 권한이 필요합니다.',
          locationWhenInUsePermission: '앱 사용 중 현재 지하철역을 감지하기 위해 위치 권한이 필요합니다.',
        },
      ],
      [
        'expo-notifications',
        {
          sounds: ['./assets/sounds/alarm.wav'],
          enableBackgroundRemoteNotifications: true,
        },
      ],
      'expo-router',
      'expo-localization',
      'expo-background-task',
      './modules/live-activity/app.plugin.js',
      './plugins/with-fmt-consteval-patch.js',
      '@sentry/react-native/expo',
      '@bacons/apple-targets',
      // #1861 — iCloud KV entitlement 자동 주입 (NSUbiquitousKeyValueStore).
      // App Store Connect에서 iCloud Capability 수동 활성화 후 expo prebuild 필요 (L15).
      './plugins/with-icloud-kv',
    ],
    extra: {
      publicDataApiKey: '',
      seoulDataApiKey: '',
      eas: {
        projectId: '0034b0da-c041-4119-8719-dcd1d517822a',
        build: {
          experimental: {
            ios: {
              appExtensions: [
                {
                  bundleIdentifier: 'com.subwaynow.app.widget',
                  targetName: 'subwaywidget',
                },
              ],
            },
          },
        },
      },
      router: {},
    },
    owner: 'handokei',
    scheme: 'subwaynow',
  },
};
