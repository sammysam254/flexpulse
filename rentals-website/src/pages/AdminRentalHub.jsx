import React, { useEffect, useState } from 'react';
import RentalsLayout from '../layouts/RentalsLayout';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { Shield, Smartphone, DollarSign, RefreshCw, CheckCircle, XCircle, RotateCcw, Trash2, Users } from 'lucide-react';
import SEO from '../components/SEO';

export default function AdminRentalHub() {
  const { profile } = useAuth();
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [priceEditingId, setPriceEditingId] = useState(null);
  const [priceInput, setPriceInput] = useState('');

  const isSeedAdmin = profile?.role === 'seed_admin' || profile?.email?.toLowerCase() === 'sammyseth260@gmail.com';

  const loadRentalData = async () => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from('devices')
        .select('*')
        .order('created_at', { ascending: false });

      setDevices(data || []);
    } catch (e) {
      console.error('Error loading rental hub data:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRentalData();

    const channel = supabase
      .channel('admin_rental_hub_realtime_sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, () => loadRentalData())
      .subscribe();

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadRentalData();
      }
    }, 300000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(timer);
    };
  }, []);

  const toggleRentalAvailability = async (deviceId, currentVal) => {
    const nextVal = !currentVal;
    try {
      await supabase.from('devices').update({
        is_available_for_rental: nextVal,
        updated_at: new Date().toISOString()
      }).eq('id', deviceId);
      loadRentalData();
    } catch (err) {
      alert('Error updating rental availability: ' + err.message);
    }
  };

  const handleSavePrice = async (deviceId) => {
    const numPrice = parseFloat(priceInput);
    if (isNaN(numPrice) || numPrice < 0) return alert('Enter a valid monthly rental price');

    try {
      await supabase.from('devices').update({
        monthly_rental_price: numPrice,
        updated_at: new Date().toISOString()
      }).eq('id', deviceId);
      setPriceEditingId(null);
      setPriceInput('');
      loadRentalData();
    } catch (err) {
      alert('Error updating rental price: ' + err.message);
    }
  };

  const handleCancelRental = async (device) => {
    if (!window.confirm(`Unallocate & cancel rental for ${device.brand} ${device.model} (${device.serial})?\n\nThis will completely remove the device from the user's dashboard and release it back for re-linking.`)) return;

    try {
      // 1. Reset device rental status
      await supabase.from('devices').update({
        rental_status: 'available',
        rented_by_user_id: null,
        rented_at: null,
        updated_at: new Date().toISOString()
      }).eq('id', device.id);

      // 2. Delete device assignment record (removes from worker dashboard completely)
      await supabase.from('device_assignments').delete().eq('device_id', device.id);

      alert('✅ Device unallocated successfully! Removed from worker dashboard and released for re-linking.');
      loadRentalData();
    } catch (err) {
      alert('Error unallocating rental: ' + err.message);
    }
  };

  const handleRotateStreamLink = async (device) => {
    if (!window.confirm(`Rotate stream link for ${device.brand} ${device.model} (${device.serial})?\n\nThis will generate a new 16-character URL key and a new 6-digit stream PIN.`)) return;

    function generate16CharKey() {
      const words = ['flex', 'pulse', 'cloud', 'agent', 'cyber', 'hyper', 'nexus', 'shield', 'matrix', 'stream', 'turbo', 'quantum', 'vector', 'blaze', 'alpha', 'delta'];
      const w1 = words[Math.floor(Math.random() * words.length)];
      const w2 = words[Math.floor(Math.random() * words.length)];
      const num = Math.floor(1000 + Math.random() * 9000).toString();
      let k = `${w1}${w2}${num}`.toLowerCase();
      if (k.length > 16) k = k.substring(0, 16);
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      while (k.length < 16) {
        k += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return k;
    }

    function generate6DigitPin() {
      return Math.floor(100000 + Math.random() * 900000).toString();
    }

    const newKey = generate16CharKey();
    const newPin = generate6DigitPin();
    const streamDomain = import.meta.env.VITE_STREAM_DOMAIN || 'https://stream.dennoh.site';
    const baseUrl = streamDomain.endsWith('/') ? streamDomain : `${streamDomain}/`;
    const newStreamUrl = `${baseUrl}?udid=${encodeURIComponent(device.serial)}&key=${newKey}&pin=${newPin}`;

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

      alert(`✅ Stream link rotated successfully!\n\nNew 16-Char URL Key: ${newKey}\nNew 6-Digit Stream PIN: ${newPin}\n\nOld stream link and PIN have been invalidated.`);
      loadRentalData();
    } catch (err) {
      alert('Error rotating stream link: ' + err.message);
    }
  };

  const unassignedDevices = devices.filter(d => !d.rented_by_user_id && d.rental_status !== 'rented');
  const activeRentals = devices.filter(d => d.rented_by_user_id || d.rental_status === 'rented');

  return (
    <RentalsLayout>
      <SEO
        title="Admin Rental Control Hub — Flexpulse"
        description="Super Admin rental management hub for setting rental rates and managing store releases."
        noIndex={true}
      />
      <main aria-labelledby="admin-hub-title">
        <header style={{ marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Shield size={26} color="var(--warning)" />
              <h1 id="admin-hub-title" style={{ fontSize: '26px', fontWeight: 800 }}>Admin Rental Control Hub</h1>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
              Super Admin & Seed Admin rental management. Release devices to marketplace, set pricing, and monitor active rentals.
            </p>
          </div>
          <button onClick={loadRentalData} className="btn btn-secondary">
            <RefreshCw size={16} /> Refresh Data
          </button>
        </header>

      {/* Overview Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '28px' }}>
        <div className="card">
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>TOTAL FLEET DEVICES</div>
          <div style={{ fontSize: '32px', fontWeight: 800, marginTop: '4px', color: 'var(--primary)' }}>{devices.length}</div>
        </div>
        <div className="card">
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>RELEASED TO STORE</div>
          <div style={{ fontSize: '32px', fontWeight: 800, marginTop: '4px', color: 'var(--success)' }}>
            {devices.filter(d => d.is_available_for_rental).length}
          </div>
        </div>
        <div className="card">
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>ACTIVE RENTALS OUT</div>
          <div style={{ fontSize: '32px', fontWeight: 800, marginTop: '4px', color: 'var(--warning)' }}>
            {activeRentals.length}
          </div>
        </div>
      </div>

      {/* Unassigned Devices: Release & Price Control */}
      <div className="card" style={{ marginBottom: '32px' }}>
        <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Smartphone size={18} color="var(--primary)" /> Unassigned Fleet Devices & Store Release
        </h3>

        {loading ? (
          <div>Loading fleet devices...</div>
        ) : unassignedDevices.length === 0 ? (
          <div style={{ color: 'var(--text-muted)' }}>No unassigned devices found.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <th style={{ padding: '12px' }}>DEVICE</th>
                  <th style={{ padding: '12px' }}>SERIAL</th>
                  <th style={{ padding: '12px' }}>MONTHLY FEE (USD)</th>
                  <th style={{ padding: '12px' }}>RENTALS STORE AVAILABILITY</th>
                  <th style={{ padding: '12px', textAlign: 'right' }}>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {unassignedDevices.map(d => {
                  const price = d.monthly_rental_price || 49;
                  const isAvailable = Boolean(d.is_available_for_rental);
                  const isEditingPrice = priceEditingId === d.id;

                  return (
                    <tr key={d.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '14px 12px', fontWeight: 700 }}>{d.brand} {d.model}</td>
                      <td style={{ padding: '14px 12px', fontFamily: 'monospace' }}>{d.serial}</td>
                      <td style={{ padding: '14px 12px' }}>
                        {isEditingPrice ? (
                          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                            <input
                              type="number"
                              className="input-field"
                              style={{ width: '90px', padding: '4px 8px' }}
                              value={priceInput}
                              onChange={e => setPriceInput(e.target.value)}
                            />
                            <button onClick={() => handleSavePrice(d.id)} className="btn btn-primary" style={{ padding: '4px 8px', fontSize: '11px' }}>Save</button>
                            <button onClick={() => setPriceEditingId(null)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '11px' }}>Cancel</button>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontWeight: 800, color: 'var(--primary)' }}>${price}/mo</span>
                            {isSeedAdmin && (
                              <button 
                                onClick={() => { setPriceEditingId(d.id); setPriceInput(String(price)); }} 
                                className="btn btn-secondary" 
                                style={{ padding: '2px 6px', fontSize: '10px' }}
                              >
                                Edit Fee
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '14px 12px' }}>
                        <span className={`badge ${isAvailable ? 'badge-success' : 'badge-warning'}`}>
                          {isAvailable ? '🛒 RELEASED TO STORE' : '🔒 HELD IN INVENTORY'}
                        </span>
                      </td>
                      <td style={{ padding: '14px 12px', textAlign: 'right' }}>
                        <button
                          onClick={() => toggleRentalAvailability(d.id, isAvailable)}
                          className={`btn ${isAvailable ? 'btn-secondary' : 'btn-primary'}`}
                          style={{ padding: '6px 12px', fontSize: '12px' }}
                        >
                          {isAvailable ? 'Hold in Inventory' : 'Release to Rentals Store'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Active Rented Devices Control */}
      <div className="card">
        <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Users size={18} color="var(--warning)" /> Active Rented Devices & Cancellation Controls
        </h3>

        {activeRentals.length === 0 ? (
          <div style={{ color: 'var(--text-muted)' }}>No devices are currently rented out.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <th style={{ padding: '12px' }}>DEVICE</th>
                  <th style={{ padding: '12px' }}>SERIAL</th>
                  <th style={{ padding: '12px' }}>RENTED BY (USER ID)</th>
                  <th style={{ padding: '12px' }}>MONTHLY FEE</th>
                  <th style={{ padding: '12px' }}>RENTAL STATUS</th>
                  <th style={{ padding: '12px', textAlign: 'right' }}>SEED ADMIN ACTION</th>
                </tr>
              </thead>
              <tbody>
                {activeRentals.map(d => (
                  <tr key={d.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '14px 12px', fontWeight: 700 }}>{d.brand} {d.model}</td>
                    <td style={{ padding: '14px 12px', fontFamily: 'monospace' }}>{d.serial}</td>
                    <td style={{ padding: '14px 12px', fontFamily: 'monospace', fontSize: '12px', color: 'var(--primary)' }}>
                      {d.rented_by_user_id || 'Assigned'}
                    </td>
                    <td style={{ padding: '14px 12px', fontWeight: 800 }}>${d.monthly_rental_price || 49}/mo</td>
                    <td style={{ padding: '14px 12px' }}>
                      <span className="badge badge-warning">ACTIVE RENTAL</span>
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
                        <button
                          onClick={() => handleCancelRental(d)}
                          className="btn btn-danger"
                          style={{ padding: '6px 10px', fontSize: '11px' }}
                          title="Unallocate device and remove from user dashboard completely"
                        >
                          Unallocate
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </main>
    </RentalsLayout>
  );
}
