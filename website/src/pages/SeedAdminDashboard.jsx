import React, { useEffect, useState } from 'react';
import DashboardLayout from '../layouts/DashboardLayout';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { Shield, Key, CheckCircle, XCircle, Users, RefreshCw, Lock, Unlock, UserX, UserCheck, Smartphone, Trash2, RotateCcw, EyeOff, Zap, Power, Wifi, WifiOff, HelpCircle, Activity } from 'lucide-react';
import CctvWall from '../components/CctvWall';
import DeviceAllocationSection from '../components/DeviceAllocationSection';
import SystemLogsModal from '../components/SystemLogsModal';
import DiamtLoader from '../components/DiamtLoader';
import { generate16CharKey, generate6DigitPin, rotateUrlWithKeyAndPin } from '../lib/keyGenerator';

export default function SeedAdminDashboard() {
  const { profile: myProfile } = useAuth();
  const [bindings, setBindings] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [blockingId, setBlockingId] = useState(null);
  const [blockReason, setBlockReason] = useState('');
  const [blockReasonModal, setBlockReasonModal] = useState(null); // profile to block
  const [wakingBindingCode, setWakingBindingCode] = useState(null);
  const [wolModalOpen, setWolModalOpen] = useState(false);
  const [wolSelectedMachine, setWolSelectedMachine] = useState(null);
  const [logsModalOpen, setLogsModalOpen] = useState(false);

  const loadData = async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      const { data: bData } = await supabase.from('machine_bindings').select('*');
      const { data: pData } = await supabase.from('profiles').select('*');
      const { data: dData } = await supabase.from('devices').select('*').order('created_at', { ascending: false });
      setBindings(bData || []);
      setProfiles(pData || []);
      setDevices(dData || []);
    } catch (e) {
      console.error('Error loading seed data:', e);
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  useEffect(() => {
    loadData(true);

    const channel = supabase
      .channel('seed_admin_realtime_sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, () => loadData(false))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'machine_bindings' }, () => loadData(false))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => loadData(false))
      .subscribe();

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadData(false);
      }
    }, 300000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, []);

  const handleDeleteFromView = async (deviceId) => {
    if (!window.confirm('Delete this device from view in all dashboards? Super Admins, Admins, and Workers will no longer see it.')) return;
    try {
      await supabase.from('devices').update({
        is_deleted_from_view: true,
        updated_at: new Date().toISOString()
      }).eq('id', deviceId);
      loadData();
    } catch (err) {
      alert('Error deleting device from view: ' + err.message);
    }
  };

  const handleRestoreToView = async (deviceId) => {
    try {
      await supabase.from('devices').update({
        is_deleted_from_view: false,
        updated_at: new Date().toISOString()
      }).eq('id', deviceId);
      loadData();
    } catch (err) {
      alert('Error restoring device to view: ' + err.message);
    }
  };

  const toggleRentalStoreRelease = async (deviceId, currentVal) => {
    const nextVal = !currentVal;
    try {
      await supabase.from('devices').update({
        is_available_for_rental: nextVal,
        updated_at: new Date().toISOString()
      }).eq('id', deviceId);
      loadData();
    } catch (err) {
      alert('Error updating rental availability: ' + err.message);
    }
  };

  const handleSetRentalFee = async (deviceId, currentPrice) => {
    const newPrice = prompt('Set Monthly Rental Fee ($ USD):', currentPrice || 49);
    if (!newPrice) return;
    const numPrice = parseFloat(newPrice);
    if (isNaN(numPrice) || numPrice < 0) return alert('Invalid price');

    try {
      await supabase.from('devices').update({
        monthly_rental_price: numPrice,
        updated_at: new Date().toISOString()
      }).eq('id', deviceId);
      loadData();
    } catch (err) {
      alert('Error setting rental fee: ' + err.message);
    }
  };

  const toggleLicense = async (bindingCode, currentStatus) => {
    const nextStatus = !currentStatus;
    await supabase.from('machine_bindings')
      .update({ is_licensed: nextStatus, updated_at: new Date().toISOString() })
      .eq('binding_code', bindingCode);
    loadData();
  };

  const toggleMode = async (bindingCode, currentMode) => {
    const nextMode = currentMode === 'free' ? 'licensed' : 'free';
    await supabase.from('machine_bindings')
      .update({ license_mode: nextMode, updated_at: new Date().toISOString() })
      .eq('binding_code', bindingCode);
    loadData();
  };

  const updateUserRole = async (userId, newRole) => {
    await supabase.from('profiles')
      .update({ role: newRole, updated_at: new Date().toISOString() })
      .eq('id', userId);
    loadData();
  };

  const handleBlockUser = async (e) => {
    e.preventDefault();
    if (!blockReasonModal) return;
    setBlockingId(blockReasonModal.id);
    try {
      await supabase.from('profiles').update({
        is_blocked: true,
        blocked_reason: blockReason.trim() || 'Suspended by Seed Owner',
        blocked_by: myProfile?.id,
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
      loadData();
    } catch (err) {
      alert('Error rotating stream link: ' + err.message);
    }
  };

  const handleWakeOnLan = async (machine) => {
    if (!machine.mac_address || machine.mac_address === '00:00:00:00:00:00') {
      alert(`⚠️ No MAC address recorded for ${machine.machine_name || 'this machine'}.\n\nPlease ensure the agent has connected at least once to sync its hardware network identity.`);
      return;
    }

    setWakingBindingCode(machine.binding_code);
    try {
      // Broadcast Wake-on-LAN Magic Packet dispatch request over Supabase Realtime
      const channel = supabase.channel('wol_broadcast_channel');
      await channel.send({
        type: 'broadcast',
        event: 'WAKE_MACHINE',
        payload: {
          mac: machine.mac_address,
          broadcastAddress: machine.broadcast_ip || '255.255.255.255',
          machineName: machine.machine_name,
          bindingCode: machine.binding_code,
          timestamp: new Date().toISOString(),
        },
      });

      alert(`⚡ Wake-on-LAN Magic Packet sent to:\n\nMachine: ${machine.machine_name}\nMAC: ${machine.mac_address}\nBroadcast: ${machine.broadcast_ip || '255.255.255.255'}\n\nOnline farm relay agents will broadcast the UDP Magic Packet to wake the computer.`);
    } catch (err) {
      alert('Error sending Wake-on-LAN request: ' + err.message);
    } finally {
      setTimeout(() => setWakingBindingCode(null), 2000);
    }
  };

  const isSeedOwner = (p) => p.email?.toLowerCase() === 'sammyseth260@gmail.com';

  return (
    <DashboardLayout>
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Shield size={24} color="var(--danger)" />
            <h1 style={{ fontSize: '24px', fontWeight: 800 }}>Seed Admin Control Center</h1>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
            Owner rights (sammyseth260@gmail.com). Manage Super Admin licenses, binding codes, and system modes.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button 
            onClick={() => setLogsModalOpen(true)} 
            className="btn btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', borderColor: 'rgba(56, 189, 248, 0.3)' }}
          >
            <Activity size={16} /> Live System Logs
          </button>
          <button onClick={loadData} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <RefreshCw size={16} /> Refresh
          </button>
        </div>
      </div>

      {/* Stats Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '28px' }}>
        <div className="card">
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>TOTAL MACHINES BOUND</div>
          <div style={{ fontSize: '32px', fontWeight: 800, marginTop: '4px', color: 'var(--primary)' }}>{bindings.length}</div>
        </div>
        <div className="card">
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>ACTIVE LICENSES</div>
          <div style={{ fontSize: '32px', fontWeight: 800, marginTop: '4px', color: 'var(--success)' }}>
            {bindings.filter(b => b.is_licensed).length}
          </div>
        </div>
        <div className="card">
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>TOTAL USERS</div>
          <div style={{ fontSize: '32px', fontWeight: 800, marginTop: '4px', color: 'var(--accent)' }}>{profiles.length}</div>
        </div>
        <div className="card">
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>DEVICES DELETED FROM VIEW</div>
          <div style={{ fontSize: '32px', fontWeight: 800, marginTop: '4px', color: 'var(--danger)' }}>
            {devices.filter(d => d.is_deleted_from_view).length}
          </div>
        </div>
      </div>

      {/* Real-time Security CCTV Camera Wall */}
      <CctvWall currentUser={myProfile} isSeedAdmin={true} />

      {/* Device Allocation Section */}
      <div style={{ marginBottom: '32px' }}>
        <DeviceAllocationSection currentUser={myProfile} />
      </div>

      {/* Seed Admin Device Visibility & Delete from View Management */}
      <div className="card" style={{ marginBottom: '32px' }}>
        <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Smartphone size={18} color="var(--primary)" /> Seed Admin Device Visibility & Delete from View Control
        </h3>

        {loading ? (
          <div style={{ padding: '32px 0' }}>
            <DiamtLoader text="RETRIEVING REGISTERED HARDWARE" subtext="Synchronizing devices from Flexpulse cloud nodes..." size="small" />
          </div>
        ) : devices.length === 0 ? (
          <div style={{ color: 'var(--text-muted)' }}>No devices registered yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <th style={{ padding: '12px' }}>DEVICE / MODEL</th>
                  <th style={{ padding: '12px' }}>SERIAL</th>
                  <th style={{ padding: '12px' }}>MONTHLY FEE ($ USD)</th>
                  <th style={{ padding: '12px' }}>RENTALS STORE RELEASE</th>
                  <th style={{ padding: '12px' }}>VISIBILITY STATUS</th>
                  <th style={{ padding: '12px', textAlign: 'right' }}>SEED ADMIN ACTION</th>
                </tr>
              </thead>
              <tbody>
                {devices.map(d => {
                  const now = new Date().getTime();
                  const lastTime = d.updated_at || d.last_seen ? new Date(d.updated_at || d.last_seen).getTime() : 0;
                  const isOnline = d.status === 'online' && (!d.last_seen || (now - lastTime < 180000));
                  const isDeleted = Boolean(d.is_deleted_from_view);
                  const isAvailableRental = Boolean(d.is_available_for_rental);
                  const price = d.monthly_rental_price || 49;

                  return (
                    <tr key={d.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '14px 12px', fontWeight: 700 }}>{d.brand} {d.model}</td>
                      <td style={{ padding: '14px 12px', fontFamily: 'monospace' }}>{d.serial}</td>
                      <td style={{ padding: '14px 12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontWeight: 800, color: 'var(--primary)' }}>${price}/mo</span>
                          <button 
                            onClick={() => handleSetRentalFee(d.id, price)} 
                            className="btn btn-secondary" 
                            style={{ padding: '2px 6px', fontSize: '10px' }}
                          >
                            Set Fee
                          </button>
                        </div>
                      </td>
                      <td style={{ padding: '14px 12px' }}>
                        <button
                          onClick={() => toggleRentalStoreRelease(d.id, isAvailableRental)}
                          className={`btn ${isAvailableRental ? 'btn-success' : 'btn-secondary'}`}
                          style={{ padding: '4px 10px', fontSize: '11px' }}
                        >
                          {isAvailableRental ? '🛒 Released to Store' : '🔒 Hold in Inventory'}
                        </button>
                      </td>
                      <td style={{ padding: '14px 12px' }}>
                        {isDeleted ? (
                          <span className="badge badge-danger" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            <EyeOff size={11} /> DELETED FROM VIEW
                          </span>
                        ) : (
                          <span className="badge badge-success" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            <CheckCircle size={11} /> VISIBLE TO ALL
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '14px 12px', textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                          <button
                            onClick={() => handleRotateStreamLink(d)}
                            className="btn btn-secondary"
                            style={{ padding: '6px 10px', fontSize: '11px' }}
                            title="Rotate stream link and issue a new 16-character access key"
                          >
                            <RotateCcw size={12} /> Rotate Link
                          </button>
                          {isDeleted ? (
                            <button
                              onClick={() => handleRestoreToView(d.id)}
                              className="btn btn-secondary"
                              style={{ padding: '6px 10px', fontSize: '11px' }}
                            >
                              Restore
                            </button>
                          ) : (
                            <button
                              onClick={() => handleDeleteFromView(d.id)}
                              className="btn btn-danger"
                              style={{ padding: '6px 10px', fontSize: '11px' }}
                            >
                              <Trash2 size={12} /> Delete from View
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Machine Bindings & Hardware Remote Power-On */}
      <div className="card" style={{ marginBottom: '32px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h3 style={{ fontSize: '18px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Key size={18} color="var(--primary)" /> Machine Binding Codes & Remote Hardware Power-On
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '2px' }}>
              Autonomous 24/7 background agent nodes with remote Wake-on-LAN power management.
            </p>
          </div>
          <button 
            onClick={() => setWolModalOpen(true)}
            className="btn btn-secondary"
            style={{ fontSize: '12px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <HelpCircle size={14} color="var(--accent)" /> Wake-on-LAN Setup Guide
          </button>
        </div>

        {loading ? (
          <div style={{ padding: '32px 0' }}>
            <DiamtLoader text="RETRIEVING MACHINE REGISTRY" subtext="Synchronizing worker nodes and host identities..." size="small" />
          </div>
        ) : bindings.length === 0 ? (
          <div style={{ color: 'var(--text-muted)' }}>No machine binding codes registered yet. Start the setup script on a computer to bind.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <th style={{ padding: '12px' }}>BINDING CODE</th>
                  <th style={{ padding: '12px' }}>MACHINE NAME</th>
                  <th style={{ padding: '12px' }}>HARDWARE NETWORK (MAC / IP)</th>
                  <th style={{ padding: '12px' }}>LIVE STATUS</th>
                  <th style={{ padding: '12px' }}>MODE</th>
                  <th style={{ padding: '12px' }}>LICENSE</th>
                  <th style={{ padding: '12px', textAlign: 'right' }}>REMOTE POWER & ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {bindings.map(b => {
                  const now = new Date().getTime();
                  const lastTime = b.last_seen || b.updated_at ? new Date(b.last_seen || b.updated_at).getTime() : 0;
                  const isOnline = lastTime > 0 && (now - lastTime < 180000);
                  const isWaking = wakingBindingCode === b.binding_code;

                  return (
                    <tr key={b.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '14px 12px', fontFamily: 'monospace', fontWeight: 700, fontSize: '16px', color: 'var(--primary)' }}>
                        {b.binding_code}
                      </td>
                      <td style={{ padding: '14px 12px', fontWeight: 600 }}>{b.machine_name || 'Windows Machine'}</td>
                      <td style={{ padding: '14px 12px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontFamily: 'monospace', fontSize: '12px' }}>
                          <span style={{ color: 'var(--text-main)', fontWeight: 600 }}>MAC: {b.mac_address || 'Not Synced'}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>IP: {b.local_ip || '127.0.0.1'}</span>
                        </div>
                      </td>
                      <td style={{ padding: '14px 12px' }}>
                        {isOnline ? (
                          <span className="badge badge-success" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            <Activity size={11} /> ONLINE (24/7)
                          </span>
                        ) : (
                          <span className="badge badge-warning" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            <Power size={11} /> ASLEEP / OFFLINE
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '14px 12px' }}>
                        <span className={`badge ${b.license_mode === 'free' ? 'badge-warning' : 'badge-info'}`}>
                          {b.license_mode.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: '14px 12px' }}>
                        <span className={`badge ${b.is_licensed ? 'badge-success' : 'badge-danger'}`}>
                          {b.is_licensed ? <CheckCircle size={12} /> : <XCircle size={12} />}
                          {b.is_licensed ? 'LICENSED' : 'REVOKED'}
                        </span>
                      </td>
                      <td style={{ padding: '14px 12px', textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          <button 
                            onClick={() => handleWakeOnLan(b)}
                            disabled={isWaking || !b.mac_address}
                            className="btn btn-warning"
                            style={{ padding: '5px 10px', fontSize: '11px', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                            title="Send Wake-on-LAN Magic Packet to turn on this computer remotely"
                          >
                            <Zap size={12} /> {isWaking ? 'Waking...' : '⚡ Wake Machine'}
                          </button>
                          <button 
                            onClick={() => toggleMode(b.binding_code, b.license_mode)}
                            className="btn btn-secondary"
                            style={{ padding: '5px 10px', fontSize: '11px' }}
                          >
                            {b.license_mode === 'free' ? 'Set Licensed' : 'Set Free'}
                          </button>
                          <button 
                            onClick={() => toggleLicense(b.binding_code, b.is_licensed)}
                            className={`btn ${b.is_licensed ? 'btn-danger' : 'btn-primary'}`}
                            style={{ padding: '5px 10px', fontSize: '11px' }}
                          >
                            {b.is_licensed ? <Lock size={12} /> : <Unlock size={12} />}
                            {b.is_licensed ? 'Revoke' : 'Activate'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* User Role Management & Block Controls */}
      <div className="card">
        <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Users size={18} color="var(--accent)" /> User Role & Access Control
        </h3>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px' }}>
                <th style={{ padding: '12px' }}>EMAIL</th>
                <th style={{ padding: '12px' }}>CURRENT ROLE</th>
                <th style={{ padding: '12px' }}>STATUS</th>
                <th style={{ padding: '12px' }}>ASSIGN ROLE</th>
                <th style={{ padding: '12px', textAlign: 'right' }}>BLOCK / UNBLOCK</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map(p => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '14px 12px', fontWeight: 600 }}>{p.email}</td>
                  <td style={{ padding: '14px 12px' }}>
                    <span className={`badge ${
                      p.role === 'seed_admin' ? 'badge-danger' :
                      p.role === 'super_admin' ? 'badge-warning' :
                      p.role === 'admin' ? 'badge-info' : 'badge-success'
                    }`}>
                      {p.role.replace('_', ' ').toUpperCase()}
                    </span>
                  </td>
                  <td style={{ padding: '14px 12px' }}>
                    {p.is_blocked ? (
                      <span className="badge badge-danger">
                        <UserX size={11} /> BLOCKED
                      </span>
                    ) : (
                      <span className="badge badge-success">
                        <UserCheck size={11} /> ACTIVE
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '14px 12px' }}>
                    {isSeedOwner(p) ? (
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Owner (Immutable)</span>
                    ) : (
                      <select 
                        value={p.role} 
                        onChange={e => updateUserRole(p.id, e.target.value)}
                        className="input-field"
                        style={{ width: 'auto', padding: '6px 12px', fontSize: '12px' }}
                      >
                        <option value="worker">Worker</option>
                        <option value="admin">Admin</option>
                        <option value="super_admin">Super Admin</option>
                      </select>
                    )}
                  </td>
                  <td style={{ padding: '14px 12px', textAlign: 'right' }}>
                    {isSeedOwner(p) ? (
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Cannot Block Owner</span>
                    ) : p.is_blocked ? (
                      <button
                        onClick={() => handleUnblockUser(p.id)}
                        disabled={blockingId === p.id}
                        className="btn btn-primary"
                        style={{ padding: '6px 14px', fontSize: '12px' }}
                      >
                        <UserCheck size={14} /> Unblock
                      </button>
                    ) : (
                      <button
                        onClick={() => { setBlockReasonModal(p); setBlockReason(''); }}
                        disabled={blockingId === p.id}
                        className="btn btn-danger"
                        style={{ padding: '6px 14px', fontSize: '12px' }}
                      >
                        <UserX size={14} /> Block User
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Block Reason Modal */}
      {blockReasonModal && (
        <div className="modal-overlay" onClick={() => setBlockReasonModal(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '440px' }}>
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--danger)' }}>
              <UserX size={20} /> Block User
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
              You are about to block <strong style={{ color: 'var(--text-main)' }}>{blockReasonModal.email}</strong>. They will immediately see an "Access Revoked" screen.
            </p>
            <form onSubmit={handleBlockUser} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                  REASON (optional)
                </label>
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

      {/* Wake-on-LAN Guide Modal */}
      {wolModalOpen && (
        <div className="modal-overlay" onClick={() => setWolModalOpen(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '560px' }}>
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--primary)' }}>
              <Zap size={20} /> Remote Power-On (Wake-on-LAN) Setup Guide
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', lineHeight: '1.5', marginBottom: '16px' }}>
              Wake-on-LAN sends a network <strong>UDP Magic Packet</strong> to power on or wake up sleeping farm host computers autonomously over Ethernet/Wi-Fi.
            </p>

            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '14px', marginBottom: '16px', fontSize: '13px', lineHeight: '1.6' }}>
              <div style={{ fontWeight: 700, color: 'var(--accent)', marginBottom: '6px' }}>🔧 Prerequisite Computer Setup (One-Time):</div>
              <ol style={{ paddingLeft: '20px', margin: 0, color: 'var(--text-main)' }}>
                <li style={{ marginBottom: '6px' }}>
                  <strong>Windows Device Manager:</strong> Open <em>Device Manager</em> → expand <em>Network Adapters</em> → Right click Ethernet/Wi-Fi Card → <em>Properties</em> → <em>Power Management</em> tab → check <strong>"Allow this device to wake the computer"</strong> and <strong>"Only allow a magic packet to wake the computer"</strong>.
                </li>
                <li style={{ marginBottom: '6px' }}>
                  <strong>Advanced Tab:</strong> In the same network properties window, switch to the <em>Advanced</em> tab and set <strong>"Wake on Magic Packet"</strong> to <em>Enabled</em>.
                </li>
                <li>
                  <strong>BIOS / UEFI:</strong> On computer boot (press DEL or F2), go to Power Management and enable <strong>"Power On by PCI-E"</strong> or <strong>"Wake-on-LAN (WoL)"</strong>.
                </li>
              </ol>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setWolModalOpen(false)} className="btn btn-primary">
                Got It, Close Guide
              </button>
            </div>
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
