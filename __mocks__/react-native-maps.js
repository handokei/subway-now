const React = require('react');
const { View } = require('react-native');

const MapView = ({ children, testID, onMapReady, ...props }) => {
  React.useEffect(() => { onMapReady?.(); }, []);
  return React.createElement(View, { testID, ...props }, children);
};

const Marker = ({ testID, onPress, ...props }) =>
  React.createElement(View, { testID, onPress, ...props });

module.exports = {
  __esModule: true,
  default: MapView,
  Marker,
  PROVIDER_DEFAULT: null,
};
