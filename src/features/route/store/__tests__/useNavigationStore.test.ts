/**
 * #1973 — useNavigationStore 테스트.
 *
 * 휘발성 in-memory store (persist 미적용) — start/stop 상태 전환만 검증.
 * coverage 100% — initial / startNavigation / stopNavigation / idempotent transitions.
 *
 * #1987 (ADR-022 B6) — 안내시작이 sleepMode를 강제하지 않음을 회귀 방지 테스트로 박제.
 * 슬라이스 경계 준수 — settings 슬라이스 store를 직접 import하지 않고 store 코드 표면만 검증.
 */
import { useNavigationStore } from '../useNavigationStore';

describe('useNavigationStore (#1973)', () => {
  beforeEach(() => {
    // zustand는 모듈 싱글톤 — 매 테스트마다 state reset.
    useNavigationStore.setState({ navigationActive: false, pausedAt: null });
  });

  describe('initial state', () => {
    it('navigationActive default false (cold start 시 명시 trigger 필요)', () => {
      expect(useNavigationStore.getState().navigationActive).toBe(false);
    });

    it('pausedAt default null', () => {
      expect(useNavigationStore.getState().pausedAt).toBeNull();
    });
  });

  describe('startNavigation', () => {
    it('navigationActive false → true 전환', () => {
      useNavigationStore.getState().startNavigation();
      expect(useNavigationStore.getState().navigationActive).toBe(true);
    });

    it('이미 true 상태에서 startNavigation 호출 시 idempotent (true 유지)', () => {
      useNavigationStore.setState({ navigationActive: true });
      useNavigationStore.getState().startNavigation();
      expect(useNavigationStore.getState().navigationActive).toBe(true);
    });

    // #2293 — 재개 시 이전 일시정지 stamp가 leak되지 않도록 pausedAt clear.
    it('startNavigation 호출 시 pausedAt null로 clear', () => {
      useNavigationStore.setState({ navigationActive: false, pausedAt: 1_000 });
      useNavigationStore.getState().startNavigation();
      expect(useNavigationStore.getState().pausedAt).toBeNull();
    });
  });

  describe('stopNavigation', () => {
    it('navigationActive true → false 전환', () => {
      useNavigationStore.setState({ navigationActive: true });
      useNavigationStore.getState().stopNavigation();
      expect(useNavigationStore.getState().navigationActive).toBe(false);
    });

    it('이미 false 상태에서 stopNavigation 호출 시 idempotent (false 유지)', () => {
      useNavigationStore.getState().stopNavigation();
      expect(useNavigationStore.getState().navigationActive).toBe(false);
    });

    // #2293 — 일시정지 진입 시각을 memory에 stamp (FG 배지 카운트다운 소스).
    it('stopNavigation 호출 시 pausedAt epoch ms로 stamp', () => {
      jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
      useNavigationStore.setState({ navigationActive: true, pausedAt: null });
      useNavigationStore.getState().stopNavigation();
      expect(useNavigationStore.getState().pausedAt).toBe(5_000_000);
      jest.restoreAllMocks();
    });
  });

  describe('clearPausedAt (#2293 PR #2301 리뷰 P1)', () => {
    it('pausedAt만 null로 clear, navigationActive는 건드리지 않음', () => {
      useNavigationStore.setState({ navigationActive: false, pausedAt: 12_345 });
      useNavigationStore.getState().clearPausedAt();
      expect(useNavigationStore.getState().pausedAt).toBeNull();
      expect(useNavigationStore.getState().navigationActive).toBe(false);
    });

    it('navigationActive=true 상태에서도 pausedAt만 clear (state 변형 없음)', () => {
      useNavigationStore.setState({ navigationActive: true, pausedAt: 99_999 });
      useNavigationStore.getState().clearPausedAt();
      expect(useNavigationStore.getState().pausedAt).toBeNull();
      expect(useNavigationStore.getState().navigationActive).toBe(true);
    });

    it('이미 null 상태에서 호출 시 idempotent', () => {
      useNavigationStore.setState({ navigationActive: false, pausedAt: null });
      useNavigationStore.getState().clearPausedAt();
      expect(useNavigationStore.getState().pausedAt).toBeNull();
    });
  });

  describe('start → stop 사이클', () => {
    it('startNavigation → stopNavigation 사이클 정합 (사용자 안내 시작 후 중단)', () => {
      const { startNavigation, stopNavigation } = useNavigationStore.getState();
      startNavigation();
      expect(useNavigationStore.getState().navigationActive).toBe(true);
      stopNavigation();
      expect(useNavigationStore.getState().navigationActive).toBe(false);
    });
  });

  // #1987 (ADR-022 B6) — "안내시작 = 취침모드 강제" 회귀 방지.
  // 사용자 관찰(2026-06-30, 2026-07-01) : "건대 알림 도착. 계속되는 진동은 취침모드에서만 동작해야 함".
  // 코드 상 직접 결합은 없지만, 회귀 재발 시 즉시 catch되도록 store shape 자체를 pin.
  //
  // 슬라이스 경계 (ESLint import/no-restricted-paths) — route slice test는 settings slice
  // store를 import 할 수 없다. sleepMode 결합 검증은 store shape이 정확히 3개 필드만
  // 노출함을 pin해 간접적으로 확인 (sleepMode / setSleepMode / vibration 등 어떤 필드가
  // 추가되어도 fail). 사용자 여정 수준의 결합 검증은 HomeScreen 통합 테스트에서 담당.
  describe('#1987 (B6) — store shape에 sleepMode 결합 없음', () => {
    // #2293 — pausedAt(일시정지 배지 카운트다운 메모리 값) + clearPausedAt(PR #2301 리뷰 P1)
    // 추가로 5개 필드로 확장.
    const EXPECTED_KEYS = [
      'navigationActive',
      'pausedAt',
      'startNavigation',
      'stopNavigation',
      'clearPausedAt',
    ].sort();

    it('initial state shape이 정확히 3개 필드만 노출 (sleepMode 등 leak 방지)', () => {
      expect(Object.keys(useNavigationStore.getState()).sort()).toEqual(EXPECTED_KEYS);
    });

    it('startNavigation 호출 후에도 store shape 불변 (새 필드 leak 방지)', () => {
      useNavigationStore.getState().startNavigation();
      expect(Object.keys(useNavigationStore.getState()).sort()).toEqual(EXPECTED_KEYS);
    });

    it('stopNavigation 호출 후에도 store shape 불변 (새 필드 leak 방지)', () => {
      useNavigationStore.getState().startNavigation();
      useNavigationStore.getState().stopNavigation();
      expect(Object.keys(useNavigationStore.getState()).sort()).toEqual(EXPECTED_KEYS);
    });
  });
});
