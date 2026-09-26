import React, { useEffect, useState } from 'react';
import RentalsLayout from '../layouts/RentalsLayout';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { Store, Smartphone, CheckCircle, RefreshCw, ShoppingCart, Lock, DollarSign, Zap, HelpCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import PaymentModal from '../components/PaymentModal';
import SEO from '../components/SEO';

export default function DeviceStore() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [storeDevices, setStoreDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [paymentModalDevice, setPaymentModalDevice] = useState(null);

  const fetchStoreDevices = async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      // Query devices available for rental & unassigned/available
      const { data } = await supabase
        .from('devices')
        .select('*')
        .eq('is_available_for_rental', true)
        .eq('status', 'online')
        .order('created_at', { ascending: false });

      // Filter: must be available rental status and not deleted from view
      const available = (data || []).filter(d => {
        if (d.is_deleted_from_view) return false;
        if (d.rental_status && d.rental_status !== 'available') return false;
        if (d.rented_by_user_id) return false;
        return true;
      });

      setStoreDevices(available);
    } catch (e) {
      console.error('Error fetching store devices:', e);
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  useEffect(() => {
    fetchStoreDevices(true);

    const channel = supabase
      .channel('store_devices_realtime_sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, () => fetchStoreDevices(false))
      .subscribe();

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchStoreDevices(false);
      }
    }, 300000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, []);

  const handleOpenPaymentModal = (device) => {
    if (!user) {
      alert('Please sign in to rent a device');
      return navigate('/login');
    }
    setPaymentModalDevice(device);
  };

  const handlePaymentConfirmed = async (paymentRef) => {
    if (!paymentModalDevice || !user) return;
    const device = paymentModalDevice;

    try {
      const autoPassword = Math.floor(100000 + Math.random() * 900000).toString();

      // 1. Update device rental status to rented
      await supabase.from('devices').update({
        rental_status: 'rented',
        rented_by_user_id: user.id,
        rented_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', device.id);

      // 2. Create device assignment record for instant stream access
      await supabase.from('device_assignments').insert([{
        device_id: device.id,
        assigned_to_user_id: user.id,
        assigned_by_user_id: user.id,
        access_password: autoPassword
      }]);

      setPaymentModalDevice(null);
      alert(`🎉 Payment Verified & Device Rented Successfully! Access Password: ${autoPassword}\n\nRedirecting to My Devices...`);
      navigate('/my-devices');
    } catch (err) {
      alert('Error finalizing rental: ' + err.message);
    }
  };

  const [expandedFaq, setExpandedFaq] = useState(null);

  const faqs = [
    {
      q: "What is Flexpulse Device Rentals Marketplace?",
      a: "Flexpulse Device Marketplace lets you rent dedicated, real physical Android devices hosted on high-speed hardware nodes. Devices feature ultra-low latency WebRTC video streaming, full touchscreen remote control, and stealth routing."
    },
    {
      q: "How fast is access activated after rental payment?",
      a: "Activation is instantaneous! As soon as your card payment via Paystack or crypto payment via NOWPayments is verified, an access PIN is generated and the device is immediately assigned to your My Devices dashboard."
    },
    {
      q: "What payment methods are supported?",
      a: "We support major credit/debit cards via Paystack (USD, NGN) and popular cryptocurrencies (USDT, BTC, ETH, SOL) via NOWPayments for flexible monthly rental plans."
    },
    {
      q: "Are the devices virtual emulators or real Android hardware?",
      a: "All devices hosted on Flexpulse are 100% real physical Android phones connected via high-speed USB 3.0 nodes with hardware acceleration."
    }
  ];

  const storeSchema = [
    {
      "@context": "https://schema.org",
      "@type": "OfferCatalog",
      "name": "Android Cloud Device Rental Store",
      "itemListElement": storeDevices.map((d, index) => ({
        "@type": "Offer",
        "position": index + 1,
        "name": `${d.brand} ${d.model}`,
        "price": d.monthly_rental_price || 49,
        "priceCurrency": "USD",
        "availability": "https://schema.org/InStock",
        "itemOffered": {
          "@type": "Product",
          "name": `${d.brand} ${d.model} Real Cloud Android Device`,
          "serialNumber": d.serial
        }
      }))
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": faqs.map(item => ({
        "@type": "Question",
        "name": item.q,
        "acceptedAnswer": {
          "@type": "Answer",
          "text": item.a
        }
      }))
    }
  ];

  return (
    <RentalsLayout>
      <SEO
        title="Device Store Marketplace — Dedicated Real Hardware Android Cloud"
        description="Browse and rent unassigned real hardware Android devices for automation, testing, and remote control with instant WebRTC streaming access."
        keywords="Android marketplace, device rental store, cloud Android devices, mobile testing farm, instant real phone rental"
        jsonLd={storeSchema}
      />
      <main aria-labelledby="marketplace-title">
        <header style={{ marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Store size={26} color="var(--primary)" />
              <h1 id="marketplace-title" style={{ fontSize: '26px', fontWeight: 800 }}>Device Store Marketplace</h1>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
              Unassigned high-performance Android devices ready for instant monthly rental.
            </p>
          </div>
          <button onClick={() => fetchStoreDevices(false)} className="btn btn-secondary" aria-label="Refresh available devices list">
            <RefreshCw size={16} /> Refresh Marketplace
          </button>
        </header>

      {loading ? (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '60px 0' }}>
          Loading available store devices...
        </div>
      ) : storeDevices.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
          <ShoppingCart size={48} style={{ marginBottom: '14px', opacity: 0.3 }} />
          <h3 style={{ fontSize: '18px', fontWeight: 700 }}>No Devices Currently in Store</h3>
          <p style={{ fontSize: '13px', marginTop: '6px' }}>
            All available devices are currently rented out. Check back soon when new devices are released by Super Admin!
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '22px' }}>
          {storeDevices.map(d => {
            const price = d.monthly_rental_price || 49;

            return (
              <div key={d.id} className="card card-interactive" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
                    <div>
                      <h3 style={{ fontSize: '18px', fontWeight: 800 }}>
                        {d.brand} {d.model}
                      </h3>
                      <p style={{ color: 'var(--text-muted)', fontSize: '12px', fontFamily: 'monospace', marginTop: '2px' }}>
                        SN: {d.serial}
                      </p>
                    </div>
                    <span className="badge badge-success">
                      <Zap size={11} /> READY
                    </span>
                  </div>

                  {/* Pricing Box */}
                  <div style={{
                    background: 'linear-gradient(135deg, rgba(56,189,248,0.08), rgba(168,85,247,0.05))',
                    border: '1px solid rgba(56,189,248,0.2)',
                    borderRadius: '12px',
                    padding: '14px 16px',
                    marginBottom: '18px',
                    display: 'flex',
                    alignItems: 'center',
                    justify: 'space-between'
                  }}>
                    <div>
                      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                        MONTHLY RENTAL FEE
                      </div>
                      <div style={{ fontSize: '26px', fontWeight: 800, color: 'var(--primary)', display: 'flex', alignItems: 'center' }}>
                        <span style={{ fontSize: '16px', marginRight: '2px' }}>$</span>{price}
                        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginLeft: '4px' }}>/mo USD</span>
                      </div>
                    </div>
                    <div className="badge badge-primary">Instant Setup</div>
                  </div>
                </div>

                {/* Action Button */}
                <button
                  onClick={() => handleOpenPaymentModal(d)}
                  className="btn btn-primary"
                  style={{ width: '100%', justifyContent: 'center', padding: '12px', fontSize: '14px' }}
                >
                  <ShoppingCart size={16} />
                  Rent Device (${price}/mo)
                </button>
              </div>
            );
          })}
        </div>
      )}
      {/* Frequently Asked Questions Section */}
      <section style={{ marginTop: '56px', paddingTop: '36px', borderTop: '1px solid var(--border-color)' }} aria-labelledby="faq-heading">
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '6px 14px', borderRadius: '30px', background: 'rgba(56, 189, 248, 0.1)', color: 'var(--primary)', fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>
            <HelpCircle size={15} /> FREQUENTLY ASKED QUESTIONS
          </div>
          <h2 id="faq-heading" style={{ fontSize: '24px', fontWeight: 800 }}>Everything You Need to Know</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
            Get instant answers to key questions about hardware device rentals, payments, and instant access.
          </p>
        </div>

        <div style={{ maxWidth: '800px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {faqs.map((faq, idx) => {
            const isOpen = expandedFaq === idx;
            return (
              <div
                key={idx}
                className="card"
                style={{ cursor: 'pointer', transition: 'all 0.2s ease', padding: '20px 24px' }}
                onClick={() => setExpandedFaq(isOpen ? null : idx)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 700, fontSize: '15px' }}>
                  <span>{faq.q}</span>
                  {isOpen ? <ChevronUp size={18} color="var(--primary)" /> : <ChevronDown size={18} color="var(--text-muted)" />}
                </div>
                {isOpen && (
                  <p style={{ marginTop: '12px', color: 'var(--text-muted)', fontSize: '14px', lineHeight: 1.6, borderTop: '1px dashed var(--border-color)', paddingTop: '12px' }}>
                    {faq.a}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* In-App Payment Modal (Paystack & NOWPayments Crypto) */}
      {paymentModalDevice && (
        <PaymentModal
          device={paymentModalDevice}
          user={user}
          onClose={() => setPaymentModalDevice(null)}
          onPaymentSuccess={handlePaymentConfirmed}
        />
      )}
      </main>
    </RentalsLayout>
  );
}
