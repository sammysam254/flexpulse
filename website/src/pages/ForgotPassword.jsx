import React, { useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Mail, KeyRound, ArrowRight, CheckCircle2, ArrowLeft, ShieldCheck, Link2, Hash, Lock, Eye, EyeOff } from 'lucide-react';
import SEO from '../components/SEO';
import QuadCornerLoader from '../components/QuadCornerLoader';
import { playSuccessSound } from '../lib/soundEffects';

export default function ForgotPassword() {
  const { resetPassword, verifyOtp, updatePassword } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState('link'); // 'link' | 'code'
  const [step, setStep] = useState(1); // 1: Send request, 2: Enter code & new password (for code mode)
  const [email, setEmail] = useState('');
  const [otpDigits, setOtpDigits] = useState(['', '', '', '', '', '']);
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);

  const otpRefs = [useRef(), useRef(), useRef(), useRef(), useRef(), useRef()];

  const handleSendRequest = async (e) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setLoading(true);

    try {
      const { error: err } = await resetPassword(email);
      if (err) throw err;

      if (mode === 'link') {
        setMessage('Password reset link sent! Please check your inbox and click the reset link to proceed.');
      } else {
        setStep(2);
      }
    } catch (err) {
      setError(err.message || 'Failed to send password reset request');
    } finally {
      setLoading(false);
    }
  };

  const handleOtpChange = (index, value) => {
    if (!/^\d*$/.test(value)) return;
    const newDigits = [...otpDigits];
    newDigits[index] = value.slice(-1);
    setOtpDigits(newDigits);

    if (value && index < 5) {
      otpRefs[index + 1].current?.focus();
    }
  };

  const handleOtpKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !otpDigits[index] && index > 0) {
      otpRefs[index - 1].current?.focus();
    }
  };

  const handleVerifyCodeAndReset = async (e) => {
    e.preventDefault();
    const token = otpDigits.join('');
    if (token.length < 6) {
      setError('Please enter all 6 digits of your reset code.');
      return;
    }
    if (newPassword.length < 6) {
      setError('New password must be at least 6 characters long.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const { error: verifyErr } = await verifyOtp(email, token, 'recovery');
      if (verifyErr) throw verifyErr;

      const { error: updateErr } = await updatePassword(newPassword);
      if (updateErr) throw updateErr;

      playSuccessSound();
      setMessage('Password updated successfully! Redirecting to log in...');
      setTimeout(() => navigate('/login'), 2500);
    } catch (err) {
      setError(err.message || 'Invalid code or failed to update password.');
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
        title="Forgot Password — Flexpulse Platform"
        description="Choose between email reset link or 6-digit verification code to reset your password."
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
            <KeyRound size={28} />
          </div>
          <h2 style={{ fontSize: '24px', fontWeight: 800 }}>Reset Password</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
            Choose your preferred password recovery method
          </p>
        </div>

        {/* Interactive Reset Mode Selector */}
        {step === 1 && !message && (
          <div className="tab-group" style={{ marginBottom: '24px' }}>
            <button
              type="button"
              className={`tab-item ${mode === 'link' ? 'active' : ''}`}
              onClick={() => setMode('link')}
            >
              <Link2 size={15} /> Receive Link
            </button>
            <button
              type="button"
              className={`tab-item ${mode === 'code' ? 'active' : ''}`}
              onClick={() => setMode('code')}
            >
              <Hash size={15} /> Receive 6-Digit Code
            </button>
          </div>
        )}

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

        {message ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{
              padding: '16px',
              borderRadius: '12px',
              background: 'rgba(34, 197, 94, 0.15)',
              border: '1px solid rgba(34, 197, 94, 0.3)',
              color: '#4ade80',
              fontSize: '14px',
              lineHeight: 1.6,
              marginBottom: '20px',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              textAlign: 'left'
            }}>
              <CheckCircle2 size={24} style={{ flexShrink: 0, marginTop: '2px' }} />
              <div>{message}</div>
            </div>
            <Link to="/login" className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }}>
              <ArrowLeft size={16} /> Return to Log In
            </Link>
          </div>
        ) : step === 1 ? (
          <form onSubmit={handleSendRequest} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                EMAIL ADDRESS
              </label>
              <div style={{ position: 'relative' }}>
                <Mail size={16} style={{ position: 'absolute', left: '14px', top: '14px', color: 'var(--text-muted)' }} />
                <input
                  type="email"
                  required
                  className="input-field"
                  style={{ paddingLeft: '40px' }}
                  placeholder="name@company.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                />
              </div>
            </div>

            <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: '10px' }}>
              {loading ? (
                <QuadCornerLoader text={mode === 'link' ? 'Sending Reset Link...' : 'Sending 6-Digit Code...'} size="small" inline />
              ) : (
                <>{mode === 'link' ? 'Send Reset Link' : 'Send 6-Digit Code'} <ArrowRight size={16} /></>
              )}
            </button>

            <div style={{ textAlign: 'center', marginTop: '12px' }}>
              <Link to="/login" style={{ fontSize: '13px', color: 'var(--primary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
                <ArrowLeft size={14} /> Back to Log In
              </Link>
            </div>
          </form>
        ) : (
          <form onSubmit={handleVerifyCodeAndReset} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ textAlign: 'center', fontSize: '13px', color: 'var(--text-muted)' }}>
              Enter the 6-digit code sent to <strong style={{ color: '#fff' }}>{email}</strong> and set your new password:
            </div>

            <div style={{ display: 'flex', justifyContent: 'center', gap: '8px' }}>
              {otpDigits.map((digit, idx) => (
                <input
                  key={idx}
                  ref={otpRefs[idx]}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  className="otp-input"
                  value={digit}
                  onChange={e => handleOtpChange(idx, e.target.value)}
                  onKeyDown={e => handleOtpKeyDown(idx, e)}
                />
              ))}
            </div>

            <div>
              <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                NEW PASSWORD
              </label>
              <div style={{ position: 'relative' }}>
                <Lock size={16} style={{ position: 'absolute', left: '14px', top: '14px', color: 'var(--text-muted)' }} />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={6}
                  className="input-field"
                  style={{ paddingLeft: '40px', paddingRight: '40px' }}
                  placeholder="At least 6 characters"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
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

            <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: '10px' }}>
              {loading ? (
                <QuadCornerLoader text="Connecting Corners & Updating..." size="small" inline />
              ) : (
                <>Verify & Update Password <ShieldCheck size={16} /></>
              )}
            </button>

            <button type="button" onClick={() => setStep(1)} style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
              <ArrowLeft size={14} /> Back to Reset Method
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
