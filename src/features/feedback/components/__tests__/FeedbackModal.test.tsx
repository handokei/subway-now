import React from 'react';
import { Keyboard } from 'react-native';
import { act, fireEvent, waitFor } from '@testing-library/react-native';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { FeedbackModal, FEEDBACK_MAX_LENGTH } from '../FeedbackModal';
import { submitFeedback } from '../../../../shared/api/feedback';
import { FEEDBACK_CATEGORIES } from '../../../../shared/constants/feedbackCategories';
import { findStationByNameAndLine } from '../../../../shared/utils/stationLookup';
import { useDestinationStore } from '../../../route/store/useDestinationStore';

jest.mock('../../../../shared/api/feedback', () => ({
  submitFeedback: jest.fn(),
}));

// #3366 — 진단 수집/렌더는 별도 모듈. 이 파일은 FeedbackModal 자체 동작만 본다
// (실 collector·buildDumpText 통합은 FeedbackModal.reportMode.test.tsx).
const mockCollect = jest.fn();
jest.mock('../../../debug/hooks/useDebugDumpInputs', () => ({
  collectReportDumpInputs: () => mockCollect(),
}));
const mockBuildDumpText = jest.fn();
jest.mock('../../../debug/components/DebugModal', () => ({
  buildDumpText: (...a: unknown[]) => mockBuildDumpText(...a),
}));

const mockedSubmit = submitFeedback as jest.MockedFunction<typeof submitFeedback>;
const NOW = 1_795_305_300_000;

describe('FeedbackModal', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    mockedSubmit.mockReset();
    mockCollect.mockReset();
    mockBuildDumpText.mockReset();
    mockCollect.mockResolvedValue({ args: { marker: 'args' }, tokens: ['tok'], tripKey: null });
    mockBuildDumpText.mockReturnValue('DUMP');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders title and submit disabled until non-empty input', () => {
    const onClose = jest.fn();
    const { getByTestId, getByText } = renderWithTheme(
      <FeedbackModal visible onClose={onClose} />,
    );
    expect(getByText('버그 신고')).toBeTruthy();
    const submit = getByTestId('feedback-submit');
    expect(submit.props.accessibilityState).toEqual({ disabled: true });

    fireEvent.changeText(getByTestId('feedback-input'), 'something broke');
    expect(getByTestId('feedback-submit').props.accessibilityState).toEqual({
      disabled: false,
    });
  });

  it('disables submit when only whitespace is entered', () => {
    const { getByTestId } = renderWithTheme(
      <FeedbackModal visible onClose={jest.fn()} />,
    );
    fireEvent.changeText(getByTestId('feedback-input'), '   ');
    expect(getByTestId('feedback-submit').props.accessibilityState).toEqual({
      disabled: true,
    });
  });

  it('submits trimmed message and shows success toast, then auto-closes', async () => {
    mockedSubmit.mockResolvedValue({ ok: true, status: 201 });
    const onClose = jest.fn();
    const { getByTestId } = renderWithTheme(
      <FeedbackModal visible onClose={onClose} />,
    );
    fireEvent.changeText(getByTestId('feedback-input'), '  hello  ');
    await act(async () => {
      fireEvent.press(getByTestId('feedback-submit'));
    });
    expect(mockedSubmit).toHaveBeenCalledWith('hello', {
      report: { occurredAt: NOW },
      diagnostics: 'DUMP',
    });
    await waitFor(() => {
      expect(getByTestId('feedback-status')).toBeTruthy();
    });
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps input and shows error toast on submit failure', async () => {
    mockedSubmit.mockResolvedValue({ ok: false, status: 500 });
    const onClose = jest.fn();
    const { getByTestId } = renderWithTheme(
      <FeedbackModal visible onClose={onClose} />,
    );
    fireEvent.changeText(getByTestId('feedback-input'), 'broken');
    await act(async () => {
      fireEvent.press(getByTestId('feedback-submit'));
    });
    await waitFor(() => {
      expect(getByTestId('feedback-status')).toBeTruthy();
    });
    expect(onClose).not.toHaveBeenCalled();
    // 입력 보존 — 사용자가 재시도할 수 있다.
    expect(getByTestId('feedback-input').props.value).toBe('broken');
  });

  it('no-op when submit pressed while disabled', async () => {
    mockedSubmit.mockResolvedValue({ ok: true, status: 201 });
    const { getByTestId } = renderWithTheme(
      <FeedbackModal visible onClose={jest.fn()} />,
    );
    await act(async () => {
      fireEvent.press(getByTestId('feedback-submit'));
    });
    expect(mockedSubmit).not.toHaveBeenCalled();
  });

  it('shows submitting label while request is in flight', async () => {
    let resolveFn: (v: { ok: boolean }) => void = () => {};
    mockedSubmit.mockImplementation(
      () => new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );
    const { getByTestId, queryByText } = renderWithTheme(
      <FeedbackModal visible onClose={jest.fn()} />,
    );
    fireEvent.changeText(getByTestId('feedback-input'), 'pending');
    await act(async () => {
      fireEvent.press(getByTestId('feedback-submit'));
    });
    expect(queryByText('보내는 중…')).toBeTruthy();
    await act(async () => {
      resolveFn({ ok: true });
    });
  });

  it('close button resets state and calls onClose', () => {
    const onClose = jest.fn();
    const { getByTestId } = renderWithTheme(
      <FeedbackModal visible onClose={onClose} />,
    );
    fireEvent.changeText(getByTestId('feedback-input'), 'draft');
    fireEvent.press(getByTestId('feedback-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('FEEDBACK_MAX_LENGTH is 2000 (matches backend)', () => {
    expect(FEEDBACK_MAX_LENGTH).toBe(2000);
  });

  it('dismisses keyboard when backdrop is pressed', () => {
    const dismissSpy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    const { getByTestId } = renderWithTheme(
      <FeedbackModal visible onClose={jest.fn()} />,
    );
    fireEvent.press(getByTestId('feedback-backdrop'));
    expect(dismissSpy).toHaveBeenCalled();
    dismissSpy.mockRestore();
  });

  it('uses height behavior on Android KeyboardAvoidingView', () => {
    const original = require('react-native').Platform.OS;
    require('react-native').Platform.OS = 'android';
    try {
      const { getByTestId } = renderWithTheme(
        <FeedbackModal visible onClose={jest.fn()} />,
      );
      // 렌더만 성공하면 OK — Android 분기 커버.
      expect(getByTestId('feedback-backdrop')).toBeTruthy();
    } finally {
      require('react-native').Platform.OS = original;
    }
  });

  it('ScrollView allows taps to pass through to submit button while keyboard open', () => {
    const { getByTestId } = renderWithTheme(
      <FeedbackModal visible onClose={jest.fn()} />,
    );
    // keyboardShouldPersistTaps="handled" 보장 — 키보드가 열려 있어도 submit 버튼이 첫 탭에 반응한다.
    expect(getByTestId('feedback-scroll').props.keyboardShouldPersistTaps).toBe(
      'handled',
    );
  });

  describe('어디서 틀렸나요 + 진단 자동 첨부 (#3366)', () => {
    const render = (onClose = jest.fn()) =>
      renderWithTheme(<FeedbackModal visible onClose={onClose} />);
    const press = async (testID: string, api: ReturnType<typeof render>) => {
      await act(async () => {
        fireEvent.press(api.getByTestId(testID));
      });
    };

    beforeEach(() => {
      useDestinationStore.setState({ destination: null, tripOrigin: null });
    });

    it('마운트만으로는 진단을 수집하지 않는다(보내기 시점에만)', () => {
      render();
      expect(mockCollect).not.toHaveBeenCalled();
      expect(mockBuildDumpText).not.toHaveBeenCalled();
    });

    it('유형 칩 7종을 ko 라벨로 렌더한다', () => {
      const api = render();
      for (const category of FEEDBACK_CATEGORIES) {
        expect(api.getByTestId(`feedback-chip-${category}`)).toBeTruthy();
      }
      expect(api.getByText('알람이 안 왔어요')).toBeTruthy();
      expect(api.getByText('내리는 문 방향이 틀렸어요')).toBeTruthy();
    });

    it('안내 한 줄을 보여준다(dump 미리보기·첨부 체크박스 없음)', () => {
      const api = render();
      expect(api.getByTestId('feedback-attach-notice').props.children).toBe(
        '앱 버전·기기·최근 이동 기록(위치 좌표 제외)이 함께 전송됩니다',
      );
      expect(api.queryByTestId('feedback-diagnostics-preview')).toBeNull();
      expect(api.queryByTestId('feedback-diagnostics-toggle')).toBeNull();
    });

    it('칩만 선택해도 보내기 활성 → message 자동 생성 + report.category', async () => {
      mockedSubmit.mockResolvedValue({ ok: true, status: 201 });
      const api = render();
      expect(api.getByTestId('feedback-submit').props.accessibilityState).toEqual({ disabled: true });
      await press('feedback-chip-alarm-missing', api);
      expect(api.getByTestId('feedback-submit').props.accessibilityState).toEqual({ disabled: false });
      await press('feedback-submit', api);
      expect(mockedSubmit).toHaveBeenCalledWith('[알람이 안 왔어요]', {
        report: { category: 'alarm-missing', occurredAt: NOW },
        diagnostics: 'DUMP',
      });
    });

    it('칩을 다시 누르면 선택 해제(둘 다 없으면 비활성)', async () => {
      const api = render();
      await press('feedback-chip-other', api);
      await press('feedback-chip-other', api);
      expect(api.getByTestId('feedback-submit').props.accessibilityState).toEqual({ disabled: true });
    });

    it('메모 + 칩 → 메모가 message, 칩은 category', async () => {
      mockedSubmit.mockResolvedValue({ ok: true, status: 201 });
      const api = render();
      await press('feedback-chip-wrong-door', api);
      fireEvent.changeText(api.getByTestId('feedback-input'), '반대쪽 문이 열렸어요');
      await press('feedback-submit', api);
      expect(mockedSubmit).toHaveBeenCalledWith('반대쪽 문이 열렸어요', {
        report: { category: 'wrong-door', occurredAt: NOW },
        diagnostics: 'DUMP',
      });
    });

    it('역 검색 → 선택하면 stationId가 report에, 역명이 자동 message에 들어간다', async () => {
      mockedSubmit.mockResolvedValue({ ok: true, status: 201 });
      const station = findStationByNameAndLine('성수', '2')!;
      const api = render();
      fireEvent.changeText(api.getByTestId('feedback-station-input'), '성수');
      await press(`feedback-station-result-${station.id}`, api);
      expect(api.getByTestId('feedback-station-selected')).toBeTruthy();
      await press('feedback-chip-alarm-late', api);
      await press('feedback-submit', api);
      expect(mockedSubmit).toHaveBeenCalledWith(`[알람이 늦게 왔어요] ${station.name}`, {
        report: { category: 'alarm-late', stationId: station.id, occurredAt: NOW },
        diagnostics: 'DUMP',
      });
    });

    it('선택한 역은 지울 수 있다', async () => {
      const station = findStationByNameAndLine('성수', '2')!;
      const api = render();
      fireEvent.changeText(api.getByTestId('feedback-station-input'), '성수');
      await press(`feedback-station-result-${station.id}`, api);
      await press('feedback-station-clear', api);
      expect(api.queryByTestId('feedback-station-selected')).toBeNull();
    });

    it('검색어가 없으면 결과 목록이 없다', () => {
      const api = render();
      expect(api.queryByTestId('feedback-station-results')).toBeNull();
    });

    it('진행 중 trip의 출발·도착역을 상단 추천으로 보여주고 탭하면 선택된다', async () => {
      const origin = findStationByNameAndLine('성수', '2')!;
      const dest = findStationByNameAndLine('잠실', '2')!;
      useDestinationStore.setState({ tripOrigin: origin, destination: dest });
      mockedSubmit.mockResolvedValue({ ok: true, status: 201 });
      const api = render();
      expect(api.getByTestId(`feedback-station-recommend-${origin.id}`)).toBeTruthy();
      await press(`feedback-station-recommend-${dest.id}`, api);
      await press('feedback-chip-other', api);
      await press('feedback-submit', api);
      expect(mockedSubmit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          report: { category: 'other', stationId: dest.id, occurredAt: NOW },
        }),
      );
    });

    it('trip이 없으면 추천 영역이 없다', () => {
      const api = render();
      expect(api.queryByTestId('feedback-station-recommend')).toBeNull();
    });

    it('collector 결과로 dump를 redact 모드로 만든다 + tripKey를 report에 싣는다', async () => {
      mockCollect.mockResolvedValue({ args: { marker: 'args' }, tokens: ['t1', 't2'], tripKey: 'abcd1234' });
      mockedSubmit.mockResolvedValue({ ok: true, status: 201 });
      const api = render();
      fireEvent.changeText(api.getByTestId('feedback-input'), 'memo');
      await press('feedback-submit', api);
      expect(mockBuildDumpText).toHaveBeenCalledWith(
        { marker: 'args' },
        { redact: true, tokens: ['t1', 't2'] },
      );
      expect(mockedSubmit).toHaveBeenCalledWith('memo', {
        report: { tripKey: 'abcd1234', occurredAt: NOW },
        diagnostics: 'DUMP',
      });
    });

    it('진단 수집이 실패해도 신고는 보낸다(message-only)', async () => {
      mockCollect.mockRejectedValue(new Error('storage down'));
      mockedSubmit.mockResolvedValue({ ok: true, status: 201 });
      const api = render();
      fireEvent.changeText(api.getByTestId('feedback-input'), 'memo');
      await press('feedback-submit', api);
      expect(mockedSubmit).toHaveBeenCalledWith('memo', { report: { occurredAt: NOW } });
    });

    it('close 시 칩·역 선택도 초기화된다', async () => {
      const api = render();
      await press('feedback-chip-other', api);
      fireEvent.press(api.getByTestId('feedback-close'));
      expect(api.getByTestId('feedback-submit').props.accessibilityState).toEqual({ disabled: true });
    });
  });
});
