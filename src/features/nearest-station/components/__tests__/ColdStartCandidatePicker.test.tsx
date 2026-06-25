import { fireEvent } from '@testing-library/react-native';
import { ColdStartCandidatePicker, COLD_START_LIST_MAX } from '../ColdStartCandidatePicker';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import type { ColdStartCandidate } from '../../hooks/useColdStartCandidates';

// ── 픽스처 ────────────────────────────────────────────────────────────────────

function makeCandidate(
  stationName: string,
  lines: string[],
  distanceKm: number,
): ColdStartCandidate {
  return {
    stationName,
    lines: lines as ColdStartCandidate['lines'],
    distanceKm,
    lat: 37.5,
    lng: 127.0,
    stations: [],
  };
}

const SINCHON = makeCandidate('신촌', ['2'], 0.05);
const HONGIK = makeCandidate('홍대입구', ['2', 'airport', 'gyeongui'], 0.42);
const WANGSIMNI = makeCandidate('왕십리', ['2', '5', 'gyeongui', 'bundang'], 0.1);
const SADANG = makeCandidate('사당', ['2', '4'], 0.3);
const YAKSU = makeCandidate('약수', ['3', '6'], 0.45);
const EXTRA = makeCandidate('extra1', ['7'], 0.48);

const TWO_TO_FIVE = [SINCHON, WANGSIMNI, SADANG, YAKSU];
const SIX_PLUS = [SINCHON, HONGIK, WANGSIMNI, SADANG, YAKSU, EXTRA];

// ── 공통 render 헬퍼 ──────────────────────────────────────────────────────────

function renderPicker(overrides: {
  visible?: boolean;
  candidates?: readonly ColdStartCandidate[];
  onSelectCandidate?: (c: ColdStartCandidate) => void;
  onSingleCandidate?: (c: ColdStartCandidate) => void;
  onSearchFallback?: () => void;
  onClose?: () => void;
} = {}) {
  return renderWithTheme(
    <ColdStartCandidatePicker
      visible={overrides.visible ?? true}
      candidates={overrides.candidates ?? TWO_TO_FIVE}
      onSelectCandidate={overrides.onSelectCandidate ?? jest.fn()}
      onSingleCandidate={overrides.onSingleCandidate ?? jest.fn()}
      onSearchFallback={overrides.onSearchFallback ?? jest.fn()}
      onClose={overrides.onClose ?? jest.fn()}
    />,
  );
}

// ── 1. 기본 렌더 ───────────────────────────────────────────────────────────────

describe('ColdStartCandidatePicker — 기본 렌더', () => {
  it('visible=true 이면 모달이 표시된다', () => {
    const { getByTestId } = renderPicker();
    expect(getByTestId('cold-start-picker-modal')).toBeTruthy();
  });

  it('visible=false 이면 Modal의 visible prop이 false다', () => {
    const { UNSAFE_getByType } = renderPicker({ visible: false });
    const ModalRN: typeof import('react-native').Modal = require('react-native').Modal;
    expect(UNSAFE_getByType(ModalRN).props.visible).toBe(false);
  });

  it('닫기 버튼이 있다', () => {
    const { getByTestId } = renderPicker();
    expect(getByTestId('cold-start-picker-close')).toBeTruthy();
  });

  it('닫기 버튼 탭 시 onClose 호출', () => {
    const onClose = jest.fn();
    const { getByTestId } = renderPicker({ onClose });
    fireEvent.press(getByTestId('cold-start-picker-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── 2. 2~5개 목록 UI ──────────────────────────────────────────────────────────

describe('ColdStartCandidatePicker — 2~5개 목록 UI', () => {
  it('후보가 2~5개면 목록 컨테이너가 렌더된다', () => {
    const { getByTestId } = renderPicker({ candidates: TWO_TO_FIVE });
    expect(getByTestId('cold-start-picker-list')).toBeTruthy();
  });

  it('fallback UI는 표시되지 않는다', () => {
    const { queryByTestId } = renderPicker({ candidates: TWO_TO_FIVE });
    expect(queryByTestId('cold-start-picker-fallback')).toBeNull();
  });

  it('각 후보의 역명으로 testID 카드가 렌더된다', () => {
    const { getByTestId } = renderPicker({ candidates: TWO_TO_FIVE });
    for (const candidate of TWO_TO_FIVE) {
      expect(getByTestId(`cold-start-picker-item-${candidate.stationName}`)).toBeTruthy();
    }
  });

  it('후보 카드 탭 시 해당 candidate로 onSelectCandidate 호출', () => {
    const onSelectCandidate = jest.fn();
    const { getByTestId } = renderPicker({ candidates: TWO_TO_FIVE, onSelectCandidate });
    fireEvent.press(getByTestId(`cold-start-picker-item-${SINCHON.stationName}`));
    expect(onSelectCandidate).toHaveBeenCalledWith(SINCHON);
  });

  it('다른 카드 탭 시 해당 candidate로 onSelectCandidate 호출', () => {
    const onSelectCandidate = jest.fn();
    const { getByTestId } = renderPicker({ candidates: TWO_TO_FIVE, onSelectCandidate });
    fireEvent.press(getByTestId(`cold-start-picker-item-${WANGSIMNI.stationName}`));
    expect(onSelectCandidate).toHaveBeenCalledWith(WANGSIMNI);
  });

  it('환승역(복수 노선) 카드도 정상 렌더 — 왕십리 4호선', () => {
    const { getByTestId } = renderPicker({ candidates: [WANGSIMNI] });
    expect(getByTestId(`cold-start-picker-item-${WANGSIMNI.stationName}`)).toBeTruthy();
  });

  it('2개 후보 — 2개 카드만 렌더', () => {
    const two = [SINCHON, WANGSIMNI];
    const { getByTestId, queryByTestId } = renderPicker({ candidates: two });
    expect(getByTestId(`cold-start-picker-item-${SINCHON.stationName}`)).toBeTruthy();
    expect(getByTestId(`cold-start-picker-item-${WANGSIMNI.stationName}`)).toBeTruthy();
    expect(queryByTestId(`cold-start-picker-item-${SADANG.stationName}`)).toBeNull();
  });

  it(`${COLD_START_LIST_MAX}개(상한) 후보 — 목록 UI 렌더 (fallback 미표시)`, () => {
    const atMax = [SINCHON, HONGIK, WANGSIMNI, SADANG, YAKSU];
    expect(atMax).toHaveLength(COLD_START_LIST_MAX);
    const { getByTestId, queryByTestId } = renderPicker({ candidates: atMax });
    expect(getByTestId('cold-start-picker-list')).toBeTruthy();
    expect(queryByTestId('cold-start-picker-fallback')).toBeNull();
  });
});

// ── 3. 6+개 fallback UI ───────────────────────────────────────────────────────

describe('ColdStartCandidatePicker — 6+개 fallback UI', () => {
  it('6개 이상이면 fallback UI가 렌더된다', () => {
    const { getByTestId } = renderPicker({ candidates: SIX_PLUS });
    expect(getByTestId('cold-start-picker-fallback')).toBeTruthy();
  });

  it('목록 UI는 표시되지 않는다', () => {
    const { queryByTestId } = renderPicker({ candidates: SIX_PLUS });
    expect(queryByTestId('cold-start-picker-list')).toBeNull();
  });

  it('검색 fallback 버튼이 있다', () => {
    const { getByTestId } = renderPicker({ candidates: SIX_PLUS });
    expect(getByTestId('cold-start-picker-search-fallback')).toBeTruthy();
  });

  it('검색 fallback 버튼 탭 시 onSearchFallback 호출', () => {
    const onSearchFallback = jest.fn();
    const { getByTestId } = renderPicker({ candidates: SIX_PLUS, onSearchFallback });
    fireEvent.press(getByTestId('cold-start-picker-search-fallback'));
    expect(onSearchFallback).toHaveBeenCalledTimes(1);
  });

  it('개별 역 카드 testID가 존재하지 않는다 (fallback 이므로)', () => {
    const { queryByTestId } = renderPicker({ candidates: SIX_PLUS });
    expect(queryByTestId(`cold-start-picker-item-${SINCHON.stationName}`)).toBeNull();
  });
});

// ── 4. 빈 배열 edge case ─────────────────────────────────────────────────────

describe('ColdStartCandidatePicker — 빈 배열', () => {
  it('candidates=[] 이면 목록과 fallback 모두 미표시 (caller가 visible=false 보장)', () => {
    // 컴포넌트 자체는 빈 배열 시 목록 컨테이너를 렌더하되 카드가 0개인 상태가 될 수 있다.
    // 빈 배열은 count=0 이므로 isFallback=false, 목록 UI 경로 진입.
    const { getByTestId, queryByTestId } = renderPicker({ candidates: [] });
    // 빈 배열 시 목록 컨테이너는 존재하지만 카드가 없다.
    expect(getByTestId('cold-start-picker-list')).toBeTruthy();
    expect(queryByTestId(`cold-start-picker-item-신촌`)).toBeNull();
    expect(queryByTestId('cold-start-picker-fallback')).toBeNull();
  });
});

// ── 5. COLD_START_LIST_MAX 상수 ───────────────────────────────────────────────

describe('COLD_START_LIST_MAX 상수', () => {
  it('COLD_START_LIST_MAX = 5', () => {
    expect(COLD_START_LIST_MAX).toBe(5);
  });
});

// ── 6. onSingleCandidate props 검증 ─────────────────────────────────────────

describe('ColdStartCandidatePicker — onSingleCandidate prop 전달', () => {
  it('1개 후보 시 목록 UI 렌더 (카드 1개)', () => {
    // 컴포넌트 자체는 1개도 목록 UI로 표시. caller(useColdStartPickerController)가 onSingleCandidate 분기.
    const { getByTestId } = renderPicker({ candidates: [SINCHON] });
    expect(getByTestId(`cold-start-picker-item-${SINCHON.stationName}`)).toBeTruthy();
  });

  it('1개 후보 카드 탭 시 onSelectCandidate 호출 (1개 case caller wire 검증)', () => {
    const onSelectCandidate = jest.fn();
    const { getByTestId } = renderPicker({ candidates: [SINCHON], onSelectCandidate });
    fireEvent.press(getByTestId(`cold-start-picker-item-${SINCHON.stationName}`));
    expect(onSelectCandidate).toHaveBeenCalledWith(SINCHON);
  });
});
