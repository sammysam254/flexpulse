import React, { useState, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate, Link } from 'react-router-dom';
import { Smartphone, Lock, Mail, ArrowRight, ShieldCheck, CheckCircle2, ArrowLeft, Hash, Link2 } from 'lucide-react';
import SEO from '../components/SEO';
import QuadCornerLoader from '../components/QuadCornerLoader';
import { playWelcomeSound } from '../lib/soundEffects';

export default function Login() {
  const { login, signup, verifyOtp } = useAuth();
  const navigate = useNavigate();

  const [isSignUp, setIsSignUp] = useState(false);
  const [verifyMode, setVerifyMode] = useState('code'); // 'code' | 'link'
  const [step, setStep] = useState(1); // 1: Form, 2: OTP Verification / Link Instructions
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otpDigits, setOtpDigits] = useState(['', '', '', '', '', '']);
  const [error, setError] = useState(null);
  const [welcomeMsg, setWelcomeMsg] = useState(null);
  const [linkSentMsg, setLinkSentMsg] = useState(null);
  const [loading, setLoading] = useState(false);

  const otpRefs = [useRef(), useRef(), useRef(), useRef(), useRef(), useRef()];

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (isSignUp) {
        const { data, error: err } = await signup(email, password);
        if (err) throw err;
        if (data?.session) {
          playWelcomeSound();
          setWelcomeMsg(`Welcome to Flexpulse, ${email}!`);
          setTimeout(() => navigate('/worker'), 1800);
        } else if (verifyMode === 'link') {
          setLinkSentMsg(`Account registered! We've sent a verification link to ${email}. Please check your email inbox and click the link to activate your account.`);
          setStep(2);
        } else {
          setStep(2);
        }
      } else {
        const { error: logErr } = await login(email, password);
        if (logErr) throw logErr;
        playWelcomeSound();
        setWelcomeMsg(`Welcome back to Flexpulse!`);
        setTimeout(() => navigate('/worker'), 1800);
      }
    } catch (err) {
      let msg = err?.message || err?.msg || err?.error_description;
      if (typeof msg === 'object' || !msg || msg === '{}' || msg === '[object Object]') {
        msg = err?.error_description || err?.msg || 'Authentication failed. Please check your credentials or server connection.';
      }
      setError(msg);
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
      const { error: err } = await verifyOtp(email, token, 'signup');
      if (err) throw err;
      playWelcomeSound();
      setWelcomeMsg(`Welcome to Flexpulse, ${email}!`);
      setTimeout(() => navigate('/worker'), 1800);
    } catch (err) {
      setError(err.message || 'Invalid or expired verification code.');
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
        title="Access Portal — Flexpulse Cloud Platform"
        description="Sign in to Flexpulse Cloud Platform to access dedicated device streaming, WebRTC controls, and agent monitoring."
      />
      <div className="card" style={{ maxWidth: '440px', width: '100%', padding: '36px 28px' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{
            width: '64px',
            height: '64px',
            borderRadius: '16px',
            background: 'linear-gradient(135deg, rgba(37,99,235,0.2), rgba(56,189,248,0.2))',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '12px',
            boxShadow: '0 8px 24px rgba(37, 99, 235, 0.35)',
            border: '1px solid rgba(56, 189, 248, 0.4)'
          }}>
            <img src="/favicon.svg" alt="Flexpulse" style={{ width: '44px', height: '44px', borderRadius: '10px' }} />
          </div>
          <h2 style={{ fontSize: '24px', fontWeight: 800 }}>Flexpulse Cloud Access</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
            {welcomeMsg ? 'Authentication Verified' : (step === 2 && verifyMode === 'code' ? `Enter code sent to ${email}` : (isSignUp ? 'Choose verification method & create account' : 'Log in to access your device dashboard'))}
          </p>
        </div>

        {/* Interactive Verification Method Selector for Signup */}
        {isSignUp && step === 1 && !welcomeMsg && (
          <div className="tab-group" style={{ marginBottom: '20px' }}>
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

        {welcomeMsg ? (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <div style={{
              padding: '20px',
              borderRadius: '16px',
              background: 'rgba(34, 197, 94, 0.15)',
              border: '1px solid rgba(34, 197, 94, 0.3)',
              color: '#4ade80',
              fontSize: '15px',
              fontWeight: 700,
              marginBottom: '16px'
            }}>
              <CheckCircle2 size={36} style={{ display: 'block', margin: '0 auto 10px auto' }} />
              {welcomeMsg}
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Opening Cloud Dashboard...</p>
          </div>
        ) : step === 1 ? (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
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

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block' }}>
                  PASSWORD
                </label>
                {!isSignUp && (
                  <Link to="/forgot-password" style={{ fontSize: '12px', color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
                    Forgot Password?
                  </Link>
                )}
              </div>
              <div style={{ position: 'relative' }}>
                <Lock size={16} style={{ position: 'absolute', left: '14px', top: '14px', color: 'var(--text-muted)' }} />
                <input 
                  type="password" 
                  required 
                  className="input-field" 
                  style={{ paddingLeft: '40px' }}
                  placeholder="••••••••" 
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                />
              </div>
            </div>

            <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: '10px' }}>
              {loading ? (
                <QuadCornerLoader text={isSignUp ? 'Creating Account...' : 'Connecting Corners & Authenticating...'} size="small" inline />
              ) : (
                <>{isSignUp ? (verifyMode === 'code' ? 'Register & Get 6-Digit Code' : 'Register & Send Email Link') : 'Sign In'} <ArrowRight size={16} /></>
              )}
            </button>
          </form>
        ) : verifyMode === 'link' && linkSentMsg ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{
              padding: '20px',
              borderRadius: '16px',
              background: 'rgba(34, 197, 94, 0.15)',
              border: '1px solid rgba(34, 197, 94, 0.3)',
              color: '#4ade80',
              fontSize: '14px',
              lineHeight: 1.6,
              marginBottom: '20px'
            }}>
              <CheckCircle2 size={36} style={{ display: 'block', margin: '0 auto 10px auto' }} />
              <div>{linkSentMsg}</div>
            </div>
            <button type="button" onClick={() => { setStep(1); setIsSignUp(false); }} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
              Return to Log In <ArrowRight size={16} />
            </button>
          </div>
        ) : (
          <form onSubmit={handleVerifyOtp} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
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

            <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
              {loading ? (
                <QuadCornerLoader text="Connecting Corners & Verifying Code..." size="small" inline />
              ) : (
                <>Verify OTP & Sign In <ShieldCheck size={16} /></>
              )}
            </button>

            <button type="button" onClick={() => setStep(1)} style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
              <ArrowLeft size={14} /> Back to Sign Up Options
            </button>
          </form>
        )}

        <div style={{ textAlign: 'center', marginTop: '20px' }}>
          <button 
            type="button" 
            onClick={() => { setIsSignUp(!isSignUp); setStep(1); setError(null); setLinkSentMsg(null); }}
            style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}
          >
            {isSignUp ? 'Already have an account? Log in' : "Don't have an account? Sign up"}
          </button>
        </div>
      </div>
    </main>
  );
}
