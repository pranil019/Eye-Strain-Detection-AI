// app.js — Digital Eye Strain Monitor

// ⚠️ PASTE your ngrok URL here after running Cell 3.4 in Colab
const API_BASE = 'https://obsolete-drown-basket.ngrok-free.dev';

// State
let monitoring   = false;
let stream       = null;
let intervalId   = null;
let sessionStart = null;
let timerInterval = null;
let blinkCount   = 0;
let lastEAR      = 0.3;
let blinkWindow  = [];  // timestamps of blinks in last 60s
let lastMetrics  = null;
let suggestThrottleTimeout = null;

// DOM
const video       = document.getElementById('video');
const overlay     = document.getElementById('overlay');
const toggleBtn   = document.getElementById('toggle-btn');
const statusBadge = document.getElementById('status-badge');
const sessionTime = document.getElementById('session-time');
const refreshBtn  = document.getElementById('refresh-suggestions');

toggleBtn.addEventListener('click', () => monitoring ? stopMonitoring() : startMonitoring());
refreshBtn.addEventListener('click', fetchSuggestions);

// ─── Session Timer ───────────────────────────────────────────────────────────
function startSessionTimer() {
  sessionStart = Date.now();
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2,'0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2,'0');
    const s = String(elapsed % 60).padStart(2,'0');
    sessionTime.textContent = `${h}:${m}:${s}`;

    // 20-20-20 rule reminder every 20 minutes
    if (elapsed > 0 && elapsed % 1200 === 0) {
      showToast('⏱️ 20-minute mark! Look at something 20 feet away for 20 seconds.', 'warn');
    }
  }, 1000);
}

// ─── Camera ──────────────────────────────────────────────────────────────────
async function startMonitoring() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
    video.srcObject = stream;
    await video.play();

    monitoring = true;
    toggleBtn.textContent = 'Stop Monitoring';
    toggleBtn.classList.add('active');
    statusBadge.textContent = 'ACTIVE';
    statusBadge.className = 'badge badge-active';
    refreshBtn.disabled = false;

    startSessionTimer();
    intervalId = setInterval(captureAndAnalyze, 2000);  // every 2 seconds
    showToast('Monitoring started. Keep your face visible to the camera.', 'info');
  } catch (e) {
    alert('Camera access denied. Please allow camera access and refresh.');
  }
}

function stopMonitoring() {
  monitoring = false;
  clearInterval(intervalId);
  clearInterval(timerInterval);
  if (stream) stream.getTracks().forEach(t => t.stop());
  video.srcObject = null;

  toggleBtn.textContent = 'Start Monitoring';
  toggleBtn.classList.remove('active');
  statusBadge.textContent = 'IDLE';
  statusBadge.className = 'badge badge-idle';
  refreshBtn.disabled = true;
  document.getElementById('strain-label').textContent = 'Monitoring Off';
}

// ─── Frame Capture + Analyze ─────────────────────────────────────────────────
async function captureAndAnalyze() {
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;
  canvas.getContext('2d').drawImage(video, 0, 0);

  canvas.toBlob(async (blob) => {
    try {
      const res  = await fetch(`${API_BASE}/analyze`, {
        method: 'POST',
        body: blob,
        headers: { 'Content-Type': 'application/octet-stream' }
      });
      const data = await res.json();
      if (data.success) {
        updateUI(data.metrics);
        lastMetrics = data.metrics;

        // Auto-fetch suggestions every ~30s or on high strain
        if (data.metrics.strain_score >= 60) {
          triggerSuggestions('high strain detected');
        }
      }
    } catch (e) {
      console.warn('Analyze error:', e.message);
    }
  }, 'image/jpeg', 0.7);
}

// ─── Blink Detection (client-side via EAR changes) ───────────────────────────
function detectBlink(ear) {
  const BLINK_THRESH = 0.22;
  const now = Date.now();
  if (lastEAR >= BLINK_THRESH && ear < BLINK_THRESH) {
    blinkWindow.push(now);
  }
  // Keep only last 60 seconds
  blinkWindow = blinkWindow.filter(t => now - t < 60000);
  lastEAR = ear;
  return blinkWindow.length;
}

// ─── Update UI ───────────────────────────────────────────────────────────────
function updateUI(m) {
  const blink = detectBlink(m.ear);

  // EAR
  const earPct = Math.min(100, (m.ear / 0.4) * 100);
  setMetric('ear', m.ear.toFixed(3), earPct, m.ear < 0.22 ? 'danger' : m.ear < 0.25 ? 'warn' : '');

  // Blink rate
  const blinkOk = blink >= 10 && blink <= 25;
  const blinkWarn = blink < 10;
  setMetric('blink', `${blink} <span class="unit">/min</span>`, Math.min(100, (blink / 25) * 100),
            blink < 7 ? 'danger' : blinkWarn ? 'warn' : '');

  // Redness
  setMetric('red', `${m.redness.toFixed(1)}%`, Math.min(100, m.redness * 3),
            m.redness > 20 ? 'danger' : m.redness > 12 ? 'warn' : '');

  // Pupil
  setMetric('pupil', m.pupil_ratio.toFixed(2), Math.min(100, m.pupil_ratio * 20),
            m.pupil_ratio > 4 ? 'danger' : m.pupil_ratio > 3.5 ? 'warn' : '');

  // Strain gauge
  updateGauge(m.strain_score);

  // Status badge
  if (m.strain_score >= 70) {
    statusBadge.textContent = 'HIGH STRAIN';
    statusBadge.className = 'badge badge-danger';
    if (m.strain_score >= 80) showToast('⚠️ High eye strain detected! Take a break now.', 'danger');
  } else if (m.strain_score >= 40) {
    statusBadge.textContent = 'MODERATE';
    statusBadge.className = 'badge badge-warning';
  } else {
    statusBadge.textContent = 'ACTIVE';
    statusBadge.className = 'badge badge-active';
  }
}

function setMetric(key, value, pct, state) {
  const card = document.getElementById(`card-${key}`);
  const val  = document.getElementById(`val-${key}`);
  const bar  = document.getElementById(`bar-${key}`);
  val.innerHTML = value;
  bar.style.width = pct + '%';
  card.className = 'card metric-card ' + state;
}

function updateGauge(score) {
  const fill  = document.getElementById('gauge-fill');
  const label = document.getElementById('strain-label');
  const text  = document.getElementById('gauge-score');
  const circumference = 251;
  const offset = circumference - (score / 100) * circumference;
  fill.style.strokeDashoffset = offset;
  fill.style.stroke = score >= 70 ? '#ef4444' : score >= 40 ? '#eab308' : '#22c55e';
  text.textContent  = score;
  label.textContent = score >= 70 ? 'High Strain — Rest Now!' :
                      score >= 40 ? 'Moderate Strain' :
                      score >  0  ? 'Low Strain — Good!' : 'Monitoring...';
}

// ─── RAG Suggestions ─────────────────────────────────────────────────────────
function triggerSuggestions(reason) {
  if (suggestThrottleTimeout) return;  // throttle to once per 30s
  fetchSuggestions();
  suggestThrottleTimeout = setTimeout(() => { suggestThrottleTimeout = null; }, 30000);
}

async function fetchSuggestions() {
  if (!lastMetrics) return;
  const box = document.getElementById('suggestions-box');
  box.innerHTML = '<p class="placeholder-text">Generating suggestions...</p>';
  try {
    const res  = await fetch(`${API_BASE}/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lastMetrics)
    });
    const data = await res.json();
    if (data.success) {
      box.textContent = data.suggestions;
    } else {
      box.innerHTML = '<p class="placeholder-text">Could not fetch suggestions.</p>';
    }
  } catch (e) {
    box.innerHTML = '<p class="placeholder-text">API error — check Colab is running.</p>';
  }
}

// ─── Toast Notifications ──────────────────────────────────────────────────────
const shownToasts = new Set();
function showToast(msg, type = 'info') {
  if (shownToasts.has(msg)) return;
  shownToasts.add(msg);
  setTimeout(() => shownToasts.delete(msg), 60000);

  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

