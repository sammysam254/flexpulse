import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LogIn, Mail, Lock, ShieldCheck, ArrowRight, CheckCircle2 } from 'lucide-react';
import SEO from '../components/SEO';
import QuadCornerLoader from '../components/QuadCornerLoader';
import { playWelcomeSound } from '../lib/soundEffects';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [welcomeMsg, setWelcomeMsg] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await login(email, password);
      playWelcomeSound();
      setWelcomeMsg(`Welcome back to Flexpulse!`);
      setTimeout(() => {
        navigate('/store');
      }, 1500);
    } catch (err) {
      setError(err.message || 'Failed to sign in');
      setLoading(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <SEO
        title="Sign In — Flexpulse Device Rentals Marketplace"
        description="Sign in to manage your rented dedicated Android devices, access remote WebRTC streams, and view active monthly rentals."
      />
      <div className="card" style={{ maxWidth: '420px', width: '100%', padding: '36px' }}>
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '14px', background: 'linear-gradient(135deg, #38bdf8, #a855f7)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px', marginBottom: '12px' }}>
            ⚡
          </div>
          <h1 style={{ fontSize: '24px', fontWeight: 800 }}>Welcome Back</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
            Sign in to access your rented devices & marketplace
          </p>
        </div>

        {error && (
          <div style={{ background: 'rgba(248, 113, 113, 0.12)', border: '1px solid rgba(248, 113, 113, 0.3)', color: 'var(--danger)', padding: '12px', borderRadius: '10px', fontSize: '13px', marginBottom: '20px' }}>
            {error}
          </div>
        )}

        {welcomeMsg ? (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <div style={{ background: 'rgba(34, 197, 94, 0.15)', border: '1px solid rgba(34, 197, 94, 0.3)', color: '#4ade80', padding: '20px', borderRadius: '16px', fontSize: '15px', fontWeight: 700, marginBottom: '16px' }}>
              <CheckCircle2 size={36} style={{ display: 'block', margin: '0 auto 10px auto' }} />
              {welcomeMsg}
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Accessing Device Store...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                EMAIL ADDRESS
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  type="email"
                  required
                  className="input-field"
                  placeholder="name@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                />
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block' }}>
                  PASSWORD
                </label>
                <Link to="/forgot-password" style={{ fontSize: '12px', color: 'var(--primary, #38bdf8)', fontWeight: 600, textDecoration: 'none' }}>
                  Forgot Password?
                </Link>
              </div>
              <input
                type="password"
                required
                className="input-field"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </div>

            <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '12px', marginTop: '8px' }}>
              {loading ? (
                <QuadCornerLoader text="Connecting Corners & Signing in..." size="small" inline />
              ) : (
                <>Sign In <ArrowRight size={16} /></>
              )}
            </button>
          </form>
        )}

        <div style={{ textAlign: 'center', marginTop: '24px', fontSize: '13px', color: 'var(--text-muted)' }}>
          Don't have an account? <Link to="/signup" style={{ fontWeight: 700 }}>Create Account</Link>
        </div>
      </div>
    </main>
  );
}
