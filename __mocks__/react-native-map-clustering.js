const React = require('react');
const { View } = require('react-native');

const animateToRegionMock = jest.fn();

const ClusteredMapView = React.forwardRef(
  ({ children, testID, onMapReady, ...props }, ref) => {
    React.useImperativeHandle(ref, () => ({
      animateToRegion: animateToRegionMock,
    }));
    React.useEffect(() => { onMapReady?.(); }, []);
    return React.createElement(View, { testID, ...props }, children);
  },
);

module.exports = {
  __esModule: true,
  default: ClusteredMapView,
  __animateToRegionMock: animateToRegionMock,
};
