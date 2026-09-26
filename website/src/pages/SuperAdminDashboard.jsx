import React, { useEffect, useState } from 'react';
import DashboardLayout from '../layouts/DashboardLayout';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { Server, Key, Smartphone, Users, RefreshCw, Link2, ExternalLink, UserX, UserCheck, Trash2, RotateCcw, Activity } from 'lucide-react';
import CctvWall from '../components/CctvWall';
import DeviceAllocationSection from '../components/DeviceAllocationSection';
import SystemLogsModal from '../components/SystemLogsModal';
import DiamtLoader from '../components/DiamtLoader';
import { generate16CharKey, generate6DigitPin, rotateUrlWithKeyAndPin, normalizeStreamUrl } from '../lib/keyGenerator';

export default function SuperAdminDashboard() {
  const { profile } = useAuth();
  const [bindingCodeInput, setBindingCodeInput] = useState('');
  const [myBindings, setMyBindings] = useState([]);
  const [devices, setDevices] = useState([]);
  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [blockingId, setBlockingId] = useState(null);
  const [blockReasonModal, setBlockReasonModal] = useState(null);
  const [blockReason, setBlockReason] = useState('');
  const [logsModalOpen, setLogsModalOpen] = useState(false);

  const loadData = async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      const isSeed = profile?.role === 'seed_admin' || profile?.role === 'super_admin';
      let bQuery = supabase.from('machine_bindings').select('*');
      if (!isSeed && profile?.id) {
        bQuery = bQuery.eq('super_admin_id', profile.id);
      }
      const { data: bData } = await bQuery;
      setMyBindings(bData || []);

      const { data: dData } = await supabase.from('devices').select('*').order('created_at', { ascending: false });
      const visibleDevices = (dData || []).filter(d => {
        if (!isSeed && d.is_deleted_from_view) return false;
        return true;
      });
      setDevices(visibleDevices);

      // Fetch admins AND workers under this super admin (to block them)
      let aQuery = supabase.from('profiles').select('*').in('role', ['admin', 'worker']);
      if (!isSeed && profile?.id) {
        aQuery = aQuery.eq('super_admin_id', profile.id);
      }
      const { data: aData } = await aQuery;
      setAdmins(aData || []);
    } catch (e) {
      console.error('Error loading super admin data:', e);
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  const handleDeleteFromView = async (deviceId) => {
    if (!window.confirm('Remove this device from view across all dashboards? Super Admins, Admins, and Workers will no longer see it.')) return;
    try {
      await supabase.from('devices').update({
        is_deleted_from_view: true,
        updated_at: new Date().toISOString()
      }).eq('id', deviceId);
      loadData(false);
    } catch (err) {
      alert('Error removing device from view: ' + err.message);
    }
  };

  useEffect(() => {
    if (!profile) return;
    loadData(true);

    const channel = supabase
      .channel('super_admin_realtime_sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, () => loadData(false))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'machine_bindings' }, () => loadData(false))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => loadData(false))
      .subscribe();

    // Fallback slow sync (5 minutes) only when the browser tab is actively visible
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadData(false);
      }
    }, 300000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(timer);
    };
  }, [profile]);

  const handleClaimBinding = async (e) => {
    e.preventDefault();
    if (!bindingCodeInput || bindingCodeInput.length !== 8) {
      return alert('Enter a valid 8-digit binding code');
    }

    try {
      const { data: existing } = await supabase
        .from('machine_bindings')
        .select('*')
        .eq('binding_code', bindingCodeInput.trim())
        .single();

      if (existing) {
        await supabase
          .from('machine_bindings')
          .update({ super_admin_id: profile.id, updated_at: new Date().toISOString() })
          .eq('binding_code', bindingCodeInput.trim());
      } else {
        await supabase
          .from('machine_bindings')
          .insert([{
            binding_code: bindingCodeInput.trim(),
            super_admin_id: profile.id,
            machine_name: 'Super Admin Machine'
          }]);
      }

      alert(`Machine Binding ${bindingCodeInput} claimed successfully!`);
      setBindingCodeInput('');
      loadData();
    } catch (err) {
      alert('Error claiming binding code: ' + err.message);
    }
  };

  const handleBlockUser = async (e) => {
    e.preventDefault();
    if (!blockReasonModal) return;
    setBlockingId(blockReasonModal.id);
    try {
      await supabase.from('profiles').update({
        is_blocked: true,
        blocked_reason: blockReason.trim() || 'Suspended by Super Admin',
        blocked_by: profile?.id,
        updated_at: new Date().toISOString(),
      }).eq('id', blockReasonModal.id);
      setBlockReasonModal(null);
      setBlockReason('');
      loadData();
    } catch (err) {
      alert('Error blocking user: ' + err.message);
    } finally {
      setBlockingId(null);
    }
  };

  const handleUnblockUser = async (userId) => {
    setBlockingId(userId);
    try {
      await supabase.from('profiles').update({
        is_blocked: false,
        blocked_reason: null,
        blocked_by: null,
        updated_at: new Date().toISOString(),
      }).eq('id', userId);
      loadData();
    } catch (err) {
      alert('Error unblocking user: ' + err.message);
    } finally {
      setBlockingId(null);
    }
  };

  const handleRotateStreamLink = async (device) => {
    if (!window.confirm(`Rotate stream link for ${device.brand} ${device.model} (${device.serial})?\n\nThis will generate a new 16-character URL key and a new 6-digit stream PIN.`)) return;

    const newKey = generate16CharKey();
    const newPin = generate6DigitPin();
    const newStreamUrl = rotateUrlWithKeyAndPin(device.stream_url, device.serial, newKey, newPin);

    try {
      await supabase.from('devices').update({
        stream_url: newStreamUrl,
        updated_at: new Date().toISOString()
      }).eq('id', device.id);

      try {
        await supabase.from('device_rentals').update({
          stream_url: newStreamUrl,
          updated_at: new Date().toISOString()
        }).eq('serial_number', device.serial);
      } catch (_) {}

      try {
        await supabase.from('device_assignments').update({
          access_password: newPin,
          updated_at: new Date().toISOString()
        }).eq('device_id', device.id);
      } catch (_) {}

      alert(`✅ Stream link rotated successfully!\n\nNew 16-Char URL Key: ${newKey}\nNew 6-Digit Stream PIN: ${newPin}\n\nThe previous link and PIN have been invalidated.`);
      loadData(false);
    } catch (err) {
      alert('Error rotating stream link: ' + err.message);
    }
  };

  return (
    <DashboardLayout>
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Server size={24} color="var(--primary)" />
            <h1 style={{ fontSize: '24px', fontWeight: 800 }}>Flexpulse Cloud Device Hub</h1>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
            Autonomous Real-Time Android Hardware Device Streaming & Cloud Orchestration
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button 
            onClick={() => setLogsModalOpen(true)} 
            className="btn btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(37, 99, 235, 0.15)', color: '#60a5fa', borderColor: 'rgba(59, 130, 246, 0.3)' }}
          >
            <Activity size={16} /> Live System Logs
          </button>
          <button onClick={loadData} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <RefreshCw size={16} /> Refresh Devices
          </button>
        </div>
      </div>

      {/* Autonomous Cloud Sync Status Banner */}
      <div className="card" style={{ marginBottom: '28px', background: 'linear-gradient(135deg, rgba(37, 99, 235, 0.12) 0%, rgba(30, 41, 59, 0.4) 100%)', border: '1px solid rgba(59, 130, 246, 0.35)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', background: '#10b981', boxShadow: '0 0 10px #10b981' }}></span>
              <h3 style={{ fontSize: '16px', fontWeight: 700, margin: 0, color: 'var(--text-main)' }}>
                Autonomous Cloud Auto-Sync Active
              </h3>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '6px' }}>
              All devices connected to your Flexpulse Desktop Agent are synchronized directly to this dashboard in real time without requiring manual machine binding codes.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)', background: 'rgba(15, 23, 42, 0.6)', padding: '6px 14px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
              Online Devices: <strong style={{ color: 'var(--primary)' }}>{devices.filter(d => d.status === 'online').length}</strong>
            </span>
          </div>
        </div>
      </div>

      {/* Real-time Security CCTV Camera Wall */}
      <CctvWall currentUser={profile} isSuperAdmin={true} />

      {/* Device Allocation Section */}
      <div style={{ marginBottom: '28px' }}>
        <DeviceAllocationSection currentUser={profile} />
      </div>

      {/* Connected Devices Table */}
      <div className="card" style={{ marginBottom: '28px' }}>
        <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Smartphone size={18} color="var(--primary)" /> Managed Devices & Stream Links
        </h3>

        {loading ? (
          <div style={{ padding: '32px 0' }}>
            <DiamtLoader text="FETCHING HARDWARE GRID" subtext="Synchronizing connected devices from Flexpulse cloud..." size="small" />
          </div>
        ) : devices.length === 0 ? (
          <div style={{ color: 'var(--text-muted)' }}>No devices connected. Launch your Flexpulse Agent desktop app to connect devices automatically.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <th style={{ padding: '12px' }}>DEVICE / MODEL</th>
                  <th style={{ padding: '12px' }}>SERIAL</th>
                  <th style={{ padding: '12px' }}>BINDING CODE</th>
                  <th style={{ padding: '12px' }}>AUTO-UPDATED STREAM URL</th>
                  <th style={{ padding: '12px', textAlign: 'right' }}>STREAM ACCESS</th>
                </tr>
              </thead>
              <tbody>
                {devices.map(d => (
                  <tr key={d.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '14px 12px', fontWeight: 700 }}>{d.brand} {d.model}</td>
                    <td style={{ padding: '14px 12px', fontFamily: 'monospace' }}>{d.serial}</td>
                    <td style={{ padding: '14px 12px', fontFamily: 'monospace', color: 'var(--primary)' }}>{d.binding_code || 'Unbound'}</td>
                    <td style={{ padding: '14px 12px', fontSize: '12px', fontFamily: 'monospace', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.stream_url ? normalizeStreamUrl(d.stream_url, d.serial) : 'Generating Cloudflare link...'}
                    </td>
                    <td style={{ padding: '14px 12px', textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
                        {(profile?.role === 'seed_admin' || profile?.email?.toLowerCase() === 'sammyseth260@gmail.com') && (
                          <button
                            onClick={() => handleDeleteFromView(d.id)}
                            className="btn btn-danger"
                            style={{ padding: '6px 12px', fontSize: '12px' }}
                            title="Remove device from view across all dashboards"
                          >
                            <Trash2 size={12} /> Remove from View
                          </button>
                        )}
                        <button
                          onClick={() => handleRotateStreamLink(d)}
                          className="btn btn-secondary"
                          style={{ padding: '6px 12px', fontSize: '12px' }}
                          title="Rotate stream link and issue a new 16-character access key"
                        >
                          <RotateCcw size={12} /> Rotate Link
                        </button>
                        {d.stream_url ? (
                          <a 
                            href={normalizeStreamUrl(d.stream_url, d.serial)} 
                            target="_blank" 
                            rel="noreferrer" 
                            className="btn btn-primary" 
                            style={{ padding: '6px 12px', fontSize: '12px' }}
                            onClick={(e) => {
                              e.preventDefault();
                              const targetUrl = normalizeStreamUrl(d.stream_url, d.serial);
                              const w = 510, h = 900;
                              const left = Math.max(0, Math.round((window.screen.width - w) / 2));
                              const top = Math.max(0, Math.round((window.screen.height - h) / 2));
                              window.open(targetUrl, `Stream_${d.serial || 'Device'}`, `width=${w},height=${h},top=${top},left=${left},resizable=yes,scrollbars=no,status=no,location=no,toolbar=no,menubar=no,popup=yes`);
                            }}
                          >
                            Open Stream <ExternalLink size={12} />
                          </a>
                        ) : (
                          <span className="badge badge-warning">Offline</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* User Block Management */}
      {admins.length > 0 && (
        <div className="card">
          <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Users size={18} color="var(--accent)" /> Admin & Worker Access Control
          </h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <th style={{ padding: '12px' }}>EMAIL</th>
                  <th style={{ padding: '12px' }}>ROLE</th>
                  <th style={{ padding: '12px' }}>STATUS</th>
                  <th style={{ padding: '12px', textAlign: 'right' }}>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {admins.map(u => (
                  <tr key={u.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '14px 12px', fontWeight: 600 }}>{u.email}</td>
                    <td style={{ padding: '14px 12px' }}>
                      <span className={`badge ${u.role === 'admin' ? 'badge-info' : 'badge-success'}`}>
                        {u.role.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: '14px 12px' }}>
                      {u.is_blocked ? (
                        <span className="badge badge-danger"><UserX size={11} /> BLOCKED</span>
                      ) : (
                        <span className="badge badge-success"><UserCheck size={11} /> ACTIVE</span>
                      )}
                    </td>
                    <td style={{ padding: '14px 12px', textAlign: 'right' }}>
                      {u.is_blocked ? (
                        <button
                          onClick={() => handleUnblockUser(u.id)}
                          disabled={blockingId === u.id}
                          className="btn btn-primary"
                          style={{ padding: '6px 14px', fontSize: '12px' }}
                        >
                          <UserCheck size={14} /> Unblock
                        </button>
                      ) : (
                        <button
                          onClick={() => { setBlockReasonModal(u); setBlockReason(''); }}
                          disabled={blockingId === u.id}
                          className="btn btn-danger"
                          style={{ padding: '6px 14px', fontSize: '12px' }}
                        >
                          <UserX size={14} /> Block
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Block Reason Modal */}
      {blockReasonModal && (
        <div className="modal-overlay" onClick={() => setBlockReasonModal(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '440px' }}>
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--danger)' }}>
              <UserX size={20} /> Block User
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
              Blocking <strong style={{ color: 'var(--text-main)' }}>{blockReasonModal.email}</strong>. They will immediately see an "Access Revoked" screen.
            </p>
            <form onSubmit={handleBlockUser} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>REASON (optional)</label>
                <input
                  type="text"
                  className="input-field"
                  placeholder="e.g. Violated usage policy"
                  value={blockReason}
                  onChange={e => setBlockReason(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '6px' }}>
                <button type="button" onClick={() => setBlockReasonModal(null)} className="btn btn-secondary">Cancel</button>
                <button type="submit" className="btn btn-danger" disabled={blockingId}>
                  <UserX size={14} /> Confirm Block
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Real-time System Logs Console */}
      <SystemLogsModal 
        isOpen={logsModalOpen} 
        onClose={() => setLogsModalOpen(false)} 
      />
    </DashboardLayout>
  );
}
