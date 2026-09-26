import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Lock, CheckCircle2, ShieldCheck, ArrowRight, Eye, EyeOff } from 'lucide-react';
import SEO from '../components/SEO';
import QuadCornerLoader from '../components/QuadCornerLoader';
import { playSuccessSound } from '../lib/soundEffects';

export default function ResetPassword() {
  const { updatePassword } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (password.length < 6) {
      setError('Password must be at least 6 characters long.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);

    try {
      await updatePassword(password);
      playSuccessSound();
      setSuccess(true);
      setTimeout(() => {
        navigate('/login');
      }, 2500);
    } catch (err) {
      setError(err.message || 'Failed to update password. Link may have expired.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <SEO
        title="Set New Password — Flexpulse Device Rentals"
      />
      <div className="card" style={{ maxWidth: '440px', width: '100%', padding: '36px' }}>
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <div style={{
            width: '52px',
            height: '52px',
            borderRadius: '16px',
            background: 'linear-gradient(135deg, #0ea5e9, #a855f7)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            marginBottom: '14px',
            boxShadow: '0 8px 20px rgba(14, 165, 233, 0.3)'
          }}>
            <ShieldCheck size={28} />
          </div>
          <h1 style={{ fontSize: '24px', fontWeight: 800 }}>Create New Password</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '6px' }}>
            Choose a strong password for your Flexpulse account
          </p>
        </div>

        {error && (
          <div style={{ background: 'rgba(248, 113, 113, 0.12)', border: '1px solid rgba(248, 113, 113, 0.3)', color: 'var(--danger)', padding: '12px 16px', borderRadius: '12px', fontSize: '13px', marginBottom: '20px' }}>
            {error}
          </div>
        )}

        {success ? (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <div style={{ background: 'rgba(34, 197, 94, 0.12)', border: '1px solid rgba(34, 197, 94, 0.3)', color: '#4ade80', padding: '20px', borderRadius: '14px', fontSize: '14px', lineHeight: 1.6, marginBottom: '24px', textAlign: 'center' }}>
              <CheckCircle2 size={36} style={{ display: 'block', margin: '0 auto 12px auto' }} />
              <strong style={{ display: 'block', fontSize: '16px', marginBottom: '4px' }}>Password Reset Complete!</strong>
              Your password has been updated successfully. Redirecting to sign in...
            </div>
            <Link to="/login" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }}>
              Go to Sign In <ArrowRight size={16} />
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                NEW PASSWORD
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  className="input-field"
                  placeholder="At least 6 characters"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <div>
              <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                CONFIRM NEW PASSWORD
              </label>
              <input
                type={showPassword ? 'text' : 'password'}
                required
                className="input-field"
                placeholder="Re-enter your new password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
              />
            </div>

            <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '12px', marginTop: '8px' }}>
              {loading ? (
                <QuadCornerLoader text="Connecting Corners & Updating..." size="small" inline />
              ) : (
                <>Update Password <ArrowRight size={16} /></>
              )}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
