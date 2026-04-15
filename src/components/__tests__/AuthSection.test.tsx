jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithIdToken: jest.fn(),
      signOut: jest.fn(),
      getSession: jest.fn(),
      setSession: jest.fn(),
      exchangeCodeForSession: jest.fn(),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
  },
}));

jest.mock('expo-apple-authentication', () => ({
  signInAsync: jest.fn(),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));

jest.mock('expo-auth-session', () => ({
  makeRedirectUri: jest.fn(() => 'test://redirect'),
  ResponseType: { Code: 'code' },
  AuthRequest: jest.fn().mockImplementation(() => ({
    promptAsync: jest.fn(),
  })),
}));

jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => 'test-uuid'),
  digestStringAsync: jest.fn(async () => 'hashed-nonce'),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));

jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
  openAuthSessionAsync: jest.fn(),
}));

import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { Platform, Alert } from 'react-native';
import AuthSection from '../AuthSection';
import { useAuthStore } from '../../store/useAuthStore';

const mockUser = { id: 'user-1', email: 'test@example.com' };

describe('AuthSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({
      session: null,
      user: null,
      isLoading: false,
    });
  });

  describe('로딩 상태', () => {
    it('isLoading이 true이면 로딩 인디케이터를 표시한다', () => {
      useAuthStore.setState({ isLoading: true });
      const { getByTestId } = render(<AuthSection />);
      expect(getByTestId('auth-loading')).toBeTruthy();
    });
  });

  describe('비로그인 상태', () => {
    it('로그인 버튼들을 렌더링한다', () => {
      const { getByTestId, getByText } = render(<AuthSection />);
      expect(getByText('로그인하면 즐겨찾기와 설정을 동기화할 수 있습니다')).toBeTruthy();
      expect(getByTestId('google-sign-in-button')).toBeTruthy();
      expect(getByTestId('kakao-sign-in-button')).toBeTruthy();
    });

    it('iOS에서 Apple 로그인 버튼을 표시한다', () => {
      Platform.OS = 'ios';
      const { getByTestId } = render(<AuthSection />);
      expect(getByTestId('apple-sign-in-button')).toBeTruthy();
    });

    it('Android에서 Apple 로그인 버튼을 숨긴다', () => {
      Platform.OS = 'android';
      const { queryByTestId } = render(<AuthSection />);
      expect(queryByTestId('apple-sign-in-button')).toBeNull();
    });

    it('Google 로그인 버튼 클릭 시 signInWithGoogle을 호출한다', async () => {
      const mockSignIn = jest.fn().mockResolvedValue(undefined);
      useAuthStore.setState({
        signInWithGoogle: mockSignIn,
      } as any);

      const { getByTestId } = render(<AuthSection />);
      fireEvent.press(getByTestId('google-sign-in-button'));

      await waitFor(() => {
        expect(mockSignIn).toHaveBeenCalled();
      });
    });

    it('Kakao 로그인 버튼 클릭 시 signInWithKakao를 호출한다', async () => {
      const mockSignIn = jest.fn().mockResolvedValue(undefined);
      useAuthStore.setState({
        signInWithKakao: mockSignIn,
      } as any);

      const { getByTestId } = render(<AuthSection />);
      fireEvent.press(getByTestId('kakao-sign-in-button'));

      await waitFor(() => {
        expect(mockSignIn).toHaveBeenCalled();
      });
    });

    it('Apple 로그인 버튼 클릭 시 signInWithApple을 호출한다', async () => {
      Platform.OS = 'ios';
      const mockSignIn = jest.fn().mockResolvedValue(undefined);
      useAuthStore.setState({
        signInWithApple: mockSignIn,
      } as any);

      const { getByTestId } = render(<AuthSection />);
      fireEvent.press(getByTestId('apple-sign-in-button'));

      await waitFor(() => {
        expect(mockSignIn).toHaveBeenCalled();
      });
    });

    it('로그인 실패 시 Alert를 표시한다', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert');
      const mockSignIn = jest.fn().mockRejectedValue(new Error('login failed'));
      useAuthStore.setState({
        signInWithGoogle: mockSignIn,
      } as any);

      const { getByTestId } = render(<AuthSection />);
      fireEvent.press(getByTestId('google-sign-in-button'));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith('로그인 실패', 'login failed');
      });
    });

    it('Error가 아닌 예외 시 기본 메시지를 표시한다', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert');
      const mockSignIn = jest.fn().mockRejectedValue('unknown');
      useAuthStore.setState({
        signInWithGoogle: mockSignIn,
      } as any);

      const { getByTestId } = render(<AuthSection />);
      fireEvent.press(getByTestId('google-sign-in-button'));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith('로그인 실패', '로그인에 실패했습니다');
      });
    });
  });

  describe('로그인 상태', () => {
    beforeEach(() => {
      useAuthStore.setState({
        user: mockUser as any,
        session: { user: mockUser, access_token: 'token' } as any,
      });
    });

    it('사용자 이메일과 로그아웃 버튼을 표시한다', () => {
      const { getByText, getByTestId } = render(<AuthSection />);
      expect(getByText('test@example.com')).toBeTruthy();
      expect(getByTestId('sign-out-button')).toBeTruthy();
    });

    it('이메일이 없으면 기본 텍스트를 표시한다', () => {
      useAuthStore.setState({
        user: { id: 'user-1', email: null } as any,
        session: { user: { id: 'user-1' }, access_token: 'token' } as any,
      });

      const { getByText } = render(<AuthSection />);
      expect(getByText('이메일 없음')).toBeTruthy();
    });

    it('로그아웃 버튼 클릭 시 signOut을 호출한다', async () => {
      const mockSignOutFn = jest.fn().mockResolvedValue(undefined);
      useAuthStore.setState({
        user: mockUser as any,
        session: { user: mockUser, access_token: 'token' } as any,
        signOut: mockSignOutFn,
      } as any);

      const { getByTestId } = render(<AuthSection />);
      fireEvent.press(getByTestId('sign-out-button'));

      await waitFor(() => {
        expect(mockSignOutFn).toHaveBeenCalled();
      });
    });

    it('로그아웃 실패 시 Alert를 표시한다', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert');
      const mockSignOutFn = jest.fn().mockRejectedValue(new Error('fail'));
      useAuthStore.setState({
        user: mockUser as any,
        session: { user: mockUser, access_token: 'token' } as any,
        signOut: mockSignOutFn,
      } as any);

      const { getByTestId } = render(<AuthSection />);
      fireEvent.press(getByTestId('sign-out-button'));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith('오류', '로그아웃에 실패했습니다');
      });
    });
  });
});
