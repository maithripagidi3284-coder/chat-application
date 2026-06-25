import { useState } from 'react';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { useNavigate, Link } from 'react-router-dom';

export default function Login() {
  const { login }   = useAuth();
  const navigate    = useNavigate();
  const [form, setForm]       = useState({ email: '', password: '' });
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await axios.post('http://localhost:3000/api/login', form);
      login(res.data.accessToken, res.data.refreshToken, res.data.user);
      navigate('/rooms');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .auth-bg { display:flex; justify-content:center; align-items:center; min-height:100dvh; background:#f5f6fa; font-family:'Inter',sans-serif; padding:1rem; }
        .auth-card { background:#fff; padding:2.5rem 2rem; border-radius:16px; width:100%; max-width:380px; box-shadow:0 4px 32px rgba(0,0,0,0.08); animation:fadeUp 0.3s ease both; }
        @keyframes fadeUp { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        .auth-title    { text-align:center; font-size:1.75rem; font-weight:600; color:#111827; margin-bottom:0.25rem; }
        .auth-subtitle { text-align:center; color:#6b7280; font-size:0.9rem; margin-bottom:1.75rem; }
        .auth-error    { background:#fef2f2; border:1px solid #fecaca; color:#dc2626; border-radius:8px; padding:0.6rem 0.9rem; font-size:0.85rem; margin-bottom:1rem; text-align:center; }
        .auth-label    { display:block; font-size:0.8rem; font-weight:500; color:#374151; margin-bottom:0.35rem; }
        .auth-input    { width:100%; padding:0.7rem 1rem; border-radius:10px; border:1.5px solid #e5e7eb; font-size:0.95rem; font-family:'Inter',sans-serif; background:#f9fafb; margin-bottom:1rem; transition:border-color 0.2s,box-shadow 0.2s; outline:none; color:#111827; }
        .auth-input:focus { border-color:#6c63ff; box-shadow:0 0 0 3px rgba(108,99,255,0.1); background:#fff; }
        .auth-btn { width:100%; padding:0.75rem; background:#6c63ff; color:#fff; border:none; border-radius:10px; font-size:1rem; font-weight:500; font-family:'Inter',sans-serif; cursor:pointer; transition:background 0.2s,transform 0.15s; margin-top:0.25rem; }
        .auth-btn:hover:not(:disabled) { background:#5a52e0; transform:translateY(-1px); }
        .auth-btn:disabled { background:#c4c1f5; cursor:not-allowed; }
        .auth-link { text-align:center; margin-top:1.25rem; font-size:0.875rem; color:#6b7280; }
        .auth-link a { color:#6c63ff; font-weight:500; text-decoration:none; }
        .auth-link a:hover { text-decoration:underline; }
      `}</style>

      <div className="auth-bg">
        <div className="auth-card">
          <h2 className="auth-title">💬 ChatApp</h2>
          <p className="auth-subtitle">Welcome back!</p>

          {error && <div className="auth-error">{error}</div>}

          <form onSubmit={handleSubmit}>
            <label className="auth-label">Email</label>
            <input
              className="auth-input"
              type="email"
              placeholder="your email"
              value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })}
              required
            />

            <label className="auth-label">Password</label>
            <input
              className="auth-input"
              type="password"
              placeholder="••••••••"
              value={form.password}
              onChange={e => setForm({ ...form, password: e.target.value })}
              required
            />

            <button className="auth-btn" type="submit" disabled={loading}>
              {loading ? 'Logging in…' : 'Login'}
            </button>
          </form>

          <p className="auth-link">
            No account? <Link to="/register">Register here</Link>
          </p>
        </div>
      </div>
    </>
  );
}