/* ============================================================
   BarScan — App Logic
   ============================================================ */
'use strict';

// ── DOM refs ────────────────────────────────────────────────
const splash        = document.getElementById('splash');
const app           = document.getElementById('app');
const video         = document.getElementById('video');
const canvas        = document.getElementById('canvas');
const scanLine      = document.getElementById('scan-line');
const camStatus     = document.getElementById('cam-status');
const camStatusText = document.getElementById('cam-status-text');
const statusDot     = camStatus.querySelector('.status-dot');
const formatBadge   = document.getElementById('format-badge');
const permState     = document.getElementById('permission-state');
const permTitle     = document.getElementById('perm-title');
const permDesc      = document.getElementById('perm-desc');
const resultPanel   = document.getElementById('result-panel');
const resultValue   = document.getElementById('result-value');
const resultFormatLabel = document.getElementById('result-format-label');
const btnRetry      = document.getElementById('btn-retry');
const btnCloseResult= document.getElementById('btn-close-result');
const btnCopy       = document.getElementById('btn-copy');
const btnOpenLink   = document.getElementById('btn-open-link');
const btnShare      = document.getElementById('btn-share');
const btnScanAgain  = document.getElementById('btn-scan-again');
const btnFlip       = document.getElementById('btn-flip');
const btnTorch      = document.getElementById('btn-torch');
const btnHistory    = document.getElementById('btn-history');
const historyList   = document.getElementById('history-list');
const historyEmpty  = document.getElementById('history-empty');
const historyBadge  = document.getElementById('history-badge');
const btnClearHistory = document.getElementById('btn-clear-history');
const toast         = document.getElementById('toast');

// Tab elements
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = {
  scanner: document.getElementById('tab-content-scanner'),
  history: document.getElementById('tab-content-history'),
};

// ── State ────────────────────────────────────────────────────
let stream        = null;
let codeReader    = null;
let scanning      = false;
let torchActive   = false;
let facingMode    = 'environment'; // 'environment' = back camera
let lastResult    = null;
let toastTimer    = null;
let history       = [];
let scanTimeout   = null;

// ── SPLASH ───────────────────────────────────────────────────
setTimeout(() => {
  splash.classList.add('fade-out');
  app.classList.remove('hidden');
  setTimeout(() => { splash.style.display = 'none'; }, 500);
  initScanner();
}, 1800);

// ── TAB NAVIGATION ───────────────────────────────────────────
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    Object.keys(tabContents).forEach(k => {
      tabContents[k].classList.toggle('hidden', k !== tab);
      tabContents[k].classList.toggle('active', k === tab);
    });
    if (tab === 'history') renderHistory();
  });
});

// ── SCANNER INIT ─────────────────────────────────────────────
async function initScanner() {
  showScannerUI();
  await startCamera();
}

async function startCamera() {
  try {
    stopCurrentStream();
    setStatus('starting', '카메라 시작 중...');

    const constraints = {
      video: {
        facingMode,
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      }
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();

    // Check torch support
    checkTorchSupport();

    // Start ZXing decode loop
    startDecoding();

  } catch (err) {
    handleCameraError(err);
  }
}

function stopCurrentStream() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  if (codeReader) {
    try { codeReader.reset(); } catch (_) {}
    codeReader = null;
  }
  scanning = false;
}

// ── ZXing decoding ───────────────────────────────────────────
function startDecoding() {
  if (!window.ZXing) {
    showToast('⚠️ ZXing 라이브러리 로드 실패');
    return;
  }
  setStatus('scanning', '스캔 중...');
  scanning = true;
  decodeFrame();
}

function decodeFrame() {
  if (!scanning || !stream) return;

  const ctx = canvas.getContext('2d');
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    try {
      const hints = new Map();
      const formats = [
        ZXing.BarcodeFormat.QR_CODE,
        ZXing.BarcodeFormat.DATA_MATRIX,
        ZXing.BarcodeFormat.EAN_13,
        ZXing.BarcodeFormat.EAN_8,
        ZXing.BarcodeFormat.CODE_128,
        ZXing.BarcodeFormat.CODE_39,
        ZXing.BarcodeFormat.CODE_93,
        ZXing.BarcodeFormat.UPC_A,
        ZXing.BarcodeFormat.UPC_E,
        ZXing.BarcodeFormat.ITF,
        ZXing.BarcodeFormat.RSS_14,
        ZXing.BarcodeFormat.AZTEC,
        ZXing.BarcodeFormat.PDF_417,
      ];
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);

      const luminanceSource = new ZXing.RGBLuminanceSource(
        imageData.data,
        canvas.width,
        canvas.height
      );
      const binaryBitmap = new ZXing.BinaryBitmap(
        new ZXing.HybridBinarizer(luminanceSource)
      );

      const reader = new ZXing.MultiFormatReader();
      reader.setHints(hints);
      const result = reader.decode(binaryBitmap);

      if (result) {
        onScanSuccess(result.getText(), result.getBarcodeFormat());
        return;
      }
    } catch (_) {
      // NotFoundException is normal — keep scanning
    }
  }

  // Schedule next frame
  if (scanning) {
    requestAnimationFrame(decodeFrame);
  }
}

// ── Scan Result ──────────────────────────────────────────────
function onScanSuccess(text, format) {
  if (!scanning) return;

  const formatName = getBarcodeFormatName(format);
  lastResult = { text, format: formatName };

  // Pause scanning momentarily
  scanning = false;

  // Haptic feedback
  if (navigator.vibrate) navigator.vibrate([60, 30, 60]);

  // Update UI
  setStatus('success', '인식 완료!');
  statusDot.className = 'status-dot success';
  formatBadge.textContent = formatName;
  formatBadge.classList.remove('hidden');
  scanLine.style.animationPlayState = 'paused';

  // Show result panel
  resultValue.textContent = text;
  resultFormatLabel.textContent = formatName;
  resultPanel.classList.remove('hidden');

  // Show/hide open link button
  const isUrl = isValidUrl(text);
  btnOpenLink.style.display = isUrl ? '' : 'none';

  // Save to history
  saveToHistory(text, formatName);

  // Auto-resume after 5 seconds unless user acts
  scanTimeout = setTimeout(() => {
    resumeScanning();
  }, 5000);
}

function resumeScanning() {
  clearTimeout(scanTimeout);
  resultPanel.classList.add('hidden');
  formatBadge.classList.add('hidden');
  scanLine.style.animationPlayState = 'running';
  setStatus('scanning', '스캔 중...');
  statusDot.className = 'status-dot scanning';
  scanning = true;
  decodeFrame();
}

// ── Result Actions ───────────────────────────────────────────
btnCloseResult.addEventListener('click', resumeScanning);
btnScanAgain.addEventListener('click', resumeScanning);

btnCopy.addEventListener('click', async () => {
  if (!lastResult) return;
  try {
    await navigator.clipboard.writeText(lastResult.text);
    showToast('✅ 클립보드에 복사되었습니다');
  } catch {
    showToast('❌ 복사 실패');
  }
});

btnOpenLink.addEventListener('click', () => {
  if (lastResult) window.open(lastResult.text, '_blank', 'noopener');
});

btnShare.addEventListener('click', async () => {
  if (!lastResult) return;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'BarScan', text: lastResult.text });
    } catch (_) {}
  } else {
    await navigator.clipboard.writeText(lastResult.text);
    showToast('📋 공유가 지원되지 않아 클립보드에 복사했습니다');
  }
});

// ── Camera Controls ──────────────────────────────────────────
btnFlip.addEventListener('click', async () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  stopCurrentStream();
  resultPanel.classList.add('hidden');
  await startCamera();
});

btnTorch.addEventListener('click', async () => {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  try {
    torchActive = !torchActive;
    await track.applyConstraints({ advanced: [{ torch: torchActive }] });
    btnTorch.classList.toggle('active', torchActive);
    showToast(torchActive ? '💡 플래시 켜짐' : '💡 플래시 꺼짐');
  } catch {
    showToast('⚠️ 플래시를 지원하지 않습니다');
    torchActive = false;
  }
});

btnRetry.addEventListener('click', () => {
  permState.classList.add('hidden');
  initScanner();
});

// ── Torch detection ──────────────────────────────────────────
function checkTorchSupport() {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  if (caps.torch) {
    btnTorch.style.display = '';
  }
}

// ── UI Helpers ───────────────────────────────────────────────
function showScannerUI() {
  permState.classList.add('hidden');
  resultPanel.classList.add('hidden');
}

function handleCameraError(err) {
  console.error('Camera error:', err);
  scanning = false;
  let title = '카메라 오류';
  let desc  = '카메라를 시작하는 중 문제가 발생했습니다.';
  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
    title = '카메라 권한 필요';
    desc  = '바코드를 스캔하려면 카메라 접근 권한이 필요합니다.\n브라우저 설정에서 카메라를 허용해주세요.';
  } else if (err.name === 'NotFoundError') {
    title = '카메라를 찾을 수 없음';
    desc  = '사용 가능한 카메라가 없습니다. 카메라가 연결되어 있는지 확인해주세요.';
  } else if (err.name === 'NotReadableError') {
    title = '카메라 사용 중';
    desc  = '다른 앱이 카메라를 사용 중입니다. 다른 앱을 닫고 다시 시도해주세요.';
  }
  setStatus('error', '카메라 오류');
  statusDot.className = 'status-dot error';
  permTitle.textContent = title;
  permDesc.textContent  = desc;
  permState.classList.remove('hidden');
}

function setStatus(type, text) {
  camStatusText.textContent = text;
  statusDot.className = 'status-dot ' + type;
}

// ── History ──────────────────────────────────────────────────
function loadHistory() {
  try { history = JSON.parse(localStorage.getItem('barscan-history') || '[]'); } 
  catch { history = []; }
}

function saveHistory() {
  localStorage.setItem('barscan-history', JSON.stringify(history));
}

function saveToHistory(text, format) {
  // Avoid duplicates at the top
  history = history.filter(h => h.text !== text);
  history.unshift({ text, format, time: Date.now() });
  if (history.length > 100) history.pop();
  saveHistory();
  updateBadge();
}

function deleteHistoryItem(idx) {
  history.splice(idx, 1);
  saveHistory();
  updateBadge();
  renderHistory();
}

function renderHistory() {
  historyList.innerHTML = '';
  if (history.length === 0) {
    historyEmpty.classList.remove('hidden');
    historyList.classList.add('hidden');
    return;
  }
  historyEmpty.classList.add('hidden');
  historyList.classList.remove('hidden');

  history.forEach((item, idx) => {
    const isUrl = isValidUrl(item.text);
    const iconClass = isUrl ? 'url-type' : 'text-type';
    const iconSvg = isUrl
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
           <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
         </svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <rect x="3" y="3" width="18" height="18" rx="2"/>
           <path d="M8 12h8"/><path d="M12 8v8"/>
         </svg>`;

    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `
      <div class="history-icon ${iconClass}">${iconSvg}</div>
      <div class="history-body">
        <div class="history-value">${escHtml(item.text)}</div>
        <div class="history-meta">
          <span class="history-format">${escHtml(item.format)}</span>
          <span class="history-time">${formatTime(item.time)}</span>
        </div>
      </div>
      <button class="history-del-btn" data-idx="${idx}" aria-label="삭제">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>`;

    // Click body → show detail / copy
    div.querySelector('.history-body').addEventListener('click', () => {
      showHistoryDetail(item);
    });

    // Delete button
    div.querySelector('.history-del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryItem(idx);
    });

    historyList.appendChild(div);
  });
}

function showHistoryDetail(item) {
  // Switch to scanner tab and show result
  tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === 'scanner'));
  Object.keys(tabContents).forEach(k => {
    tabContents[k].classList.toggle('hidden', k !== 'scanner');
    tabContents[k].classList.toggle('active', k === 'scanner');
  });
  lastResult = item;
  resultValue.textContent = item.text;
  resultFormatLabel.textContent = item.format;
  btnOpenLink.style.display = isValidUrl(item.text) ? '' : 'none';
  resultPanel.classList.remove('hidden');
  scanLine.style.animationPlayState = 'paused';
  scanning = false;
}

function updateBadge() {
  const count = history.length;
  historyBadge.textContent = count;
  historyBadge.classList.toggle('hidden', count === 0);
}

btnClearHistory.addEventListener('click', () => {
  if (!history.length) return;
  history = [];
  saveHistory();
  updateBadge();
  renderHistory();
  showToast('🗑️ 기록이 모두 삭제되었습니다');
});

// ── Toast ────────────────────────────────────────────────────
function showToast(msg, duration = 2400) {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.classList.remove('hidden');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('show'));
  });
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 280);
  }, duration);
}

// ── Utilities ────────────────────────────────────────────────
function isValidUrl(str) {
  try { const u = new URL(str); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1)   return '방금 전';
  if (diffMin < 60)  return `${diffMin}분 전`;
  if (diffMin < 1440) return `${Math.floor(diffMin/60)}시간 전`;
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function getBarcodeFormatName(format) {
  const names = {
    0:  'AZTEC', 1: 'CODABAR', 2: 'CODE_39', 3: 'CODE_93', 4: 'CODE_128',
    5:  'DATA_MATRIX', 6: 'EAN_8', 7: 'EAN_13', 8: 'ITF',
    9:  'MAXICODE', 10: 'PDF_417', 11: 'QR_CODE', 12: 'RSS_14',
    13: 'RSS_EXPANDED', 14: 'UPC_A', 15: 'UPC_E', 16: 'UPC_EAN_EXTENSION',
  };
  if (typeof format === 'number') return names[format] || 'BARCODE';
  const s = String(format);
  return s.replace(/.*\./, '').replace(/_/g, ' ') || 'BARCODE';
}

// ── Init ─────────────────────────────────────────────────────
loadHistory();
updateBadge();
renderHistory();

// Handle page visibility (pause/resume camera)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Pause on hide
    if (scanning) { scanning = false; }
  } else {
    // Resume on show (only if on scanner tab)
    const onScanner = tabContents.scanner.classList.contains('active');
    if (onScanner && stream && !resultPanel.classList.contains('hidden') === false) {
      scanning = true;
      decodeFrame();
    }
  }
});
