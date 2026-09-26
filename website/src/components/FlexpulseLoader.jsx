import React from 'react';

/**
 * Flexpulse Signature Quantum Orbital Loader
 * High-performance, branded loading animation for Flexpulse Cloud Platform.
 */
export default function FlexpulseLoader({ 
  text = 'SYNCHRONIZING HARDWARE NODES', 
  subtext = 'Connecting to Autonomous Device Grid...',
  fullScreen = false,
  size = 'default' 
}) {
  const isSmall = size === 'small';

  const content = (
    <div className={`diamt-loader-container ${isSmall ? 'small' : ''}`}>
      {/* Precision Holographic Core */}
      <div className="diamt-loader-core">
        {/* Outer Orbital Scanning Ring */}
        <div className="diamt-orbit-ring outer" />
        
        {/* Inner Counter-Rotating Ring */}
        <div className="diamt-orbit-ring inner" />
        
        {/* Precision Crosshair Target Indicators */}
        <div className="diamt-crosshair top" />
        <div className="diamt-crosshair bottom" />
        <div className="diamt-crosshair left" />
        <div className="diamt-crosshair right" />

        {/* Central Luminous Phone Emblem */}
        <div className="diamt-core-emblem">
          <svg viewBox="0 0 24 24" fill="none" className="diamt-core-svg">
            <rect x="5" y="2" width="14" height="20" rx="3" stroke="currentColor" strokeWidth="2"/>
            <path d="M12 18h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            <path d="M9 5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.6"/>
          </svg>
        </div>

        {/* Ambient Radial Energy Aura */}
        <div className="diamt-core-aura" />
      </div>

      {/* Typography & System Identification */}
      {!isSmall && (
        <div className="diamt-loader-info">
          <div className="diamt-loader-brand">
            FLEXPULSE <span className="diamt-brand-accent">CLOUD</span>
          </div>
          
          <div className="diamt-loader-title">
            <span className="diamt-pulse-dot" />
            {text}
          </div>

          {subtext && (
            <div className="diamt-loader-subtext">
              {subtext}
            </div>
          )}

          {/* Laser Progressive Scanner Line */}
          <div className="diamt-laser-track">
            <div className="diamt-laser-beam" />
          </div>

          {/* Micro Telemetry Badges */}
          <div className="diamt-loader-telemetry">
            <span className="telemetry-pill">NODE: ACTIVE</span>
            <span className="telemetry-separator">•</span>
            <span className="telemetry-pill">ENCRYPTION: TLS 1.3</span>
            <span className="telemetry-separator">•</span>
            <span className="telemetry-pill">LATENCY: &lt;15ms</span>
          </div>
        </div>
      )}
    </div>
  );

  if (fullScreen) {
    return (
      <div className="diamt-loader-fullscreen">
        {content}
      </div>
    );
  }

  return content;
}
