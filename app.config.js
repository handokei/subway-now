const pkg = require('./package.json');

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
      './plugins/with-sentry-modular-headers.js',
      '@sentry/react-native/expo',
      '@bacons/apple-targets',
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
