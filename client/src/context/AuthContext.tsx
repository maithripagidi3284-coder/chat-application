import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import axios from 'axios';

interface User {
  id: number;
  username: string;
  email: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (accessToken: string, refreshToken: string, user: User) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser]   = useState<User | null>(
    JSON.parse(localStorage.getItem('user') || 'null')
  );
  const [token, setToken] = useState<string | null>(
    localStorage.getItem('accessToken')
  );

  const login = (accessToken: string, refreshToken: string, user: User) => {
    localStorage.setItem('accessToken',  accessToken);
    localStorage.setItem('refreshToken', refreshToken);
    localStorage.setItem('user', JSON.stringify(user));
    setToken(accessToken);
    setUser(user);
  };

  const logout = useCallback(async () => {
    const refreshToken = localStorage.getItem('refreshToken');
    // Revoke on server
    if (refreshToken) {
      await axios.post(`${API}/api/logout`, { refreshToken }).catch(() => {});
    }
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    setToken(null);
    setUser(null);
  }, []);

  // ── Auto-refresh access token every 13 minutes ──────────
  const refreshAccessToken = useCallback(async () => {
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) return;
    try {
      const res = await axios.post(`${API}/api/refresh`, { refreshToken });
      const newAccessToken = res.data.accessToken;
      localStorage.setItem('accessToken', newAccessToken);
      setToken(newAccessToken);
    } catch {
      // Refresh token expired — force logout
      logout();
    }
  }, [logout]);

  useEffect(() => {
    // Refresh on mount if token exists
    const refreshToken = localStorage.getItem('refreshToken');
    if (refreshToken) refreshAccessToken();

    // Then refresh every 13 minutes (access token lasts 15m)
    const interval = setInterval(refreshAccessToken, 13 * 60 * 1000);
    return () => clearInterval(interval);
  }, [refreshAccessToken]);

  return (
    <AuthContext.Provider value={{ user, token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext)!;