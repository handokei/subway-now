import React from 'react';
import { View } from 'react-native';

export const WebView = ({ onMessage, testID, ...props }: any) =>
  React.createElement(View, { testID, onMessage, ...props });

export default WebView;
