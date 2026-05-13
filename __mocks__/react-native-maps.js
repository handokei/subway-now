const React = require('react');
const { View } = require('react-native');

const fitToCoordinatesMock = jest.fn();

const MapView = React.forwardRef(({ children, testID, onMapReady, ...props }, ref) => {
  React.useImperativeHandle(ref, () => ({
    fitToCoordinates: fitToCoordinatesMock,
  }));
  React.useEffect(() => { onMapReady?.(); }, []);
  return React.createElement(View, { testID, ...props }, children);
});

const Marker = ({ testID, onPress, children, ...props }) =>
  React.createElement(View, { testID, onPress, ...props }, children);

const Polyline = ({ testID, ...props }) =>
  React.createElement(View, { testID, ...props });

module.exports = {
  __esModule: true,
  default: MapView,
  Marker,
  Polyline,
  PROVIDER_DEFAULT: null,
  __fitToCoordinatesMock: fitToCoordinatesMock,
};
