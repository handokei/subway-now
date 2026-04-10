import React from 'react';
import { View } from 'react-native';

export const NaverMapView = ({ children, ...props }: any) =>
  React.createElement(View, { testID: 'naver-map-view', ...props }, children);

export const NaverMapMarkerOverlay = ({ children, onTap, latitude, testID, ...props }: any) =>
  React.createElement(View, { testID: testID ?? `marker-${latitude}`, onTap, latitude, ...props }, children);
