import { create } from 'zustand';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? '';

interface AuthState {
  session: Session | null;
  user: User | null;
  isLoading: boolean;
  setSession: (session: Session | null) => void;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signInWithKakao: () => Promise<void>;
  signOut: () => Promise<void>;
  restoreSession: () => Promise<void>;
}

export function extractCodeFromUrl(url: string): string | null {
  const codeMatch = url.match(/[?&#]code=([^&#]+)/);
  return codeMatch ? decodeURIComponent(codeMatch[1]) : null;
}

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  user: null,
  isLoading: true,

  setSession: (session: Session | null) => {
    set({ session, user: session?.user ?? null });
  },

  signInWithApple: async () => {
    const rawNonce = Crypto.randomUUID();
    const hashedNonce = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      rawNonce,
    );

    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });

    if (!credential.identityToken) {
      throw new Error('Apple Sign In: identityToken이 없습니다');
    }

    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
      nonce: rawNonce,
    });

    if (error) throw error;
  },

  signInWithGoogle: async () => {
    const redirectUri = AuthSession.makeRedirectUri();
    const discovery = {
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
    };

    const request = new AuthSession.AuthRequest({
      clientId: GOOGLE_CLIENT_ID,
      redirectUri,
      scopes: ['openid', 'profile', 'email'],
      responseType: AuthSession.ResponseType.Code,
      usePKCE: true,
    });

    const result = await request.promptAsync(discovery);

    if (result.type !== 'success' || !result.params.code) {
      throw new Error('Google Sign In 취소 또는 실패');
    }

    const { error } = await supabase.auth.exchangeCodeForSession(
      result.params.code,
    );

    if (error) throw error;
  },

  signInWithKakao: async () => {
    const redirectUri = AuthSession.makeRedirectUri();
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';

    const result = await WebBrowser.openAuthSessionAsync(
      `${supabaseUrl}/auth/v1/authorize?provider=kakao&redirect_to=${encodeURIComponent(redirectUri)}`,
      redirectUri,
    );

    if (result.type !== 'success') {
      throw new Error('Kakao Sign In 취소 또는 실패');
    }

    const code = extractCodeFromUrl(result.url);

    if (!code) {
      throw new Error('Kakao Sign In: 인증 코드를 찾을 수 없습니다');
    }

    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) throw error;
  },

  signOut: async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    set({ session: null, user: null });
  },

  restoreSession: async () => {
    set({ isLoading: true });
    try {
      const { data } = await supabase.auth.getSession();
      set({
        session: data.session,
        user: data.session?.user ?? null,
        isLoading: false,
      });
    } catch {
      set({ session: null, user: null, isLoading: false });
    }
  },
}));
