-- ══════════════════════════════════════════════════════════════════════════════
-- UNIFIED SUPABASE SETUP & MIGRATION SCRIPT
-- Execute this entire script in Supabase Dashboard -> SQL Editor -> Click 'Run'
-- ══════════════════════════════════════════════════════════════════════════════

-- 1. Enable Required Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Create PROFILES Table
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'worker' CHECK (role IN ('seed_admin', 'super_admin', 'admin', 'worker')),
    super_admin_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    is_blocked BOOLEAN DEFAULT FALSE,
    blocked_reason TEXT DEFAULT NULL,
    blocked_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Create MACHINE BINDINGS Table
CREATE TABLE IF NOT EXISTS public.machine_bindings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    binding_code TEXT UNIQUE NOT NULL,
    machine_name TEXT DEFAULT 'Windows Agent Machine',
    mac_address TEXT DEFAULT NULL,
    local_ip TEXT DEFAULT NULL,
    broadcast_ip TEXT DEFAULT '255.255.255.255',
    status TEXT DEFAULT 'online',
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    super_admin_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    is_licensed BOOLEAN DEFAULT TRUE,
    license_mode TEXT DEFAULT 'licensed' CHECK (license_mode IN ('licensed', 'free')),
    license_note TEXT DEFAULT 'Active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Create DEVICES Table
CREATE TABLE IF NOT EXISTS public.devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    serial TEXT UNIQUE NOT NULL,
    model TEXT DEFAULT 'Android Device',
    brand TEXT DEFAULT 'Generic',
    stream_url TEXT,
    local_url TEXT,
    port INT,
    binding_code TEXT REFERENCES public.machine_bindings(binding_code) ON DELETE CASCADE,
    status TEXT DEFAULT 'online',
    is_deleted_from_view BOOLEAN DEFAULT FALSE,
    is_available_for_rental BOOLEAN DEFAULT FALSE,
    monthly_rental_price NUMERIC(10,2) DEFAULT 49.00,
    rented_by_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    rental_status TEXT DEFAULT 'available',
    rented_at TIMESTAMP WITH TIME ZONE,
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Create DEVICE RENTALS Table
CREATE TABLE IF NOT EXISTS public.device_rentals (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    serial_number TEXT UNIQUE NOT NULL,
    user_id TEXT,
    device_model TEXT,
    device_brand TEXT,
    monthly_fee NUMERIC DEFAULT 30.00,
    currency TEXT DEFAULT 'USD',
    status TEXT DEFAULT 'unpaid',
    binding_code TEXT,
    stream_url TEXT,
    stealth_root_enabled BOOLEAN DEFAULT TRUE,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Create DEVICE ASSIGNMENTS Table
CREATE TABLE IF NOT EXISTS public.device_assignments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    assigned_to_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    assigned_by_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    access_password TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(device_id, assigned_to_user_id)
);

-- 7. Create SYSTEM SETTINGS Table
CREATE TABLE IF NOT EXISTS public.system_settings (
    key TEXT PRIMARY KEY,
    value JSONB,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. Functions & Triggers
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role)
  VALUES (
    NEW.id,
    NEW.email,
    CASE 
      WHEN LOWER(NEW.email) = 'sammyseth260@gmail.com' THEN 'seed_admin'
      ELSE 'worker'
    END
  )
  ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.handle_user_blocked()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_blocked = TRUE AND (OLD.is_blocked IS DISTINCT FROM TRUE) THEN
    DELETE FROM public.device_assignments
    WHERE assigned_to_user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_user_blocked ON public.profiles;
CREATE TRIGGER on_user_blocked
  AFTER UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_user_blocked();

-- 9. Row Level Security & Policies
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.machine_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_rentals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read profiles" ON public.profiles;
CREATE POLICY "Allow public read profiles" ON public.profiles FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow authenticated update profiles" ON public.profiles;
CREATE POLICY "Allow authenticated update profiles" ON public.profiles FOR ALL USING (true);

DROP POLICY IF EXISTS "Allow public read machine_bindings" ON public.machine_bindings;
CREATE POLICY "Allow public read machine_bindings" ON public.machine_bindings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow all write machine_bindings" ON public.machine_bindings;
CREATE POLICY "Allow all write machine_bindings" ON public.machine_bindings FOR ALL USING (true);

DROP POLICY IF EXISTS "Allow public read devices" ON public.devices;
CREATE POLICY "Allow public read devices" ON public.devices FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow all write devices" ON public.devices;
CREATE POLICY "Allow all write devices" ON public.devices FOR ALL USING (true);

DROP POLICY IF EXISTS "Allow public read device_assignments" ON public.device_assignments;
CREATE POLICY "Allow public read device_assignments" ON public.device_assignments FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow all write device_assignments" ON public.device_assignments;
CREATE POLICY "Allow all write device_assignments" ON public.device_assignments FOR ALL USING (true);

DROP POLICY IF EXISTS "Allow public read device_rentals" ON public.device_rentals;
CREATE POLICY "Allow public read device_rentals" ON public.device_rentals FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow all write device_rentals" ON public.device_rentals;
CREATE POLICY "Allow all write device_rentals" ON public.device_rentals FOR ALL USING (true);

DROP POLICY IF EXISTS "Allow public read system_settings" ON public.system_settings;
CREATE POLICY "Allow public read system_settings" ON public.system_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow all write system_settings" ON public.system_settings;
CREATE POLICY "Allow all write system_settings" ON public.system_settings FOR ALL USING (true);

-- 10. Realtime Replication & Publication
ALTER TABLE public.devices REPLICA IDENTITY FULL;
ALTER TABLE public.machine_bindings REPLICA IDENTITY FULL;
ALTER TABLE public.device_assignments REPLICA IDENTITY FULL;
ALTER TABLE public.profiles REPLICA IDENTITY FULL;
ALTER TABLE public.device_rentals REPLICA IDENTITY FULL;
ALTER TABLE public.system_settings REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'devices') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.devices;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'machine_bindings') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.machine_bindings;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'device_assignments') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.device_assignments;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'profiles') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'device_rentals') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.device_rentals;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'system_settings') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.system_settings;
  END IF;
END $$;

-- 11. Temporarily Disable Trigger to Import Auth Users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- 12. Import Auth Users (Preserving original passwords and UUIDs)
INSERT INTO auth.users (
  id, instance_id, email, encrypted_password, email_confirmed_at, 
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data, aud, role
) VALUES
  ('337707f5-9573-47da-a613-1eb80a6f62f0', '00000000-0000-0000-0000-000000000000', 'nickkipkoech5@gmail.com', '$2a$10$rUzT6Z8pnzCw6dLivCCPmuv8IyxCNYR/4pt9qIjNdMbkvqJzBK2Ka', '2026-08-07T16:49:52.100589+00:00', '2026-08-07T16:49:52.042285+00:00', '2026-08-08T11:33:26.901393+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "nickkipkoech5@gmail.com", "sub": "337707f5-9573-47da-a613-1eb80a6f62f0", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('019443f6-50cf-4560-824f-27cd93a4e30b', '00000000-0000-0000-0000-000000000000', 'mosesalex9902@gmail.com', '$2a$10$wZpLNr./HULbCHYpQq1SYeHiwu97z4K1Xe0y7X/5/w9Gz9RYoVNZ2', '2026-07-31T21:29:51.855266+00:00', '2026-07-31T21:29:51.825244+00:00', '2026-08-08T11:35:26.392522+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "mosesalex9902@gmail.com", "sub": "019443f6-50cf-4560-824f-27cd93a4e30b", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('a3b92bff-63f3-4d2f-8d20-556438e210d3', '00000000-0000-0000-0000-000000000000', 'kipkorirmutai27@gmail.com', '$2a$10$affISRIzu44HiU3kyj66y.TntHLOtu3kjIMR8hxKb5FmFFJd4I6ku', '2026-07-31T11:42:29.510299+00:00', '2026-07-31T11:42:29.464364+00:00', '2026-08-21T18:45:46.503857+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "kipkorirmutai27@gmail.com", "sub": "a3b92bff-63f3-4d2f-8d20-556438e210d3", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('9818bf20-c42d-4b84-9885-64277ba5eb62', '00000000-0000-0000-0000-000000000000', 'kiproprono03@gmail.com', '$2a$10$rHhCG5ybD5CuYn/vgJR4veT5A5p3s5RxuD1Sr9otv.gTOHoAp1x1K', '2026-07-31T21:41:04.318559+00:00', '2026-07-31T21:41:04.313823+00:00', '2026-08-16T20:06:36.415115+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "kiproprono03@gmail.com", "sub": "9818bf20-c42d-4b84-9885-64277ba5eb62", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('dfddbc44-d861-4d34-8fed-5ac5071ebcd9', '00000000-0000-0000-0000-000000000000', 'bettnicki647@gmail.com', '$2a$10$VKxcMBiPyIpJ4rzopR0ehurR1iDHRD23X8FSGJIvWCwaO51AZunM6', '2026-08-07T07:50:11.140609+00:00', '2026-08-07T07:50:11.094726+00:00', '2026-08-22T01:09:57.094992+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "bettnicki647@gmail.com", "sub": "dfddbc44-d861-4d34-8fed-5ac5071ebcd9", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('707001e5-25b8-4d6f-b9a3-9fc501ec52e5', '00000000-0000-0000-0000-000000000000', 'leonardtarus71@gmail.com', '$2a$10$p3VdWihwMbhiYED5ZY3.LeCzpW74B.4D9ErbhinvmkeWEwfUmmduK', '2026-07-31T10:40:33.020732+00:00', '2026-07-31T10:40:33.008972+00:00', '2026-08-22T04:23:03.941907+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "leonardtarus71@gmail.com", "sub": "707001e5-25b8-4d6f-b9a3-9fc501ec52e5", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('853b0d9c-6b74-4699-b606-05abd8ac3df9', '00000000-0000-0000-0000-000000000000', 'mat@gmail.com', '$2a$10$dUXEjKYAOdGsAhn.myqMUOd3Q6bQx.MNbiBQiqnDIAggwOuk5/Wk.', '2026-08-09T20:58:24.317634+00:00', '2026-08-09T20:58:24.290557+00:00', '2026-08-19T07:43:52.025898+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "mat@gmail.com", "sub": "853b0d9c-6b74-4699-b606-05abd8ac3df9", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('0b3879b9-c823-434c-9c8f-12d2ff7f8f91', '00000000-0000-0000-0000-000000000000', 'collinsbet50@gmail.com', '$2a$10$2ZEKHoLk.flBruszKSITAelQjYy5AiIhh03V2KMEWtpsRrkOb6Z3q', '2026-07-31T10:42:49.161537+00:00', '2026-07-31T10:42:49.147324+00:00', '2026-08-22T07:26:33.717417+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "collinsbet50@gmail.com", "sub": "0b3879b9-c823-434c-9c8f-12d2ff7f8f91", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('308236a0-a5e6-4c70-80f0-c5b60aba57ec', '00000000-0000-0000-0000-000000000000', 'warslaysamm@gmail.com', '$2a$10$8UebwrOlyBELn55JfIORMu5VrRh5fHjEHmDsLXwokxn7/juyBW3vS', '2026-07-31T22:53:49.123386+00:00', '2026-07-31T22:53:49.097294+00:00', '2026-08-10T20:48:50.156035+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "warslaysamm@gmail.com", "sub": "308236a0-a5e6-4c70-80f0-c5b60aba57ec", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('9c0ff971-83df-4540-af4b-92e9ed79240d', '00000000-0000-0000-0000-000000000000', 'nicholusmwariri40@gmail.com', '$2a$10$l6h0.JWj8n.b.z6Z8e8KL.F1mAqXlBd/EVP3K4H179Co2qN5U9DPW', '2026-08-07T18:02:03.604422+00:00', '2026-08-07T18:02:03.586371+00:00', '2026-08-10T19:20:54.264231+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "nicholusmwariri40@gmail.com", "sub": "9c0ff971-83df-4540-af4b-92e9ed79240d", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('578da9f3-9fed-4f48-9f1a-8ea586ad62b5', '00000000-0000-0000-0000-000000000000', 'collins20collo@gmail.com', '$2a$10$OsXp11LW80I1uxfckxjG.eoUT4ZGK/qpRwk6XwFrT8XRNUehXS61a', '2026-08-17T11:32:22.346476+00:00', '2026-08-17T11:32:22.319187+00:00', '2026-08-19T09:03:19.524839+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "collins20collo@gmail.com", "sub": "578da9f3-9fed-4f48-9f1a-8ea586ad62b5", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('8578324b-1e59-4fec-8423-20546173cb86', '00000000-0000-0000-0000-000000000000', 'kibetngeno428@gmail.com', '$2a$10$XvtephRUhpdFh9TyXHcgEuJ8SzdRf/o7kEur/wWjo11fDdx1QL5la', '2026-07-31T21:40:58.761601+00:00', '2026-07-31T21:40:58.744408+00:00', '2026-08-22T05:11:38.367696+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "kibetngeno428@gmail.com", "sub": "8578324b-1e59-4fec-8423-20546173cb86", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('95daa7dc-c17a-4caf-bf39-1fc03ed117be', '00000000-0000-0000-0000-000000000000', 'kiptoolenny36@gmail.com', '$2a$10$ldN0E3.MJAIOp3nHe5T0qOxqybOBpQAmAfG8p5X0MMKlWVf24YRCi', '2026-08-07T17:42:46.511773+00:00', '2026-08-07T17:42:46.485203+00:00', '2026-08-22T07:27:42.380016+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "kiptoolenny36@gmail.com", "sub": "95daa7dc-c17a-4caf-bf39-1fc03ed117be", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('76eeb120-1ea5-44a5-b924-0f5968ad5ae6', '00000000-0000-0000-0000-000000000000', 'sammyseth260@gmail.com', '$2a$10$R8Ja2HH2xNgIP0JKf03AvurGuS2w/ynGyCwnrKXxiP.gucV57p2y.', '2026-07-31T10:35:30.495439+00:00', '2026-07-31T10:34:56.000497+00:00', '2026-08-22T07:39:49.029338+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "sammyseth260@gmail.com", "sub": "76eeb120-1ea5-44a5-b924-0f5968ad5ae6", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('cdfa9620-b1fa-4693-908f-fa17409f467c', '00000000-0000-0000-0000-000000000000', 'jacobreed6232@gmail.com', '$2a$10$C6nPCPUz6.sjpjjWGjqiIeX6.IqGlUl7qNRjxC72jTTaJFnmQX6MK', '2026-08-13T22:53:25.084028+00:00', '2026-08-13T22:53:25.03609+00:00', '2026-08-22T07:42:54.68458+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "jacobreed6232@gmail.com", "sub": "cdfa9620-b1fa-4693-908f-fa17409f467c", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('42033b6d-38ef-4354-9253-968abcefe026', '00000000-0000-0000-0000-000000000000', 'vintarus1@gmail.com', '$2a$10$ccwXmxgh5AEuvtHTTbNWTuol9MovWByqS5G2Yy72PuUn0v9GElbRm', '2026-08-12T10:00:45.210707+00:00', '2026-08-12T10:00:45.162163+00:00', '2026-08-14T19:51:06.804816+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "vintarus1@gmail.com", "sub": "42033b6d-38ef-4354-9253-968abcefe026", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('69b9955c-0df6-46af-9b4b-8a909afcf4dc', '00000000-0000-0000-0000-000000000000', 'kenn19599@gmail.com', '$2a$10$ghXACGbCX0zO5Aahh5wCqOt0xyZdPNFjloOYpb6vfh9EUsQbt4PWK', '2026-08-19T07:46:42.824682+00:00', '2026-08-19T07:46:42.796856+00:00', '2026-08-19T16:12:02.210708+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "kenn19599@gmail.com", "sub": "69b9955c-0df6-46af-9b4b-8a909afcf4dc", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('b0c2be32-df91-47a4-8898-90ab2f6df85b', '00000000-0000-0000-0000-000000000000', 'justicekipkemoi2006@gmail.com', '$2a$10$dmCUfzc.ZvuZ61/PHpGd5.xmecpKQW/7ThQEP8caMxJgZfnzcpxo.', '2026-08-11T06:14:20.303585+00:00', '2026-08-11T06:14:20.261511+00:00', '2026-08-21T18:09:52.549922+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "justicekipkemoi2006@gmail.com", "sub": "b0c2be32-df91-47a4-8898-90ab2f6df85b", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('8b2d784f-a221-49b4-a4c5-30ca3608e104', '00000000-0000-0000-0000-000000000000', 'isabellajenkins348@gmail.com', '$2a$10$Vs.wxftTQGrWPGWdCJB77OoWf7P1/rFAgslZN3gxIkzR32/u6bfdm', '2026-08-17T13:37:18.488085+00:00', '2026-08-17T13:37:18.438993+00:00', '2026-08-17T14:53:56.359591+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "isabellajenkins348@gmail.com", "sub": "8b2d784f-a221-49b4-a4c5-30ca3608e104", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('7c65fb78-552c-4479-b290-dbd08bb0fb81', '00000000-0000-0000-0000-000000000000', 'matatasam.ai@gmail.com', '$2a$10$YuGswnEaFfPkiO787XoQXej2bq7f5EoZy5cRRBPqUwaE5VtLuMmoi', '2026-08-17T13:52:51.978055+00:00', '2026-08-17T13:52:51.948203+00:00', '2026-08-19T10:40:18.999494+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "matatasam.ai@gmail.com", "sub": "7c65fb78-552c-4479-b290-dbd08bb0fb81", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('1c19d8b0-6127-4230-a07c-67786ad4ca76', '00000000-0000-0000-0000-000000000000', 'kipngetichkenneth184@gmail.com', '$2a$10$RDn2OQnD0vW9MHABQCc3v.5j8egMgiT/Sk5arMV6IpDR5CAdnpCmm', '2026-08-15T19:35:19.954121+00:00', '2026-08-15T19:35:19.894311+00:00', '2026-08-17T16:39:20.502382+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "kipngetichkenneth184@gmail.com", "sub": "1c19d8b0-6127-4230-a07c-67786ad4ca76", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('c7ba5c95-79ad-403f-a6e2-8bb1f6066b76', '00000000-0000-0000-0000-000000000000', 'vintarus4@gmail.com', '$2a$10$y4yd0hY00noM82gGGyRRhus2iQocuvHH3PKSQG.sn2AFl6A89tXvu', '2026-08-13T23:05:47.564566+00:00', '2026-08-13T23:05:47.55573+00:00', '2026-08-21T21:51:53.590944+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "vintarus4@gmail.com", "sub": "c7ba5c95-79ad-403f-a6e2-8bb1f6066b76", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('43ff12a8-2d31-409b-9fff-3edb2f7a7af9', '00000000-0000-0000-0000-000000000000', 'tkoech779@gmail.com', '$2a$10$7gFMv9dTqlOIrhCNMeGGxuhMs3gskvR4ggBFI0fCzHpviSRKcalQ6', '2026-08-17T21:37:11.852873+00:00', '2026-08-17T21:37:11.804133+00:00', '2026-08-22T07:45:13.706586+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "tkoech779@gmail.com", "sub": "43ff12a8-2d31-409b-9fff-3edb2f7a7af9", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('33fa0532-4007-4e94-a7ca-4ebfad585bf5', '00000000-0000-0000-0000-000000000000', 'timookorir@gmail.com', '$2a$10$8OSY.wmRN/IMs6wLCafo/O8PMNyujkOUk9IleqZNlKwp7op7urFdq', '2026-08-13T23:08:27.840305+00:00', '2026-08-13T23:08:27.828985+00:00', '2026-08-18T10:19:04.604879+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "timookorir@gmail.com", "sub": "33fa0532-4007-4e94-a7ca-4ebfad585bf5", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated'),
  ('59427519-8043-4425-9e0b-019db51b1b2c', '00000000-0000-0000-0000-000000000000', 'cnahashon51@gmail.com', '$2a$10$LSIh3EmNSqoJ0W2D.YBjaOsKvGEc7NPaENT8FDv0eEzpbRgvOHfX6', '2026-08-13T23:04:00.567935+00:00', '2026-08-13T23:04:00.488645+00:00', '2026-08-22T07:16:31.299723+00:00', '{"provider": "email", "providers": ["email"]}'::jsonb, '{"email": "cnahashon51@gmail.com", "sub": "59427519-8043-4425-9e0b-019db51b1b2c", "email_verified": true, "phone_verified": false}'::jsonb, 'authenticated', 'authenticated')
ON CONFLICT (id) DO NOTHING;

-- Fix NULL token columns for all users so GoTrue's internal database scanner does not fail
UPDATE auth.users SET 
  confirmation_token = COALESCE(confirmation_token, ''),
  recovery_token = COALESCE(recovery_token, ''),
  email_change_token_new = COALESCE(email_change_token_new, ''),
  email_change = COALESCE(email_change, ''),
  email_change_token_current = COALESCE(email_change_token_current, ''),
  phone = COALESCE(phone, ''),
  phone_change = COALESCE(phone_change, ''),
  phone_change_token = COALESCE(phone_change_token, ''),
  reauthentication_token = COALESCE(reauthentication_token, '');

-- 13. Ensure auth.identities exists for all users so email login functions seamlessly
INSERT INTO auth.identities (
  id,
  user_id,
  identity_data,
  provider,
  provider_id,
  last_sign_in_at,
  created_at,
  updated_at
)
SELECT 
  gen_random_uuid(),
  u.id,
  json_build_object('sub', u.id::text, 'email', u.email)::jsonb,
  'email',
  u.id::text,
  u.created_at,
  u.created_at,
  u.updated_at
FROM auth.users u
ON CONFLICT DO NOTHING;

UPDATE auth.identities SET
  identity_data = json_build_object('sub', user_id::text, 'email', (SELECT email FROM auth.users WHERE auth.users.id = auth.identities.user_id))::jsonb
WHERE identity_data IS NULL OR identity_data = '{}'::jsonb;

-- 14. Re-enable New User Trigger
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 15. Import Profiles (sammyseth260@gmail.com is Seed Admin)
INSERT INTO public.profiles (id, email, role, super_admin_id, is_blocked, blocked_reason, blocked_by, created_at, updated_at) VALUES
  ('76eeb120-1ea5-44a5-b924-0f5968ad5ae6', 'sammyseth260@gmail.com', 'seed_admin', NULL, false, NULL, NULL, '2026-07-31T10:34:55.995497+00:00', '2026-07-31T10:34:55.995497+00:00'),
  ('707001e5-25b8-4d6f-b9a3-9fc501ec52e5', 'leonardtarus71@gmail.com', 'super_admin', NULL, false, NULL, NULL, '2026-07-31T10:40:33.008653+00:00', '2026-07-31T10:51:50.232+00:00'),
  ('0b3879b9-c823-434c-9c8f-12d2ff7f8f91', 'collinsbet50@gmail.com', 'super_admin', NULL, false, NULL, NULL, '2026-07-31T10:42:49.147009+00:00', '2026-07-31T11:48:14.337+00:00'),
  ('8578324b-1e59-4fec-8423-20546173cb86', 'kibetngeno428@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-07-31T21:40:58.744074+00:00', '2026-07-31T21:40:58.744074+00:00'),
  ('95daa7dc-c17a-4caf-bf39-1fc03ed117be', 'kiptoolenny36@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-08-07T17:42:46.484882+00:00', '2026-08-07T17:42:46.484882+00:00'),
  ('019443f6-50cf-4560-824f-27cd93a4e30b', 'mosesalex9902@gmail.com', 'worker', NULL, true, 'Suspended by Admin', '707001e5-25b8-4d6f-b9a3-9fc501ec52e5', '2026-07-31T21:29:51.824347+00:00', '2026-08-08T07:37:25.973+00:00'),
  ('9818bf20-c42d-4b84-9885-64277ba5eb62', 'kiproprono03@gmail.com', 'worker', NULL, true, 'Suspended by Admin', '707001e5-25b8-4d6f-b9a3-9fc501ec52e5', '2026-07-31T21:41:04.31352+00:00', '2026-08-08T07:37:59.14+00:00'),
  ('a3b92bff-63f3-4d2f-8d20-556438e210d3', 'kipkorirmutai27@gmail.com', 'super_admin', NULL, false, NULL, NULL, '2026-07-31T11:42:29.462619+00:00', '2026-08-09T19:17:28.234+00:00'),
  ('9c0ff971-83df-4540-af4b-92e9ed79240d', 'nicholusmwariri40@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-08-07T18:02:03.586056+00:00', '2026-08-09T19:56:42.129+00:00'),
  ('308236a0-a5e6-4c70-80f0-c5b60aba57ec', 'warslaysamm@gmail.com', 'super_admin', NULL, false, NULL, NULL, '2026-07-31T22:53:49.096475+00:00', '2026-08-09T20:12:58.808+00:00'),
  ('dfddbc44-d861-4d34-8fed-5ac5071ebcd9', 'bettnicki647@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-08-07T07:50:11.092+00:00', '2026-08-10T09:47:19.791+00:00'),
  ('337707f5-9573-47da-a613-1eb80a6f62f0', 'nickkipkoech5@gmail.com', 'worker', NULL, true, 'Suspended by Admin', '0b3879b9-c823-434c-9c8f-12d2ff7f8f91', '2026-08-07T16:49:52.040505+00:00', '2026-08-10T09:47:33.68+00:00'),
  ('853b0d9c-6b74-4699-b606-05abd8ac3df9', 'mat@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-08-09T20:58:24.285916+00:00', '2026-08-10T22:43:48.844+00:00'),
  ('b0c2be32-df91-47a4-8898-90ab2f6df85b', 'justicekipkemoi2006@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-08-11T06:14:20.259787+00:00', '2026-08-11T06:14:20.259787+00:00'),
  ('42033b6d-38ef-4354-9253-968abcefe026', 'vintarus1@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-08-12T10:00:45.155157+00:00', '2026-08-12T10:11:12.444+00:00'),
  ('cdfa9620-b1fa-4693-908f-fa17409f467c', 'jacobreed6232@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-08-13T22:53:25.023597+00:00', '2026-08-13T22:53:25.023597+00:00'),
  ('59427519-8043-4425-9e0b-019db51b1b2c', 'cnahashon51@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-08-13T23:04:00.484715+00:00', '2026-08-13T23:04:00.484715+00:00'),
  ('c7ba5c95-79ad-403f-a6e2-8bb1f6066b76', 'vintarus4@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-08-13T23:05:47.554639+00:00', '2026-08-13T23:05:47.554639+00:00'),
  ('1c19d8b0-6127-4230-a07c-67786ad4ca76', 'kipngetichkenneth184@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-08-15T19:35:19.890711+00:00', '2026-08-15T19:35:19.890711+00:00'),
  ('578da9f3-9fed-4f48-9f1a-8ea586ad62b5', 'collins20collo@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-08-17T11:32:22.318269+00:00', '2026-08-17T11:32:22.318269+00:00'),
  ('8b2d784f-a221-49b4-a4c5-30ca3608e104', 'isabellajenkins348@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-08-17T13:37:18.436841+00:00', '2026-08-17T13:37:18.436841+00:00'),
  ('7c65fb78-552c-4479-b290-dbd08bb0fb81', 'matatasam.ai@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-08-17T13:52:51.947187+00:00', '2026-08-17T13:52:51.947187+00:00'),
  ('69b9955c-0df6-46af-9b4b-8a909afcf4dc', 'kenn19599@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-08-19T07:46:42.796576+00:00', '2026-08-19T07:46:42.796576+00:00'),
  ('33fa0532-4007-4e94-a7ca-4ebfad585bf5', 'timookorir@gmail.com', 'worker', NULL, true, 'suspended', '0b3879b9-c823-434c-9c8f-12d2ff7f8f91', '2026-08-13T23:08:27.828665+00:00', '2026-08-19T07:47:24.175+00:00'),
  ('43ff12a8-2d31-409b-9fff-3edb2f7a7af9', 'tkoech779@gmail.com', 'worker', NULL, false, NULL, NULL, '2026-08-17T21:37:11.801689+00:00', '2026-08-19T08:04:59.826+00:00')
ON CONFLICT (id) DO UPDATE SET 
  role = EXCLUDED.role,
  is_blocked = EXCLUDED.is_blocked,
  blocked_reason = EXCLUDED.blocked_reason,
  blocked_by = EXCLUDED.blocked_by,
  super_admin_id = EXCLUDED.super_admin_id;

-- 16. Import Machine Bindings (including this independent machine: 20741881)
INSERT INTO public.machine_bindings (id, binding_code, machine_name, super_admin_id, is_licensed, license_mode, license_note, created_at, updated_at) VALUES
  (uuid_generate_v4(), '20741881', 'DIAMT-Node', '76eeb120-1ea5-44a5-b924-0f5968ad5ae6', true, 'licensed', 'Active Node', NOW(), NOW()),
  ('8124ed0c-544f-4037-a797-63f881cc17c9', '19182109', 'DESKTOP-HBV8NFP', NULL, true, 'licensed', 'Active', '2026-07-31T16:52:44.02654+00:00', '2026-07-31T18:39:07.666+00:00'),
  ('c358ab7d-0660-4542-8b80-7f3ce345207f', '11014040', 'DENNIS', NULL, true, 'licensed', 'Active', '2026-08-14T15:59:43.048604+00:00', '2026-08-22T07:03:53.65+00:00'),
  ('ce071a22-dac4-4cae-af0a-706261930be8', '63460176', 'DENNIS', NULL, true, 'licensed', 'Active', '2026-08-06T07:08:51.931973+00:00', '2026-08-14T05:53:17.873+00:00'),
  ('093830c7-1c1f-4ce8-95a1-b00ba712571d', '94879348', 'VERTEXT', '76eeb120-1ea5-44a5-b924-0f5968ad5ae6', true, 'licensed', 'Active', '2026-08-02T16:19:40.866802+00:00', '2026-08-09T18:18:41.157+00:00'),
  ('3cc8cc64-86e2-46bf-a3a4-feae1c3261da', '71721632', 'LENOVO', NULL, true, 'licensed', 'Active', '2026-07-31T11:09:36.669305+00:00', '2026-08-07T16:36:52.795+00:00'),
  ('20736c6e-8662-4483-bd19-5f39f0bf24bc', '83416352', 'DESKTOP-HBV8NFP', NULL, true, 'licensed', 'Active', '2026-07-31T19:22:21.118019+00:00', '2026-07-31T19:26:41.474+00:00'),
  ('4a4ab325-db6a-4be6-ad90-d1db39e8a581', '96049531', 'DESKTOP-HBV8NFP', NULL, true, 'licensed', 'Active', '2026-07-31T14:18:31.000235+00:00', '2026-07-31T14:18:22.597+00:00'),
  ('f7ed56c1-f772-4e8d-9a59-18d16d0d0809', '50090096', 'DESKTOP-HBV8NFP', NULL, true, 'licensed', 'Active', '2026-07-31T19:27:05.540912+00:00', '2026-07-31T19:29:31.925+00:00'),
  ('e69c09ab-a36e-4bf6-9099-184924c1e6f9', '63478186', 'DESKTOP-HBV8NFP', NULL, true, 'licensed', 'Active', '2026-07-31T14:19:53.562351+00:00', '2026-07-31T14:19:45.033+00:00'),
  ('98412c34-cb58-4061-bd85-0e19361b338c', '18065189', 'DESKTOP-HBV8NFP', NULL, true, 'licensed', 'Active', '2026-07-31T14:48:42.198215+00:00', '2026-07-31T14:48:33.475+00:00'),
  ('39107207-f57d-4e54-ae90-c05c04a1b414', '44840380', 'DENNIS', NULL, true, 'licensed', 'Active', '2026-08-14T12:34:28.373884+00:00', '2026-08-14T12:35:45.837+00:00'),
  ('fc1c4cc2-5b77-48b2-9f5c-56083ff72fa9', '17132833', 'DESKTOP-HBV8NFP', NULL, true, 'licensed', 'Active', '2026-07-31T19:30:05.381977+00:00', '2026-07-31T19:31:01.588+00:00'),
  ('18fbd45b-6d2e-42b4-8cc9-9da9e89d9e85', '14412529', 'DENNIS', NULL, true, 'licensed', 'Active', '2026-08-10T20:49:10.740415+00:00', '2026-08-14T14:53:54.599+00:00'),
  ('4cfeea94-6bf6-411f-95e0-5a28330af79c', '25346984', 'LENOVO', NULL, true, 'licensed', 'Active', '2026-07-31T12:38:14.745225+00:00', '2026-07-31T19:35:39.478+00:00'),
  ('60182cb0-f8b0-4619-b07d-f54ae8752b38', '39658666', 'LENOVO', '76eeb120-1ea5-44a5-b924-0f5968ad5ae6', true, 'licensed', 'Active', '2026-07-31T10:37:25.150589+00:00', '2026-07-31T12:05:23.457+00:00'),
  ('7935f809-df5c-4124-8e47-7f9783a92ffb', '92467154', 'LENOVO', NULL, true, 'licensed', 'Active', '2026-07-31T10:57:14.269104+00:00', '2026-07-31T12:05:25.513+00:00'),
  ('6c7b5aab-8e6b-4557-a3c8-ccae90150dc8', '52127110', 'LENOVO', NULL, true, 'licensed', 'Active', '2026-07-31T10:53:46.180669+00:00', '2026-07-31T12:05:27.161+00:00'),
  ('a0330f34-dd43-422c-ae0a-e71d178779ba', '99498676', 'LENOVO', NULL, true, 'licensed', 'Active', '2026-07-31T10:55:59.825717+00:00', '2026-07-31T12:05:28.826+00:00'),
  ('9014bb7d-6510-4171-b233-3a66a975c13c', '82095018', 'LENOVO', NULL, true, 'licensed', 'Active', '2026-07-31T10:52:17.617271+00:00', '2026-07-31T12:05:30.705+00:00'),
  ('bf781bd1-5b32-45d4-a5d7-49167bd5e680', '10193272', 'DESKTOP-HBV8NFP', '76eeb120-1ea5-44a5-b924-0f5968ad5ae6', true, 'licensed', 'Active', '2026-07-31T13:56:06.577123+00:00', '2026-08-07T10:38:56.839+00:00')
ON CONFLICT (binding_code) DO NOTHING;

-- 17. Import Devices
INSERT INTO public.devices (
  id, serial, model, brand, stream_url, local_url, port, binding_code, status, 
  is_deleted_from_view, is_available_for_rental, monthly_rental_price, rented_by_user_id, 
  rental_status, rented_at, last_seen, created_at, updated_at
) VALUES
  ('b648d6e7-a82f-4bd3-8ca7-4396fd465e45', '1120308025024495', 'B170D', 'BLU', 'https://dennoh.site/?udid=1120308025024495&pin=11014040', NULL, 8100, '11014040', 'online', false, true, 80, NULL, 'available', NULL, '2026-08-22T08:14:58.192+00:00', '2026-08-07T06:56:57.715013+00:00', '2026-08-22T08:14:58.192+00:00'),
  ('6ae4df31-0c37-4146-adbd-6284c426e559', 'R92Y10PMLWD', 'SM-A055F', 'samsung', 'https://dennoh.site/?udid=R92Y10PMLWD', 'http://localhost:8102', 8102, '71721632', 'offline', true, false, 49, NULL, 'available', NULL, '2026-07-31T19:51:25.332+00:00', '2026-07-31T10:54:04.623364+00:00', '2026-08-09T20:14:54.896+00:00'),
  ('b3ab2731-c9f0-4137-a284-8d197a39c641', '7070016025067254', 'B1660V', 'BLU', 'https://dennoh.site/?udid=7070016025067254&pin=11014040', NULL, 8101, '11014040', 'online', false, true, 80, NULL, 'available', NULL, '2026-08-22T08:14:58.42+00:00', '2026-08-07T06:57:07.624982+00:00', '2026-08-22T08:14:58.42+00:00'),
  ('8f968d45-1178-4260-ab27-e641e7772c6b', 'M769UCQCDMZLPF8D', 'T513V', 'TCL', 'https://dennoh.site/?udid=M769UCQCDMZLPF8D&pin=11014040', NULL, 8102, '11014040', 'online', false, true, 80, NULL, 'available', NULL, '2026-08-22T08:14:58.627+00:00', '2026-08-09T19:03:42.710236+00:00', '2026-08-22T08:14:58.627+00:00'),
  ('5ef436c8-0da9-4c68-9c46-2d3cc673a9b5', 'NBIR5LAYORLRDU4T', 'T513V', 'TCL', 'https://dennoh.site/?udid=NBIR5LAYORLRDU4T&pin=11014040', NULL, 8103, '11014040', 'online', false, true, 80, NULL, 'available', NULL, '2026-08-22T08:14:58.842+00:00', '2026-08-09T18:56:27.83144+00:00', '2026-08-22T08:14:58.842+00:00'),
  ('a66be2f9-9e15-48db-a6a7-628361f42d13', 'OBOFP75LXGV4EIJN', 'T513V', 'TCL', 'https://dennoh.site/?udid=OBOFP75LXGV4EIJN&pin=11014040', NULL, 8104, '11014040', 'online', false, true, 80, NULL, 'available', NULL, '2026-08-22T08:14:59.056+00:00', '2026-08-07T06:57:17.685145+00:00', '2026-08-22T08:14:59.056+00:00'),
  ('7b03e1c9-3860-49ed-8bfd-fc863f9515c4', '102892535Q103674', 'TECNO CK8n', 'TECNO', 'https://dennoh.site/?udid=102892535Q103674&key=hyperflex1977ljc&pin=957807', 'http://localhost:8101', 8101, '71721632', 'offline', true, false, 49, NULL, 'available', NULL, '2026-07-31T23:19:41.849+00:00', '2026-07-31T10:57:23.22401+00:00', '2026-08-13T21:22:06.067+00:00'),
  ('56351d73-346f-48ac-b4ea-56d342b4b8ce', 'V8RGXC5D5LMJJRQW', 'T513V', 'TCL', 'https://dennoh.site/?udid=V8RGXC5D5LMJJRQW&pin=11014040', NULL, 8105, '11014040', 'online', false, true, 80, NULL, 'available', NULL, '2026-08-22T08:14:59.265+00:00', '2026-08-07T06:57:28.025827+00:00', '2026-08-22T08:14:59.266+00:00'),
  ('ac963c9d-2216-42be-a961-ee194f8a729c', 'W45989YDRW8LIFYT', 'T513V', 'TCL', 'https://dennoh.site/?udid=W45989YDRW8LIFYT&pin=11014040', NULL, 8106, '11014040', 'online', false, true, 80, NULL, 'available', NULL, '2026-08-22T08:14:59.471+00:00', '2026-08-09T18:59:03.414692+00:00', '2026-08-22T08:14:59.471+00:00'),
  ('5aa6eaab-fc22-4b78-b872-54545895b0d8', 'YTCY999TVKVCZDZX', 'T513V', 'TCL', 'https://dennoh.site/?udid=YTCY999TVKVCZDZX&pin=11014040', NULL, 8107, '11014040', 'online', false, true, 80, NULL, 'available', NULL, '2026-08-22T08:14:59.68+00:00', '2026-08-06T07:21:38.241853+00:00', '2026-08-22T08:14:59.68+00:00'),
  ('cfefd4cc-9b8c-4e93-b5e2-eceb3ba81f1b', 'ZA223HQMXQ', 'moto g - 2025', 'motorola', 'https://dennoh.site/?udid=ZA223HQMXQ&pin=11014040', NULL, 8108, '11014040', 'online', false, true, 80, NULL, 'available', NULL, '2026-08-22T08:14:59.9+00:00', '2026-08-07T06:57:39.566326+00:00', '2026-08-22T08:14:59.9+00:00'),
  ('3a8b7555-8cf5-4228-81ba-5386d603fc91', 'R8YWA0A09JW', 'SM-A042F', 'samsung', 'https://dennoh.site/?udid=R8YWA0A09JW&key=streamalpha2707l&pin=830099', 'http://localhost:8100', 8100, '94879348', 'online', true, false, 49, NULL, 'available', NULL, '2026-08-09T18:18:54.917+00:00', '2026-07-31T10:37:35.21605+00:00', '2026-08-13T21:22:07.994+00:00'),
  ('16059ced-42f9-4937-a144-d4d0c1a5f024', 'ZA223HRJVF', 'moto g - 2025', 'motorola', 'https://dennoh.site/?udid=ZA223HRJVF&key=blazenexus6625cd&pin=823887', NULL, 8109, '11014040', 'online', false, true, 80, NULL, 'available', NULL, '2026-08-22T08:15:00.165+00:00', '2026-08-09T18:58:39.581432+00:00', '2026-08-22T08:15:00.165+00:00')
ON CONFLICT (serial) DO UPDATE SET 
  stream_url = EXCLUDED.stream_url,
  status = EXCLUDED.status,
  monthly_rental_price = EXCLUDED.monthly_rental_price,
  is_available_for_rental = EXCLUDED.is_available_for_rental,
  is_deleted_from_view = EXCLUDED.is_deleted_from_view;

-- 18. Import Device Rentals
INSERT INTO public.device_rentals (
  id, serial_number, user_id, device_model, device_brand, monthly_fee, 
  currency, status, binding_code, stream_url, expires_at, created_at, updated_at, stealth_root_enabled
) VALUES
  ('9c82f5d4-ba5a-4cdd-b833-1bca1078468f', '1120308025024495', 'RENTAL_USER_DEFAULT', 'B170D', 'BLU', 30, 'USD', 'active', '11014040', 'https://dennoh.site/?udid=1120308025024495&pin=11014040', NULL, '2026-08-13T18:29:14.616059+00:00', '2026-08-22T08:14:58.306+00:00', true),
  ('915461de-9b05-425a-b205-caf2b9050b77', '7070016025067254', 'RENTAL_USER_DEFAULT', 'B1660V', 'BLU', 30, 'USD', 'active', '11014040', 'https://dennoh.site/?udid=7070016025067254&pin=11014040', NULL, '2026-08-13T18:29:20.074044+00:00', '2026-08-22T08:14:58.527+00:00', true),
  ('1e4c8a1d-0650-4bb9-8363-7741b6eeea43', 'M769UCQCDMZLPF8D', 'RENTAL_USER_DEFAULT', 'T513V', 'TCL', 30, 'USD', 'active', '11014040', 'https://dennoh.site/?udid=M769UCQCDMZLPF8D&pin=11014040', NULL, '2026-08-13T18:29:25.010403+00:00', '2026-08-22T08:14:58.731+00:00', true),
  ('6099c73a-a215-4266-8ee4-68ece322df0e', 'NBIR5LAYORLRDU4T', 'RENTAL_USER_DEFAULT', 'T513V', 'TCL', 30, 'USD', 'active', '11014040', 'https://dennoh.site/?udid=NBIR5LAYORLRDU4T&pin=11014040', NULL, '2026-08-13T18:29:30.120813+00:00', '2026-08-22T08:14:58.948+00:00', true),
  ('6e8c816f-d93d-44c3-9e19-b154cd595ab6', 'OBOFP75LXGV4EIJN', 'RENTAL_USER_DEFAULT', 'T513V', 'TCL', 30, 'USD', 'active', '11014040', 'https://dennoh.site/?udid=OBOFP75LXGV4EIJN&pin=11014040', NULL, '2026-08-13T18:29:35.421327+00:00', '2026-08-22T08:14:59.157+00:00', true),
  ('281802d4-1d53-4394-aae4-7150ad05dd7f', 'V8RGXC5D5LMJJRQW', 'RENTAL_USER_DEFAULT', 'T513V', 'TCL', 30, 'USD', 'active', '11014040', 'https://dennoh.site/?udid=V8RGXC5D5LMJJRQW&pin=11014040', NULL, '2026-08-13T18:29:40.883034+00:00', '2026-08-22T08:14:59.366+00:00', true),
  ('25af8c65-0770-4efa-a95b-56f1aea1ba2a', 'W45989YDRW8LIFYT', 'RENTAL_USER_DEFAULT', 'T513V', 'TCL', 30, 'USD', 'active', '11014040', 'https://dennoh.site/?udid=W45989YDRW8LIFYT&pin=11014040', NULL, '2026-08-13T18:29:47.048995+00:00', '2026-08-22T08:14:59.579+00:00', true),
  ('197b7693-3043-4bc0-960d-f90d28a9edc0', 'YTCY999TVKVCZDZX', 'RENTAL_USER_DEFAULT', 'T513V', 'TCL', 30, 'USD', 'active', '11014040', 'https://dennoh.site/?udid=YTCY999TVKVCZDZX&pin=11014040', NULL, '2026-08-13T18:29:53.117078+00:00', '2026-08-22T08:14:59.783+00:00', true),
  ('83ba0981-58c4-461b-87fc-4a99f5b29f1e', 'ZA223HQMXQ', 'RENTAL_USER_DEFAULT', 'moto g - 2025', 'motorola', 30, 'USD', 'active', '11014040', 'https://dennoh.site/?udid=ZA223HQMXQ&pin=11014040', NULL, '2026-08-13T18:30:00.877127+00:00', '2026-08-22T08:15:00.051+00:00', true),
  ('8aa0c061-427a-466d-a4f2-1d306eb29719', 'ZA223HRJVF', 'RENTAL_USER_DEFAULT', 'moto g - 2025', 'motorola', 30, 'USD', 'active', '11014040', 'https://dennoh.site/?udid=ZA223HRJVF&key=blazenexus6625cd&pin=823887', NULL, '2026-08-13T18:30:08.081505+00:00', '2026-08-22T08:15:00.279+00:00', true)
ON CONFLICT (serial_number) DO UPDATE SET 
  stream_url = EXCLUDED.stream_url,
  status = EXCLUDED.status,
  updated_at = EXCLUDED.updated_at;

-- 19. Import Device Assignments
INSERT INTO public.device_assignments (
  id, device_id, assigned_to_user_id, assigned_by_user_id, access_password, created_at, updated_at
) VALUES
  ('6293976b-9d5f-4b6a-99ce-1c330ce6975d', '6ae4df31-0c37-4146-adbd-6284c426e559', '0b3879b9-c823-434c-9c8f-12d2ff7f8f91', '76eeb120-1ea5-44a5-b924-0f5968ad5ae6', '759091', '2026-07-31T11:18:30.182203+00:00', '2026-07-31T11:18:30.182203+00:00'),
  ('883bd8a7-0f46-4397-a12c-6c63875aaf85', '5ef436c8-0da9-4c68-9c46-2d3cc673a9b5', '59427519-8043-4425-9e0b-019db51b1b2c', '0b3879b9-c823-434c-9c8f-12d2ff7f8f91', '653961', '2026-08-13T23:11:42.099705+00:00', '2026-08-13T23:11:42.099705+00:00'),
  ('1a68b3bb-039b-4362-a4e2-0ae9e9b160e5', 'b3ab2731-c9f0-4137-a284-8d197a39c641', '95daa7dc-c17a-4caf-bf39-1fc03ed117be', '707001e5-25b8-4d6f-b9a3-9fc501ec52e5', '917818', '2026-08-08T07:37:47.529069+00:00', '2026-08-13T21:21:56.305+00:00'),
  ('af32fd5a-88e5-4754-820a-17961d261449', '3a8b7555-8cf5-4228-81ba-5386d603fc91', '707001e5-25b8-4d6f-b9a3-9fc501ec52e5', '76eeb120-1ea5-44a5-b924-0f5968ad5ae6', '830099', '2026-07-31T10:40:55.604358+00:00', '2026-08-13T21:22:09.993+00:00'),
  ('e7919555-79eb-485f-9328-f57d634515c3', '3a8b7555-8cf5-4228-81ba-5386d603fc91', '0b3879b9-c823-434c-9c8f-12d2ff7f8f91', '76eeb120-1ea5-44a5-b924-0f5968ad5ae6', '830099', '2026-07-31T10:43:12.069782+00:00', '2026-08-13T21:22:09.993+00:00'),
  ('d3b90daa-9de6-4309-9762-f540ae8c4a65', '3a8b7555-8cf5-4228-81ba-5386d603fc91', 'a3b92bff-63f3-4d2f-8d20-556438e210d3', 'a3b92bff-63f3-4d2f-8d20-556438e210d3', '830099', '2026-07-31T11:45:12.241786+00:00', '2026-08-13T21:22:09.993+00:00'),
  ('3bbb80f9-5f78-4479-86f0-c9162387f451', 'b648d6e7-a82f-4bd3-8ca7-4396fd465e45', 'dfddbc44-d861-4d34-8fed-5ac5071ebcd9', '707001e5-25b8-4d6f-b9a3-9fc501ec52e5', '807389', '2026-08-17T20:03:20.513429+00:00', '2026-08-18T00:19:02.958+00:00'),
  ('32ec3f35-4580-4358-81ad-1fbb4550b351', 'a66be2f9-9e15-48db-a6a7-628361f42d13', 'c7ba5c95-79ad-403f-a6e2-8bb1f6066b76', '0b3879b9-c823-434c-9c8f-12d2ff7f8f91', '604098', '2026-08-13T23:11:02.640103+00:00', '2026-08-13T23:11:02.640103+00:00'),
  ('e0d0e3f5-122b-4e2f-9f3e-f885cec9444a', '5aa6eaab-fc22-4b78-b872-54545895b0d8', 'b0c2be32-df91-47a4-8898-90ab2f6df85b', '0b3879b9-c823-434c-9c8f-12d2ff7f8f91', '231606', '2026-08-11T14:33:02.777877+00:00', '2026-08-11T14:33:02.777877+00:00'),
  ('d23994eb-643b-4fae-9518-8759684da3ec', '8f968d45-1178-4260-ab27-e641e7772c6b', '43ff12a8-2d31-409b-9fff-3edb2f7a7af9', '0b3879b9-c823-434c-9c8f-12d2ff7f8f91', '281494', '2026-08-19T08:05:44.380599+00:00', '2026-08-19T08:05:44.380599+00:00'),
  ('f8edfc8b-b124-48e5-9d4a-068bc3c354bf', '16059ced-42f9-4937-a144-d4d0c1a5f024', '707001e5-25b8-4d6f-b9a3-9fc501ec52e5', '707001e5-25b8-4d6f-b9a3-9fc501ec52e5', '823887', '2026-08-18T19:07:16.54731+00:00', '2026-08-18T19:07:16.54731+00:00'),
  ('33bdfa95-edd1-4925-ba6b-bed1ffd31ab1', 'ac963c9d-2216-42be-a961-ee194f8a729c', '0b3879b9-c823-434c-9c8f-12d2ff7f8f91', '0b3879b9-c823-434c-9c8f-12d2ff7f8f91', '747609', '2026-08-11T17:57:02.956077+00:00', '2026-08-13T21:25:41.862+00:00'),
  ('f6b06c07-04b5-456f-a34c-d4c83e47ffa6', 'cfefd4cc-9b8c-4e93-b5e2-eceb3ba81f1b', '8578324b-1e59-4fec-8423-20546173cb86', '707001e5-25b8-4d6f-b9a3-9fc501ec52e5', '391889', '2026-08-07T07:40:14.542713+00:00', '2026-08-13T21:21:40.353+00:00'),
  ('59d1889b-81af-43cd-8d00-e3dbb739ddd6', '56351d73-346f-48ac-b4ea-56d342b4b8ce', 'cdfa9620-b1fa-4693-908f-fa17409f467c', '0b3879b9-c823-434c-9c8f-12d2ff7f8f91', '834114', '2026-08-13T22:55:29.686435+00:00', '2026-08-13T22:55:29.686435+00:00')
ON CONFLICT (id) DO UPDATE SET
  access_password = EXCLUDED.access_password,
  updated_at = EXCLUDED.updated_at;

-- 20. Initialize Default System Settings
INSERT INTO public.system_settings (key, value) VALUES
  ('cctv_wall_locked', 'false'::jsonb),
  ('platform_mode', '"production"'::jsonb)
ON CONFLICT (key) DO NOTHING;
