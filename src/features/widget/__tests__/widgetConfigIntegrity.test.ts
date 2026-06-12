/**
 * 위젯 Phase 4 회귀 가드 (issue #1242).
 *
 * Phase 1 (#1232 머지) 회귀 evidence: `targets/subway-widget/expo-target.config.json`에
 * `entitlements` 필드가 누락되어 `@bacons/apple-targets` plugin이 위젯 Xcode 타깃에
 * `CODE_SIGN_ENTITLEMENTS`를 부착하지 않았고, 결과적으로 위젯이 App Groups에 접근하지
 * 못해 현재 역 정보를 읽지 못했다. 자동 게이트가 잡지 못한 회귀였다.
 *
 * 본 테스트는 두 entitlements SSOT가 같은 App Group을 선언하는지, 그리고 과거에
 * 사용되던 `expo-target.json` (dead 파일) 이 부활하지 않는지를 검증한다.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const APP_GROUP_KEY = 'com.apple.security.application-groups';
const EXPECTED_APP_GROUP = 'group.com.subwaynow.app';
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

const widgetConfigPath = join(
  REPO_ROOT,
  'targets',
  'subway-widget',
  'expo-target.config.json',
);
const liveActivityPluginPath = join(
  REPO_ROOT,
  'modules',
  'live-activity',
  'app.plugin.js',
);
const deadTargetConfigPath = join(
  REPO_ROOT,
  'targets',
  'subway-widget',
  'expo-target.json',
);

const loadWidgetEntitlements = (): Record<string, unknown> => {
  const raw = readFileSync(widgetConfigPath, 'utf8');
  const parsed = JSON.parse(raw) as { entitlements?: Record<string, unknown> };
  if (!parsed.entitlements) {
    throw new Error(
      `widget expo-target.config.json에 entitlements 키가 없음. Phase 1 (#1232) 회귀 재발: ` +
        `위젯 Xcode 타깃에 CODE_SIGN_ENTITLEMENTS 미부착 → App Groups 접근 불가. ` +
        `복구: { "entitlements": { "${APP_GROUP_KEY}": ["${EXPECTED_APP_GROUP}"] } } 추가.`,
    );
  }
  return parsed.entitlements;
};

const loadLiveActivityAppGroups = (): readonly string[] => {
  const raw = readFileSync(liveActivityPluginPath, 'utf8');
  // 메인 앱 entitlements는 modules/live-activity/app.plugin.js의 withEntitlementsPlist
  // 콜백이 inline으로 주입한다. 동적 import 없이 정적 검증을 위해 라인 자체를 검사한다.
  const pattern = new RegExp(
    `['"]${APP_GROUP_KEY.replace(/\./g, '\\.')}['"]\\s*\\]?\\s*=\\s*\\[([^\\]]+)\\]`,
  );
  const match = pattern.exec(raw);
  if (!match) {
    throw new Error(
      `live-activity app.plugin.js에서 ${APP_GROUP_KEY} 선언을 찾지 못함. ` +
        `메인 앱 entitlements에서 App Groups가 제거되면 위젯과 sync가 깨진다.`,
    );
  }
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter((entry) => entry.length > 0);
};

describe('widget config integrity (#1242 regression guard)', () => {
  it('widget expo-target.config.json은 entitlements와 App Groups 배열을 선언한다', () => {
    const entitlements = loadWidgetEntitlements();
    const appGroups = entitlements[APP_GROUP_KEY];
    expect(Array.isArray(appGroups)).toBe(true);
    expect(appGroups).toContain(EXPECTED_APP_GROUP);
  });

  it('메인 앱 entitlements (live-activity plugin)는 같은 App Group을 선언한다', () => {
    const appGroups = loadLiveActivityAppGroups();
    expect(appGroups).toContain(EXPECTED_APP_GROUP);
  });

  it('메인 앱과 위젯이 동일한 App Groups 집합을 공유한다 (sync 깨짐 차단)', () => {
    const widgetGroups = loadWidgetEntitlements()[APP_GROUP_KEY] as readonly string[];
    const mainGroups = loadLiveActivityAppGroups();
    // 양쪽이 같은 set이어야 위젯이 메인 앱의 SharedGroupPreferences를 읽을 수 있다.
    expect([...widgetGroups].sort()).toEqual([...mainGroups].sort());
  });

  it('과거의 expo-target.json (dead 파일)이 부활하지 않는다', () => {
    // expo-target.json은 구버전 schema. @bacons/apple-targets는 expo-target.config.{json,js}만
    // 인식한다. dead 파일이 다시 생기면 사람 눈에 "설정처럼 보이지만" 실제로는 무시되어
    // Phase 1 같은 silent regression을 유발한다.
    expect(existsSync(deadTargetConfigPath)).toBe(false);
  });
});
