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
    fireEvent.press(getByTestId('marker-2-022'));
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
