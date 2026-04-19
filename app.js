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

// ─── Settings ─────────────────────────────────────────────────────────────────
function loadSettings() {
  return JSON.parse(localStorage.getItem('eg_settings') || JSON.stringify({
    apiBase: '', interval: 2000, reminders: true, alerts: true
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
  API_BASE = s.apiBase;
  SCAN_MS  = s.interval;
  showToast('✓ Settings saved', 'info');
}

let settings = loadSettings();
let API_BASE = settings.apiBase;
let SCAN_MS  = settings.interval;

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('api-input').value         = settings.apiBase;
  document.getElementById('interval-select').value   = settings.interval;
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
let monitoring        = false;
let stream            = null;
let scanInterval      = null;
let sessionStart      = null;
let timerInterval     = null;
let frameCount        = 0;
let lastMetrics       = null;
let blinkWindow       = [];
let lastEAR           = 0.35;
let modalCountdown    = null;
let sessionLog        = [];
let toastSet          = new Set();

// Suggestion throttle — prevents spamming the /suggest endpoint
let lastSuggestTime   = 0;
let isFetchingSuggest = false;
const SUGGEST_COOLDOWN = 45000;  // 45 seconds between auto-fetches

const video     = document.getElementById('video');
const canvas    = document.getElementById('canvas');
const toggleBtn = document.getElementById('toggle-btn');

// ─── Monitor Toggle ───────────────────────────────────────────────────────────
async function toggleMonitor() {
  monitoring ? stopMonitoring() : await startMonitoring();
}

async function startMonitoring() {
  if (!API_BASE) {
    showToast('⚠ Set your API URL in Settings first.', 'warn');
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
  } catch {
    showToast('Camera access denied. Please allow camera and retry.', 'danger');
    return;
  }

  monitoring        = true;
  frameCount        = 0;
  blinkWindow       = [];
  lastSuggestTime   = 0;
  isFetchingSuggest = false;

  toggleBtn.className = 'btn-monitor stop';
  document.getElementById('btn-icon').textContent  = '■';
  document.getElementById('btn-label').textContent = 'Stop';
  setLiveBadge('active', '● LIVE');
  document.getElementById('scan-overlay').classList.add('active');
  document.querySelector('.chip-dot').classList.add('live');
  document.getElementById('refresh-btn').disabled = false;

  startSessionTimer();
  checkAPIStatus();

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
  if (stream) stream.getTracks().forEach(t => t.stop());
  video.srcObject = null;
  if (sessionLog.length > 0) saveSessionToHistory();

  toggleBtn.className = 'btn-monitor';
  document.getElementById('btn-icon').textContent  = '▶';
  document.getElementById('btn-label').textContent = 'Start';
  setLiveBadge('idle', '● IDLE');
  document.getElementById('scan-overlay').classList.remove('active');
  document.querySelector('.chip-dot').classList.remove('live');
  document.getElementById('refresh-btn').disabled = true;
  document.getElementById('api-status').innerHTML =
    '<span class="status-dot dot-off"></span> API Disconnected';
  showToast('Session ended. Data saved to history.', 'info');
}

// ─── API Health Check ─────────────────────────────────────────────────────────
async function checkAPIStatus() {
  try {
    const r = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      document.getElementById('api-status').innerHTML =
        '<span class="status-dot dot-on"></span> API Connected';
    } else throw new Error();
  } catch {
    document.getElementById('api-status').innerHTML =
      '<span class="status-dot dot-warn"></span> API Unreachable';
    showToast('⚠ Cannot reach API. Is Colab + ngrok running?', 'warn');
  }
}

// ─── Session Timer ────────────────────────────────────────────────────────────
function startSessionTimer() {
  sessionStart = Date.now();
  timerInterval = setInterval(() => {
    const s  = Math.floor((Date.now() - sessionStart) / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    document.getElementById('session-time').textContent = `${hh}:${mm}:${ss}`;
    if (s > 0 && s % 1200 === 0 && loadSettings().reminders) show2020Modal();
  }, 1000);
}

// ─── Capture + Analyze ────────────────────────────────────────────────────────
async function captureAndAnalyze() {
  if (!monitoring || video.readyState < 2) return;

  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(-1, 1);
  ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
  ctx.restore();

  canvas.toBlob(async (blob) => {
    if (!blob) return;
    frameCount++;
    document.getElementById('ms-frames').textContent = frameCount;
    document.getElementById('ms-last').textContent =
      new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', second:'2-digit' });

    try {
      const res  = await fetch(`${API_BASE}/analyze`, {
        method: 'POST', body: blob,
        headers: { 'Content-Type': 'application/octet-stream' }
      });
      const data = await res.json();
      if (data.success) {
        updateDashboard(data.metrics);   // updates blinkWindow as side-effect
        lastMetrics = data.metrics;
        sessionLog.push({ time: Date.now(), metrics: data.metrics });

        // ── Check whether to fetch suggestions ──
        checkAndTriggerSuggestions(data.metrics);
      }
    } catch (err) {
      console.warn('Analyze error:', err.message);
    }
  }, 'image/jpeg', 0.75);
}

// ─── Smart Suggestion Trigger ─────────────────────────────────────────────────
// Runs every frame after metrics arrive. Builds a list of active issues,
// then fires fetchSuggestions() if conditions are bad and cooldown has passed.
function checkAndTriggerSuggestions(m) {
  const now        = Date.now();
  const cooledDown = (now - lastSuggestTime) >= SUGGEST_COOLDOWN;
  if (!cooledDown || isFetchingSuggest) return;

  const blink  = blinkWindow.length;   // already updated by detectBlink inside updateDashboard
  const issues = [];

  if (m.strain_score >= 60) issues.push(`high strain score (${m.strain_score}/100)`);
  if (m.ear < 0.22)         issues.push(`very low EAR — eyes drooping (${m.ear.toFixed(3)})`);
  if (blink < 7)            issues.push(`critically low blink rate (${blink}/min)`);
  if (m.redness > 18)       issues.push(`high eye redness (${m.redness.toFixed(1)}%)`);
  if (m.pupil_ratio > 4)    issues.push(`abnormal pupil dilation (${m.pupil_ratio.toFixed(2)})`);

  if (issues.length === 0) return;   // all metrics normal — skip

  // Warn toast naming exactly what triggered this
  const label = issues.slice(0, 2).join(' + ');
  throttleToast(`👁 Issue detected: ${label}. Fetching suggestions...`, 'warn', SUGGEST_COOLDOWN);

  fetchSuggestions(issues);
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
  const blink = detectBlink(m.ear);   // side-effect: updates blinkWindow

  const earState   = m.ear < 0.22       ? 'danger' : m.ear < 0.25       ? 'warn' : 'ok';
  const blinkState = blink < 7          ? 'danger' : blink < 12         ? 'warn' : 'ok';
  const redState   = m.redness > 20     ? 'danger' : m.redness > 12     ? 'warn' : 'ok';
  const pupilState = m.pupil_ratio > 4  ? 'danger' : m.pupil_ratio > 3.5 ? 'warn' : 'ok';

  setMetric('ear',   m.ear.toFixed(3),           (m.ear / 0.4) * 100, earState);
  setMetricHTML('blink', `${blink} <small>/min</small>`, (blink / 25) * 100, blinkState);
  setMetric('red',   `${m.redness.toFixed(1)}%`,  m.redness * 3,       redState);
  setMetric('pupil', m.pupil_ratio.toFixed(2),    m.pupil_ratio * 18,  pupilState);

  updateGauge(m.strain_score);

  // Live badge
  if (m.strain_score >= 70) {
    setLiveBadge('danger', '▲ HIGH STRAIN');
    if (loadSettings().alerts)
      throttleToast(`⚠ High eye strain (${m.strain_score}/100). Take a break!`, 'danger', 60000);
  } else if (m.strain_score >= 40) {
    setLiveBadge('warn', '◉ MODERATE');
  } else {
    setLiveBadge('active', '● LIVE');
  }

  // Per-metric warning toasts
  if (blinkState === 'danger')
    throttleToast(`👁 Blink rate critically low (${blink}/min). Blink consciously!`, 'warn', 60000);
  if (earState === 'danger')
    throttleToast('😴 Eyes drooping (low EAR). Stay alert or take a break.', 'warn', 60000);
  if (redState === 'danger')
    throttleToast('🔴 Eyes very red. Use artificial tears or take a 5-min break.', 'warn', 90000);

  document.getElementById('eye-state-pill').textContent =
    m.eye_state === 'closed' ? '😴 Eyes Closed' :
    m.eye_state === 'open'   ? '👁 Eyes Open'   : '👁 Detecting...';
  document.getElementById('ms-state').textContent = m.eye_state || '--';
}

function setMetric(key, value, pct, state) {
  document.getElementById('v-' + key).textContent = value;
  document.getElementById('b-' + key).style.width = Math.min(100, pct) + '%';
  document.getElementById('mc-' + key).className  = 'metric-card state-' + state;
}
function setMetricHTML(key, html, pct, state) {
  document.getElementById('v-' + key).innerHTML   = html;
  document.getElementById('b-' + key).style.width = Math.min(100, pct) + '%';
  document.getElementById('mc-' + key).className  = 'metric-card state-' + state;
}

function updateGauge(score) {
  document.getElementById('gauge-fill').style.strokeDashoffset = 277 - (score / 100) * 277;
  document.getElementById('gauge-num').textContent = score;
  document.getElementById('strain-hint').textContent =
    score >= 70 ? '🔴 High — Rest Now!' :
    score >= 40 ? '🟡 Moderate'         :
    score  >  0 ? '🟢 Low — Good'       : '—';
}

function setLiveBadge(state, text) {
  const b = document.getElementById('live-badge');
  b.className   = `live-badge live-${state}`;
  b.textContent = text;
}

// ─── RAG Suggestions ─────────────────────────────────────────────────────────
async function fetchSuggestions(issues = []) {
  if (!lastMetrics || !API_BASE) return;
  if (isFetchingSuggest) return;          // already in-flight, skip

  isFetchingSuggest = true;
  lastSuggestTime   = Date.now();

  const box = document.getElementById('suggestions-body');
  const issueLabel = issues.length ? issues.join(', ') : 'current metrics';
  box.innerHTML = `<div class="suggest-placeholder">
    <div class="suggest-icon">⏳</div>
    <p>Fetching RAG suggestions for: <strong>${issueLabel}</strong>...</p>
  </div>`;

  try {
    const res  = await fetch(`${API_BASE}/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...lastMetrics, detected_issues: issues })
    });
    const data = await res.json();

    if (data.success) {
      // Render each bullet as a styled suggestion row
      const lines = data.suggestions.split('\n').filter(l => l.trim());
      box.innerHTML = lines.map(line => {
        const clean = line.replace(/^[\•\-\*]\s*/, '').trim();
        return `<div class="suggest-item">
          <span class="suggest-bullet">→</span>
          <span>${clean}</span>
        </div>`;
      }).join('');

      // Toast with first suggestion as a teaser
      const first = lines[0]?.replace(/^[\•\-\*→]\s*/, '').slice(0, 90);
      if (first) showToast(`💡 ${first}`, 'info');
    } else {
      box.innerHTML = '<div class="suggest-placeholder"><div class="suggest-icon">⚠</div><p>Could not fetch suggestions. Check Colab console.</p></div>';
    }
  } catch {
    box.innerHTML = '<div class="suggest-placeholder"><div class="suggest-icon">⚡</div><p>API error — make sure Colab cell 3.4 is still running.</p></div>';
  } finally {
    isFetchingSuggest = false;   // always release the lock
  }
}

// ─── Session History ──────────────────────────────────────────────────────────
function saveSessionToHistory() {
  const avgScore = Math.round(
    sessionLog.reduce((a, b) => a + b.metrics.strain_score, 0) / sessionLog.length
  );
  const duration = Math.floor((Date.now() - sessionStart) / 1000);
  const sessions = JSON.parse(localStorage.getItem('eg_history') || '[]');
  sessions.unshift({ date: new Date().toLocaleString('en-IN'), score: avgScore, duration, user: USER.email });
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
    const dur = s.duration >= 60 ? `${Math.floor(s.duration/60)}m ${s.duration%60}s` : `${s.duration}s`;
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
  const toast = document.createElement('div');
  toast.className   = `toast ${type}`;
  toast.textContent = msg;
  document.getElementById('toasts').appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

function throttleToast(msg, type, ms) {
  if (toastSet.has(msg)) return;
  toastSet.add(msg);
  showToast(msg, type);
  setTimeout(() => toastSet.delete(msg), ms);
}