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
        favorites={[{ station: favStation }]}
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
      <DestinationPicker {...defaultProps} favorites={[{ station: favStation }]} />,
    );
    expect(getByTestId('favorites-chip-row')).toBeTruthy();
    fireEvent.changeText(getByTestId('search-input'), '강남');
    expect(queryByTestId('favorites-chip-row')).toBeNull();
  });

  it('recentDestination과 중복되는 label 없는 즐겨찾기는 chip에서 제외한다', () => {
    const recent: Station = {
      id: '2-022',
      name: '강남',
      line: '2',
      lineColor: '#009D3E',
      lat: 37.498,
      lng: 127.0279,
    };
    const other: Station = {
      id: '2-021',
      name: '역삼',
      line: '2',
      lineColor: '#009D3E',
      lat: 37.5006,
      lng: 127.0365,
    };
    const { queryByTestId, getByTestId } = render(
      <DestinationPicker
        {...defaultProps}
        favorites={[{ station: recent }, { station: other }]}
        recentDestination={recent}
      />,
    );
    expect(queryByTestId(`favorite-chip-${recent.id}`)).toBeNull();
    expect(getByTestId(`favorite-chip-${other.id}`)).toBeTruthy();
  });

  it('label 있는 즐겨찾기는 recentDestination과 중복돼도 chip을 표시하고 label을 노출한다', () => {
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
        favorites={[{ station: home, label: '집' }]}
        recentDestination={home}
      />,
    );
    expect(getByTestId(`favorite-chip-${home.id}`)).toBeTruthy();
    expect(getByText('집')).toBeTruthy();
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
