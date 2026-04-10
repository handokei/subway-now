import React from 'react';
import { View } from 'react-native';

export const NaverMapView = ({ children, ...props }: any) =>
  React.createElement(View, { testID: 'naver-map-view', ...props }, children);

export const NaverMapMarkerOverlay = ({ children, onTap, latitude, longitude, ...props }: any) =>
  React.createElement(View, { testID: `marker-${latitude}-${longitude}`, onTap, latitude, longitude, ...props }, children);
