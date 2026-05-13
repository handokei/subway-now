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
      buildNumber: '42',
      infoPlist: {
        NSAppTransportSecurity: {
          NSExceptionDomains: {
            'swopenapi.seoul.go.kr': {
              NSExceptionAllowsInsecureHTTPLoads: true,
            },
          },
        },
        UIBackgroundModes: ['location'],
        ITSAppUsesNonExemptEncryption: false,
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
      ],
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      package: 'com.subwaynow.app',
      versionCode: 1,
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
        },
      ],
      'expo-router',
      'expo-localization',
      'expo-background-task',
      './modules/live-activity/app.plugin.js',
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
