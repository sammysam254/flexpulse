'use strict';

const { spawn, execFile } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const logger = require('../utils/logger');

const ADB_BIN = (() => {
  const candidates = [
    path.join(process.cwd(), 'assets', 'bin', 'adb.exe'),
    'C:\\platform-tools\\adb.exe',
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return 'adb';
})();

const SCRCPY_JAR_PATH = path.join(process.cwd(), 'scrcpy-server.jar');

function hasSpsNal(buf) {
  if (!buf || buf.length < 4) return false;
  for (let i = 0; i < Math.min(buf.length - 4, 128); i++) {
    if (buf[i] === 0 && buf[i+1] === 0) {
      if (buf[i+2] === 1 && i + 3 < buf.length) {
        if ((buf[i+3] & 0x1f) === 7) return true;
      } else if (buf[i+2] === 0 && buf[i+3] === 1 && i + 4 < buf.length) {
        if ((buf[i+4] & 0x1f) === 7) return true;
      }
    }
  }
  return false;
}

function inspectH264Payload(buf) {
  let isKeyframe = false;
  let isSps = false;
  let isPps = false;
  let isIdr = false;
  if (!buf || buf.length < 4) return { isKeyframe, isSps, isPps, isIdr };

  const len = Math.min(buf.length, 512);
  for (let i = 0; i <= len - 4; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      let ntype = -1;
      if (buf[i + 2] === 1 && i + 3 < buf.length) {
        ntype = buf[i + 3] & 0x1f;
      } else if (buf[i + 2] === 0 && buf[i + 3] === 1 && i + 4 < buf.length) {
        ntype = buf[i + 4] & 0x1f;
      }
      if (ntype === 7) { isSps = true; isKeyframe = true; }
      else if (ntype === 8) { isPps = true; isKeyframe = true; }
      else if (ntype === 5) { isIdr = true; isKeyframe = true; }
    }
  }
  return { isKeyframe, isSps, isPps, isIdr };
}

/**
 * Extract the encoded frame dimensions directly from an H.264 SPS NAL unit.
 * This is the ground truth — the exact size the scrcpy encoder configured,
 * and the value the server uses to validate INJECT_TOUCH_EVENT dimensions.
 *
 * Reads pic_width_in_mbs_minus1 and pic_height_in_map_units_minus1 from the
 * SPS RBSP. These values encode the picture size in 16-pixel macroblocks.
 * The full formula also accounts for frame_crop_* fields.
 */
function _findSpsStart(buf) {
  for (let i = 0; i < Math.min(buf.length - 4, 256); i++) {
    if (buf[i] === 0 && buf[i+1] === 0) {
      if (buf[i+2] === 1 && (buf[i+3] & 0x1f) === 7) return i + 4;
      if (buf[i+2] === 0 && buf[i+3] === 1 && (buf[i+4] & 0x1f) === 7) return i + 5;
    }
  }
  return -1;
}

function _readUEGolomb(data, bitOffset) {
  // Count leading zeros
  let zeros = 0;
  while (bitOffset < data.length * 8 && !((data[bitOffset >> 3] >> (7 - (bitOffset & 7))) & 1)) {
    zeros++;
    bitOffset++;
  }
  bitOffset++; // skip the 1 bit
  if (zeros === 0) return { val: 0, bitOffset };
  let val = 1;
  for (let i = 0; i < zeros; i++) {
    val = (val << 1) | ((data[bitOffset >> 3] >> (7 - (bitOffset & 7))) & 1);
    bitOffset++;
  }
  return { val: val - 1, bitOffset };
}

function parseSpsWidth(payload) {
  const start = _findSpsStart(payload);
  if (start < 0 || start + 10 >= payload.length) return 0;
  try {
    let bit = 0;
    const profileIdc = payload[start];
    bit = (start * 8) + 8 + 8 + 8; // skip profile/constraints/level
    
    // seq_parameter_set_id (UE)
    let r = _readUEGolomb(payload, bit); bit = r.bitOffset;
    
    // For profile 100/110/122/244 — these need chroma/bit-depth parsing (skip for now)
    const needsExtended = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138].includes(profileIdc);
    if (needsExtended && start + 20 >= payload.length) return 0;
    
    if (needsExtended) {
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // chroma_format_idc
      if (r.val === 3) bit++; // separate_colour_plane_flag
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // bit_depth_luma_minus8
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // bit_depth_chroma_minus8
      bit++; // qpprime_y_zero_transform_bypass_flag
      const seqScalingMatrixPresent = (payload[bit >> 3] >> (7 - (bit & 7))) & 1; bit++;
      if (seqScalingMatrixPresent) return 0; // too complex
    }
    
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // log2_max_frame_num_minus4
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // pic_order_cnt_type
    if (r.val === 0) { r = _readUEGolomb(payload, bit); bit = r.bitOffset; }
    else if (r.val === 1) {
      bit++; // delta_pic_order_always_zero_flag
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // offset_for_non_ref_pic
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // offset_for_top_to_bottom_field
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // num_ref_frames_in_pic_order_cnt_cycle
      for (let i = 0; i < Math.min(r.val, 256); i++) { 
        r = _readUEGolomb(payload, bit); bit = r.bitOffset; 
      }
    }
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // max_num_ref_frames
    bit++; // gaps_in_frame_num_value_allowed_flag
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // pic_width_in_mbs_minus1
    const widthInMbs = r.val + 1;
    return Math.max(16, widthInMbs * 16);
  } catch (err) {
    return 0;
  }
}

function parseSpsHeight(payload) {
  const start = _findSpsStart(payload);
  if (start < 0 || start + 10 >= payload.length) return 0;
  try {
    let bit = 0;
    const profileIdc = payload[start];
    bit = (start * 8) + 8 + 8 + 8;
    
    let r = _readUEGolomb(payload, bit); bit = r.bitOffset; // seq_parameter_set_id
    
    const needsExtended = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138].includes(profileIdc);
    if (needsExtended && start + 20 >= payload.length) return 0;
    
    if (needsExtended) {
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // chroma_format_idc
      if (r.val === 3) bit++;
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // bit_depth_luma_minus8
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // bit_depth_chroma_minus8
      bit++;
      const sm = (payload[bit >> 3] >> (7 - (bit & 7))) & 1; bit++;
      if (sm) return 0;
    }
    
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // log2_max_frame_num_minus4
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // pic_order_cnt_type
    if (r.val === 0) { r = _readUEGolomb(payload, bit); bit = r.bitOffset; }
    else if (r.val === 1) {
      bit++;
      r = _readUEGolomb(payload, bit); bit = r.bitOffset;
      r = _readUEGolomb(payload, bit); bit = r.bitOffset;
      r = _readUEGolomb(payload, bit); bit = r.bitOffset;
      for (let i = 0; i < Math.min(r.val, 256); i++) { 
        r = _readUEGolomb(payload, bit); bit = r.bitOffset; 
      }
    }
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // max_num_ref_frames
    bit++;
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // pic_width_in_mbs_minus1
    r = _readUEGolomb(payload, bit); bit = r.bitOffset; // pic_height_in_map_units_minus1
    const heightInMapUnits = r.val + 1;
    const frameMbsOnly = (payload[bit >> 3] >> (7 - (bit & 7))) & 1; bit++;
    const heightInMbs = frameMbsOnly ? heightInMapUnits : heightInMapUnits * 2;
    let height = heightInMbs * 16;
    
    // Parse frame cropping if present
    bit++; // direct_8x8_inference_flag
    const frameCroppingFlag = (payload[bit >> 3] >> (7 - (bit & 7))) & 1; bit++;
    if (frameCroppingFlag && start + 30 < payload.length) {
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // crop_left
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // crop_right
      r = _readUEGolomb(payload, bit); bit = r.bitOffset; // crop_top
      const cropBottom = r.val; r = _readUEGolomb(payload, bit); bit = r.bitOffset;
      height -= (cropBottom + r.val) * (frameMbsOnly ? 2 : 4);
    }
    return Math.max(16, height);
  } catch (err) {
    return 0;
  }
}

/**
 * ScrcpyEngine — manages a scrcpy server session for one device.
 *
 * VIDEO MODE: scrcpy streams H264 over the video socket. We relay raw
 * H264 NAL units directly to WebSocket clients. The browser decodes
 * them using the WebCodecs VideoDecoder API.
 *
 * Zero-latency design:
 *  - max_fps=60, max_size=720, bit_rate=4Mbps
 *  - send_frame_meta=true so we can strip the 12-byte header cleanly
 *  - SPS/PPS config packet sent immediately to every new client
 *  - Backpressure threshold lowered to 64KB (was 512KB) to avoid jitter
 */
class ScrcpyEngine extends EventEmitter {
  constructor(serial) {
    super();
    this.serial        = serial;
    this.serverProc    = null;
    this.videoSocket   = null;
    this.controlSocket = null;
    this.isRunning     = false;
    this.videoPort     = null;

    // Device dimensions — populated by scrcpy stdout and video header
    // Initialize to common Android portrait defaults so commands don't fail before stream starts
    this.screenWidth  = 1080;
    this.screenHeight = 2340;

    // Connected WS clients receiving H264 stream & audio
    this.wsClients = new Set();
    this._configPacket = null;
    this._keyframeBuffer = null;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.scrcpyVideoWidth = 0;
    this.scrcpyVideoHeight = 0;
    this._jarPushed = false;
    this._screencapActive = false;
    this.enableAudio = false;
    this.audioSocket = null;
  }

  get isReady() {
    return this.isRunning && this.controlSocket && !this.controlSocket.destroyed;
  }

  /**
   * Register a WS client. We immediately flush the cached SPS/PPS + IDR keyframe
   * so the WebCodecs decoder is initialised before any new delta frame arrives.
   */
  addClient(ws) {
    ws._needsKeyframe = false;
    ws._qualityLevel = 'high'; // 'high' | 'medium' | 'low'
    ws._frameCounter = 0;
    ws._lastQualityChange = Date.now();
    ws._congestedCount = 0;
    ws._healthyCount = 0;
    this.wsClients.add(ws);
    // Send cached SPS/PPS config & IDR keyframe immediately so WebCodecs decodes instantly
    const initialPacket = this._keyframeBuffer || this._configPacket;
    if (initialPacket && ws.readyState === 1) {
      try { ws.send(initialPacket, { binary: true }); } catch (_) {}
    }
    // Nudge Android window compositor with WAKEUP (224) and MENU (82) to dismiss lockscreen and produce fresh frames
    try {
      this._adb(['shell', 'input', 'keyevent', '224']).catch(() => {});
      this._adb(['shell', 'input', 'keyevent', '82']).catch(() => {});
      this._adb(['shell', 'svc', 'power', 'stayon', 'true']).catch(() => {});
    } catch (_) {}
  }

  removeClient(ws) {
    this.wsClients.delete(ws);
  }

  async _pushServerJar() {
    if (this._jarPushed) return;
    if (!fs.existsSync(SCRCPY_JAR_PATH)) {
      logger.error(`[ScrcpyEngine ${this.serial}] CRITICAL: ${SCRCPY_JAR_PATH} not found!`);
      throw new Error(`scrcpy-server.jar missing at ${SCRCPY_JAR_PATH}`);
    }
    logger.info(`[ScrcpyEngine ${this.serial}] Pushing scrcpy-server.jar to /data/local/tmp/scrcpy-server.jar...`);
    await this._adb(['push', SCRCPY_JAR_PATH, '/data/local/tmp/scrcpy-server.jar']);
    this._jarPushed = true;
    logger.info(`[ScrcpyEngine ${this.serial}] scrcpy-server.jar pushed successfully`);
  }

  async start(videoPort) {
    if (this.isRunning) return;
    this.videoPort = videoPort;
    this.isRunning = true;

    try {
      // 0. Force-kill any lingering scrcpy/app_process on device to release localabstract:scrcpy
      try {
        await this._adb(['shell', 'pkill', '-9', '-f', 'com.genymobile.scrcpy']).catch(() => {});
        await new Promise(r => setTimeout(r, 200));
      } catch (_) {}

      // Wake display, keep screen on, and unlock so hardware H.264 encoder never feeds black frames
      try {
        await this._adb(['shell', 'svc', 'power', 'stayon', 'true']).catch(() => {});
        await this._adb(['shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', '3']).catch(() => {});
        await this._adb(['shell', 'input', 'keyevent', '224']).catch(() => {}); // KEYCODE_WAKEUP
        await this._adb(['shell', 'input', 'keyevent', '82']).catch(() => {});  // KEYCODE_MENU
      } catch (_) {}

      // 1. Fetch real screen dimensions
      try {
        const out = await this._adb(['shell', 'wm', 'size']);
        const m = out.match(/Physical size:\s*(\d+)x(\d+)/);
        if (m) {
          this.screenWidth  = parseInt(m[1], 10);
          this.screenHeight = parseInt(m[2], 10);
        }
      } catch (_) {}
      logger.info(`[ScrcpyEngine ${this.serial}] Screen: ${this.screenWidth}x${this.screenHeight}`);

      // 2. Push scrcpy-server.jar to device
      await this._pushServerJar();

      // 3. Setup ADB port forwarding for scrcpy
      try { await this._adb(['forward', '--remove', `tcp:${this.videoPort}`]); } catch (_) {}
      await this._adb(['forward', `tcp:${this.videoPort}`, 'localabstract:scrcpy']);

      // 4. Spawn scrcpy-server process on device
      this._spawnServer();

      // 5. Connect video and control sockets
      await this._connectSockets();

      logger.info(`[ScrcpyEngine ${this.serial}] High-speed 60FPS Scrcpy H264 engine active`);

    } catch (err) {
      logger.warn(`[ScrcpyEngine ${this.serial}] Scrcpy start failed: ${err.message} — freeing phone socket and scheduling auto-recovery`);
      try {
        await this._adb(['shell', 'pkill', '-9', '-f', 'com.genymobile.scrcpy']).catch(() => {});
      } catch (_) {}
      if (this.isRunning) {
        setTimeout(() => this._restart(), 2000);
      }
    }
  }

  _spawnServer() {
    // Diagnostic: verify scrcpy-server.jar exists before spawning
    if (!fs.existsSync(SCRCPY_JAR_PATH)) {
      logger.error(`[ScrcpyEngine ${this.serial}] CRITICAL: ${SCRCPY_JAR_PATH} not found! Streaming will fail.`);
      logger.error(`[ScrcpyEngine ${this.serial}] Download from: https://github.com/Genymobile/scrcpy/releases/download/v2.4/scrcpy-server-v2.4`);
    }

    const args = [
      '-s', this.serial, 'shell',
      'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
      'app_process', '/', 'com.genymobile.scrcpy.Server', '2.4',
      'tunnel_forward=true',
      'audio=' + (this.enableAudio ? 'true' : 'false'),
      'audio_codec=opus',
      'audio_bit_rate=64000',
      'control=true',
      'cleanup=false',
      'send_dummy_byte=true',
      'video_source=display',
      'video_bit_rate=900000',
      'max_size=800',
      'max_fps=30',
      'video_codec_options=i-frame-interval=1',
      'send_frame_meta=true',
      'show_touches=false',
      'stay_awake=true',
    ];

    logger.info(`[ScrcpyEngine ${this.serial}] Spawning scrcpy server with args: ${args.slice(2).join(' ')}`);

    this.serverProc = spawn(ADB_BIN, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Return a Promise that resolves when scrcpy prints its "Device:" ready line.
    // This avoids the race condition where we connect sockets before the server is ready.
    this._serverReady = new Promise((resolve) => {
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };

      this.serverProc.stdout.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg) logger.info(`[ScrcpyEngine ${this.serial}] stdout: ${msg}`);
        // scrcpy prints "Device: <model> (<WxH>)" once the encoder is initialised.
        // Parse the negotiated resolution so touch events use the exact same dimensions.
        const dimMatch = msg.match(/\((\d+)x(\d+)\)/) || msg.match(/(?:texture|resolution|size):\s*(\d+)x(\d+)/i);
        if (dimMatch) {
          const sw = parseInt(dimMatch[1], 10);
          const sh = parseInt(dimMatch[2], 10);
          if (sw > 0 && sh > 0) {
            this.scrcpyVideoWidth = sw;
            this.scrcpyVideoHeight = sh;
            this.videoWidth  = sw;
            this.videoHeight = sh;
            logger.info(`[ScrcpyEngine ${this.serial}] Server-negotiated resolution: ${sw}x${sh}`);
          }
        }
        if (msg.includes('Device:') || msg.includes('device:')) done();
      });

      this.serverProc.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg) logger.warn(`[ScrcpyEngine ${this.serial}] stderr: ${msg}`);
        if (msg.includes('Address already in use')) {
          logger.warn(`[ScrcpyEngine ${this.serial}] Socket conflict on device — force-killing zombie scrcpy server`);
          this._adb(['shell', 'pkill', '-9', '-f', 'com.genymobile.scrcpy']).catch(() => {});
        }
      });

      // Safety timeout — if no "Device:" within 5s, proceed anyway
      setTimeout(done, 5000);
    });

    this.serverProc.on('error', (e) => {
      logger.error(`[ScrcpyEngine ${this.serial}] proc error: ${e.message}`);
    });

    this._procStartTime = Date.now();
    this._restartPending = false;

    this.serverProc.on('close', (code) => {
      // Ignore close events triggered by our own stop() call
      if (!this.isRunning) return;
      // Ignore if a restart is already queued
      if (this._restartPending) return;

      const uptime = Date.now() - this._procStartTime;
      logger.warn(`[ScrcpyEngine ${this.serial}] proc exited (code=${code}, uptime=${uptime}ms)`);

      this._cleanup();

      // Only restart if we weren't already in fallback mode
      if (!this._fallbackActive) {
        this._restartPending = true;
        // Back off longer if it died quickly (likely a startup error)
        const delay = uptime < 3000 ? 4000 : 1500;
        logger.info(`[ScrcpyEngine ${this.serial}] Restarting in ${delay}ms...`);
        setTimeout(() => {
          this._restartPending = false;
          if (this.isRunning && !this._fallbackActive) this._restart();
        }, delay);
      }
    });
  }

  _startScreenrecordFallback() {
    if (this._fallbackActive) return;
    this._fallbackActive = true;
    logger.info(`[ScrcpyEngine ${this.serial}] Starting hardware screenrecord fallback...`);

    const args = [
      '-s', this.serial, 'exec-out',
      'screenrecord',
      '--output-format=h264',
      '--size', '720x1280',
      '--bit-rate', '2500000',
      '-'
    ];

    const proc = spawn(ADB_BIN, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    this._fallbackProc = proc;

    proc.stdout.on('data', (chunk) => {
      this._broadcastVideo(chunk, false);
    });

    proc.on('close', () => {
      this._fallbackProc = null;
      if (this.isRunning && this._fallbackActive) {
        setTimeout(() => {
          this._fallbackActive = false;
          if (this.isRunning) this._startScreenrecordFallback();
        }, 1000);
      }
    });

    proc.on('error', (err) => {
      logger.warn(`[ScrcpyEngine ${this.serial}] Screenrecord process error: ${err.message}`);
    });
  }

  stop() {
    this.isRunning = false;
    this._screencapActive = false;
    this._fallbackActive = false;
    if (this._fallbackProc) {
      try { this._fallbackProc.kill(); } catch (_) {}
      this._fallbackProc = null;
    }
    this._cleanup();
    this.wsClients.clear();
    this.emit('stopped');
  }

  _cleanup() {
    if (this.videoSocket) {
      try { this.videoSocket.destroy(); } catch (_) {}
      this.videoSocket = null;
    }
    if (this.controlSocket) {
      try { this.controlSocket.destroy(); } catch (_) {}
      this.controlSocket = null;
    }
    if (this.serverProc) {
      try { this.serverProc.kill(); } catch (_) {}
      this.serverProc = null;
    }
  }

  // ── Socket connection ─────────────────────────────────────────────────────

  async _connectSockets() {
    // Wait for scrcpy server to print its "Device:" ready signal before connecting.
    // This eliminates the race condition where we connected before the server was ready.
    logger.info(`[ScrcpyEngine ${this.serial}] Waiting for scrcpy server ready signal...`);
    if (this._serverReady) await this._serverReady;

    // Small additional buffer to ensure the ADB forward socket is fully open
    await new Promise(r => setTimeout(r, 200));

    logger.info(`[ScrcpyEngine ${this.serial}] Connecting video socket...`);
    // tunnel_forward socket 1 = video stream
    this.videoSocket = await this._connectOne(this.videoPort);
    this.videoSocket.setNoDelay(true);
    this._pipeVideoToClients(this.videoSocket);

    await new Promise(r => setTimeout(r, 150));

    // tunnel_forward socket 2 = audio stream (when audio=true)
    if (this.enableAudio) {
      try {
        logger.info(`[ScrcpyEngine ${this.serial}] Connecting audio socket...`);
        this.audioSocket = await this._connectOne(this.videoPort);
        this.audioSocket.setNoDelay(true);
        this._pipeAudioToClients(this.audioSocket);
        await new Promise(r => setTimeout(r, 150));
      } catch (err) {
        logger.warn(`[ScrcpyEngine ${this.serial}] Audio socket notice: ${err.message}`);
      }
    }

    // tunnel_forward socket 3 = control socket
    logger.info(`[ScrcpyEngine ${this.serial}] Connecting control socket...`);
    this.controlSocket = await this._connectOne(this.videoPort);
    this.controlSocket.setNoDelay(true);
    this.controlSocket.setKeepAlive(true, 1000);

    this.controlSocket.on('close', () => {
      this.controlSocket = null;
      if (this.isRunning) setTimeout(() => this._reconnectControl(), 300);
    });
    this.controlSocket.on('error', () => { this.controlSocket = null; });
  }

  _connectOne(port, retries = 50) {
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        const s = net.connect({ port, host: '127.0.0.1' }, () => resolve(s));
        s.on('error', (e) => {
          s.destroy();
          if (n <= 0) return reject(new Error(`Timeout connecting to port ${port}: ${e.message}`));
          setTimeout(() => attempt(n - 1), 150);
        });
      };
      attempt(retries);
    });
  }

  /**
   * Relay raw H264 NAL units from the video socket to all WS clients.
   * Zero-copy buffer slicing & minimal latency stream pipeline.
   */
  _pipeVideoToClients(socket) {
    if (socket && typeof socket.setNoDelay === 'function') {
      try { socket.setNoDelay(true); } catch (_) {}
    }
    let buf = Buffer.alloc(0);
    let headerDone = false;
    let lastDataTime = Date.now();
    const DEVICE_HEADER_LEN = 77;
    const META = 12; // 8-byte PTS + 4-byte size

    const watchdog = setInterval(() => {
      // 1. If no video data received for 3s while clients are watching, nudge screen compositor to unfreeze
      if (this.isRunning && this.wsClients.size > 0 && Date.now() - lastDataTime > 3000) {
        try {
          this._adb(['shell', 'input', 'keyevent', '224']).catch(() => {});
        } catch (_) {}
      }
      // 2. Only trigger fallback if video socket is destroyed or disconnected
      if ((!this.videoSocket || this.videoSocket.destroyed) && !this._fallbackActive && this.isRunning) {
        logger.warn(`[ScrcpyEngine ${this.serial}] Video socket disconnected — starting screenrecord fallback`);
        this._startScreenrecordFallback();
      }
    }, 2000);

    socket.on('data', (chunk) => {
      lastDataTime = Date.now();
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

      // 1. Skip the device-info header exactly once & parse real video stream size
      if (!headerDone) {
        if (buf.length < DEVICE_HEADER_LEN) return;

        try {
          // scrcpy 2.4 video socket header layout (77 bytes total):
          //   [0]      dummy byte (0x00)
          //   [1-4]    codec ID ASCII ("h264")
          //   [5-68]   device name, 64 bytes null-padded
          //   [69-72]  uint32 BE — negotiated encoder width
          //   [73-76]  uint32 BE — negotiated encoder height
          const w = buf.readUInt32BE(69);
          const h = buf.readUInt32BE(73);
          if (w > 0 && h > 0 && w < 10000 && h < 10000) {
            this.scrcpyVideoWidth = w;
            this.scrcpyVideoHeight = h;
            this.videoWidth = w;
            this.videoHeight = h;
            logger.info(`[ScrcpyEngine ${this.serial}] Scrcpy stream resolution: ${w}x${h}`);
          }
        } catch (_) {}

        if (buf.length >= DEVICE_HEADER_LEN + META) {
          const firstPktSize = buf.readUInt32BE(DEVICE_HEADER_LEN + 8);
          if (firstPktSize === 0 || firstPktSize > 2 * 1024 * 1024) {
            logger.warn(`[ScrcpyEngine ${this.serial}] Unexpected first packet size ${firstPktSize} — trying 1-byte header`);
            buf = buf.subarray(1);
          } else {
            buf = buf.subarray(DEVICE_HEADER_LEN);
          }
        } else {
          buf = buf.subarray(DEVICE_HEADER_LEN);
        }

        logger.info(`[ScrcpyEngine ${this.serial}] Device-info header consumed, stream parsing started`);
        headerDone = true;
      }

      // 2. Process video frame packets zero-copy
      while (buf.length >= META) {
        const pktSize = buf.readUInt32BE(8);
        if (buf.length < META + pktSize) break;

        const ptsHigh  = buf.readUInt32BE(0);
        const payload  = buf.subarray(META, META + pktSize);
        buf = buf.subarray(META + pktSize);

        const info = inspectH264Payload(payload);
        const isSps = info.isSps;
        const isIdr = info.isIdr;
        const isConfig = isSps || (ptsHigh & 0x80000000) !== 0;
        const isKeyframe = isConfig || isIdr || isSps;

        if (isSps || (isConfig && !this._configPacket)) {
          this._configPacket = Buffer.from(payload);
          logger.info(`[ScrcpyEngine ${this.serial}] SPS/PPS config cached (${payload.length} bytes)`);

          // Use SPS NAL as resolution fallback only if scrcpy header didn't specify width/height.
          // Note: SPS macroblock calculation rounds to 16px multiples without frame crop offsets,
          // whereas scrcpy header gives the exact encoder display size required by Controller.java.
          if (!this.scrcpyVideoWidth || !this.scrcpyVideoHeight) {
            try {
              const spsW = parseSpsWidth(payload);
              const spsH = parseSpsHeight(payload);
              if (spsW > 16 && spsH > 16 && spsW < 10000 && spsH < 10000) {
                this.scrcpyVideoWidth = spsW;
                this.scrcpyVideoHeight = spsH;
                this.videoWidth  = spsW;
                this.videoHeight = spsH;
                logger.info(`[ScrcpyEngine ${this.serial}] Fallback SPS resolution: ${spsW}x${spsH}`);
              }
            } catch (err) {
              logger.warn(`[ScrcpyEngine ${this.serial}] SPS parse error: ${err.message}`);
            }
          }
        }

        // Always ensure keyframes sent to clients include the SPS/PPS config so browser decoder never stalls
        let outPayload = payload;
        if (isIdr) {
          if (this._configPacket && !isSps) {
            outPayload = Buffer.concat([this._configPacket, payload]);
          }
          this._keyframeBuffer = outPayload;
        }

        this._broadcastVideo(outPayload, isKeyframe);
      }

      // Safety reset
      if (buf.length > 1024 * 1024) {
        logger.warn(`[ScrcpyEngine ${this.serial}] Buffer overflow — resetting`);
        buf = Buffer.alloc(0);
      }
    });

    socket.on('close', () => {
      clearInterval(watchdog);
      logger.warn(`[ScrcpyEngine ${this.serial}] Video socket closed`);
      this.videoSocket = null;
      if (this.isRunning && !this._fallbackActive) {
        this._startScreenrecordFallback();
      }
    });

    socket.on('error', (e) => {
      clearInterval(watchdog);
      logger.warn(`[ScrcpyEngine ${this.serial}] Video socket error: ${e.message}`);
      this.videoSocket = null;
    });
  }

  _pipeAudioToClients(socket) {
    let buf = Buffer.alloc(0);
    let headerDone = false;

    socket.on('data', (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

      if (!headerDone) {
        // Scrcpy 2.x sends: 1 dummy byte (0x00) + 4-byte codec ID (e.g. "opus")
        // Total header = 5 bytes minimum
        if (buf.length < 5) return;

        let offset = 0;
        if (buf[0] === 0x00) offset = 1;

        const codecStr = buf.toString('utf8', offset, offset + 4).toLowerCase().trim().replace(/\0/g, '');
        logger.info(`[ScrcpyEngine ${this.serial}] Audio codec header detected: "${codecStr}"`);
        this._audioCodec = codecStr; // 'opus' or 'raw'
        buf = buf.subarray(offset + 4);
        headerDone = true;
      }

      const META = 12; // 8-byte PTS + 4-byte size
      while (buf.length >= META) {
        const pktSize = buf.readUInt32BE(8);
        if (pktSize === 0 || pktSize > 512 * 1024) {
          buf = buf.subarray(1);
          continue;
        }
        if (buf.length < META + pktSize) break;
        const payload = buf.subarray(META, META + pktSize);
        buf = buf.subarray(META + pktSize);
        this._broadcastAudio(payload);
      }
    });
    socket.on('close', () => { this.audioSocket = null; });
    socket.on('error', (e) => {
      logger.warn(`[ScrcpyEngine ${this.serial}] Audio socket error: ${e.message}`);
      this.audioSocket = null;
    });
  }

  _broadcastAudio(payload) {
    const codec = (this._audioCodec === 'opus') ? 0x4F : 0x52;
    const audioFrame = Buffer.allocUnsafe(2 + payload.length);
    audioFrame[0] = 0x41; // 'A' = audio frame tag
    audioFrame[1] = codec; // 'O' = opus, 'R' = raw
    payload.copy(audioFrame, 2);

    for (const ws of this.wsClients) {
      if (ws.readyState === 1 && ws.bufferedAmount < 48 * 1024 && !ws._needsKeyframe) {
        // In low-quality mode, skip audio data packets to conserve bandwidth for screen interactivity
        if (ws._qualityLevel === 'low') continue;
        try { ws.send(audioFrame, { binary: true }); } catch (_) {}
      }
    }
  }

  _broadcastVideo(payload, isKeyframe = false) {
    const now = Date.now();

    for (const ws of this.wsClients) {
      if (ws.readyState !== 1) {
        this.wsClients.delete(ws);
        continue;
      }

      if (!ws._qualityLevel) {
        ws._qualityLevel = 'high';
        ws._frameCounter = 0;
        ws._lastQualityChange = now;
        ws._congestedCount = 0;
        ws._healthyCount = 0;
      }

      ws._frameCounter = (ws._frameCounter + 1) % 10000;
      const bufLen = ws.bufferedAmount || 0;

      // ── Adaptive Bitrate / Quality Evaluation (YouTube-Style) ──
      // Evaluate on keyframes with at least 3.5s cooldown between quality changes
      if (isKeyframe && (now - ws._lastQualityChange > 3500)) {
        if (bufLen > 50 * 1024) {
          // Severe congestion / buffer bloat: step down to low
          ws._congestedCount = (ws._congestedCount || 0) + 1;
          ws._healthyCount = 0;
          if (ws._qualityLevel !== 'low' && ws._congestedCount >= 2) {
            ws._qualityLevel = 'low';
            ws._lastQualityChange = now;
            ws._needsKeyframe = true;
            this._notifyClientQuality(ws, 'low', 'Adapting to lower quality stream because of speed...', '📶');
          }
        } else if (bufLen > 20 * 1024) {
          // Moderate latency / congestion: step down to medium
          ws._congestedCount = (ws._congestedCount || 0) + 1;
          ws._healthyCount = 0;
          if (ws._qualityLevel === 'high' && ws._congestedCount >= 2) {
            ws._qualityLevel = 'medium';
            ws._lastQualityChange = now;
            this._notifyClientQuality(ws, 'medium', 'Adapting to standard quality (optimizing for network speed)...', '📶');
          }
        } else if (bufLen === 0) {
          // Clean, fast socket: step up
          ws._healthyCount = (ws._healthyCount || 0) + 1;
          ws._congestedCount = 0;

          if (ws._qualityLevel === 'low' && ws._healthyCount >= 3) {
            ws._qualityLevel = 'medium';
            ws._lastQualityChange = now;
            ws._healthyCount = 0;
            this._notifyClientQuality(ws, 'medium', 'Connection improving — adapting stream quality...', '⚡');
          } else if (ws._qualityLevel === 'medium' && ws._healthyCount >= 5) {
            ws._qualityLevel = 'high';
            ws._lastQualityChange = now;
            ws._healthyCount = 0;
            this._notifyClientQuality(ws, 'high', 'Connection stable — adapting to high quality stream', '⚡');
          }
        }
      }

      // ── Stream-Preserving Frame Delivery ──
      // Keyframes (IDR / SPS / PPS) are ALWAYS sent unconditionally so decoder never desyncs!
      if (!isKeyframe) {
        // Immediate buffer safety: if buffer exceeds 80KB, drop delta frames until next keyframe
        if (bufLen > 80 * 1024) {
          ws._needsKeyframe = true;
        }

        if (ws._needsKeyframe) {
          continue;
        }

        // Adaptive decimation without breaking stream:
        // 'high': send all frames (100%)
        // 'medium': send every 2nd frame (50% reduction in bandwidth)
        // 'low': send every 4th frame (75% reduction in bandwidth)
        if (ws._qualityLevel === 'medium' && (ws._frameCounter % 2 !== 0)) {
          continue;
        }
        if (ws._qualityLevel === 'low' && (ws._frameCounter % 4 !== 0)) {
          continue;
        }
      } else {
        // Fresh keyframe delivered: clear catch-up flag
        ws._needsKeyframe = false;
      }

      try {
        ws.send(payload, { binary: true });
      } catch (_) {
        this.wsClients.delete(ws);
      }
    }
  }

  _notifyClientQuality(ws, quality, message, icon) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({
          type: 'adaptive_quality',
          quality,
          message,
          icon
        }));
      } catch (_) {}
    }
  }

  handleNetworkReport(ws, data) {
    if (!ws || ws.readyState !== 1) return;
    const now = Date.now();
    if (data && data.lag && (now - (ws._lastQualityChange || 0) > 3000)) {
      if (ws._qualityLevel === 'high') {
        ws._qualityLevel = 'medium';
        ws._lastQualityChange = now;
        this._notifyClientQuality(ws, 'medium', 'Adapting to standard quality (optimizing for network speed)...', '📶');
      } else if (ws._qualityLevel === 'medium') {
        ws._qualityLevel = 'low';
        ws._lastQualityChange = now;
        ws._needsKeyframe = true;
        this._notifyClientQuality(ws, 'low', 'Adapting to lower quality stream because of speed...', '📶');
      }
    }
  }

  /**
   * Simple, reliable screencap streaming.
   * Captures PNG screenshots continuously and sends as base64 to clients.
   * ~10-15 fps, works on all devices, no codec issues.
   */
  _startScreencapStream() {
    if (this._screencapActive) return;
    this._screencapActive = true;

    const captureLoop = async () => {
      while (this._screencapActive && this.isRunning) {
        try {
          const startTime = Date.now();
          
          // Capture screenshot
          const proc = spawn(ADB_BIN, ['-s', this.serial, 'exec-out', 'screencap -p'], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore']
          });

          const chunks = [];
          proc.stdout.on('data', c => chunks.push(c));
          
          await new Promise((resolve) => {
            proc.on('close', () => resolve());
            proc.on('error', () => resolve());
          });

          if (chunks.length > 0) {
            // exec-out via spawn stdio:pipe delivers clean binary — no CRLF stripping needed
            const pngData = Buffer.concat(chunks);
            
            // Send to all connected clients
            for (const ws of this.wsClients) {
              if (ws.readyState === 1) {
                try {
                  ws.send(pngData, { binary: true });
                } catch (_) {
                  this.wsClients.delete(ws);
                }
              } else {
                this.wsClients.delete(ws);
              }
            }
          }

          // Maintain ~15 fps (67ms per frame)
          const elapsed = Date.now() - startTime;
          const delay = Math.max(1, 67 - elapsed);
          await new Promise(r => setTimeout(r, delay));

        } catch (err) {
          logger.warn(`[ScrcpyEngine ${this.serial}] Screencap error: ${err.message}`);
          await new Promise(r => setTimeout(r, 100));
        }
      }
    };

    captureLoop();
    logger.info(`[ScrcpyEngine ${this.serial}] Screencap streaming started`);
  }

  // ── Control protocol ──────────────────────────────────────────────────────

  /**
   * INJECT_TOUCH_EVENT (32 bytes, scrcpy 2.x)
   *   [0]     msg type = 2
   *   [1]     action: 0=DOWN 1=UP 2=MOVE
   *   [2-9]   pointer id i64BE (-1 = virtual)
   *   [10-13] x i32BE
   *   [14-17] y i32BE
   *   [18-19] screen width u16BE
   *   [20-21] screen height u16BE
   *   [22-23] pressure u16BE (0xFFFF = 1.0)
   *   [24-27] action_button i32BE (1=PRIMARY on DOWN)
   *   [28-31] buttons i32BE (1 on DOWN/MOVE, 0 on UP)
   */
  sendTouchEvent(action, x, y, width, height, pressure = 1.0) {
    if (!this.controlSocket || this.controlSocket.destroyed) {
      return false;
    }

    // Must use the exact resolution scrcpy-server expects in Controller.java:
    // Controller.java: if (!position.getScreenSize().equals(device.getScreenInfo().getVideoSize())) reject
    // The device header (bytes 69-76) provides this exact videoSize.
    let targetW = this.scrcpyVideoWidth || this.videoWidth;
    let targetH = this.scrcpyVideoHeight || this.videoHeight;
    if (!targetW || !targetH) {
      targetW = this.screenWidth || 1080;
      targetH = this.screenHeight || 2340;
    }

    const srcW = (width  > 10) ? width  : targetW;
    const srcH = (height > 10) ? height : targetH;
    
    const scaledX = Math.round((x / srcW) * targetW);
    const scaledY = Math.round((y / srcH) * targetH);

    // Clamp to valid range
    const finalX = Math.max(0, Math.min(targetW - 1, scaledX));
    const finalY = Math.max(0, Math.min(targetH - 1, scaledY));

    const buf = Buffer.allocUnsafe(32);
    buf.writeUInt8(2, 0);                 // INJECT_TOUCH_EVENT
    buf.writeUInt8(action, 1);            // 0=DOWN, 1=UP, 2=MOVE
    buf.writeBigInt64BE(0n, 2);           // pointerId 0n (finger 0)
    buf.writeInt32BE(finalX, 10);
    buf.writeInt32BE(finalY, 14);
    buf.writeUInt16BE(targetW, 18);
    buf.writeUInt16BE(targetH, 20);
    buf.writeUInt16BE(action === 1 ? 0 : Math.floor(pressure * 65535), 22);
    buf.writeInt32BE(0, 24);              // action_button = 0
    buf.writeInt32BE(action === 1 ? 0 : 1, 28); // buttons: 1 on DOWN/MOVE, 0 on UP
    try {
      this.controlSocket.cork();
      this.controlSocket.write(buf);
      this.controlSocket.uncork();
      return true;
    } catch (e) { 
      logger.warn(`[ScrcpyEngine ${this.serial}] touch write failed: ${e.message}`);
      return false; 
    }
  }

  /**
   * INJECT_KEYCODE (14 bytes)
   *   [0]     msg type = 0
   *   [1]     action 0=DOWN 1=UP
   *   [2-5]   keycode i32BE
   *   [6-9]   repeat i32BE
   *   [10-13] metastate i32BE
   */
  sendKeycode(action, keycode, repeat = 0, metastate = 0) {
    if (!this.controlSocket || this.controlSocket.destroyed) return false;
    const buf = Buffer.allocUnsafe(14);
    buf.writeUInt8(0, 0);
    buf.writeUInt8(action, 1);
    buf.writeInt32BE(keycode, 2);
    buf.writeInt32BE(repeat, 6);
    buf.writeInt32BE(metastate, 10);
    try { this.controlSocket.write(buf); return true; }
    catch (_) { return false; }
  }

  /**
   * INJECT_TEXT (variable)
   *   [0]     msg type = 1
   *   [1-4]   text length i32BE
   *   [5...]  UTF-8 text
   */
  sendText(text) {
    if (!this.controlSocket || this.controlSocket.destroyed) return false;
    const tb = Buffer.from(text, 'utf-8');
    const buf = Buffer.allocUnsafe(5 + tb.length);
    buf.writeUInt8(1, 0);
    buf.writeInt32BE(tb.length, 1);
    tb.copy(buf, 5);
    try { this.controlSocket.write(buf); return true; }
    catch (_) { return false; }
  }

  // ── Reconnect / restart ───────────────────────────────────────────────────

  async _reconnectControl() {
    if (!this.isRunning) return;
    try {
      const cs = await this._connectOne(this.videoPort, 10);
      cs.setNoDelay(true);
      cs.setKeepAlive(true, 1000);
      this.controlSocket = cs;
      cs.on('close', () => {
        this.controlSocket = null;
        if (this.isRunning) setTimeout(() => this._reconnectControl(), 300);
      });
      cs.on('error', () => { this.controlSocket = null; });
    } catch (_) {
      if (this.isRunning) setTimeout(() => this._reconnectControl(), 1000);
    }
  }

  // ── Reset stream state on restart ────────────────────────────────────────
  _resetStreamState() {
    this._configPacket   = null;
    this._keyframeBuffer = null;
    // Notify all connected browsers to reset their decoders
    const resetMsg = Buffer.from(JSON.stringify({ type: 'stream_reset' }));
    for (const ws of this.wsClients) {
      if (ws.readyState === 1) {
        try { ws.send(resetMsg); } catch (_) {}
      }
    }
  }

  async _restart() {
    if (!this.isRunning) return;
    logger.info(`[ScrcpyEngine ${this.serial}] Restarting...`);
    // Clear stale keyframe cache so fresh SPS/PPS+IDR are sent after restart
    this._configPacket   = null;
    this._keyframeBuffer = null;
    this._restartPending = false;
    // Tell connected browsers to reset their decoders before new stream data arrives
    const resetMsg = Buffer.from(JSON.stringify({ type: 'stream_reset' }));
    for (const ws of this.wsClients) {
      if (ws.readyState === 1) try { ws.send(resetMsg); } catch (_) {}
    }
    try {
      // Force-kill any lingering scrcpy/app_process on device to release localabstract:scrcpy
      try {
        await this._adb(['shell', 'pkill', '-9', '-f', 'com.genymobile.scrcpy']).catch(() => {});
        await new Promise(r => setTimeout(r, 200));
      } catch (_) {}

      try { await this._adb(['forward', '--remove', `tcp:${this.videoPort}`]); } catch (_) {}
      await this._adb(['forward', `tcp:${this.videoPort}`, 'localabstract:scrcpy']);
      this._spawnServer();
      await this._connectSockets();
      logger.info(`[ScrcpyEngine ${this.serial}] Restarted successfully`);
    } catch (err) {
      logger.warn(`[ScrcpyEngine ${this.serial}] Restart failed: ${err.message} — retry in 3s`);
      if (this.isRunning) setTimeout(() => this._restart(), 3000);
    }
  }

  _adb(args) {
    return new Promise((resolve, reject) => {
      execFile(ADB_BIN, ['-s', this.serial, ...args], { timeout: 10000 }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout || '');
      });
    });
  }
}

module.exports = ScrcpyEngine;
