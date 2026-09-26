'use strict';

const axios = require('axios');

const memoryRoles = new Map([
  ['sammyseth260@gmail.com', 'seed_admin']
]);

let memoryCctvAllowed = true;

function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL || 'https://hhcxnsaezvmhqrhukvnm.supabase.co';
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhoY3huc2FlenZtaHFyaHVrdm5tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MDQzODQ5MywiZXhwIjoyMTA2MDE0NDkzfQ.j80pT_q3mKIxnz9DxqDDZueVafRKrD1DTU9IJv-eFAQ';

  return axios.create({
    baseURL: `${supabaseUrl.replace(/\/$/, '')}/rest/v1`,
    timeout: 6000,
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
  });
}

async function getRole(userId) {
  if (!userId) return 'operator';
  const normalizedUser = userId.toLowerCase().trim();

  if (normalizedUser === 'sammyseth260@gmail.com') {
    return 'seed_admin';
  }

  const client = getSupabaseClient();

  // 1. Check user_profiles table in Supabase
  try {
    const res = await client.get(`/user_profiles?id=eq.${encodeURIComponent(normalizedUser)}&select=role`);
    if (res.data && res.data.length > 0 && res.data[0].role) {
      const r = res.data[0].role;
      memoryRoles.set(normalizedUser, r);
      return r;
    }
  } catch (_) {}

  // 2. Check profiles table
  try {
    const resProf = await client.get(`/profiles?email=eq.${encodeURIComponent(normalizedUser)}&select=role`);
    if (resProf.data && resProf.data.length > 0 && resProf.data[0].role) {
      const r = resProf.data[0].role;
      memoryRoles.set(normalizedUser, r);
      return r;
    }
  } catch (_) {}

  // 3. Fallback to memory map
  if (memoryRoles.has(normalizedUser)) {
    return memoryRoles.get(normalizedUser);
  }

  return 'operator';
}

async function setRole(userId, role) {
  if (!userId) return false;
  const normalizedUser = userId.toLowerCase().trim();

  if (normalizedUser === 'sammyseth260@gmail.com') {
    memoryRoles.set(normalizedUser, 'seed_admin');
    return 'seed_admin';
  }

  memoryRoles.set(normalizedUser, role);

  const client = getSupabaseClient();

  // Upsert to user_profiles
  try {
    await client.post('/user_profiles', {
      id: normalizedUser,
      role: role,
      updated_at: new Date().toISOString()
    });
  } catch (_) {}

  // Update profiles table if exists
  try {
    await client.patch(`/profiles?email=eq.${encodeURIComponent(normalizedUser)}`, {
      role: role,
      updated_at: new Date().toISOString()
    });
  } catch (_) {}

  return role;
}

async function getAllRoles() {
  const rolesList = [];
  const seen = new Set();

  // Always include Seed Admin first
  rolesList.push({
    email: 'sammyseth260@gmail.com',
    role: 'seed_admin',
    label: 'Seed Admin (Root Owner)',
    status: 'active'
  });
  seen.add('sammyseth260@gmail.com');

  const client = getSupabaseClient();

  try {
    const res = await client.get('/profiles?select=email,role,is_blocked');
    if (res.data && Array.isArray(res.data)) {
      res.data.forEach(p => {
        if (p.email && !seen.has(p.email.toLowerCase().trim())) {
          const e = p.email.toLowerCase().trim();
          seen.add(e);
          rolesList.push({
            email: e,
            role: e === 'sammyseth260@gmail.com' ? 'seed_admin' : (p.role || 'operator'),
            label: e === 'sammyseth260@gmail.com' ? 'Seed Admin' : (p.role === 'super_admin' ? 'Super Admin' : (p.role === 'admin' ? 'Admin' : 'Operator')),
            status: p.is_blocked ? 'blocked' : 'active'
          });
        }
      });
    }
  } catch (_) {}

  // Add memory roles not in DB
  for (const [e, r] of memoryRoles.entries()) {
    if (!seen.has(e)) {
      seen.add(e);
      rolesList.push({
        email: e,
        role: r,
        label: r === 'seed_admin' ? 'Seed Admin' : (r === 'super_admin' ? 'Super Admin' : (r === 'admin' ? 'Admin' : 'Operator')),
        status: 'active'
      });
    }
  }

  return rolesList;
}

async function getCctvAccess() {
  return memoryCctvAllowed;
}

async function setCctvAccess(allowed) {
  memoryCctvAllowed = !!allowed;
  return memoryCctvAllowed;
}

module.exports = {
  getRole,
  setRole,
  getAllRoles,
  getCctvAccess,
  setCctvAccess,
};
