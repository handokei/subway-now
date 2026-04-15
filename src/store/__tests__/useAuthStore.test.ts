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

import { supabase } from '../../lib/supabase';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { useAuthStore, extractCodeFromUrl } from '../useAuthStore';

const mockSupabaseAuth = supabase.auth as jest.Mocked<typeof supabase.auth>;
const mockAppleSignIn = AppleAuthentication.signInAsync as jest.Mock;
const mockOpenAuthSession = WebBrowser.openAuthSessionAsync as jest.Mock;

const mockUser = { id: 'user-1', email: 'test@example.com' };
const mockSession = { user: mockUser, access_token: 'token-1' };

describe('extractCodeFromUrl', () => {
  it('query param에서 code를 추출한다', () => {
    expect(extractCodeFromUrl('test://redirect?code=abc123')).toBe('abc123');
  });

  it('hash fragment에서 code를 추출한다', () => {
    expect(extractCodeFromUrl('test://redirect#code=def456')).toBe('def456');
  });

  it('code가 없으면 null을 반환한다', () => {
    expect(extractCodeFromUrl('test://redirect?other=value')).toBeNull();
  });

  it('encoded code를 디코딩한다', () => {
    expect(extractCodeFromUrl('test://redirect?code=a%20b')).toBe('a b');
  });
});

describe('useAuthStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({
      session: null,
      user: null,
      isLoading: true,
    });
  });

  describe('setSession', () => {
    it('세션과 유저를 설정한다', () => {
      useAuthStore.getState().setSession(mockSession as any);
      const state = useAuthStore.getState();
      expect(state.session).toBe(mockSession);
      expect(state.user).toBe(mockUser);
    });

    it('null 세션이면 유저도 null이다', () => {
      useAuthStore.getState().setSession(null);
      const state = useAuthStore.getState();
      expect(state.session).toBeNull();
      expect(state.user).toBeNull();
    });
  });

  describe('signInWithApple', () => {
    it('Apple 로그인 성공 시 Supabase에 idToken을 전달한다', async () => {
      mockAppleSignIn.mockResolvedValueOnce({
        identityToken: 'apple-id-token',
      });
      (mockSupabaseAuth.signInWithIdToken as jest.Mock).mockResolvedValueOnce({
        error: null,
      });

      await useAuthStore.getState().signInWithApple();

      expect(mockAppleSignIn).toHaveBeenCalledWith(
        expect.objectContaining({ nonce: 'hashed-nonce' }),
      );
      expect(mockSupabaseAuth.signInWithIdToken).toHaveBeenCalledWith({
        provider: 'apple',
        token: 'apple-id-token',
        nonce: 'test-uuid',
      });
    });

    it('identityToken이 없으면 에러를 던진다', async () => {
      mockAppleSignIn.mockResolvedValueOnce({ identityToken: null });

      await expect(
        useAuthStore.getState().signInWithApple(),
      ).rejects.toThrow('identityToken이 없습니다');
    });

    it('Supabase 에러 시 에러를 던진다', async () => {
      mockAppleSignIn.mockResolvedValueOnce({
        identityToken: 'apple-id-token',
      });
      (mockSupabaseAuth.signInWithIdToken as jest.Mock).mockResolvedValueOnce({
        error: new Error('supabase error'),
      });

      await expect(
        useAuthStore.getState().signInWithApple(),
      ).rejects.toThrow('supabase error');
    });
  });

  describe('signInWithGoogle', () => {
    it('Google 로그인 성공 시 PKCE code flow로 세션을 교환한다', async () => {
      const AuthRequestMock = AuthSession.AuthRequest as jest.Mock;
      AuthRequestMock.mockImplementationOnce(() => ({
        promptAsync: jest.fn().mockResolvedValueOnce({
          type: 'success',
          params: { code: 'google-auth-code' },
        }),
      }));
      (mockSupabaseAuth.exchangeCodeForSession as jest.Mock).mockResolvedValueOnce({
        error: null,
      });

      await useAuthStore.getState().signInWithGoogle();

      expect(AuthRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          responseType: 'code',
          usePKCE: true,
        }),
      );
      expect(mockSupabaseAuth.exchangeCodeForSession).toHaveBeenCalledWith(
        'google-auth-code',
      );
    });

    it('Google 로그인 취소 시 에러를 던진다', async () => {
      const AuthRequestMock = AuthSession.AuthRequest as jest.Mock;
      AuthRequestMock.mockImplementationOnce(() => ({
        promptAsync: jest.fn().mockResolvedValueOnce({ type: 'cancel' }),
      }));

      await expect(
        useAuthStore.getState().signInWithGoogle(),
      ).rejects.toThrow('Google Sign In 취소 또는 실패');
    });

    it('code가 없으면 에러를 던진다', async () => {
      const AuthRequestMock = AuthSession.AuthRequest as jest.Mock;
      AuthRequestMock.mockImplementationOnce(() => ({
        promptAsync: jest.fn().mockResolvedValueOnce({
          type: 'success',
          params: {},
        }),
      }));

      await expect(
        useAuthStore.getState().signInWithGoogle(),
      ).rejects.toThrow('Google Sign In 취소 또는 실패');
    });

    it('Supabase 에러 시 에러를 던진다', async () => {
      const AuthRequestMock = AuthSession.AuthRequest as jest.Mock;
      AuthRequestMock.mockImplementationOnce(() => ({
        promptAsync: jest.fn().mockResolvedValueOnce({
          type: 'success',
          params: { code: 'google-auth-code' },
        }),
      }));
      (mockSupabaseAuth.exchangeCodeForSession as jest.Mock).mockResolvedValueOnce({
        error: new Error('google exchange error'),
      });

      await expect(
        useAuthStore.getState().signInWithGoogle(),
      ).rejects.toThrow('google exchange error');
    });
  });

  describe('signInWithKakao', () => {
    it('Kakao 로그인 성공 시 code를 교환한다', async () => {
      mockOpenAuthSession.mockResolvedValueOnce({
        type: 'success',
        url: 'test://redirect?code=kakao-auth-code',
      });
      (mockSupabaseAuth.exchangeCodeForSession as jest.Mock).mockResolvedValueOnce({
        error: null,
      });

      await useAuthStore.getState().signInWithKakao();

      expect(mockSupabaseAuth.exchangeCodeForSession).toHaveBeenCalledWith(
        'kakao-auth-code',
      );
    });

    it('Kakao 로그인 취소 시 에러를 던진다', async () => {
      mockOpenAuthSession.mockResolvedValueOnce({ type: 'cancel' });

      await expect(
        useAuthStore.getState().signInWithKakao(),
      ).rejects.toThrow('Kakao Sign In 취소 또는 실패');
    });

    it('code가 없으면 에러를 던진다', async () => {
      mockOpenAuthSession.mockResolvedValueOnce({
        type: 'success',
        url: 'test://redirect?other=value',
      });

      await expect(
        useAuthStore.getState().signInWithKakao(),
      ).rejects.toThrow('인증 코드를 찾을 수 없습니다');
    });

    it('Supabase exchangeCodeForSession 에러 시 에러를 던진다', async () => {
      mockOpenAuthSession.mockResolvedValueOnce({
        type: 'success',
        url: 'test://redirect?code=kakao-code',
      });
      (mockSupabaseAuth.exchangeCodeForSession as jest.Mock).mockResolvedValueOnce({
        error: new Error('kakao exchange error'),
      });

      await expect(
        useAuthStore.getState().signInWithKakao(),
      ).rejects.toThrow('kakao exchange error');
    });
  });

  describe('signOut', () => {
    it('로그아웃 성공 시 세션을 초기화한다', async () => {
      useAuthStore.setState({
        session: mockSession as any,
        user: mockUser as any,
      });
      (mockSupabaseAuth.signOut as jest.Mock).mockResolvedValueOnce({
        error: null,
      });

      await useAuthStore.getState().signOut();

      const state = useAuthStore.getState();
      expect(state.session).toBeNull();
      expect(state.user).toBeNull();
    });

    it('Supabase 에러 시 에러를 던진다', async () => {
      (mockSupabaseAuth.signOut as jest.Mock).mockResolvedValueOnce({
        error: new Error('sign out error'),
      });

      await expect(useAuthStore.getState().signOut()).rejects.toThrow(
        'sign out error',
      );
    });
  });

  describe('restoreSession', () => {
    it('기존 세션을 복원한다', async () => {
      (mockSupabaseAuth.getSession as jest.Mock).mockResolvedValueOnce({
        data: { session: mockSession },
      });

      await useAuthStore.getState().restoreSession();

      const state = useAuthStore.getState();
      expect(state.session).toBe(mockSession);
      expect(state.user).toBe(mockUser);
      expect(state.isLoading).toBe(false);
    });

    it('세션이 없으면 null로 설정한다', async () => {
      (mockSupabaseAuth.getSession as jest.Mock).mockResolvedValueOnce({
        data: { session: null },
      });

      await useAuthStore.getState().restoreSession();

      const state = useAuthStore.getState();
      expect(state.session).toBeNull();
      expect(state.user).toBeNull();
      expect(state.isLoading).toBe(false);
    });

    it('에러 시 null로 설정한다', async () => {
      (mockSupabaseAuth.getSession as jest.Mock).mockRejectedValueOnce(
        new Error('restore error'),
      );

      await useAuthStore.getState().restoreSession();

      const state = useAuthStore.getState();
      expect(state.session).toBeNull();
      expect(state.user).toBeNull();
      expect(state.isLoading).toBe(false);
    });
  });
});
