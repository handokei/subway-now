import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StationSuggestionList } from '../StationSuggestionList';
import type { Station } from '../../types/station';

const stations: Station[] = [
  { id: '2-022', name: '강남', nameEn: 'Gangnam', line: '2', lineColor: '#009D3E', lat: 37.5, lng: 127.0 },
  { id: '2-023', name: '선릉', nameEn: 'Seolleung', line: '2', lineColor: '#009D3E', lat: 37.5, lng: 127.0 },
];

describe('StationSuggestionList', () => {
  it('suggestions가 비어 있으면 null을 반환한다', () => {
    const { queryByTestId } = render(
      <StationSuggestionList
        suggestions={[]}
        onSelect={jest.fn()}
        listTestID="list"
        itemTestIDPrefix="item-"
      />,
    );
    expect(queryByTestId('list')).toBeNull();
  });

  it('각 역에 대해 prefix가 적용된 testID로 항목을 렌더링한다', () => {
    const { getByTestId } = render(
      <StationSuggestionList
        suggestions={stations}
        onSelect={jest.fn()}
        listTestID="list"
        itemTestIDPrefix="item-"
      />,
    );
    expect(getByTestId('list')).toBeTruthy();
    expect(getByTestId('item-2-022')).toBeTruthy();
    expect(getByTestId('item-2-023')).toBeTruthy();
  });

  it('항목 탭 시 해당 역을 onSelect로 전달한다', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <StationSuggestionList
        suggestions={stations}
        onSelect={onSelect}
        listTestID="list"
        itemTestIDPrefix="item-"
      />,
    );
    fireEvent.press(getByTestId('item-2-022'));
    expect(onSelect).toHaveBeenCalledWith(stations[0]);
  });
});
