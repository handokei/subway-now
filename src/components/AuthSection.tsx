import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useAuthStore } from '../store/useAuthStore';

WebBrowser.maybeCompleteAuthSession();

const signInHandlers = {
  apple: () => useAuthStore.getState().signInWithApple(),
  google: () => useAuthStore.getState().signInWithGoogle(),
  kakao: () => useAuthStore.getState().signInWithKakao(),
};

export default function AuthSection() {
  const { user, isLoading, signOut } = useAuthStore();
  const [loading, setLoading] = useState(false);

  const handleSignIn = async (provider: 'apple' | 'google' | 'kakao') => {
    setLoading(true);
    try {
      await signInHandlers[provider]();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : '로그인에 실패했습니다';
      Alert.alert('로그인 실패', message);
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch {
      Alert.alert('오류', '로그아웃에 실패했습니다');
    }
  };

  if (isLoading) {
    return (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>계정</Text>
        <ActivityIndicator color="#a78bfa" testID="auth-loading" />
      </View>
    );
  }

  if (user) {
    return (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>계정</Text>
        <Text style={styles.email}>{user.email ?? '이메일 없음'}</Text>
        <Pressable
          style={styles.signOutButton}
          onPress={handleSignOut}
          testID="sign-out-button"
        >
          <Text style={styles.signOutText}>로그아웃</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>계정</Text>
      <Text style={styles.description}>
        로그인하면 즐겨찾기와 설정을 동기화할 수 있습니다
      </Text>

      {Platform.OS === 'ios' && (
        <Pressable
          style={[styles.loginButton, styles.appleButton]}
          onPress={() => handleSignIn('apple')}
          disabled={loading}
          testID="apple-sign-in-button"
        >
          <Text style={styles.appleButtonText}>Apple로 로그인</Text>
        </Pressable>
      )}

      <Pressable
        style={[styles.loginButton, styles.googleButton]}
        onPress={() => handleSignIn('google')}
        disabled={loading}
        testID="google-sign-in-button"
      >
        <Text style={styles.googleButtonText}>Google로 로그인</Text>
      </Pressable>

      <Pressable
        style={[styles.loginButton, styles.kakaoButton]}
        onPress={() => handleSignIn('kakao')}
        disabled={loading}
        testID="kakao-sign-in-button"
      >
        <Text style={styles.kakaoButtonText}>카카오 로그인</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#16213e',
    borderRadius: 16,
    padding: 20,
    marginHorizontal: 24,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 14,
    color: '#8888aa',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  description: {
    fontSize: 13,
    color: '#8888aa',
    lineHeight: 18,
    marginBottom: 16,
  },
  email: {
    fontSize: 16,
    color: '#ffffff',
    marginBottom: 16,
  },
  loginButton: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 10,
  },
  appleButton: {
    backgroundColor: '#ffffff',
  },
  appleButtonText: {
    color: '#000000',
    fontSize: 16,
    fontWeight: '600',
  },
  googleButton: {
    backgroundColor: '#4285f4',
  },
  googleButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  kakaoButton: {
    backgroundColor: '#FEE500',
  },
  kakaoButtonText: {
    color: '#191919',
    fontSize: 16,
    fontWeight: '600',
  },
  signOutButton: {
    backgroundColor: '#2a2a4a',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  signOutText: {
    color: '#ff6b6b',
    fontSize: 16,
    fontWeight: '600',
  },
});
