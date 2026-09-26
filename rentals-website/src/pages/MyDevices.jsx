import React, { useEffect, useState } from 'react';
import RentalsLayout from '../layouts/RentalsLayout';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { Smartphone, Lock, Unlock, ExternalLink, RefreshCw, Eye, EyeOff, AlertCircle, ArrowLeft, Video, ShieldCheck } from 'lucide-react';
import SEO from '../components/SEO';

export default function MyDevices() {
  const { user } = useAuth();
  const [rentedDevices, setRentedDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [revealedPasswords, setRevealedPasswords] = useState({});
  const [unlockModal, setUnlockModal] = useState(null);
  const [inputPassword, setInputPassword] = useState('');
  const [error, setError] = useState(null);

  const fetchMyRentedDevices = async (isInitial = false) => {
    if (!user) return;
    if (isInitial) setLoading(true);
    try {
      // Query device assignments for this user
      const { data: aData } = await supabase
        .from('device_assignments')
        .select('*, devices(*)')
        .eq('assigned_to_user_id', user.id);

      setRentedDevices(aData || []);
    } catch (e) {
      console.error('Error fetching my rented devices:', e);
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    fetchMyRentedDevices(true);

    const channel = supabase
      .channel(`my_rented_devices_realtime_${user.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'device_assignments',
        filter: `assigned_to_user_id=eq.${user.id}`,
      }, () => fetchMyRentedDevices(false))
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'devices',
      }, () => fetchMyRentedDevices(false))
      .subscribe();

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchMyRentedDevices(false);
      }
    }, 300000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(timer);
    };
  }, [user]);

  const handleUnlock = (e) => {
    e.preventDefault();
    setError(null);

    if (inputPassword.trim() === unlockModal.access_password.trim()) {
      let rawStreamUrl = unlockModal.devices?.stream_url;
      if (rawStreamUrl) {
        let streamUrl = rawStreamUrl;
        try {
          const u = new URL(rawStreamUrl.startsWith('http') ? rawStreamUrl : `https://${rawStreamUrl}`);
          u.protocol = 'https:';
          u.host = 'agent.dennoh.site';
          u.searchParams.set('pin', unlockModal.access_password.trim());
          if (user?.id) {
            u.searchParams.set('user_id', user.id);
          }
          streamUrl = u.toString();
        } catch (_) {
          streamUrl = `https://agent.dennoh.site/?udid=${encodeURIComponent(unlockModal.devices?.serial || '')}&pin=${encodeURIComponent(unlockModal.access_password.trim())}${user?.id ? '&user_id=' + encodeURIComponent(user.id) : ''}`;
        }
        const w = 510, h = 900;
        const left = Math.max(0, Math.round((window.screen.width - w) / 2));
        const top = Math.max(0, Math.round((window.screen.height - h) / 2));
        window.open(streamUrl, `Stream_${unlockModal.devices?.serial || 'Device'}`, `width=${w},height=${h},top=${top},left=${left},resizable=yes,scrollbars=no,status=no,location=no,toolbar=no,menubar=no,popup=yes`);
      } else {
        alert('Device stream link is currently generating or device is offline');
      }
      setUnlockModal(null);
      setInputPassword('');
    } else {
      setError('Invalid access password. Please check your password above.');
    }
  };

  const togglePasswordReveal = (id) => {
    setRevealedPasswords(prev => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const isDeviceOnline = (d) => {
    if (!d || d.is_deleted_from_view) return false;
    if (d.status === 'offline') return false;
    if (d.status === 'online' && d.stream_url) return true;
    return Boolean(d.stream_url);
  };

  return (
    <RentalsLayout>
      <SEO
        title="My Rented Devices — Flexpulse Device Rentals"
        description="View and control your active rented real Android cloud devices with instant PIN unlock."
        noIndex={true}
      />
      <main aria-labelledby="my-devices-heading">
        <header style={{ marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Smartphone size={26} color="var(--primary)" />
              <h1 id="my-devices-heading" style={{ fontSize: '26px', fontWeight: 800 }}>My Rented Devices</h1>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
              Devices assigned to you. Unlock with password to open the full interactive stream with stealth controls.
            </p>
          </div>
          <button onClick={() => fetchMyRentedDevices(true)} className="btn btn-secondary" aria-label="Refresh Feeds">
            <RefreshCw size={16} /> Refresh Feeds
          </button>
        </header>

      {loading ? (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '60px 0' }}>
          Loading your rented devices...
        </div>
      ) : rentedDevices.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
          <Lock size={48} style={{ marginBottom: '14px', opacity: 0.3 }} />
          <h3 style={{ fontSize: '18px', fontWeight: 700 }}>No Rented Devices Found</h3>
          <p style={{ fontSize: '13px', marginTop: '6px' }}>
            You haven't rented any devices yet. Browse the Device Store to rent available devices!
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '22px' }}>
          {rentedDevices.map(a => {
            const dev = a.devices;
            const online = isDeviceOnline(dev);
            const price = dev?.monthly_rental_price || 49;
            const isPasswordRevealed = revealedPasswords[a.id];

            return (
              <div key={a.id} className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
                    <div>
                      <h3 style={{ fontSize: '18px', fontWeight: 800 }}>
                        {dev?.brand || ''} {dev?.model || 'Android Device'}
                      </h3>
                      <p style={{ color: 'var(--text-muted)', fontSize: '12px', fontFamily: 'monospace', marginTop: '2px' }}>
                        SN: {dev?.serial}
                      </p>
                    </div>
                    <span className={`badge ${online ? 'badge-success' : 'badge-warning'}`}>
                      {online ? '🟢 Live Online' : '🟡 Device Offline'}
                    </span>
                  </div>

                  {/* Password / PIN box */}
                  <div style={{
                    background: 'rgba(56,189,248,0.06)',
                    border: '1px solid rgba(56,189,248,0.15)',
                    borderRadius: '12px',
                    padding: '12px 14px',
                    marginBottom: '14px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '8px',
                  }}>
                    <div>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                        YOUR ACCESS PIN (6-DIGIT)
                      </div>
                      <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '18px', letterSpacing: '3px', color: 'var(--primary)' }}>
                        {isPasswordRevealed ? (a.access_password || '------') : '••••••'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        onClick={() => togglePasswordReveal(a.id)}
                        className="btn btn-secondary"
                        style={{ padding: '6px 10px', fontSize: '12px' }}
                        title={isPasswordRevealed ? 'Hide PIN' : 'Show PIN'}
                      >
                        {isPasswordRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
                        {isPasswordRevealed ? 'Hide' : 'Show'}
                      </button>
                      <button
                        onClick={() => {
                          if (a.access_password) {
                            navigator.clipboard.writeText(a.access_password);
                            alert('✅ 6-Digit PIN (' + a.access_password + ') copied to clipboard!');
                          }
                        }}
                        className="btn btn-primary"
                        style={{ padding: '6px 10px', fontSize: '12px' }}
                        title="Copy 6-Digit PIN to clipboard"
                      >
                        📋 Copy PIN
                      </button>
                    </div>
                  </div>

                  {/* Stream URL snippet */}
                  {dev?.stream_url ? (
                    <div style={{
                      fontSize: '11px', fontFamily: 'monospace',
                      color: 'var(--text-muted)', wordBreak: 'break-all',
                      marginBottom: '14px', lineHeight: 1.5,
                    }}>
                      {(dev.stream_url.replace(/https?:\/\/[^/]+/, 'https://agent.dennoh.site')).substring(0, 55)}...
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '14px', color: 'var(--text-dim)', fontSize: '12px' }}>
                      <AlertCircle size={14} /> Stream URL generating / device offline
                    </div>
                  )}

                  {/* Rental details */}
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>
                    Rental Fee: <strong style={{ color: '#fff' }}>${price}/mo USD</strong>
                  </div>
                </div>

                {/* Actions */}
                <button
                  disabled={!online}
                  onClick={() => { setUnlockModal(a); setInputPassword(''); setError(null); }}
                  className="btn btn-primary"
                  style={{ width: '100%', justifyContent: 'center', padding: '12px', opacity: online ? 1 : 0.5 }}
                >
                  <Unlock size={16} />
                  {online ? 'Unlock & Open Worker Stream' : 'Device Offline'}
                  {online && <ExternalLink size={14} />}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Password Unlock Modal */}
      {unlockModal && (
        <div className="modal-overlay" onClick={() => setUnlockModal(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Lock size={20} color="var(--primary)" /> Unlock Device Stream
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
              Enter the access password to open <b>{unlockModal.devices?.brand} {unlockModal.devices?.model}</b> stream with right-side controls.
            </p>

            {error && (
              <div style={{ color: 'var(--danger)', fontSize: '13px', marginBottom: '12px', padding: '8px 12px', background: 'rgba(248,113,113,0.12)', borderRadius: '8px', border: '1px solid rgba(248,113,113,0.3)' }}>
                {error}
              </div>
            )}

            <form onSubmit={handleUnlock} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <input
                type="password"
                required
                autoFocus
                className="input-field"
                placeholder="Enter Access Password"
                value={inputPassword}
                onChange={e => setInputPassword(e.target.value)}
              />
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
                <button type="button" onClick={() => setUnlockModal(null)} className="btn btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Unlock Stream <ExternalLink size={14} />
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      </main>
    </RentalsLayout>
  );
}
