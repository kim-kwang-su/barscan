/* ============================================================
   BarScan — App Logic
   Quagga2 (1D 바코드) + ZXing (QR/2D) 이중 스캔
   ============================================================ */
'use strict';

// ── DOM refs ────────────────────────────────────────────────
const splash            = document.getElementById('splash');
const app               = document.getElementById('app');
const video             = document.getElementById('video');
const canvas            = document.getElementById('canvas');
const scanLine          = document.getElementById('scan-line');
const camStatus         = document.getElementById('cam-status');
const camStatusText     = document.getElementById('cam-status-text');
const statusDot         = camStatus.querySelector('.status-dot');
const formatBadge       = document.getElementById('format-badge');
const permState         = document.getElementById('permission-state');
const permTitle         = document.getElementById('perm-title');
const permDesc          = document.getElementById('perm-desc');
const resultPanel       = document.getElementById('result-panel');
const resultValue       = document.getElementById('result-value');
const resultFormatLabel = document.getElementById('result-format-label');
const btnRetry          = document.getElementById('btn-retry');
const btnCloseResult    = document.getElementById('btn-close-result');
const btnCopy           = document.getElementById('btn-copy');
const btnOpenLink       = document.getElementById('btn-open-link');
const btnShare          = document.getElementById('btn-share');
const btnScanAgain      = document.getElementById('btn-scan-again');
const btnFlip           = document.getElementById('btn-flip');
const btnTorch          = document.getElementById('btn-torch');
const historyList       = document.getElementById('history-list');
const historyEmpty      = document.getElementById('history-empty');
const historyBadge      = document.getElementById('history-badge');
const btnClearHistory   = document.getElementById('btn-clear-history');
const toast             = document.getElementById('toast');

const tabBtns     = document.querySelectorAll('.tab-btn');
const tabContents = {
  scanner: document.getElementById('tab-content-scanner'),
  history: document.getElementById('tab-content-history'),
};

// ── State ────────────────────────────────────────────────────
let quaggaRunning = false;
let zxingTimer    = null;
let facingMode    = 'environment';
let torchActive   = false;
let scanning      = false;
let lastResult    = null;
let scanCooldown  = false;   // 중복 인식 방지
let toastTimer    = null;
let scanTimeout   = null;
let history       = [];

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

// ── 스캐너 초기화 ────────────────────────────────────────────
async function initScanner() {
  showScannerUI();
  setStatus('starting', '카메라 시작 중...');
  await startQuagga();
  startZXingQRLoop();
}

// ────────────────────────────────────────────────────────────
//  Quagga2 — 1D 바코드 스캐너 (EAN-13/8, Code128, UPC 등)
// ────────────────────────────────────────────────────────────
function startQuagga() {
  return new Promise((resolve) => {
    if (quaggaRunning) {
      Quagga.stop();
      quaggaRunning = false;
    }

    if (typeof Quagga === 'undefined') {
      console.warn('Quagga2 라이브러리가 없습니다. ZXing만 사용합니다.');
      startFallbackCamera().then(resolve);
      return;
    }

    Quagga.init({
      inputStream: {
        name: 'Live',
        type: 'LiveStream',
        target: video,          // 기존 <video> 엘리먼트 재활용
        constraints: {
          width:  { min: 640, ideal: 1920 },
          height: { min: 480, ideal: 1080 },
          facingMode: facingMode,
        },
        // 인식 영역: 화면 중앙 80% 만 스캔 (노이즈 감소)
        area: {
          top:    '15%',
          right:  '5%',
          left:   '5%',
          bottom: '15%',
        },
      },
      locator: {
        patchSize: 'medium',   // 'small' | 'medium' | 'large' | 'x-large'
        halfSample: true,
      },
      numOfWorkers: Math.min(navigator.hardwareConcurrency || 2, 4),
      frequency: 15,           // 초당 디코딩 횟수
      decoder: {
        readers: [
          'ean_reader',        // EAN-13  ← 첨부 바코드 형식
          'ean_8_reader',      // EAN-8
          'code_128_reader',   // Code128
          'code_39_reader',    // Code39
          'code_93_reader',    // Code93
          'upc_reader',        // UPC-A
          'upc_e_reader',      // UPC-E
          'i2of5_reader',      // ITF (Interleaved 2 of 5)
          'codabar_reader',    // Codabar
        ],
        multiple: false,
      },
      locate: true,
    }, (err) => {
      if (err) {
        console.error('Quagga init error:', err);
        handleCameraError(err);
        resolve();
        return;
      }
      Quagga.start();
      quaggaRunning = true;
      scanning = true;
      setStatus('scanning', '스캔 중...');
      checkTorchSupport();
      resolve();
    });

    // 1D 바코드 인식 콜백
    Quagga.onDetected((result) => {
      if (!scanning || scanCooldown) return;
      if (!result || !result.codeResult || !result.codeResult.code) return;

      // 신뢰도 필터: 에러율 25% 초과 시 무시
      const errors = (result.codeResult.decodedCodes || [])
        .filter(x => x.error !== undefined && x.error !== null)
        .map(x => x.error);
      if (errors.length > 0) {
        const avgErr = errors.reduce((a, b) => a + b, 0) / errors.length;
        if (avgErr > 0.25) return;
      }

      const code   = result.codeResult.code;
      const fmt    = (result.codeResult.format || 'barcode')
                       .toUpperCase().replace(/_/g, '-');
      onScanSuccess(code, fmt);
    });
  });
}

// Quagga2가 없을 때 기본 카메라 시작 (ZXing 전용 모드)
async function startFallbackCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    video.srcObject = stream;
    await video.play();
    scanning = true;
    setStatus('scanning', '스캔 중...');
    checkTorchSupport();
  } catch (err) {
    handleCameraError(err);
  }
}

// ────────────────────────────────────────────────────────────
//  ZXing — QR코드 / 2D 바코드 전용 (주기적 프레임 캡처)
// ────────────────────────────────────────────────────────────
function startZXingQRLoop() {
  clearZXingTimer();
  if (typeof ZXing === 'undefined') return;

  zxingTimer = setInterval(() => {
    if (!scanning || scanCooldown) return;
    if (!video || !video.videoWidth || video.readyState < 2) return;
    tryDecodeQR();
  }, 300);
}

function tryDecodeQR() {
  try {
    const ctx = canvas.getContext('2d');
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      ZXing.BarcodeFormat.QR_CODE,
      ZXing.BarcodeFormat.DATA_MATRIX,
      ZXing.BarcodeFormat.PDF_417,
      ZXing.BarcodeFormat.AZTEC,
    ]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);

    const luminanceSource = new ZXing.RGBLuminanceSource(
      imageData.data, canvas.width, canvas.height
    );
    const binaryBitmap = new ZXing.BinaryBitmap(
      new ZXing.HybridBinarizer(luminanceSource)
    );
    const reader = new ZXing.MultiFormatReader();
    reader.setHints(hints);
    const result = reader.decode(binaryBitmap);

    if (result) {
      const fmt = getZXingFormatName(result.getBarcodeFormat());
      onScanSuccess(result.getText(), fmt);
    }
  } catch (_) {
    // NotFoundException → 정상 (바코드 없음)
  }
}

function clearZXingTimer() {
  if (zxingTimer) { clearInterval(zxingTimer); zxingTimer = null; }
}

// ── 스캔 성공 처리 ────────────────────────────────────────────
function onScanSuccess(text, format) {
  if (!scanning || scanCooldown) return;

  // 쿨다운 (연속 중복 인식 방지)
  scanCooldown = true;
  setTimeout(() => { scanCooldown = false; }, 1500);

  lastResult = { text, format };
  scanning = false;

  // 햅틱 피드백
  if (navigator.vibrate) navigator.vibrate([60, 30, 60]);

  // UI 업데이트
  setStatus('success', '인식 완료!');
  statusDot.className = 'status-dot success';
  formatBadge.textContent = format;
  formatBadge.classList.remove('hidden');
  scanLine.style.animationPlayState = 'paused';

  resultValue.textContent = text;
  resultFormatLabel.textContent = format;
  resultPanel.classList.remove('hidden');
  btnOpenLink.style.display = isValidUrl(text) ? '' : 'none';

  saveToHistory(text, format);

  // 5초 후 자동 재스캔
  scanTimeout = setTimeout(resumeScanning, 5000);
}

function resumeScanning() {
  clearTimeout(scanTimeout);
  resultPanel.classList.add('hidden');
  formatBadge.classList.add('hidden');
  scanLine.style.animationPlayState = 'running';
  setStatus('scanning', '스캔 중...');
  statusDot.className = 'status-dot scanning';
  scanning = true;
}

// ── 카메라 전환 ───────────────────────────────────────────────
btnFlip.addEventListener('click', async () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  clearZXingTimer();
  resultPanel.classList.add('hidden');
  scanning = false;

  if (quaggaRunning) { Quagga.stop(); quaggaRunning = false; }

  await startQuagga();
  startZXingQRLoop();
});

// ── 플래시 (토치) ─────────────────────────────────────────────
btnTorch.addEventListener('click', async () => {
  const track = getActiveTrack();
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

// ── Result Actions ────────────────────────────────────────────
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
    try { await navigator.share({ title: 'BarScan', text: lastResult.text }); }
    catch (_) {}
  } else {
    await navigator.clipboard.writeText(lastResult.text);
    showToast('📋 클립보드에 복사했습니다');
  }
});

// ── 유틸리티 ─────────────────────────────────────────────────
function getActiveTrack() {
  // Quagga2 스트림 또는 fallback 스트림에서 트랙 추출
  if (typeof Quagga !== 'undefined' && quaggaRunning) {
    try { return Quagga.CameraAccess.getActiveTrack(); } catch (_) {}
  }
  const v = video;
  if (v && v.srcObject) {
    const tracks = v.srcObject.getVideoTracks();
    return tracks[0] || null;
  }
  return null;
}

function checkTorchSupport() {
  const track = getActiveTrack();
  if (!track) return;
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.torch) btnTorch.style.display = '';
  } catch (_) {}
}

function showScannerUI() {
  permState.classList.add('hidden');
  resultPanel.classList.add('hidden');
}

function handleCameraError(err) {
  console.error('Camera error:', err);
  scanning = false;
  let title = '카메라 오류';
  let desc  = '카메라를 시작하는 중 문제가 발생했습니다.';
  if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
    title = '카메라 권한 필요';
    desc  = '바코드를 스캔하려면 카메라 접근 권한이 필요합니다.\n브라우저 설정에서 카메라를 허용해주세요.';
  } else if (err && err.name === 'NotFoundError') {
    title = '카메라를 찾을 수 없음';
    desc  = '사용 가능한 카메라가 없습니다. 기기에 카메라가 연결되어 있는지 확인해주세요.';
  } else if (err && err.name === 'NotReadableError') {
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

// ── History ───────────────────────────────────────────────────
function loadHistory() {
  try { history = JSON.parse(localStorage.getItem('barscan-history') || '[]'); }
  catch { history = []; }
}

function saveHistory() {
  localStorage.setItem('barscan-history', JSON.stringify(history));
}

function saveToHistory(text, format) {
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
      : `<svg width="16" height="16" viewBox="0 0 56 56" fill="none">
           <rect x="12" y="14" width="4" height="20" fill="currentColor"/>
           <rect x="20" y="14" width="2" height="20" fill="currentColor"/>
           <rect x="26" y="14" width="6" height="20" fill="currentColor"/>
           <rect x="36" y="14" width="2" height="20" fill="currentColor"/>
           <rect x="42" y="14" width="4" height="20" fill="currentColor"/>
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

    div.querySelector('.history-body').addEventListener('click', () => showHistoryDetail(item));
    div.querySelector('.history-del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryItem(idx);
    });
    historyList.appendChild(div);
  });
}

function showHistoryDetail(item) {
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

// ── Toast ─────────────────────────────────────────────────────
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

// ── 포맷 이름 변환 ────────────────────────────────────────────
function getZXingFormatName(format) {
  const names = {
    0:  'AZTEC',   1: 'CODABAR',   2: 'CODE-39',  3: 'CODE-93',
    4:  'CODE-128', 5: 'DATA-MATRIX', 6: 'EAN-8', 7: 'EAN-13',
    8:  'ITF',    10: 'PDF-417',   11: 'QR-CODE', 12: 'RSS-14',
    14: 'UPC-A',  15: 'UPC-E',
  };
  return names[format] || 'BARCODE';
}

// ── 공통 유틸 ─────────────────────────────────────────────────
function isValidUrl(str) {
  try { const u = new URL(str); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatTime(ts) {
  const d = new Date(ts), now = new Date();
  const diffMin = Math.floor((now - d) / 60000);
  if (diffMin < 1)    return '방금 전';
  if (diffMin < 60)   return `${diffMin}분 전`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}시간 전`;
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

// ── 초기화 ────────────────────────────────────────────────────
loadHistory();
updateBadge();
renderHistory();

// 화면 숨김/표시 처리
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    const onScanner = tabContents.scanner.classList.contains('active');
    const resultShown = !resultPanel.classList.contains('hidden');
    if (onScanner && !resultShown && !scanning) {
      scanning = true;
    }
  }
});
