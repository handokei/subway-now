import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { MapSearchBar } from '../MapSearchBar';

describe('MapSearchBar', () => {
  it('검색창을 렌더링한다', () => {
    const { getByTestId } = render(<MapSearchBar onSelect={jest.fn()} />);
    expect(getByTestId('map-search-input')).toBeTruthy();
  });

  it('초기 상태에서는 추천 목록을 렌더링하지 않는다', () => {
    const { queryByTestId } = render(<MapSearchBar onSelect={jest.fn()} />);
    expect(queryByTestId('map-search-suggestions')).toBeNull();
  });

  it('포커스만 받으면(검색어 없음) 추천을 보이지 않는다', () => {
    const { getByTestId, queryByTestId } = render(<MapSearchBar onSelect={jest.fn()} />);
    fireEvent(getByTestId('map-search-input'), 'focus');
    expect(queryByTestId('map-search-suggestions')).toBeNull();
  });

  it('검색어 입력 시 일치하는 역의 추천 목록을 보여준다', () => {
    const { getByTestId } = render(<MapSearchBar onSelect={jest.fn()} />);
    fireEvent.changeText(getByTestId('map-search-input'), '강남');
    expect(getByTestId('map-search-suggestions')).toBeTruthy();
  });

  it('공백만 입력 시 추천 목록을 보여주지 않는다', () => {
    const { getByTestId, queryByTestId } = render(<MapSearchBar onSelect={jest.fn()} />);
    fireEvent.changeText(getByTestId('map-search-input'), '   ');
    expect(queryByTestId('map-search-suggestions')).toBeNull();
  });

  it('추천 항목 탭 시 onSelect를 호출하고 추천을 닫는다', () => {
    const onSelect = jest.fn();
    const { getByTestId, queryByTestId, getAllByTestId } = render(
      <MapSearchBar onSelect={onSelect} />,
    );
    fireEvent.changeText(getByTestId('map-search-input'), '강남');
    const items = getAllByTestId(/^map-search-suggestion-/);
    fireEvent.press(items[0]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toEqual(
      expect.objectContaining({ name: expect.any(String), id: expect.any(String) }),
    );
    expect(queryByTestId('map-search-suggestions')).toBeNull();
  });

  it('일치하지 않는 검색어는 추천을 보여주지 않는다', () => {
    const { getByTestId, queryByTestId } = render(<MapSearchBar onSelect={jest.fn()} />);
    fireEvent.changeText(getByTestId('map-search-input'), 'zzzzzzzz없는역명');
    expect(queryByTestId('map-search-suggestions')).toBeNull();
  });

  it('추천 목록은 최대 8개로 제한된다', () => {
    const { getByTestId, getAllByTestId } = render(<MapSearchBar onSelect={jest.fn()} />);
    // 한글 단일 문자로 다수 매칭 유도
    fireEvent.changeText(getByTestId('map-search-input'), '역');
    const items = getAllByTestId(/^map-search-suggestion-/);
    expect(items.length).toBeLessThanOrEqual(8);
  });
});
