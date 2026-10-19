import { existsSync } from 'fs';
import { join } from 'path';
import { FAVORITES_ROUTE } from '../routes';

describe('FAVORITES_ROUTE', () => {
  it('실제 expo-router 라우트 파일(app/(tabs)/favorites.tsx)과 일치한다', () => {
    const segments = FAVORITES_ROUTE.split('/').filter(Boolean);
    const routeFile = join(__dirname, '../../../../app', ...segments) + '.tsx';
    expect(existsSync(routeFile)).toBe(true);
  });
});
