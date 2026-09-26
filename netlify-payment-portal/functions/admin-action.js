'use strict';

const axios = require('axios');
const walletStore = require('./wallet-store');

const SEED_ADMIN_EMAIL = 'sammyseth260@gmail.com';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { adminEmail, action, targetEmail, targetRole, serialNumber } = body;

    const callerEmail = (adminEmail || '').toLowerCase().trim();
    const callerRole = await walletStore.getRole(callerEmail);

    const isSeedAdmin = callerEmail === SEED_ADMIN_EMAIL || callerRole === 'seed_admin';
    const isSuperAdmin = isSeedAdmin || callerRole === 'super_admin';
    const isAdmin = isSuperAdmin || callerRole === 'admin';

    if (!isAdmin) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'error', message: 'Access Denied: Administrative privileges required.' }),
      };
    }

    const supabaseUrl = process.env.SUPABASE_URL || 'https://hhcxnsaezvmhqrhukvnm.supabase.co';
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhoY3huc2FlenZtaHFyaHVrdm5tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MDQzODQ5MywiZXhwIjoyMTA2MDE0NDkzfQ.j80pT_q3mKIxnz9DxqDDZueVafRKrD1DTU9IJv-eFAQ';

    const client = axios.create({
      baseURL: `${supabaseUrl.replace(/\/$/, '')}/rest/v1`,
      timeout: 6000,
      headers: {
        apikey: supabaseServiceRoleKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
    });

    // 1. Get All System Roles (Users & Admins)
    if (action === 'get_roles') {
      const roles = await walletStore.getAllRoles();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'ok',
          callerRole: isSeedAdmin ? 'seed_admin' : callerRole,
          roles,
        }),
      };
    }

    // 2. Assign / Promote User Role (Seed Admin can add Super Admin, Admin; Super Admin can add Admin)
    if (action === 'assign_role') {
      if (!isSuperAdmin) {
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'error', message: 'Only Seed Admin or Super Admin can assign administrative roles.' }),
        };
      }

      const target = (targetEmail || '').toLowerCase().trim();
      if (!target) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'error', message: 'Valid target email is required.' }),
        };
      }

      if (target === SEED_ADMIN_EMAIL) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'error', message: 'Seed Admin root role cannot be altered.' }),
        };
      }

      const validRoles = ['super_admin', 'admin', 'operator'];
      const assignedRole = validRoles.includes(targetRole) ? targetRole : 'operator';

      await walletStore.setRole(target, assignedRole);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'ok',
          message: `User ${target} has been successfully assigned role: ${assignedRole.toUpperCase().replace('_', ' ')}`,
          targetEmail: target,
          role: assignedRole,
        }),
      };
    }

    // 3. Get All Devices
    if (action === 'get_all_devices') {
      let devices = [];
      const seenSerials = new Set();

      try {
        const altRes = await client.get('/devices?select=*&order=updated_at.desc');
        if (altRes.data && Array.isArray(altRes.data)) {
          altRes.data.forEach(d => {
            const s = d.serial || d.serial_number;
            if (s && !seenSerials.has(s)) {
              seenSerials.add(s);
              devices.push({
                serial_number: s,
                device_model: d.model || d.device_model || 'Android Device',
                device_brand: d.brand || d.device_brand || 'Hardware Node',
                status: 'active',
                is_paid: true,
                binding_code: d.binding_code || 'AUTONOMOUS',
                stream_url: d.stream_url || `http://localhost:${d.local_port || 8100}`,
                local_port: d.local_port || 8100,
                updated_at: d.updated_at,
                stealth_root_enabled: d.stealth_root_enabled !== false,
              });
            }
          });
        }
      } catch (_) {}

      try {
        const rentRes = await client.get('/device_rentals?select=*&order=updated_at.desc');
        if (rentRes.data && Array.isArray(rentRes.data)) {
          rentRes.data.forEach(d => {
            const s = d.serial_number || d.serial;
            if (s && !seenSerials.has(s)) {
              seenSerials.add(s);
              devices.push({
                serial_number: s,
                device_model: d.device_model || 'Android Device',
                device_brand: d.device_brand || 'Hardware Node',
                status: 'active',
                is_paid: true,
                binding_code: d.binding_code || 'AUTONOMOUS',
                stream_url: d.stream_url || `http://localhost:${d.local_port || 8100}`,
                local_port: d.local_port || 8100,
                updated_at: d.updated_at,
                stealth_root_enabled: d.stealth_root_enabled !== false,
              });
            }
          });
        }
      } catch (_) {}

      const cctvAllowed = await walletStore.getCctvAccess();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ok', devices, cctvAllowed }),
      };
    }

    // 4. Toggle Stealth Root on Device
    if (action === 'toggle_stealth_root' || action === 'enable_stealth_root' || action === 'disable_stealth_root') {
      let targetState = true;
      if (action === 'disable_stealth_root') targetState = false;
      else if (action === 'enable_stealth_root') targetState = true;

      try {
        await client.patch(
          `/devices?serial=eq.${encodeURIComponent(serialNumber)}`,
          { stealth_root_enabled: targetState, updated_at: new Date().toISOString() }
        );
      } catch (_) {}

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'ok',
          message: `Stealth Root for device ${serialNumber} set to ${targetState ? 'ENABLED (Root Masking Active)' : 'DISABLED (Standard Mode)'}.`,
          stealthRootEnabled: targetState,
        }),
      };
    }

    // 5. Toggle CCTV Wall Access
    if (action === 'toggle_cctv_access') {
      const current = await walletStore.getCctvAccess();
      const updated = await walletStore.setCctvAccess(!current);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'ok',
          message: `Live CCTV Wall access is now ${updated ? 'ALLOWED' : 'LOCKED'}.`,
          cctvAllowed: updated,
        }),
      };
    }

    // 6. Rotate Stream Link
    if (action === 'rotate_stream_link') {
      const randomKey = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
      const randomPin = Math.floor(100000 + Math.random() * 900000).toString();
      const newStreamUrl = `http://localhost:8100/?udid=${encodeURIComponent(serialNumber)}&key=${randomKey}&pin=${randomPin}`;

      try {
        await client.patch(
          `/devices?serial=eq.${encodeURIComponent(serialNumber)}`,
          { stream_url: newStreamUrl, updated_at: new Date().toISOString() }
        );
      } catch (_) {}

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'ok',
          message: `Stream credentials rotated for ${serialNumber}.`,
          newStreamUrl,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ok', message: 'Action completed.' }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'error', message: err.message || 'Server error' }),
    };
  }
};
