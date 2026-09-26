import React, { useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ArrowRight, CheckCircle2, ShieldCheck, Mail, ArrowLeft, Hash, Link2 } from 'lucide-react';
import SEO from '../components/SEO';
import QuadCornerLoader from '../components/QuadCornerLoader';
import { playWelcomeSound } from '../lib/soundEffects';

export default function Signup() {
  const { signup, verifyOtp } = useAuth();
  const navigate = useNavigate();

  const [verifyMode, setVerifyMode] = useState('code'); // 'code' | 'link'
  const [step, setStep] = useState(1); // 1: Form, 2: OTP Verification / Link instructions
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otpDigits, setOtpDigits] = useState(['', '', '', '', '', '']);
  const [error, setError] = useState(null);
  const [welcomeMsg, setWelcomeMsg] = useState(null);
  const [linkSentMsg, setLinkSentMsg] = useState(null);
  const [loading, setLoading] = useState(false);

  const otpRefs = [useRef(), useRef(), useRef(), useRef(), useRef(), useRef()];

  const handleSignupSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const data = await signup(email, password);
      // If user session is established immediately without email confirmation
      if (data?.session) {
        playWelcomeSound();
        setWelcomeMsg(`Welcome to Flexpulse, ${email}!`);
        setTimeout(() => navigate('/store'), 2000);
      } else if (verifyMode === 'link') {
        setLinkSentMsg(`Account registered! We've sent a verification link to ${email}. Please check your email inbox and click the link to activate your account.`);
        setStep(2);
      } else {
        // Move to OTP 6-digit code verification step
        setStep(2);
      }
    } catch (err) {
      setError(err.message || 'Failed to create account');
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

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    const token = otpDigits.join('');
    if (token.length < 6) {
      setError('Please enter all 6 digits of your verification code.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      await verifyOtp(email, token, 'signup');
      playWelcomeSound();
      setWelcomeMsg(`Welcome to Flexpulse, ${email}!`);
      setTimeout(() => navigate('/store'), 2000);
    } catch (err) {
      setError(err.message || 'Invalid or expired verification code.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <SEO
        title="Create Account — Flexpulse Device Rentals"
        description="Register and choose your verification method (6-Digit Code or Email Link) to access Flexpulse."
      />
      <div className="card" style={{ maxWidth: '440px', width: '100%', padding: '36px' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{
            width: '52px',
            height: '52px',
            borderRadius: '16px',
            background: 'linear-gradient(135deg, var(--primary), var(--primary-hover))',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '24px',
            marginBottom: '12px',
            boxShadow: '0 8px 24px rgba(37, 99, 235, 0.35)'
          }}>
            ⚡
          </div>
          <h1 style={{ fontSize: '24px', fontWeight: 800 }}>
            {welcomeMsg ? 'Account Verified' : (step === 2 && verifyMode === 'code' ? 'Verify Email Code' : 'Create Account')}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
            {welcomeMsg ? 'Welcome aboard' : (step === 2 && verifyMode === 'code' ? `Enter the 6-digit code sent to ${email}` : 'Join Flexpulse Device Rentals Marketplace')}
          </p>
        </div>

        {/* Interactive Verification Method Selector */}
        {step === 1 && !welcomeMsg && (
          <div className="tab-group" style={{ marginBottom: '24px' }}>
            <button
              type="button"
              className={`tab-item ${verifyMode === 'code' ? 'active' : ''}`}
              onClick={() => setVerifyMode('code')}
            >
              <Hash size={15} /> 6-Digit Code
            </button>
            <button
              type="button"
              className={`tab-item ${verifyMode === 'link' ? 'active' : ''}`}
              onClick={() => setVerifyMode('link')}
            >
              <Link2 size={15} /> Email Link
            </button>
          </div>
        )}

        {error && (
          <div style={{ background: 'rgba(248, 113, 113, 0.12)', border: '1px solid rgba(248, 113, 113, 0.3)', color: 'var(--danger)', padding: '12px 16px', borderRadius: '12px', fontSize: '13px', marginBottom: '20px' }}>
            {error}
          </div>
        )}

        {welcomeMsg ? (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <div style={{ background: 'rgba(34, 197, 94, 0.15)', border: '1px solid rgba(34, 197, 94, 0.3)', color: '#4ade80', padding: '20px', borderRadius: '16px', fontSize: '15px', fontWeight: 700, marginBottom: '16px' }}>
              <CheckCircle2 size={36} style={{ display: 'block', margin: '0 auto 10px auto' }} />
              {welcomeMsg}
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Redirecting to Device Marketplace...</p>
          </div>
        ) : step === 1 ? (
          <form onSubmit={handleSignupSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                EMAIL ADDRESS
              </label>
              <input
                type="email"
                required
                className="input-field"
                placeholder="name@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </div>

            <div>
              <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                PASSWORD
              </label>
              <input
                type="password"
                required
                minLength={6}
                className="input-field"
                placeholder="At least 6 characters"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </div>

            <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '12px', marginTop: '8px' }}>
              {loading ? (
                <QuadCornerLoader text="Creating Account..." size="small" inline />
              ) : (
                <>{verifyMode === 'code' ? 'Register & Get 6-Digit Code' : 'Register & Send Email Link'} <ArrowRight size={16} /></>
              )}
            </button>
          </form>
        ) : verifyMode === 'link' && linkSentMsg ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ background: 'rgba(34, 197, 94, 0.15)', border: '1px solid rgba(34, 197, 94, 0.3)', color: '#4ade80', padding: '20px', borderRadius: '16px', fontSize: '14px', lineHeight: 1.6, marginBottom: '24px', textAlign: 'center' }}>
              <CheckCircle2 size={36} style={{ display: 'block', margin: '0 auto 12px auto' }} />
              <div>{linkSentMsg}</div>
            </div>
            <Link to="/login" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }}>
              Go to Sign In <ArrowRight size={16} />
            </Link>
          </div>
        ) : (
          <form onSubmit={handleVerifyOtp} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
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

            <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }}>
              {loading ? (
                <QuadCornerLoader text="Connecting Corners & Verifying..." size="small" inline />
              ) : (
                <>Verify Code & Enter <ShieldCheck size={16} /></>
              )}
            </button>

            <button type="button" onClick={() => setStep(1)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
              <ArrowLeft size={14} /> Back to Sign Up Options
            </button>
          </form>
        )}

        <div style={{ textAlign: 'center', marginTop: '24px', fontSize: '13px', color: 'var(--text-muted)' }}>
          Already have an account? <Link to="/login" style={{ fontWeight: 700 }}>Sign In</Link>
        </div>
      </div>
    </main>
  );
}
