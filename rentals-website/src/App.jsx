import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import DeviceStore from './pages/DeviceStore';
import MyDevices from './pages/MyDevices';
import AdminRentalHub from './pages/AdminRentalHub';

const ProtectedRoute = ({ children }) => {
  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-main, #070b16)',
        color: '#fff',
        gap: '14px'
      }}>
        <div style={{
          width: '44px',
          height: '44px',
          borderRadius: '12px',
          background: 'linear-gradient(135deg, #2563eb, #38bdf8)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 0 20px rgba(56, 189, 248, 0.4)'
        }}>
          <span style={{ fontWeight: 900, color: '#fff', fontSize: '20px' }}>D</span>
        </div>
        <div style={{ fontWeight: 800, fontSize: '16px', letterSpacing: '0.4px' }}>
          Flexpulse <span style={{ color: 'var(--primary, #38bdf8)' }}>MARKETPLACE</span>
        </div>
      </div>
    );
  }
  return children;
};

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<DeviceStore />} />
          <Route path="/store" element={<DeviceStore />} />
          <Route path="/my-devices" element={<ProtectedRoute><MyDevices /></ProtectedRoute>} />
          <Route path="/admin-rentals" element={<ProtectedRoute><AdminRentalHub /></ProtectedRoute>} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="*" element={<Navigate to="/store" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
