import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { DestinationPicker } from '../DestinationPicker';
import type { Station } from '../../types/station';

const mockStation: Station = {
  id: '2-022',
  name: '강남',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.4979,
  lng: 127.0276,
};

const defaultProps = {
  visible: true,
  onSelect: jest.fn(),
  onClose: jest.fn(),
};

describe('DestinationPicker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('visible=true 일 때 제목과 검색창을 렌더링한다', () => {
    const { getByText, getByTestId } = render(<DestinationPicker {...defaultProps} />);
    expect(getByText('목적지 설정')).toBeTruthy();
    expect(getByTestId('search-input')).toBeTruthy();
    expect(getByTestId('close-button')).toBeTruthy();
  });

  it('닫기 버튼 클릭 시 onClose를 호출한다', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(
      <DestinationPicker {...defaultProps} onClose={onClose} />
    );
    fireEvent.press(getByTestId('close-button'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('역 이름으로 검색하면 필터링된 결과를 보여준다', () => {
    const { getByTestId, queryByTestId } = render(
      <DestinationPicker {...defaultProps} />
    );
    fireEvent.changeText(getByTestId('search-input'), '강남');
    expect(getByTestId(`station-item-${mockStation.id}`)).toBeTruthy();
    // 강남이 포함되지 않는 역은 표시되지 않아야 함
    expect(queryByTestId('station-item-1-001')).toBeNull();
  });

  it('역 항목 선택 시 onSelect를 호출한다', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <DestinationPicker {...defaultProps} onSelect={onSelect} />
    );
    fireEvent.changeText(getByTestId('search-input'), '강남');
    fireEvent.press(getByTestId(`station-item-${mockStation.id}`));
    expect(onSelect).toHaveBeenCalledWith(mockStation);
  });

  it('역 선택 후 검색어가 초기화된다', () => {
    const { getByTestId } = render(<DestinationPicker {...defaultProps} />);
    fireEvent.changeText(getByTestId('search-input'), '강남');
    fireEvent.press(getByTestId(`station-item-${mockStation.id}`));
    expect(getByTestId('search-input').props.value).toBe('');
  });

  it('닫기 후 검색어가 초기화된다', () => {
    const { getByTestId } = render(<DestinationPicker {...defaultProps} />);
    fireEvent.changeText(getByTestId('search-input'), '강남');
    fireEvent.press(getByTestId('close-button'));
    expect(getByTestId('search-input').props.value).toBe('');
  });

  it('검색어가 비어있으면 기본 목록이 표시된다', () => {
    const { getAllByTestId } = render(<DestinationPicker {...defaultProps} />);
    const items = getAllByTestId(/^station-item-/);
    expect(items.length).toBeGreaterThan(0);
  });
});
