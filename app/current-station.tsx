// expo-router route entry — 위젯 딥링크(subway-now://current-station) alias.
// 홈(현재 역 탭)으로 redirect. thin route 컨벤션(redirect 전용).
import { Redirect } from 'expo-router';

export default function CurrentStationRedirect() {
  return <Redirect href="/" />;
}
