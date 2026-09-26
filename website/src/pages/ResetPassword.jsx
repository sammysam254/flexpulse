import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Lock, ShieldCheck, ArrowRight, CheckCircle2, Eye, EyeOff } from 'lucide-react';
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
      const { error: err } = await updatePassword(password);
      if (err) throw err;

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
    <main style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      background: 'radial-gradient(circle at top, rgba(56,189,248,0.1), transparent)'
    }}>
      <SEO
        title="Set New Password — Flexpulse Platform"
        description="Enter your new password to complete account recovery."
      />
      <div className="card" style={{ maxWidth: '440px', width: '100%', padding: '36px 28px' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{
            width: '56px',
            height: '56px',
            borderRadius: '16px',
            background: 'linear-gradient(135deg, var(--primary), var(--primary-hover))',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '14px',
            color: '#fff',
            boxShadow: '0 8px 24px rgba(56, 189, 248, 0.3)'
          }}>
            <ShieldCheck size={28} />
          </div>
          <h2 style={{ fontSize: '24px', fontWeight: 800 }}>Create New Password</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
            Enter your new secure password below
          </p>
        </div>

        {error && (
          <div style={{
            padding: '10px 14px',
            borderRadius: '10px',
            background: 'rgba(239,68,68,0.15)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: 'var(--danger)',
            fontSize: '13px',
            marginBottom: '16px'
          }}>
            {error}
          </div>
        )}

        {success ? (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <div style={{
              padding: '20px',
              borderRadius: '14px',
              background: 'rgba(34, 197, 94, 0.15)',
              border: '1px solid rgba(34, 197, 94, 0.3)',
              color: '#4ade80',
              fontSize: '14px',
              lineHeight: 1.6,
              marginBottom: '20px'
            }}>
              <CheckCircle2 size={36} style={{ display: 'block', margin: '0 auto 12px auto' }} />
              <strong style={{ display: 'block', fontSize: '16px', marginBottom: '4px' }}>Password Updated!</strong>
              Your password was successfully updated. Redirecting to log in...
            </div>
            <Link to="/login" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }}>
              Go to Log In <ArrowRight size={16} />
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                NEW PASSWORD
              </label>
              <div style={{ position: 'relative' }}>
                <Lock size={16} style={{ position: 'absolute', left: '14px', top: '14px', color: 'var(--text-muted)' }} />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  className="input-field"
                  style={{ paddingLeft: '40px', paddingRight: '40px' }}
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
              <div style={{ position: 'relative' }}>
                <Lock size={16} style={{ position: 'absolute', left: '14px', top: '14px', color: 'var(--text-muted)' }} />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  className="input-field"
                  style={{ paddingLeft: '40px' }}
                  placeholder="Re-enter your new password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                />
              </div>
            </div>

            <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: '10px' }}>
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
