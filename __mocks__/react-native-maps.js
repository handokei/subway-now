const React = require('react');
const { View } = require('react-native');

const fitToCoordinatesMock = jest.fn();
const animateToRegionMock = jest.fn();
const animatedRegionTimingStartMock = jest.fn();
const animatedRegionTimingMock = jest.fn(() => ({ start: animatedRegionTimingStartMock }));

const MapView = React.forwardRef(({ children, testID, onMapReady, ...props }, ref) => {
  React.useImperativeHandle(ref, () => ({
    fitToCoordinates: fitToCoordinatesMock,
    animateToRegion: animateToRegionMock,
  }));
  React.useEffect(() => { onMapReady?.(); }, []);
  return React.createElement(View, { testID, ...props }, children);
});

const Marker = ({ testID, onPress, children, ...props }) =>
  React.createElement(View, { testID, onPress, ...props }, children);

const MarkerAnimated = ({ testID, onPress, children, ...props }) =>
  React.createElement(View, { testID, onPress, ...props }, children);

const Polyline = ({ testID, ...props }) =>
  React.createElement(View, { testID, ...props });

class AnimatedRegion {
  constructor(region) {
    this._region = region;
  }
  timing(config) {
    animatedRegionTimingMock(config);
    return { start: animatedRegionTimingStartMock };
  }
}

module.exports = {
  __esModule: true,
  default: MapView,
  Marker,
  MarkerAnimated,
  Polyline,
  AnimatedRegion,
  PROVIDER_DEFAULT: null,
  __fitToCoordinatesMock: fitToCoordinatesMock,
  __animateToRegionMock: animateToRegionMock,
  __animatedRegionTimingMock: animatedRegionTimingMock,
  __animatedRegionTimingStartMock: animatedRegionTimingStartMock,
};
