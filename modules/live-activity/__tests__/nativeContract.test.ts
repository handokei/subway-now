/**
 * #3162 — Swift는 jest로 실행할 수 없으므로, JS가 의존하는 native 계약을 소스 텍스트로 고정한다.
 * (Swift 타입체크는 PR 본문의 xcrun swiftc 검증이 담당 — 여기는 "계약이 지워지지 않았는가"만 본다.)
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const IOS_DIR = join(__dirname, '..', 'ios');
const manager = readFileSync(join(IOS_DIR, 'LiveActivityManager.swift'), 'utf8');
const moduleSource = readFileSync(join(IOS_DIR, 'LiveActivityModule.swift'), 'utf8');

describe('LiveActivity native 계약 (#3162)', () => {
  it('시스템/원격 종료(.ended)는 사용자 dismiss로 분류하지 않는다 — dismiss는 .dismissed + 앱이 기대하지 않은 종료만', () => {
    const line = manager.split('\n').find((l) => l.includes('let wasUserDismiss'));
    expect(line).toBeDefined();
    expect(line).toContain('"dismissed"');
    expect(line).toContain('!expectingSystemEnd');
  });

  it('JS 불변식 복구용 requestPushToken AsyncFunction이 노출되고 manager의 현재 토큰 재조회로 연결된다', () => {
    expect(moduleSource.includes('AsyncFunction("requestPushToken")')).toBe(true);
    expect(moduleSource.includes('currentPushTokenHex()')).toBe(true);
    expect(manager.includes('func currentPushTokenHex()')).toBe(true);
  });
});
