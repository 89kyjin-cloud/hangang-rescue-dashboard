/* HED v1.0 Phase 3.2 TimeoutGuard
 * 목적: api.hrfco.go.kr 등 외부 API 요청이 응답 없이 멈출 때 10초 후 자동 중단하여
 *       후보 스캔이 "대기 중"에서 무한 정지되는 것을 방지합니다.
 * 사용: index.html에서 js/app.js 다음 줄에 아래처럼 추가합니다.
 * <script src="js/timeoutguard.js?v=20260628-timeoutguard"></script>
 */
(function(){
  if (window.__HED_TIMEOUT_GUARD__) return;
  window.__HED_TIMEOUT_GUARD__ = true;

  const DEFAULT_TIMEOUT_MS = 10000;
  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!originalFetch) return;

  function maskSecrets(s){
    return String(s || '')
      .replace(/serviceKey=([^&\s]+)/gi, 'serviceKey=***')
      .replace(/\/([A-Za-z0-9%+\-_]{20,})\//g, '/***/')
      .replace(/[A-Fa-f0-9]{32,}/g, '***')
      .replace(/[0-9A-Za-z%+\-_]{36,}/g, '***');
  }

  function appendLog(line){
    const safe = maskSecrets(line);
    const el = document.getElementById('rawLog');
    if (el) {
      el.textContent += (el.textContent ? '\n' : '') + safe;
      el.scrollTop = el.scrollHeight;
    }
    try { console.warn(safe); } catch (_) {}
  }

  function getTimeoutMs(){
    const fromStorage = Number(localStorage.getItem('hedFetchTimeoutMs') || '');
    if (Number.isFinite(fromStorage) && fromStorage >= 3000) return fromStorage;
    return DEFAULT_TIMEOUT_MS;
  }

  window.fetch = function hedTimeoutFetch(input, init){
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const options = init ? Object.assign({}, init) : {};

    // 이미 signal이 있으면 기존 호출 의도를 존중합니다.
    if (options.signal) return originalFetch(input, options);

    const timeoutMs = getTimeoutMs();
    const controller = new AbortController();
    const timer = setTimeout(function(){
      controller.abort();
    }, timeoutMs);

    options.signal = controller.signal;
    if (!options.cache) options.cache = 'no-store';

    return originalFetch(input, options).finally(function(){
      clearTimeout(timer);
    }).catch(function(err){
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        appendLog(`[요청 타임아웃] ${Math.round(timeoutMs/1000)}초 초과 · 다음 후보로 진행 필요 · ${url}`);
      } else {
        appendLog(`[요청 오류] ${err && err.name ? err.name : 'Error'} · ${err && err.message ? err.message : err} · ${url}`);
      }
      throw err;
    });
  };

  appendLog(`[TimeoutGuard] 적용 완료 · API 요청 ${Math.round(getTimeoutMs()/1000)}초 초과 시 자동 중단`);
})();
