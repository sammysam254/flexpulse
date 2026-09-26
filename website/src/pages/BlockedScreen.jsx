import React from 'react';
import { useAuth } from '../context/AuthContext';
import { ShieldOff, LogOut, Mail } from 'lucide-react';

export default function BlockedScreen() {
  const { profile, logout } = useAuth();

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg-primary)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
    }}>
      {/* Animated background blobs */}
      <div style={{
        position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
        zIndex: 0, pointerEvents: 'none', overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', top: '-10%', left: '15%',
          width: '500px', height: '500px', borderRadius: '50%',
          background: 'rgba(239,68,68,0.12)', filter: 'blur(100px)',
        }} />
        <div style={{
          position: 'absolute', bottom: '10%', right: '10%',
          width: '600px', height: '600px', borderRadius: '50%',
          background: 'rgba(148,0,0,0.1)', filter: 'blur(120px)',
        }} />
      </div>

      <div style={{
        position: 'relative', zIndex: 1,
        maxWidth: '480px', width: '100%',
        background: 'var(--bg-card)',
        border: '1px solid rgba(239,68,68,0.3)',
        borderRadius: '24px',
        padding: '48px 40px',
        textAlign: 'center',
        boxShadow: '0 0 60px rgba(239,68,68,0.1)',
        animation: 'fadeIn 0.5s ease-out',
      }}>

        {/* Lock Icon */}
        <div style={{
          width: '80px', height: '80px',
          borderRadius: '50%',
          background: 'rgba(239,68,68,0.15)',
          border: '2px solid rgba(239,68,68,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 24px',
        }}>
          <ShieldOff size={36} color="#ef4444" />
        </div>

        <h1 style={{
          fontSize: '26px', fontWeight: 800,
          color: '#ef4444', marginBottom: '8px',
        }}>
          Access Revoked
        </h1>

        <p style={{
          color: 'var(--text-muted)', fontSize: '14px',
          lineHeight: '1.7', marginBottom: '24px',
        }}>
          Your account has been suspended by an administrator. You no longer have access to the Flexpulse system.
        </p>

        {/* Blocked Reason */}
        {profile?.blocked_reason && (
          <div style={{
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)',
            borderRadius: '12px',
            padding: '14px 18px',
            marginBottom: '24px',
            textAlign: 'left',
          }}>
            <div style={{ fontSize: '11px', fontWeight: 800, color: '#ef4444', textTransform: 'uppercase', marginBottom: '4px' }}>
              Reason
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-main)' }}>
              {profile.blocked_reason}
            </div>
          </div>
        )}

        {/* Account Info */}
        <div style={{
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid var(--border-color)',
          borderRadius: '12px',
          padding: '12px 18px',
          marginBottom: '28px',
          display: 'flex', alignItems: 'center', gap: '10px',
        }}>
          <Mail size={16} color="var(--text-muted)" />
          <span style={{ fontSize: '13px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>
            {profile?.email}
          </span>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '20px' }}>
          If you believe this is a mistake, contact your administrator.
        </p>

        <button
          onClick={logout}
          style={{
            width: '100%', padding: '12px',
            background: 'rgba(239,68,68,0.15)',
            border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: '10px',
            color: '#ef4444', fontWeight: 700,
            fontSize: '14px', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
          }}
        >
          <LogOut size={16} /> Sign Out
        </button>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
