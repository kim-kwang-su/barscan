/* ============================================================
   BarScan — App Logic v3
   카메라: getUserMedia 직접 제어
   1D 바코드: Quagga2 decodeSingle (프레임별 이미지 모드)
   QR/2D: ZXing
   정확도: 3회 일치 투표 시스템
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

// ── 상태 변수 ────────────────────────────────────────────────
let cameraStream  = null;      // MediaStream
let animFrame     = null;      // requestAnimationFrame ID
let zxingTimer    = null;      // QR 스캔 인터벌
let scanning      = false;     // 스캔 중 여부
let scanCooldown  = false;     // 인식 후 쿨다운 (중복 방지)
let facingMode    = 'environment';
let torchActive   = false;
let lastResult    = null;
let toastTimer    = null;
let scanTimeout   = null;
let history       = [];

// ── 투표 시스템 (3회 연속 일치 시 확정) ─────────────────────
const VOTE_NEEDED = 3;
let voteCode      = null;
let voteCount     = 0;
let voteFormat    = null;

// ── Native BarcodeDetector (Chrome / Android 기본 API) ──────
let barcodeDetector = null;
const NATIVE_FORMATS = [
  'ean_13','ean_8','code_128','code_39','code_93',
  'upc_a','upc_e','itf','codabar',
  'qr_code','data_matrix','pdf_417','aztec',
];

// ── SPLASH ───────────────────────────────────────────────────
setTimeout(() => {
  splash.classList.add('fade-out');
  app.classList.remove('hidden');
  setTimeout(() => { splash.style.display = 'none'; }, 500);
  initApp();
}, 1800);

// ── 앱 초기화 ────────────────────────────────────────────────
async function initApp() {
  showScannerUI();
  await initBarcodeDetector();   // 네이티브 API 초기화 시도
  await startCamera();           // 카메라 시작
}

// ── 네이티브 BarcodeDetector 초기화 ─────────────────────────
async function initBarcodeDetector() {
  if (!('BarcodeDetector' in window)) return;
  try {
    const supported = await BarcodeDetector.getSupportedFormats();
    const formats   = NATIVE_FORMATS.filter(f => supported.includes(f));
    if (formats.length > 0) {
      barcodeDetector = new BarcodeDetector({ formats });
      console.log('[BarScan] BarcodeDetector 사용 가능:', formats);
    }
  } catch (err) {
    console.warn('[BarScan] BarcodeDetector 초기화 실패:', err);
  }
}

// ────────────────────────────────────────────────────────────
//  카메라 관리 (getUserMedia 직접 제어)
// ────────────────────────────────────────────────────────────
async function startCamera() {
  stopCamera();
  setStatus('starting', '카메라 시작 중...');
  statusDot.className = 'status-dot';

  let stream = null;

  // 1순위: 후면 카메라 (exact)
  const tryGetCamera = async (constraints) => {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: constraints });
    } catch { return null; }
  };

  stream = await tryGetCamera({
    facingMode: { exact: facingMode },
    width:  { ideal: 1920 },
    height: { ideal: 1080 },
  });

  // 2순위: facingMode 힌트만
  if (!stream) {
    stream = await tryGetCamera({
      facingMode,
      width:  { ideal: 1920 },
      height: { ideal: 1080 },
    });
  }

  // 3순위: 아무 카메라
  if (!stream) {
    stream = await tryGetCamera({ width: { ideal: 1280 }, height: { ideal: 720 } });
  }

  if (!stream) {
    handleCameraError({ name: 'NotAllowedError' });
    return;
  }

  cameraStream = stream;
  video.srcObject = stream;

  // 비디오 준비 완료 후 스캔 시작
  video.onloadedmetadata = () => {
    video.play()
      .then(() => {
        setStatus('scanning', '스캔 중...');
        statusDot.className = 'status-dot scanning';
        scanning = true;
        checkTorchSupport();
        startScanLoop();
      })
      .catch(err => handleCameraError(err));
  };
}

function stopCamera() {
  scanning = false;
  scanCooldown = false;
  resetVotes();

  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  if (zxingTimer) { clearInterval(zxingTimer); zxingTimer = null; }
  if (scanTimeout) { clearTimeout(scanTimeout); scanTimeout = null; }

  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  video.srcObject = null;
}

// ────────────────────────────────────────────────────────────
//  스캔 루프 — 엔진 선택
// ────────────────────────────────────────────────────────────
function startScanLoop() {
  if (barcodeDetector) {
    // 최우선: 네이티브 API (가장 정확, 빠름)
    nativeDetectLoop();
  } else {
    // 차선: Quagga2 프레임별 디코드 (1D 바코드)
    quaggaFrameLoop();
  }
  // QR / 2D 바코드는 ZXing으로 병렬 실행 (네이티브가 없을 때)
  if (!barcodeDetector) {
    startZXingQRLoop();
  }
}

// ────────────────────────────────────────────────────────────
//  엔진 A: Native BarcodeDetector (Chrome/Android)
// ────────────────────────────────────────────────────────────
async function nativeDetectLoop() {
  if (!scanning || !barcodeDetector) return;

  if (video.readyState >= 2 && video.videoWidth > 0) {
    try {
      const barcodes = await barcodeDetector.detect(video);
      if (barcodes.length > 0) {
        const { rawValue, format } = barcodes[0];
        addVote(rawValue, format.replace(/_/g, '-').toUpperCase());
      }
    } catch (_) {}
  }

  if (scanning) animFrame = requestAnimationFrame(nativeDetectLoop);
}

// ────────────────────────────────────────────────────────────
//  엔진 B: Quagga2 decodeSingle (1D 바코드 폴백)
//  - 라이브스트림 모드 대신 프레임별 이미지 디코딩 사용
//  - halfSample: false → 정확도 우선
//  - patchSize: large  → 인식 범위 확장
// ────────────────────────────────────────────────────────────
let quaggaBusy = false;

function quaggaFrameLoop() {
  if (!scanning) return;
  if (!window.Quagga || quaggaBusy) {
    if (scanning) animFrame = requestAnimationFrame(quaggaFrameLoop);
    return;
  }
  if (video.readyState < 2 || !video.videoWidth) {
    if (scanning) animFrame = requestAnimationFrame(quaggaFrameLoop);
    return;
  }

  // 현재 프레임 캡처
  const ctx = canvas.getContext('2d');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0);

  // 대비 강화 (인식률 개선)
  enhanceContrast(ctx, canvas.width, canvas.height);

  const dataURL = canvas.toDataURL('image/jpeg', 0.95);
  quaggaBusy = true;

  Quagga.decodeSingle(
    {
      src: dataURL,
      numOfWorkers: 0,       // 메인 스레드 실행 (안정적)
      inputStream: { size: 1000 },
      locator: {
        patchSize: 'large',  // 더 넓은 영역 탐색
        halfSample: false,   // 정확도 우선 (속도 약간 감소)
      },
      locate: true,
      decoder: {
        readers: [
          'ean_reader',
          'ean_8_reader',
          'code_128_reader',
          'code_39_reader',
          'code_93_reader',
          'upc_reader',
          'upc_e_reader',
          'i2of5_reader',
          'codabar_reader',
        ],
        multiple: false,
      },
    },
    (result) => {
      quaggaBusy = false;

      if (result && result.codeResult && result.codeResult.code) {
        // 엄격한 신뢰도 필터 (15% 이하 에러율만 허용)
        const errs = (result.codeResult.decodedCodes || [])
          .filter(x => x.error !== undefined && x.error !== null)
          .map(x => x.error);

        let passConfidence = true;
        if (errs.length > 0) {
          const avg = errs.reduce((a, b) => a + b, 0) / errs.length;
          passConfidence = avg <= 0.15;
        }

        if (passConfidence) {
          const fmt = (result.codeResult.format || 'BARCODE')
            .toUpperCase().replace(/_/g, '-');
          addVote(result.codeResult.code, fmt);
        }
      }

      if (scanning) {
        setTimeout(() => {
          if (scanning) animFrame = requestAnimationFrame(quaggaFrameLoop);
        }, 40);  // 25fps 정도
      }
    }
  );
}

// 대비 강화 (어두운 환경 / 흐린 바코드 보조)
function enhanceContrast(ctx, w, h) {
  try {
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const factor = 1.4; // 대비 배율
    const intercept = 128 * (1 - factor);
    for (let i = 0; i < d.length; i += 4) {
      d[i]     = Math.min(255, Math.max(0, d[i]     * factor + intercept));
      d[i + 1] = Math.min(255, Math.max(0, d[i + 1] * factor + intercept));
      d[i + 2] = Math.min(255, Math.max(0, d[i + 2] * factor + intercept));
    }
    ctx.putImageData(imgData, 0, 0);
  } catch (_) {}
}

// ────────────────────────────────────────────────────────────
//  엔진 C: ZXing — QR / 2D 바코드 병렬 스캔
// ────────────────────────────────────────────────────────────
function startZXingQRLoop() {
  if (!window.ZXing) return;
  zxingTimer = setInterval(() => {
    if (!scanning || scanCooldown) return;
    if (video.readyState < 2 || !video.videoWidth) return;
    tryZXingQR();
  }, 300);
}

function tryZXingQR() {
  try {
    const ctx = canvas.getContext('2d');
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hints   = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      ZXing.BarcodeFormat.QR_CODE,
      ZXing.BarcodeFormat.DATA_MATRIX,
      ZXing.BarcodeFormat.PDF_417,
      ZXing.BarcodeFormat.AZTEC,
    ]);
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);

    const ls     = new ZXing.RGBLuminanceSource(imgData.data, canvas.width, canvas.height);
    const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(ls));
    const reader = new ZXing.MultiFormatReader();
    reader.setHints(hints);
    const result = reader.decode(bitmap);

    if (result) {
      addVote(result.getText(), getZXingFormatName(result.getBarcodeFormat()));
    }
  } catch (_) {}  // NotFoundException 무시
}

// ────────────────────────────────────────────────────────────
//  투표 시스템 — 동일 코드 VOTE_NEEDED회 연속 확인 시 확정
// ────────────────────────────────────────────────────────────
function addVote(code, format) {
  if (!code || !scanning || scanCooldown) return;

  if (code === voteCode) {
    voteCount++;
  } else {
    // 다른 코드 → 리셋 후 첫 표
    voteCode   = code;
    voteFormat = format;
    voteCount  = 1;
  }

  // 진행 상황 피드백 (스캔라인 색상으로 표시)
  const progress = Math.round((voteCount / VOTE_NEEDED) * 100);
  camStatusText.textContent = voteCount > 1
    ? `확인 중... (${voteCount}/${VOTE_NEEDED})`
    : '스캔 중...';

  if (voteCount >= VOTE_NEEDED) {
    const finalCode   = voteCode;
    const finalFormat = voteFormat;
    resetVotes();
    onScanSuccess(finalCode, finalFormat);
  }
}

function resetVotes() {
  voteCode   = null;
  voteCount  = 0;
  voteFormat = null;
}

// ────────────────────────────────────────────────────────────
//  스캔 성공 처리
// ────────────────────────────────────────────────────────────
function onScanSuccess(text, format) {
  if (scanCooldown) return;
  scanCooldown = true;
  scanning = false;

  // 햅틱
  if (navigator.vibrate) navigator.vibrate([80, 40, 80]);

  // UI
  setStatus('success', '인식 완료!');
  statusDot.className = 'status-dot success';
  formatBadge.textContent = format;
  formatBadge.classList.remove('hidden');
  scanLine.style.animationPlayState = 'paused';

  lastResult = { text, format };
  resultValue.textContent = text;
  resultFormatLabel.textContent = format;
  resultPanel.classList.remove('hidden');
  btnOpenLink.style.display = isValidUrl(text) ? '' : 'none';

  saveToHistory(text, format);

  // 6초 후 자동 재개
  scanTimeout = setTimeout(resumeScanning, 6000);
}

function resumeScanning() {
  clearTimeout(scanTimeout);
  scanCooldown = false;
  resetVotes();

  resultPanel.classList.add('hidden');
  formatBadge.classList.add('hidden');
  scanLine.style.animationPlayState = 'running';
  setStatus('scanning', '스캔 중...');
  statusDot.className = 'status-dot scanning';

  scanning = true;
  // 루프 재기동 (animFrame이 종료됐을 수 있음)
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  startScanLoop();
}

// ── 카메라 전환 ───────────────────────────────────────────────
btnFlip.addEventListener('click', async () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  torchActive = false;
  btnTorch.classList.remove('active');
  await startCamera();
});

// ── 플래시 ───────────────────────────────────────────────────
btnTorch.addEventListener('click', async () => {
  if (!cameraStream) return;
  const track = cameraStream.getVideoTracks()[0];
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
  initApp();
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
    try { await navigator.clipboard.writeText(lastResult.text); }
    catch (_) {}
    showToast('📋 클립보드에 복사했습니다');
  }
});

// ── 카메라 유틸 ──────────────────────────────────────────────
function checkTorchSupport() {
  if (!cameraStream) return;
  const track = cameraStream.getVideoTracks()[0];
  if (!track) return;
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    btnTorch.style.display = caps.torch ? '' : 'none';
  } catch (_) {
    btnTorch.style.display = 'none';
  }
}

function showScannerUI() {
  permState.classList.add('hidden');
  resultPanel.classList.add('hidden');
}

function handleCameraError(err) {
  console.error('[BarScan] Camera error:', err);
  scanning = false;
  let title = '카메라 오류';
  let desc  = '카메라를 시작하는 중 문제가 발생했습니다.';
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    title = '카메라 권한 필요';
    desc  = '바코드를 스캔하려면 카메라 접근 권한이 필요합니다.\n브라우저 설정에서 카메라를 허용해주세요.';
  } else if (name === 'NotFoundError') {
    title = '카메라를 찾을 수 없음';
    desc  = '사용 가능한 카메라가 없습니다. 기기에 카메라가 연결되어 있는지 확인해주세요.';
  } else if (name === 'NotReadableError') {
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
    const iconSvg = isUrl
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
           <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
         </svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <rect x="3" y="3" width="3" height="14"/><rect x="9" y="3" width="1.5" height="14"/>
           <rect x="13" y="3" width="3" height="14"/><rect x="19" y="3" width="1.5" height="14"/>
         </svg>`;

    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `
      <div class="history-icon ${isUrl ? 'url-type' : 'text-type'}">${iconSvg}</div>
      <div class="history-body">
        <div class="history-value">${escHtml(item.text)}</div>
        <div class="history-meta">
          <span class="history-format">${escHtml(item.format)}</span>
          <span class="history-time">${formatTime(item.time)}</span>
        </div>
      </div>
      <button class="history-del-btn" aria-label="삭제">
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

// ── 포맷명 변환 ───────────────────────────────────────────────
function getZXingFormatName(format) {
  const m = {
    0: 'AZTEC', 1: 'CODABAR', 2: 'CODE-39', 3: 'CODE-93',
    4: 'CODE-128', 5: 'DATA-MATRIX', 6: 'EAN-8', 7: 'EAN-13',
    8: 'ITF', 10: 'PDF-417', 11: 'QR-CODE', 12: 'RSS-14',
    14: 'UPC-A', 15: 'UPC-E',
  };
  return m[format] || 'BARCODE';
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
  const d = new Date(ts);
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1)    return '방금 전';
  if (diffMin < 60)   return `${diffMin}분 전`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}시간 전`;
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

// ── 초기화 ────────────────────────────────────────────────────
loadHistory();
updateBadge();
renderHistory();

// 화면 숨김 → 복귀 시 카메라 재시작
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    const onScanner = tabContents.scanner.classList.contains('active');
    const resultShown = !resultPanel.classList.contains('hidden');
    if (onScanner && !resultShown && cameraStream && !scanning) {
      scanning = true;
      startScanLoop();
    }
  }
});
