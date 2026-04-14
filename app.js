// ─── Auth Guard ───────────────────────────────────────────────────────────────
const userRaw = localStorage.getItem('eg_user');
if (!userRaw) { window.location.href = 'auth.html'; }

const USER = JSON.parse(userRaw);
document.getElementById('user-name').textContent  = USER.name;
document.getElementById('user-email').textContent = USER.email;
document.getElementById('user-avatar').textContent = USER.name.charAt(0).toUpperCase();

function logout() {
  localStorage.removeItem('eg_user');
  window.location.href = 'auth.html';
}

// ─── Settings (persisted) ─────────────────────────────────────────────────────
function loadSettings() {
  return JSON.parse(localStorage.getItem('eg_settings') || JSON.stringify({
    apiBase: '',
    interval: 2000,
    reminders: true,
    alerts: true
  }));
}
function saveSettings() {
  const s = {
    apiBase:   document.getElementById('api-input').value.trim().replace(/\/$/, ''),
    interval:  parseInt(document.getElementById('interval-select').value),
    reminders: document.getElementById('reminder-toggle').checked,
    alerts:    document.getElementById('alert-toggle').checked
  };
  localStorage.setItem('eg_settings', JSON.stringify(s));
  API_BASE  = s.apiBase;
  SCAN_MS   = s.interval;
  showToast('✓ Settings saved', 'info');
}

let settings  = loadSettings();
let API_BASE  = settings.apiBase;
let SCAN_MS   = settings.interval;

// Populate settings UI
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('api-input').value       = settings.apiBase;
  document.getElementById('interval-select').value = settings.interval;
  document.getElementById('reminder-toggle').checked = settings.reminders;
  document.getElementById('alert-toggle').checked    = settings.alerts;
});

// ─── Navigation ───────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault();
    const page = item.dataset.page;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
    document.getElementById('page-' + page).classList.remove('hidden');
    document.querySelector('.page-title').textContent =
      page === 'dashboard' ? 'Live Monitor' :
      page === 'history'   ? 'Session History' : 'Settings';
    if (page === 'history') renderHistory();
  });
});

// ─── State ────────────────────────────────────────────────────────────────────
let monitoring     = false;
let stream         = null;
let scanInterval   = null;
let sessionStart   = null;
let timerInterval  = null;
let frameCount     = 0;
let lastMetrics    = null;
let blinkWindow    = [];
let lastEAR        = 0.35;
let suggestTimer   = null;
let modalCountdown = null;
let sessionLog     = [];   // {time, metrics}
let toastSet       = new Set();

const video      = document.getElementById('video');
const canvas     = document.getElementById('canvas');
const toggleBtn  = document.getElementById('toggle-btn');

// ─── Monitor Toggle ───────────────────────────────────────────────────────────
async function toggleMonitor() {
  monitoring ? stopMonitoring() : await startMonitoring();
}

async function startMonitoring() {
  if (!API_BASE) {
    showToast('⚠ Set your API URL in Settings first.', 'warn');
    // Auto-nav to settings
    document.querySelector('[data-page="settings"]').click();
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    showToast('Camera access denied. Please allow camera and retry.', 'danger');
    return;
  }

  monitoring = true;
  frameCount = 0;
  blinkWindow = [];

  // UI updates
  toggleBtn.className = 'btn-monitor stop';
  document.getElementById('btn-icon').textContent  = '■';
  document.getElementById('btn-label').textContent = 'Stop';
  setLiveBadge('active', '● LIVE');
  document.getElementById('scan-overlay').classList.add('active');
  document.querySelector('.chip-dot').classList.add('live');
  document.getElementById('refresh-btn').disabled = false;

  startSessionTimer();
  checkAPIStatus();

  // 20-20-20 reminder
  if (loadSettings().reminders) {
    setTimeout(() => { if (monitoring) show2020Modal(); }, 20 * 60 * 1000);
  }

  scanInterval = setInterval(captureAndAnalyze, SCAN_MS);
  showToast('Monitoring started. Keep your face visible.', 'info');
}

function stopMonitoring() {
  monitoring = false;
  clearInterval(scanInterval);
  clearInterval(timerInterval);
  clearTimeout(suggestTimer);
  if (stream) stream.getTracks().forEach(t => t.stop());
  video.srcObject = null;

  // Save session to history
  if (sessionLog.length > 0) saveSessionToHistory();

  toggleBtn.className = 'btn-monitor';
  document.getElementById('btn-icon').textContent  = '▶';
  document.getElementById('btn-label').textContent = 'Start';
  setLiveBadge('idle', '● IDLE');
  document.getElementById('scan-overlay').classList.remove('active');
  document.querySelector('.chip-dot').classList.remove('live');
  document.getElementById('refresh-btn').disabled = true;
  document.getElementById('api-status').innerHTML = '<span class="status-dot dot-off"></span> API Disconnected';
  showToast('Session ended. Data saved to history.', 'info');
}

// ─── API Health Check ─────────────────────────────────────────────────────────
async function checkAPIStatus() {
  try {
    const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      document.getElementById('api-status').innerHTML = '<span class="status-dot dot-on"></span> API Connected';
    } else throw new Error();
  } catch {
    document.getElementById('api-status').innerHTML = '<span class="status-dot dot-warn"></span> API Unreachable';
    showToast('⚠ Cannot reach API. Is Colab + ngrok running?', 'warn');
  }
}

// ─── Session Timer ────────────────────────────────────────────────────────────
function startSessionTimer() {
  sessionStart = Date.now();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - sessionStart) / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    document.getElementById('session-time').textContent = `${hh}:${mm}:${ss}`;

    // 20-20-20 every 20 min
    if (s > 0 && s % 1200 === 0 && loadSettings().reminders) {
      show2020Modal();
    }
  }, 1000);
}

// ─── Capture + Analyze ────────────────────────────────────────────────────────
async function captureAndAnalyze() {
  if (!monitoring || video.readyState < 2) return;

  // Draw mirrored frame to hidden canvas (canvas output is normal for API)
  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  // Flip horizontally for canvas (so API receives non-mirrored, natural image)
  ctx.save();
  ctx.scale(-1, 1);
  ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
  ctx.restore();

  canvas.toBlob(async (blob) => {
    if (!blob) return;
    frameCount++;
    document.getElementById('ms-frames').textContent = frameCount;
    document.getElementById('ms-last').textContent =
      new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    try {
      const res  = await fetch(`${API_BASE}/analyze`, {
        method: 'POST', body: blob,
        headers: { 'Content-Type': 'application/octet-stream' }
      });
      const data = await res.json();
      if (data.success) {
        updateDashboard(data.metrics);
        lastMetrics = data.metrics;
        sessionLog.push({ time: Date.now(), metrics: data.metrics });

        // Auto-suggest on high strain (throttled)
        if (data.metrics.strain_score >= 60 && !suggestTimer) {
          suggestTimer = setTimeout(() => { fetchSuggestions(); suggestTimer = null; }, 30000);
          fetchSuggestions(); // immediate first time
        }
      }
    } catch (err) {
      // silent — API might be momentarily busy
      console.warn('Analyze error:', err.message);
    }
  }, 'image/jpeg', 0.75);
}

// ─── Blink Detection ──────────────────────────────────────────────────────────
function detectBlink(ear) {
  const THRESH = 0.22;
  const now    = Date.now();
  if (lastEAR >= THRESH && ear < THRESH) blinkWindow.push(now);
  blinkWindow = blinkWindow.filter(t => now - t < 60000);
  lastEAR = ear;
  return blinkWindow.length;
}

// ─── Dashboard Update ─────────────────────────────────────────────────────────
function updateDashboard(m) {
  const blink = detectBlink(m.ear);

  // EAR
  const earState = m.ear < 0.22 ? 'danger' : m.ear < 0.25 ? 'warn' : 'ok';
  setMetric('ear',   m.ear.toFixed(3), (m.ear / 0.4) * 100, earState);

  // Blink
  const blinkState = blink < 7 ? 'danger' : blink < 12 ? 'warn' : 'ok';
  setMetricHTML('blink', `${blink} <small>/min</small>`, (blink / 25) * 100, blinkState);

  // Redness
  const redState = m.redness > 20 ? 'danger' : m.redness > 12 ? 'warn' : 'ok';
  setMetric('red', `${m.redness.toFixed(1)}%`, m.redness * 3, redState);

  // Pupil
  const pupilState = m.pupil_ratio > 4 ? 'danger' : m.pupil_ratio > 3.5 ? 'warn' : 'ok';
  setMetric('pupil', m.pupil_ratio.toFixed(2), m.pupil_ratio * 18, pupilState);

  // Gauge
  updateGauge(m.strain_score);

  // Live badge + alerts
  if (m.strain_score >= 70) {
    setLiveBadge('danger', '▲ HIGH STRAIN');
    if (loadSettings().alerts) throttleToast(`⚠ High eye strain (${m.strain_score}/100). Take a break!`, 'danger', 60000);
  } else if (m.strain_score >= 40) {
    setLiveBadge('warn', '◉ MODERATE');
  } else {
    setLiveBadge('active', '● LIVE');
  }

  // Eye state pill
  const pill = document.getElementById('eye-state-pill');
  pill.textContent = m.eye_state === 'closed' ? '😴 Eyes Closed' :
                     m.eye_state === 'open'   ? '👁 Eyes Open'   : '👁 Detecting...';

  // Mini stats
  document.getElementById('ms-state').textContent = m.eye_state || '--';
}

function setMetric(key, value, pct, state) {
  document.getElementById('v-' + key).textContent = value;
  document.getElementById('b-' + key).style.width = Math.min(100, pct) + '%';
  document.getElementById('mc-' + key).className  = 'metric-card state-' + state;
}
function setMetricHTML(key, html, pct, state) {
  document.getElementById('v-' + key).innerHTML  = html;
  document.getElementById('b-' + key).style.width = Math.min(100, pct) + '%';
  document.getElementById('mc-' + key).className  = 'metric-card state-' + state;
}

function updateGauge(score) {
  const circumference = 277;
  const offset = circumference - (score / 100) * circumference;
  document.getElementById('gauge-fill').style.strokeDashoffset = offset;
  document.getElementById('gauge-num').textContent  = score;

  const hint = score >= 70 ? '🔴 High — Rest Now!' :
               score >= 40 ? '🟡 Moderate' :
               score  >  0 ? '🟢 Low — Good' : '—';
  document.getElementById('strain-hint').textContent = hint;
}

function setLiveBadge(state, text) {
  const b = document.getElementById('live-badge');
  b.className = `live-badge live-${state}`;
  b.textContent = text;
}

// ─── RAG Suggestions ─────────────────────────────────────────────────────────
async function fetchSuggestions() {
  if (!lastMetrics || !API_BASE) return;
  const box = document.getElementById('suggestions-body');
  box.innerHTML = '<div class="suggest-placeholder"><div class="suggest-icon">⏳</div><p>Generating personalized recommendations via RAG + LangChain...</p></div>';

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
      box.innerHTML = '<div class="suggest-placeholder"><div class="suggest-icon">⚠</div><p>Could not fetch suggestions. Check Colab console.</p></div>';
    }
  } catch {
    box.innerHTML = '<div class="suggest-placeholder"><div class="suggest-icon">⚡</div><p>API error — make sure Colab cell 3.4 is still running.</p></div>';
  }
}

// ─── Session History ──────────────────────────────────────────────────────────
function saveSessionToHistory() {
  const avgScore = Math.round(
    sessionLog.reduce((a, b) => a + b.metrics.strain_score, 0) / sessionLog.length
  );
  const duration = Math.floor((Date.now() - sessionStart) / 1000);
  const sessions = JSON.parse(localStorage.getItem('eg_history') || '[]');
  sessions.unshift({
    date: new Date().toLocaleString('en-IN'),
    score: avgScore,
    duration,
    user: USER.email
  });
  localStorage.setItem('eg_history', JSON.stringify(sessions.slice(0, 50)));
  sessionLog = [];
}

function renderHistory() {
  const list = document.getElementById('history-list');
  const all  = JSON.parse(localStorage.getItem('eg_history') || '[]')
               .filter(s => s.user === USER.email);

  if (!all.length) {
    list.innerHTML = '<p style="color:var(--muted);font-size:0.9rem;">No sessions recorded yet.</p>';
    return;
  }

  list.innerHTML = all.map(s => {
    const col = s.score >= 70 ? 'var(--danger)' : s.score >= 40 ? 'var(--warn)' : 'var(--accent)';
    const dur = s.duration >= 60
      ? `${Math.floor(s.duration/60)}m ${s.duration%60}s`
      : `${s.duration}s`;
    return `<div class="history-item">
      <div class="hi-date">${s.date}</div>
      <div class="hi-score" style="color:${col}">${s.score}<small style="font-size:.7rem;font-weight:400;color:var(--muted)">/100</small></div>
      <div class="hi-dur">⏱ ${dur}</div>
    </div>`;
  }).join('');
}

// ─── 20-20-20 Modal ───────────────────────────────────────────────────────────
function show2020Modal() {
  document.getElementById('modal-backdrop').classList.remove('hidden');
  let t = 20;
  document.getElementById('modal-timer').textContent = t;
  modalCountdown = setInterval(() => {
    t--;
    document.getElementById('modal-timer').textContent = t;
    if (t <= 0) closeModal();
  }, 1000);
}
function closeModal() {
  clearInterval(modalCountdown);
  document.getElementById('modal-backdrop').classList.add('hidden');
  showToast('Great! 20-20-20 break complete. Your eyes thank you. 👁', 'info');
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const container = document.getElementById('toasts');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

function throttleToast(msg, type, ms) {
  if (toastSet.has(msg)) return;
  toastSet.add(msg);
  showToast(msg, type);
  setTimeout(() => toastSet.delete(msg), ms);
}