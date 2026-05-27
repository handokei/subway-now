import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import { DestinationPicker } from '../DestinationPicker';
import type { Station } from '../../types/station';

const mockStation: Station = {
  id: '2-022',
  name: '강남',
  nameEn: 'Gangnam',
  nameJa: 'カンナム',
  nameHanja: '江南',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.49799,
  lng: 127.027912,
};

const defaultProps = {
  visible: true,
  onSelect: jest.fn(),
  onClose: jest.fn(),
};

const mapProps = {
  ...defaultProps,
  userLat: 37.498,
  userLng: 127.027,
};

describe('DestinationPicker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('제목, 검색창, 닫기 버튼을 렌더링한다', () => {
    const { getByText, getByTestId } = render(<DestinationPicker {...defaultProps} />);
    expect(getByText('목적지 설정')).toBeTruthy();
    expect(getByTestId('search-input')).toBeTruthy();
    expect(getByTestId('close-button')).toBeTruthy();
  });

  it('닫기 버튼 클릭 시 onClose를 호출한다', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(<DestinationPicker {...defaultProps} onClose={onClose} />);
    fireEvent.press(getByTestId('close-button'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('좌표가 있으면 지도를 렌더링한다', () => {
    const { getByTestId } = render(<DestinationPicker {...mapProps} />);
    expect(getByTestId('station-map')).toBeTruthy();
  });

  it('좌표가 없으면 map-fallback을 렌더링한다', () => {
    const { getByTestId } = render(<DestinationPicker {...defaultProps} />);
    expect(getByTestId('map-fallback')).toBeTruthy();
  });

  it('검색어 입력 시 일치하는 역 드롭다운을 표시한다', () => {
    const { getByTestId } = render(<DestinationPicker {...defaultProps} />);
    fireEvent.changeText(getByTestId('search-input'), '강남');
    expect(getByTestId('suggestions-list')).toBeTruthy();
    expect(getByTestId(`suggestion-item-${mockStation.id}`)).toBeTruthy();
  });

  it('검색어와 일치하는 역이 없으면 드롭다운을 표시하지 않는다', () => {
    const { getByTestId, queryByTestId } = render(<DestinationPicker {...defaultProps} />);
    fireEvent.changeText(getByTestId('search-input'), '존재하지않는역이름xyz');
    expect(queryByTestId('suggestions-list')).toBeNull();
  });

  it('빈 검색어에서는 드롭다운을 표시하지 않는다', () => {
    const { getByTestId, queryByTestId } = render(<DestinationPicker {...defaultProps} />);
    fireEvent.changeText(getByTestId('search-input'), '강남');
    fireEvent.changeText(getByTestId('search-input'), '');
    expect(queryByTestId('suggestions-list')).toBeNull();
  });

  it('드롭다운 항목 선택 시 onSelect를 호출한다', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(<DestinationPicker {...defaultProps} onSelect={onSelect} />);
    fireEvent.changeText(getByTestId('search-input'), '강남');
    fireEvent.press(getByTestId(`suggestion-item-${mockStation.id}`));
    expect(onSelect).toHaveBeenCalledWith(mockStation);
  });

  it('드롭다운 항목 선택 후 검색어가 초기화된다', () => {
    const { getByTestId, queryByTestId } = render(<DestinationPicker {...defaultProps} />);
    fireEvent.changeText(getByTestId('search-input'), '강남');
    fireEvent.press(getByTestId(`suggestion-item-${mockStation.id}`));
    expect(getByTestId('search-input').props.value).toBe('');
    expect(queryByTestId('suggestions-list')).toBeNull();
  });

  it('닫기 후 검색어가 초기화된다', () => {
    const { getByTestId, queryByTestId } = render(<DestinationPicker {...defaultProps} />);
    fireEvent.changeText(getByTestId('search-input'), '강남');
    fireEvent.press(getByTestId('close-button'));
    expect(getByTestId('search-input').props.value).toBe('');
    expect(queryByTestId('suggestions-list')).toBeNull();
  });

  it('지도 마커 탭으로 onSelect가 호출된다', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(<DestinationPicker {...mapProps} onSelect={onSelect} />);
    fireEvent.press(getByTestId('marker-강남'));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: '2-022', name: '강남' }),
    );
  });

  it('특수 노선 검색 시 한글 호선명이 표시된다', () => {
    const { getByTestId, getAllByText } = render(<DestinationPicker {...defaultProps} />);
    fireEvent.changeText(getByTestId('search-input'), '김포공항');
    expect(getAllByText('공항철도').length).toBeGreaterThanOrEqual(1);
  });

  it('visible false로 전환 시 모달 세션 로그를 출력한다', () => {
    const debugSpy = jest.spyOn(console, 'log');
    const { rerender } = render(<DestinationPicker {...defaultProps} visible={true} />);
    rerender(<DestinationPicker {...defaultProps} visible={false} />);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('[DestinationPicker]'),
      expect.stringContaining('모달 세션 유지 시간'),
    );
    debugSpy.mockRestore();
  });

  it('처음부터 visible false이면 세션 로그를 출력하지 않는다', () => {
    const debugSpy = jest.spyOn(console, 'log');
    render(<DestinationPicker {...defaultProps} visible={false} />);
    const sessionLogs = debugSpy.mock.calls.filter(
      (args) => typeof args[1] === 'string' && args[1].includes('모달 세션 유지 시간'),
    );
    expect(sessionLogs).toHaveLength(0);
    debugSpy.mockRestore();
  });

  it('좌표가 있으면 recenter 버튼을 렌더링한다', () => {
    const { getByTestId } = render(<DestinationPicker {...mapProps} />);
    expect(getByTestId('recenter-button')).toBeTruthy();
  });

  it('좌표가 없으면 recenter 버튼을 렌더링하지 않는다', () => {
    const { queryByTestId } = render(<DestinationPicker {...defaultProps} />);
    expect(queryByTestId('recenter-button')).toBeNull();
  });

  it('recenter 버튼 클릭 시 onRecenter 콜백을 호출한다', () => {
    const onRecenter = jest.fn();
    const { getByTestId } = render(
      <DestinationPicker {...mapProps} onRecenter={onRecenter} />,
    );
    fireEvent.press(getByTestId('recenter-button'));
    expect(onRecenter).toHaveBeenCalledTimes(1);
  });

  it('onRecenter 미제공 상태에서 recenter 버튼을 눌러도 오류가 없다', () => {
    const { getByTestId } = render(<DestinationPicker {...mapProps} />);
    expect(() => fireEvent.press(getByTestId('recenter-button'))).not.toThrow();
  });

  it('favorites가 비어있거나 미제공이면 chip 영역을 렌더링하지 않는다', () => {
    const { queryByTestId, rerender } = render(<DestinationPicker {...defaultProps} />);
    expect(queryByTestId('favorites-chip-row')).toBeNull();

    rerender(<DestinationPicker {...defaultProps} favorites={[]} />);
    expect(queryByTestId('favorites-chip-row')).toBeNull();
  });

  it('favorites가 있으면 chip을 렌더링하고 탭 시 onSelect를 Station으로 호출한다', () => {
    const onSelect = jest.fn();
    const favStation: Station = {
      id: '2-021',
      name: '역삼',
      line: '2',
      lineColor: '#009D3E',
      lat: 37.5006,
      lng: 127.0365,
    };
    const { getByTestId } = render(
      <DestinationPicker
        {...defaultProps}
        favorites={[{ station: favStation, role: 'general' }]}
        onSelect={onSelect}
      />,
    );
    expect(getByTestId('favorites-chip-row')).toBeTruthy();
    fireEvent.press(getByTestId(`favorite-chip-${favStation.id}`));
    expect(onSelect).toHaveBeenCalledWith(favStation);
  });

  it('검색어를 입력해 드롭다운이 열리면 favorites chip을 숨긴다', () => {
    const favStation: Station = {
      id: '2-021',
      name: '역삼',
      line: '2',
      lineColor: '#009D3E',
      lat: 37.5006,
      lng: 127.0365,
    };
    const { getByTestId, queryByTestId } = render(
      <DestinationPicker {...defaultProps} favorites={[{ station: favStation, role: 'general' }]} />,
    );
    expect(getByTestId('favorites-chip-row')).toBeTruthy();
    fireEvent.changeText(getByTestId('search-input'), '강남');
    expect(queryByTestId('favorites-chip-row')).toBeNull();
  });

  it('label 있는 즐겨찾기 chip은 label을 노출한다', () => {
    const home: Station = {
      id: '2-022',
      name: '강남',
      line: '2',
      lineColor: '#009D3E',
      lat: 37.498,
      lng: 127.0279,
    };
    const { getByTestId, getByText } = render(
      <DestinationPicker
        {...defaultProps}
        favorites={[{ station: home, role: 'general', label: '집' }]}
      />,
    );
    expect(getByTestId(`favorite-chip-${home.id}`)).toBeTruthy();
    expect(getByText('집')).toBeTruthy();
  });

  it('home/work 슬롯 chip은 아이콘과 i18n 라벨(집/회사)을 노출하며 general 앞에 정렬된다', () => {
    const home: Station = {
      id: '2-022',
      name: '강남',
      line: '2',
      lineColor: '#009D3E',
      lat: 37.498,
      lng: 127.0279,
    };
    const work: Station = {
      id: '2-021',
      name: '역삼',
      line: '2',
      lineColor: '#009D3E',
      lat: 37.5006,
      lng: 127.0365,
    };
    const general: Station = {
      id: '2-020',
      name: '선릉',
      line: '2',
      lineColor: '#009D3E',
      lat: 37.5045,
      lng: 127.0489,
    };
    const { getByText, getAllByTestId } = render(
      <DestinationPicker
        {...defaultProps}
        favorites={[
          { station: general, role: 'general' },
          { station: home, role: 'home' },
          { station: work, role: 'work' },
        ]}
      />,
    );
    expect(getByText('집')).toBeTruthy();
    expect(getByText('회사')).toBeTruthy();
    expect(getByText('🏠')).toBeTruthy();
    expect(getByText('🏢')).toBeTruthy();
    // 첫 chip은 home, 두 번째는 work, 세 번째는 general
    const chips = getAllByTestId(/^favorite-chip-/);
    expect(chips[0].props.testID).toBe(`favorite-chip-${home.id}`);
    expect(chips[1].props.testID).toBe(`favorite-chip-${work.id}`);
    expect(chips[2].props.testID).toBe(`favorite-chip-${general.id}`);
  });

  it('미설정 슬롯이 있고 onAssignSlot이 제공되면 placeholder chip을 노출한다', () => {
    const { getByTestId } = render(
      <DestinationPicker {...defaultProps} favorites={[]} onAssignSlot={jest.fn()} />,
    );
    expect(getByTestId('slot-placeholder-chip-home')).toBeTruthy();
    expect(getByTestId('slot-placeholder-chip-work')).toBeTruthy();
  });

  it('favorites prop이 없어도 onAssignSlot만 있으면 placeholder chip을 노출한다', () => {
    const { getByTestId } = render(
      <DestinationPicker {...defaultProps} onAssignSlot={jest.fn()} />,
    );
    expect(getByTestId('slot-placeholder-chip-home')).toBeTruthy();
  });

  it('onAssignSlot이 없으면 placeholder chip을 노출하지 않는다', () => {
    const { queryByTestId } = render(
      <DestinationPicker {...defaultProps} favorites={[]} />,
    );
    expect(queryByTestId('slot-placeholder-chip-home')).toBeNull();
    expect(queryByTestId('slot-placeholder-chip-work')).toBeNull();
  });

  it('placeholder chip 탭 → 다음 선택 역이 onAssignSlot으로 전달되고 chip이 갱신된다', () => {
    const onAssignSlot = jest.fn();
    const onSelect = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <DestinationPicker
        {...defaultProps}
        favorites={[]}
        onAssignSlot={onAssignSlot}
        onSelect={onSelect}
      />,
    );
    fireEvent.press(getByTestId('slot-placeholder-chip-home'));
    expect(getByTestId('pending-slot-banner')).toBeTruthy();
    // 검색 결과 선택 → onAssignSlot이 호출되고 onSelect는 호출되지 않음
    fireEvent.changeText(getByTestId('search-input'), '강남');
    fireEvent.press(getByTestId(`suggestion-item-${mockStation.id}`));
    expect(onAssignSlot).toHaveBeenCalledWith('home', mockStation);
    expect(onSelect).not.toHaveBeenCalled();
    // 배너는 사라짐
    expect(queryByTestId('pending-slot-banner')).toBeNull();
  });

  it('placeholder chip을 다시 누르면 pending 모드가 해제된다', () => {
    const { getByTestId, queryByTestId } = render(
      <DestinationPicker {...defaultProps} favorites={[]} onAssignSlot={jest.fn()} />,
    );
    fireEvent.press(getByTestId('slot-placeholder-chip-home'));
    expect(getByTestId('pending-slot-banner')).toBeTruthy();
    fireEvent.press(getByTestId('slot-placeholder-chip-home'));
    expect(queryByTestId('pending-slot-banner')).toBeNull();
  });

  it('pending banner의 취소 버튼이 모드를 해제한다', () => {
    const { getByTestId, queryByTestId } = render(
      <DestinationPicker {...defaultProps} favorites={[]} onAssignSlot={jest.fn()} />,
    );
    fireEvent.press(getByTestId('slot-placeholder-chip-home'));
    fireEvent.press(getByTestId('pending-slot-cancel'));
    expect(queryByTestId('pending-slot-banner')).toBeNull();
  });

  it('모달 닫기 시 pending 모드가 초기화된다', () => {
    const onClose = jest.fn();
    const { getByTestId, queryByTestId, rerender } = render(
      <DestinationPicker {...defaultProps} favorites={[]} onAssignSlot={jest.fn()} onClose={onClose} />,
    );
    fireEvent.press(getByTestId('slot-placeholder-chip-home'));
    fireEvent.press(getByTestId('close-button'));
    expect(onClose).toHaveBeenCalled();
    rerender(<DestinationPicker {...defaultProps} visible={true} favorites={[]} onAssignSlot={jest.fn()} onClose={onClose} />);
    expect(queryByTestId('pending-slot-banner')).toBeNull();
  });

  it('이미 home/work가 모두 지정되어 있으면 placeholder chip을 노출하지 않는다', () => {
    const home: Station = { ...mockStation };
    const work: Station = { id: '2-021', name: '역삼', line: '2', lineColor: '#009D3E', lat: 37.5, lng: 127 };
    const { queryByTestId } = render(
      <DestinationPicker
        {...defaultProps}
        favorites={[
          { station: home, role: 'home' },
          { station: work, role: 'work' },
        ]}
        onAssignSlot={jest.fn()}
      />,
    );
    expect(queryByTestId('slot-placeholder-chip-home')).toBeNull();
    expect(queryByTestId('slot-placeholder-chip-work')).toBeNull();
  });

  it('지도 마커 탭으로도 슬롯 지정이 동작한다', () => {
    const onAssignSlot = jest.fn();
    const { getByTestId } = render(
      <DestinationPicker {...mapProps} favorites={[]} onAssignSlot={onAssignSlot} />,
    );
    fireEvent.press(getByTestId('slot-placeholder-chip-work'));
    fireEvent.press(getByTestId('marker-강남'));
    expect(onAssignSlot).toHaveBeenCalledWith('work', expect.objectContaining({ id: '2-022' }));
  });

  it('검색창 포커스 시 드롭다운 표시 상태가 활성화된다', () => {
    const { getByTestId, queryByTestId } = render(<DestinationPicker {...defaultProps} />);
    fireEvent.changeText(getByTestId('search-input'), '강남');
    fireEvent.press(getByTestId(`suggestion-item-${mockStation.id}`));
    expect(queryByTestId('suggestions-list')).toBeNull();
    fireEvent.changeText(getByTestId('search-input'), '강남');
    fireEvent(getByTestId('search-input'), 'focus');
    expect(getByTestId('suggestions-list')).toBeTruthy();
  });
});
