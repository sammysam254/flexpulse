import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Store, Smartphone, Shield, LogOut, User, Menu, X } from 'lucide-react';

export default function RentalsLayout({ children }) {
  const { user, profile, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const closeMobileMenu = () => {
    setMobileMenuOpen(false);
  };

  const isSeedAdmin = profile?.role === 'seed_admin' || profile?.email?.toLowerCase() === 'sammyseth260@gmail.com';
  const isSuperAdmin = profile?.role === 'super_admin' || isSeedAdmin;

  return (
    <div className="rentals-layout">
      {/* Mobile Top Header */}
      <header className="mobile-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <img src="/favicon.svg" alt="Flexpulse" style={{ width: '32px', height: '32px', borderRadius: '8px', boxShadow: '0 2px 8px rgba(56, 189, 248, 0.3)' }} />
          <div>
            <div style={{ fontWeight: 800, fontSize: '15px', letterSpacing: '-0.3px', color: '#fff' }}>Flexpulse</div>
            <div style={{ fontSize: '10px', color: 'var(--primary)', fontWeight: 700, lineHeight: 1 }}>RENTALS STORE</div>
          </div>
        </div>

        <button 
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="mobile-hamburger-btn"
          aria-label="Toggle menu"
        >
          {mobileMenuOpen ? <X size={22} color="#fff" /> : <Menu size={22} color="#fff" />}
        </button>
      </header>

      {/* Mobile Backdrop */}
      {mobileMenuOpen && (
        <div className="sidebar-backdrop" onClick={closeMobileMenu} />
      )}

      {/* Sidebar Navigation */}
      <aside className={`sidebar ${mobileMenuOpen ? 'mobile-open' : ''}`} style={{ padding: '24px 16px' }}>
        <div style={{ padding: '0 8px 24px', borderBottom: '1px solid var(--border-color)', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <img src="/favicon.svg" alt="Flexpulse" style={{ width: '36px', height: '36px', borderRadius: '10px', boxShadow: '0 4px 12px rgba(56, 189, 248, 0.35)' }} />
            <div>
              <div style={{ fontWeight: 800, fontSize: '16px', letterSpacing: '-0.3px' }}>Flexpulse</div>
              <div style={{ fontSize: '11px', color: 'var(--primary)', fontWeight: 700 }}>DEVICE RENTALS</div>
            </div>
          </div>
          {mobileMenuOpen && (
            <button onClick={closeMobileMenu} className="btn btn-secondary" style={{ padding: '4px 8px' }}>
              <X size={16} />
            </button>
          )}
        </div>

        {/* Menu Items */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
          <Link 
            to="/store" 
            onClick={closeMobileMenu}
            style={{ 
              display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', borderRadius: '12px',
              fontWeight: 700, fontSize: '14px',
              color: location.pathname === '/store' || location.pathname === '/' ? '#fff' : 'var(--text-muted)',
              background: location.pathname === '/store' || location.pathname === '/' ? 'linear-gradient(135deg, rgba(56,189,248,0.2), rgba(168,85,247,0.15))' : 'transparent',
              border: location.pathname === '/store' || location.pathname === '/' ? '1px solid rgba(56,189,248,0.3)' : '1px solid transparent'
            }}
          >
            <Store size={18} color={location.pathname === '/store' ? 'var(--primary)' : 'currentColor'} />
            Device Store
          </Link>

          <Link 
            to="/my-devices" 
            onClick={closeMobileMenu}
            style={{ 
              display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', borderRadius: '12px',
              fontWeight: 700, fontSize: '14px',
              color: location.pathname === '/my-devices' ? '#fff' : 'var(--text-muted)',
              background: location.pathname === '/my-devices' ? 'linear-gradient(135deg, rgba(56,189,248,0.2), rgba(168,85,247,0.15))' : 'transparent',
              border: location.pathname === '/my-devices' ? '1px solid rgba(56,189,248,0.3)' : '1px solid transparent'
            }}
          >
            <Smartphone size={18} color={location.pathname === '/my-devices' ? 'var(--success)' : 'currentColor'} />
            My Devices
          </Link>

          {isSuperAdmin && (
            <Link 
              to="/admin-rentals" 
              onClick={closeMobileMenu}
              style={{ 
                display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', borderRadius: '12px',
                fontWeight: 700, fontSize: '14px', marginTop: '12px',
                color: location.pathname === '/admin-rentals' ? '#fff' : 'var(--warning)',
                background: location.pathname === '/admin-rentals' ? 'rgba(251,191,36,0.15)' : 'rgba(251,191,36,0.05)',
                border: '1px solid rgba(251,191,36,0.2)'
              }}
            >
              <Shield size={18} />
              Admin Rental Hub
            </Link>
          )}
        </nav>

        {/* User Footer Profile & Logout */}
        <div style={{ paddingTop: '16px', borderTop: '1px solid var(--border-color)' }}>
          {user ? (
            <div>
              <div style={{ padding: '8px 12px', marginBottom: '8px', background: 'rgba(255,255,255,0.03)', borderRadius: '10px' }}>
                <div style={{ fontSize: '12px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user.email}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-dim)', textTransform: 'uppercase', marginTop: '2px' }}>
                  Role: {profile?.role || 'Renter'}
                </div>
              </div>
              <button 
                onClick={() => { closeMobileMenu(); handleLogout(); }}
                className="btn btn-secondary"
                style={{ width: '100%', justifyContent: 'center', padding: '8px', fontSize: '12px' }}
              >
                <LogOut size={14} /> Sign Out
              </button>
            </div>
          ) : (
            <Link to="/login" onClick={closeMobileMenu} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
              <User size={14} /> Sign In
            </Link>
          )}
        </div>
      </aside>

      {/* Main Page Body */}
      <main className="main-content">
        {children}
      </main>
    </div>
  );
}
