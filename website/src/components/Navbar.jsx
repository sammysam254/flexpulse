import React from 'react';
import { useAuth } from '../context/AuthContext';
import { Sun, Moon, Menu, LogOut, Shield, Smartphone } from 'lucide-react';

export default function Navbar({ toggleSidebar }) {
  const { user, profile, theme, toggleTheme, logout } = useAuth();

  const getRoleBadge = (role) => {
    switch (role) {
      case 'seed_admin': return <span className="badge badge-danger"><Shield size={12} /> Seed Owner</span>;
      case 'super_admin': return <span className="badge badge-warning">Super Admin</span>;
      case 'admin': return <span className="badge badge-info">Admin</span>;
      default: return <span className="badge badge-success">Worker</span>;
    }
  };

  return (
    <header style={{
      height: '64px',
      background: 'var(--bg-header)',
      backdropFilter: 'blur(10px)',
      borderBottom: '1px solid var(--border-color)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 16px',
      position: 'sticky',
      top: 0,
      zIndex: 40
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button 
          onClick={toggleSidebar}
          className="btn btn-secondary"
          style={{ padding: '8px', display: 'flex' }}
          aria-label="Toggle Navigation Menu"
        >
          <Menu size={20} />
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 800, fontSize: '18px' }}>
          <img src="/favicon.svg" alt="Flexpulse" style={{ width: '28px', height: '28px', borderRadius: '6px' }} />
          <span>Flexpulse</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <button 
          onClick={toggleTheme} 
          className="btn btn-secondary" 
          style={{ padding: '8px', borderRadius: '50%' }}
          title="Toggle Dark/Light Mode"
        >
          {theme === 'dark' ? <Sun size={18} color="#f59e0b" /> : <Moon size={18} color="#8b5cf6" />}
        </button>

        {profile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {getRoleBadge(profile.role)}
            <button onClick={logout} className="btn btn-danger" style={{ padding: '6px 12px', fontSize: '12px' }}>
              <LogOut size={14} /> <span style={{ display: 'none' }} className="nav-exit-label">Exit</span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

