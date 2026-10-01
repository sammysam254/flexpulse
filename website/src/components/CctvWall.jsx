import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Video, Shield, Maximize2, RefreshCw, X, ArrowLeft, Eye, Play, Trash2, ExternalLink } from 'lucide-react';
import { normalizeStreamUrl } from '../lib/keyGenerator';

export default function CctvWall({ currentUser, isSuperAdmin, isSeedAdmin }) {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cctvLocked, setCctvLocked] = useState(false);
  const [focusDevice, setFocusDevice] = useState(null);
  const [feedTimestamp, setFeedTimestamp] = useState(Date.now());

  const handleRefreshFeeds = () => {
    setFeedTimestamp(Date.now());
    fetchDevicesAndLockState(true);
    try {
      fetch('https://agent.dennoh.site/api/devices/rescan', { method: 'POST' }).catch(() => {});
    } catch (_) {}
  };

  const fetchDevicesAndLockState = async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      // 1. Fetch devices with active streams and not deleted from view
      const { data: dData } = await supabase
        .from('devices')
        .select('*')
        .order('updated_at', { ascending: false });

      const activeOnlineDevices = (dData || []).filter(d => {
        if (d.is_deleted_from_view) return false;
        if (d.status === 'online' && Boolean(d.stream_url)) return true;
        return false;
      });

      setDevices(prev => {
        if (prev.length === activeOnlineDevices.length) {
          const isSame = prev.every((p, idx) => {
            const n = activeOnlineDevices[idx];
            return p.id === n.id && 
                   p.stream_url === n.stream_url && 
                   p.stealth_root_enabled === n.stealth_root_enabled && 
                   p.status === n.status;
          });
          if (isSame) return prev;
        }
        return activeOnlineDevices;
      });

      // 2. Fetch CCTV lock setting from system_settings
      const { data: sData } = await supabase.from('system_settings').select('*').eq('key', 'cctv_wall_locked').single();
      if (sData) {
        setCctvLocked(sData.value === 'true' || sData.value === true);
      }
    } catch (e) {
      console.error('Error loading CCTV Wall data:', e);
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  useEffect(() => {
    fetchDevicesAndLockState(true);

    const channel = supabase
      .channel('cctv_wall_realtime_sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, () => fetchDevicesAndLockState(false))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'system_settings' }, () => fetchDevicesAndLockState(false))
      .subscribe();

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchDevicesAndLockState(false);
      }
    }, 300000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, []);

  const deleteDeviceFromView = async (deviceId) => {
    if (!window.confirm('Are you sure you want to delete this device from view in all dashboards?')) return;
    try {
      await supabase.from('devices').update({
        is_deleted_from_view: true,
        updated_at: new Date().toISOString()
      }).eq('id', deviceId);

      setDevices(prev => prev.filter(d => d.id !== deviceId));
    } catch (err) {
      alert('Error deleting device from view: ' + err.message);
    }
  };

  const toggleStealthRoot = async (deviceId, currentState) => {
    const nextState = !currentState;
    try {
      await supabase.from('devices').update({
        stealth_root_enabled: nextState,
        updated_at: new Date().toISOString()
      }).eq('id', deviceId);

      setDevices(prev => prev.map(d => d.id === deviceId ? { ...d, stealth_root_enabled: nextState } : d));
    } catch (err) {
      alert('Error updating stealth root status: ' + err.message);
    }
  };

  const toggleCctvWallLock = async () => {
    if (!isSuperAdmin && !isSeedAdmin) return;
    const nextLock = !cctvLocked;
    try {
      await supabase.from('system_settings').upsert({
        key: 'cctv_wall_locked',
        value: String(nextLock),
        updated_at: new Date().toISOString()
      });
      setCctvLocked(nextLock);
    } catch (err) {
      alert('Error toggling CCTV lock: ' + err.message);
    }
  };

  // If locked by Super Admin and viewer is not Seed Admin override
  if (cctvLocked && !isSeedAdmin && !isSuperAdmin) {
    return (
      <div className="card" style={{ marginTop: '24px', background: 'rgba(251, 113, 133, 0.08)', borderColor: 'rgba(251, 113, 133, 0.3)', textAlign: 'center', padding: '32px' }}>
        <div style={{ fontSize: '36px', marginBottom: '12px' }}>🔒</div>
        <h3 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--danger)' }}>Live Admin Monitor Control Locked</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
          Access to the live admin monitor control wall has been locked by Super Admin.
        </p>
      </div>
    );
  }

  return (
    <div style={{ marginTop: '28px' }}>
      {/* Admin Monitor Header */}
      <div className="card" style={{ background: 'linear-gradient(135deg, rgba(15,23,42,0.95), rgba(6,9,17,0.98))', borderColor: 'rgba(56,189,248,0.35)', marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <div className="badge badge-danger" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
              <span style={{ width: '6px', height: '6px', background: '#f87171', borderRadius: '50%', animation: 'pulse 1s infinite' }}></span>
              🔴 LIVE ADMIN MONITOR CONTROL
            </div>
            <h2 style={{ fontSize: '20px', fontWeight: 800, margin: 0 }}>Multi-Machine Live Monitor Wall</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
              Real-time video streams for all connected profile devices. Click any camera tile to focus and control.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            {(isSuperAdmin || isSeedAdmin) && (
              <button 
                onClick={toggleCctvWallLock} 
                className={`btn ${cctvLocked ? 'btn-danger' : 'btn-primary'}`}
                style={{ fontSize: '12px', padding: '8px 14px' }}
              >
                {cctvLocked ? '🔒 Admin Monitor: LOCKED' : '🔓 Admin Monitor: ALLOWED'}
              </button>
            )}
            <button onClick={handleRefreshFeeds} className="btn btn-secondary" style={{ fontSize: '12px', padding: '8px 14px' }}>
              <RefreshCw size={14} /> Refresh Feeds
            </button>
          </div>
        </div>
      </div>

      {/* Grid View */}
      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
          Loading live admin monitor feeds...
        </div>
      ) : devices.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
          No active online devices connected. Connect devices via Desktop Agent.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '18px' }}>
          {devices.map(d => {
            let streamUrl = normalizeStreamUrl(d.stream_url, d.serial, true);
            if (!streamUrl.includes('muted=')) {
              streamUrl += (streamUrl.includes('?') ? '&' : '?') + 'muted=1';
            }
            const isFocused = focusDevice && focusDevice.id === d.id;
            const isStealthOn = d.stealth_root_enabled !== false;

            return (
              <div 
                key={d.id}
                className="card" 
                style={{ padding: 0, overflow: 'hidden', position: 'relative', cursor: 'pointer', transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)', borderColor: 'rgba(56, 189, 248, 0.3)' }}
                onClick={() => setFocusDevice(d)}
              >
                {/* Tile Header Bar */}
                <div style={{ padding: '8px 12px', background: 'rgba(15, 23, 42, 0.95)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  <div style={{ fontWeight: 700, fontSize: '12px', color: '#fff', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Video size={13} color="var(--primary)" />
                    {d.brand || ''} {d.model || 'Android'} ({d.serial})
                  </div>
                  <div style={{ fontSize: '10px', fontWeight: 800, color: '#f87171', background: 'rgba(239,68,68,0.2)', padding: '2px 6px', borderRadius: '100px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ width: '5px', height: '5px', background: '#f87171', borderRadius: '50%' }}></span> LIVE
                  </div>
                </div>

                {/* Viewport Frame */}
                <div style={{ position: 'relative', width: '100%', aspectRatio: '9 / 16', background: '#000', overflow: 'hidden' }}>
                  {streamUrl && !isFocused ? (
                    <iframe 
                      key={`${d.id}_${feedTimestamp}`}
                      src={streamUrl} 
                      style={{ width: '100%', height: '100%', border: 'none', pointerEvents: 'none' }} 
                      title={d.serial} 
                      referrerPolicy="no-referrer"
                      allow="autoplay; fullscreen"
                    />
                  ) : isFocused ? (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)', fontSize: '12px', fontWeight: 700 }}>
                      ⚡ Focused in Active Modal
                    </div>
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
                      Device Offline
                    </div>
                  )}

                  {/* Hover overlay */}
                  <div style={{
                    position: 'absolute', inset: 0, background: 'rgba(6, 9, 17, 0.65)', backdropFilter: 'blur(3px)',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px',
                    opacity: 0, transition: 'opacity 0.2s ease', color: '#fff', fontWeight: 800, fontSize: '13px'
                  }}
                  className="cctv-hover-target"
                  >
                    <Maximize2 size={24} color="var(--primary)" />
                    <span>Click to Focus & Control</span>
                    <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--text-muted)' }}>Serial: {d.serial}</span>
                  </div>
                </div>

                {/* Card Footer Quick Action Bar */}
                <div style={{ padding: '8px 12px', background: 'rgba(15, 23, 42, 0.8)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                  <button 
                    onClick={() => toggleStealthRoot(d.id, isStealthOn)}
                    className="btn btn-secondary"
                    style={{ fontSize: '11px', padding: '4px 8px', color: isStealthOn ? 'var(--primary)' : 'var(--text-muted)' }}
                  >
                    {isStealthOn ? '🛡️ Stealth Root: ON' : '⚪ Stealth Root: OFF'}
                  </button>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    {isSeedAdmin && (
                      <button 
                        onClick={() => deleteDeviceFromView(d.id)}
                        className="btn btn-danger"
                        style={{ fontSize: '11px', padding: '4px 8px' }}
                        title="Delete device from view across all dashboards"
                      >
                        <Trash2 size={12} /> Delete
                      </button>
                    )}
                    <button 
                      onClick={() => setFocusDevice(d)}
                      className="btn btn-primary"
                      style={{ fontSize: '11px', padding: '4px 10px' }}
                    >
                      <Eye size={12} /> Focus View
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Focus Fullscreen Control Modal */}
      {focusDevice && (
        <div className="modal-overlay" onClick={() => setFocusDevice(null)}>
          <div 
            className="modal-box" 
            onClick={e => e.stopPropagation()} 
            style={{ maxWidth: '560px', height: '92vh', maxHeight: '860px', padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
          >
            {/* Header */}
            <div style={{ padding: '14px 20px', background: 'rgba(15, 23, 42, 0.95)', borderBottom: '1px solid rgba(255,255,255,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong style={{ color: '#fff', fontSize: '15px' }}>📱 {focusDevice.brand || ''} {focusDevice.model || 'Android'}</strong>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>Serial: {focusDevice.serial}</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button 
                  onClick={() => {
                    const u = normalizeStreamUrl(focusDevice.stream_url, focusDevice.serial, true);
                    const w = 510, h = 900;
                    const left = Math.max(0, Math.round((window.screen.width - w) / 2));
                    const top = Math.max(0, Math.round((window.screen.height - h) / 2));
                    window.open(u, `Stream_${focusDevice.serial || 'Device'}`, `width=${w},height=${h},top=${top},left=${left},resizable=yes,scrollbars=no,status=no,location=no,toolbar=no,menubar=no,popup=yes`);
                  }} 
                  className="btn btn-primary" 
                  style={{ padding: '6px 14px', fontSize: '12px' }}
                >
                  <ExternalLink size={14} /> Pop Out Window
                </button>
                <button onClick={() => setFocusDevice(null)} className="btn btn-danger" style={{ padding: '6px 14px', fontSize: '12px' }}>
                  <ArrowLeft size={14} /> Back to Admin Monitor
                </button>
              </div>
            </div>

            {/* Interactive Stream Frame */}
            <div style={{ flex: 1, background: '#000', position: 'relative' }}>
              <iframe 
                src={normalizeStreamUrl(focusDevice.stream_url, focusDevice.serial, true)} 
                style={{ width: '100%', height: '100%', border: 'none' }} 
                title="Focused Device Stream"
                referrerPolicy="no-referrer"
                allow="autoplay; fullscreen"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
