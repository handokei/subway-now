/**
 * #1973 — useNavigationStore 테스트.
 *
 * 휘발성 in-memory store (persist 미적용) — start/stop 상태 전환만 검증.
 * coverage 100% — initial / startNavigation / stopNavigation / idempotent transitions.
 */
import { useNavigationStore } from '../useNavigationStore';

describe('useNavigationStore (#1973)', () => {
  beforeEach(() => {
    // zustand는 모듈 싱글톤 — 매 테스트마다 state reset.
    useNavigationStore.setState({ navigationActive: false });
  });

  describe('initial state', () => {
    it('navigationActive default false (cold start 시 명시 trigger 필요)', () => {
      expect(useNavigationStore.getState().navigationActive).toBe(false);
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
});
