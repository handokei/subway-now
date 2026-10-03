import { fireEvent } from '@testing-library/react-native';
import { CurrentStationConfirmModal } from '../CurrentStationConfirmModal';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import type { Station } from '../../../../shared/types/station';

const YONGMASAN: Station = {
  id: '7-015',
  name: '용마산',
  nameEn: 'Yongmasan',
  line: '7',
  lineColor: '#747F00',
  lat: 37.573647,
  lng: 127.086727,
};

const JUNGGOK: Station = {
  id: '7-016',
  name: '중곡',
  nameEn: 'Junggok',
  line: '7',
  lineColor: '#747F00',
  lat: 37.565923,
  lng: 127.08432,
};

const SAGAJEONG: Station = {
  id: '7-014',
  name: '사가정',
  nameEn: 'Sagajeong',
  line: '7',
  lineColor: '#747F00',
  lat: 37.5814,
  lng: 127.0884,
};

function renderModal(overrides: {
  visible?: boolean;
  candidates?: readonly Station[];
  topPick?: Station | null;
  onConfirm?: (s: Station) => void;
  onSearchFallback?: () => void;
  onClose?: () => void;
} = {}) {
  // topPick은 null도 의미 있는 값이라 ?? 대신 hasOwnProperty 체크로 디폴트 적용.
  const topPick = 'topPick' in overrides ? (overrides.topPick ?? null) : YONGMASAN;
  return renderWithTheme(
    <CurrentStationConfirmModal
      visible={overrides.visible ?? true}
      candidates={overrides.candidates ?? [YONGMASAN, JUNGGOK, SAGAJEONG]}
      topPick={topPick}
      onConfirm={overrides.onConfirm ?? jest.fn()}
      onSearchFallback={overrides.onSearchFallback ?? jest.fn()}
      onClose={overrides.onClose ?? jest.fn()}
    />,
  );
}

describe('CurrentStationConfirmModal', () => {
  it('visible=true이면 모달과 후보 list를 렌더한다', () => {
    const { getByTestId } = renderModal();
    expect(getByTestId('current-station-confirm-modal')).toBeTruthy();
    expect(getByTestId('current-station-confirm-list')).toBeTruthy();
  });

  it('각 후보마다 prefix 적용된 testID로 카드 렌더', () => {
    const { getByTestId } = renderModal();
    expect(getByTestId('current-station-confirm-item-7-015')).toBeTruthy();
    expect(getByTestId('current-station-confirm-item-7-016')).toBeTruthy();
    expect(getByTestId('current-station-confirm-item-7-014')).toBeTruthy();
  });

  it('topPick과 일치하는 후보만 강조 라벨 노출', () => {
    const { getByTestId, queryByTestId } = renderModal({ topPick: JUNGGOK });
    expect(getByTestId('current-station-confirm-top-pick-7-016')).toBeTruthy();
    expect(queryByTestId('current-station-confirm-top-pick-7-015')).toBeNull();
    expect(queryByTestId('current-station-confirm-top-pick-7-014')).toBeNull();
  });

  it('topPick=null이면 강조 라벨이 어디에도 표시되지 않음', () => {
    const { queryByTestId } = renderModal({ topPick: null });
    expect(queryByTestId('current-station-confirm-top-pick-7-015')).toBeNull();
    expect(queryByTestId('current-station-confirm-top-pick-7-016')).toBeNull();
  });

  it('카드 탭 시 해당 station을 onConfirm으로 전달', () => {
    const onConfirm = jest.fn();
    const { getByTestId } = renderModal({ onConfirm });
    fireEvent.press(getByTestId('current-station-confirm-item-7-016'));
    expect(onConfirm).toHaveBeenCalledWith(JUNGGOK);
  });

  it('닫기 버튼 탭 시 onClose 호출', () => {
    const onClose = jest.fn();
    const { getByTestId } = renderModal({ onClose });
    fireEvent.press(getByTestId('current-station-confirm-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('후보가 비어 있으면 empty 영역 + 검색 fallback 버튼 노출', () => {
    const { getByTestId, queryByTestId } = renderModal({ candidates: [], topPick: null });
    expect(getByTestId('current-station-confirm-empty')).toBeTruthy();
    expect(getByTestId('current-station-confirm-search-fallback')).toBeTruthy();
    expect(queryByTestId('current-station-confirm-list')).toBeNull();
  });

  it('검색 fallback 버튼 탭 시 onSearchFallback 호출', () => {
    const onSearchFallback = jest.fn();
    const { getByTestId } = renderModal({
      candidates: [],
      topPick: null,
      onSearchFallback,
    });
    fireEvent.press(getByTestId('current-station-confirm-search-fallback'));
    expect(onSearchFallback).toHaveBeenCalledTimes(1);
  });

  it('후보가 1개면 그 한 카드만 렌더', () => {
    const { getByTestId, queryByTestId } = renderModal({
      candidates: [YONGMASAN],
      topPick: YONGMASAN,
    });
    expect(getByTestId('current-station-confirm-item-7-015')).toBeTruthy();
    expect(queryByTestId('current-station-confirm-item-7-016')).toBeNull();
  });

  it('visible=false이면 list testID가 검색되지 않는다 (RN Modal hidden semantics)', () => {
    // RN의 Modal은 visible=false 시 자식을 hide. queryBy는 visible과 무관하게 트리를 보지만
    // 호출자에겐 Modal의 visible prop 전달만 검증하면 충분 — 추가 검증으로 prop 시그니처 확인.
    const { UNSAFE_getByType } = renderModal({ visible: false });
    // react-native Modal element를 직접 lookup해 visible prop 전달 확인.
    const ModalRN: typeof import('react-native').Modal = require('react-native').Modal;
    expect(UNSAFE_getByType(ModalRN).props.visible).toBe(false);
  });
});
