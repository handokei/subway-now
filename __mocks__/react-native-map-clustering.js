const React = require('react');
const { View } = require('react-native');

const ClusteredMapView = ({ children, testID, onMapReady, ...props }) => {
  React.useEffect(() => { onMapReady?.(); }, []);
  return React.createElement(View, { testID, ...props }, children);
};

module.exports = {
  __esModule: true,
  default: ClusteredMapView,
};
