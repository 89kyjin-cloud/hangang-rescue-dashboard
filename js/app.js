/* HanRiver Environment Dashboard v1.0 Phase 2.2 FlowFix
 * 원칙: 확인된 원자료/계산값/검증필요를 구분한다.
 * 수정: 수위·방류량 필드 자동검증, 투신시점/조회시점 환경 비교, 교량 영향 방류량은 팔당 지연시간 보정.
 * 주의: 물 방향/물살은 유속 실측값이 아니라 수위변화·방류량·조석보정 기반 참고판정이다.
 */
const $ = (id) => document.getElementById(id);
const logLines = [];
function log(...args){
  const line = args.map(v => typeof v === 'string' ? v : JSON.stringify(v, null, 2)).join(' ');
  logLines.push(maskSecrets(line));
  const el = $('rawLog'); if (el) el.textContent = logLines.join('\n');
}
function clearLog(){ logLines.length = 0; const el=$('rawLog'); if(el) el.textContent=''; }
function maskSecrets(s){
  return String(s)
    .replace(/serviceKey=([^&\s]+)/gi, 'serviceKey=***')
    .replace(/\/([A-Za-z0-9%+\-_]{20,})\//g, '/***/')
    .replace(/[A-Fa-f0-9]{32,}/g, '***')
    .replace(/[0-9A-Za-z%+\-_]{36,}/g, '***');
}

const DAM_CODE = '1017310';
const TIDE_STATION = 'DT_0001';
const MAX_NEAREST_MIN = 40;
const WATER_KEYS = ['wl','WL','waterLevel','water_level','obsWl','obs_wl','wlevel','level','wlv','rfwl','fw'];
const DAM_KEYS = ['tototf','TOTOTF','totOutflow','totalOutflow','tot_outflow','tdsrf','outflow','discharge','otf','fw','放流量'];
const TIDE_KEYS = ['tdlvHgt','tdlv_hgt','tideHeight','tideHgt','tide_hgt','tideLevel','tide_level','tphLevel','tph_level','level','obsLevel','obs_level'];

// 대표 관측소 기준은 Phase 1 모델 + 추가 교량 확장안입니다. 좌표 기반 최종 검증 전까지는 "운영 매핑안"으로 표시합니다.
const BRIDGES = [
  {bridge:'강동대교',zone:'수중보 상류',station:'서울시(광진교)',code:'1018640',tide:false,offset:null,releaseLag:330,reason:'잠실수중보 상류: 조석 적용 제외'},
  {bridge:'구리암사대교',zone:'수중보 상류',station:'서울시(광진교)',code:'1018640',tide:false,offset:null,releaseLag:330,reason:'잠실수중보 상류: 조석 적용 제외'},
  {bridge:'천호대교',zone:'수중보 상류',station:'서울시(광진교)',code:'1018640',tide:false,offset:null,releaseLag:330,reason:'잠실수중보 상류: 조석 적용 제외'},
  {bridge:'광진교',zone:'수중보 상류',station:'서울시(광진교)',code:'1018640',tide:false,offset:null,releaseLag:330,reason:'잠실수중보 상류: 조석 적용 제외'},
  {bridge:'올림픽대교',zone:'수중보 상류',station:'서울시(광진교)',code:'1018640',tide:false,offset:null,releaseLag:330,reason:'잠실수중보 상류: 조석 적용 제외'},
  {bridge:'잠실철교',zone:'수중보 하류 경계',station:'서울시(청담대교)',code:'1018662',tide:true,offset:70,releaseLag:330,reason:'추가 교량. 청담대교 관측소 권역. 조석 영향은 현장 검증 필요'},
  {bridge:'잠실대교',zone:'수중보 하류 경계',station:'서울시(청담대교)',code:'1018662',tide:true,offset:70,releaseLag:330,reason:'청담대교 대표값. 모델: 행주→청담 +70분'},
  {bridge:'청담대교',zone:'중상류 혼합',station:'서울시(청담대교)',code:'1018662',tide:true,offset:70,releaseLag:330,reason:'청담대교 대표값. 모델: 행주→청담 +70분'},
  {bridge:'영동대교',zone:'중상류 혼합',station:'서울시(청담대교)',code:'1018662',tide:true,offset:70,releaseLag:330,reason:'청담대교 대표값'},
  {bridge:'성수대교',zone:'중상류 혼합',station:'서울시(청담대교)',code:'1018662',tide:true,offset:70,releaseLag:330,reason:'청담대교 대표값'},
  {bridge:'동호대교',zone:'중류',station:'서울시(잠수교)',code:'1018680',tide:true,offset:50,releaseLag:310,reason:'잠수교 대표값. 모델: 행주→잠수 +50분'},
  {bridge:'한남대교',zone:'중류',station:'서울시(잠수교)',code:'1018680',tide:true,offset:50,releaseLag:310,reason:'잠수교 대표값'},
  {bridge:'잠수교',zone:'중류',station:'서울시(잠수교)',code:'1018680',tide:true,offset:50,releaseLag:310,reason:'잠수교 대표값'},
  {bridge:'반포대교',zone:'중류',station:'서울시(반포2교)',code:'1018681',tide:true,offset:50,releaseLag:310,reason:'반포2교 수위관측소 대표값. 시간차는 잠수권역 준용'},
  {bridge:'동작대교',zone:'중류',station:'서울시(한강대교)',code:'1018683',tide:true,offset:40,releaseLag:300,reason:'한강대교 대표값'},
  {bridge:'한강철교',zone:'중류',station:'서울시(한강대교)',code:'1018683',tide:true,offset:40,releaseLag:300,reason:'추가 교량. 한강대교 관측소 권역'},
  {bridge:'한강대교',zone:'중류',station:'서울시(한강대교)',code:'1018683',tide:true,offset:40,releaseLag:300,reason:'모델: 행주→한강 +40분'},
  {bridge:'원효대교',zone:'중류',station:'서울시(한강대교)',code:'1018683',tide:true,offset:40,releaseLag:300,reason:'한강대교 대표값'},
  {bridge:'마포대교',zone:'중류',station:'서울시(한강대교)',code:'1018683',tide:true,offset:40,releaseLag:300,reason:'한강대교 대표값'},
  {bridge:'서강대교',zone:'중류',station:'서울시(한강대교)',code:'1018683',tide:true,offset:40,releaseLag:300,reason:'한강대교 대표값'},
  {bridge:'당산철교',zone:'중류',station:'서울시(한강대교)',code:'1018683',tide:true,offset:40,releaseLag:300,reason:'추가 교량. 한강대교 관측소 권역'},
  {bridge:'양화대교',zone:'중하류',station:'서울시(한강대교)',code:'1018683',tide:true,offset:40,releaseLag:300,reason:'한강대교 대표값'},
  {bridge:'성산대교',zone:'하류 조석',station:'서울시(행주대교)',code:'1019630',tide:true,offset:0,releaseLag:260,reason:'행주대교 대표값'},
  {bridge:'월드컵대교',zone:'하류 조석',station:'서울시(행주대교)',code:'1019630',tide:true,offset:0,releaseLag:260,reason:'추가 교량. 행주대교 관측소 권역'},
  {bridge:'가양대교',zone:'하류 조석',station:'서울시(행주대교)',code:'1019630',tide:true,offset:0,releaseLag:260,reason:'행주대교 대표값'},
  {bridge:'마곡대교',zone:'하류 조석',station:'서울시(행주대교)',code:'1019630',tide:true,offset:0,releaseLag:260,reason:'추가 교량. 행주대교 관측소 권역'},
  {bridge:'방화대교',zone:'하류 조석',station:'서울시(행주대교)',code:'1019630',tide:true,offset:0,releaseLag:260,reason:'행주대교 대표값'},
  {bridge:'행주대교',zone:'하류 조석',station:'서울시(행주대교)',code:'1019630',tide:true,offset:0,releaseLag:260,reason:'행주대교 대표값'}
];

function init(){
  $('bridgeSelect').innerHTML = BRIDGES.map((b,i)=>`<option value="${i}">${b.bridge} · ${b.station}</option>`).join('');
  $('bridgeCount').textContent = `교량 ${BRIDGES.length}개 등록 · 철교/대교 포함`;
  loadKeys();
  setDefaultTimes();
  bindInputs();
  renderQuality();
  renderModelInfo(BRIDGES[0]);
  renderBoard([]);
  log('[초기화]', `교량 ${BRIDGES.length}개`, 'Phase 2');
}

function bindInputs(){
  ['incidentDate','searchDate'].forEach(id => $(id).addEventListener('input', e => e.target.value = formatDateInput(e.target.value)));
  ['incidentTime','searchTime'].forEach(id => $(id).addEventListener('input', e => e.target.value = formatTimeInput(e.target.value)));
  document.querySelectorAll('[data-toggle-key]').forEach(btn => btn.addEventListener('click', () => toggleKey(btn.dataset.toggleKey, btn)));
  $('saveKeys').onclick = saveKeys;
  $('clearKeys').onclick = clearKeys;
  $('setNow').onclick = setNow;
  $('runQuery').onclick = runQuery;
  $('bridgeSelect').addEventListener('change', () => renderModelInfo(BRIDGES[Number($('bridgeSelect').value)]));
}

function toggleKey(id, btn){
  const input=$(id); if(!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
  btn.textContent = input.type === 'password' ? '보기' : '숨김';
}
function formatDateInput(v){ const d=v.replace(/\D/g,'').slice(0,8); if(d.length<=4)return d; if(d.length<=6)return `${d.slice(0,4)}-${d.slice(4)}`; return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6)}`; }
function formatTimeInput(v){ const d=v.replace(/\D/g,'').slice(0,4); if(d.length<=2)return d; return `${d.slice(0,2)}:${d.slice(2)}`; }
function validDate(s){ return /^\d{4}-\d{2}-\d{2}$/.test(s); }
function validTime(s){ if(!/^\d{2}:\d{2}$/.test(s))return false; const [h,m]=s.split(':').map(Number); return h>=0&&h<=23&&m>=0&&m<=59; }
function parseLocal(date,time){ if(!validDate(date)||!validTime(time)) return null; const [y,mo,d]=date.split('-').map(Number); const [h,mi]=time.split(':').map(Number); return new Date(y,mo-1,d,h,mi,0); }
function ymd(d){ return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }
function ymdhm(d){ return ymd(d)+String(d.getHours()).padStart(2,'0')+String(d.getMinutes()).padStart(2,'0'); }
function hhmm(d){ return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function pretty(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${hhmm(d)}`; }
function setDefaultTimes(){ const now=new Date(); const incident=new Date(now.getTime()-6*3600e3); $('incidentDate').value=formatDateInput(ymd(incident)); $('incidentTime').value=hhmm(incident); $('searchDate').value=formatDateInput(ymd(now)); $('searchTime').value=hhmm(now); }
function setNow(){ const now=new Date(); $('searchDate').value=formatDateInput(ymd(now)); $('searchTime').value=hhmm(now); $('inputStatus').textContent='조회시각을 현재시각으로 입력했습니다.'; }
function saveKeys(){ ['hrfcoKey','tideKey','weatherKey'].forEach(id=>localStorage.setItem(id,$(id).value.trim())); $('keyStatus').textContent='저장 완료 · 화면 기본값은 계속 숨김입니다.'; }
function clearKeys(){ ['hrfcoKey','tideKey','weatherKey'].forEach(id=>{localStorage.removeItem(id);$(id).value='';}); $('keyStatus').textContent='삭제 완료'; }
function loadKeys(){ ['hrfcoKey','tideKey','weatherKey'].forEach(id=>{ $(id).value=localStorage.getItem(id)||''; $(id).type='password'; }); }

async function fetchJson(url){
  log('[FETCH]', url);
  const r = await fetch(url);
  const text = await r.text();
  if(!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0,160)}`);
  try{return JSON.parse(text);}catch(e){ throw new Error('JSON 파싱 실패: '+text.slice(0,160)); }
}
function normalizeRows(data){
  if(!data) return [];
  const cands = [data?.content, data?.list, data?.body?.items?.item, data?.response?.body?.items?.item, data?.items?.item, data?.data, data?.result?.data, data?.response?.body?.item];
  for(const c of cands){ if(Array.isArray(c)) return c; if(c && typeof c==='object') return [c]; }
  if(Array.isArray(data)) return data;
  return [];
}
function parseObsTime(row){
  const raw = row.obstm || row.obsTime || row.obs_time || row.ymdhm || row.tm || row.datetime || row.dateTime || row.fcstDateTime || row.predcDt || row.obsvDt || row.tideTime || row.tide_time || row.tphTime || row.tph_time || row.tdlvTime || row.tdlv_time || row.time;
  let nums = raw ? String(raw).replace(/\D/g,'') : '';
  if(nums.length>=12){ const y=+nums.slice(0,4), mo=+nums.slice(4,6), d=+nums.slice(6,8), h=+nums.slice(8,10), m=+nums.slice(10,12); return new Date(y,mo-1,d,h,m); }
  const dateRaw = row.reqDate || row.fcstDate || row.date || row.tideDate || row.tide_date || row.ymd;
  const timeRaw = row.hm || row.hhmm || row.tideTime || row.tide_time || row.tphTime || row.tph_time || row.time;
  const dnums = dateRaw ? String(dateRaw).replace(/\D/g,'') : '';
  const tnums = timeRaw ? String(timeRaw).replace(/\D/g,'') : '';
  if(dnums.length>=8 && tnums.length>=3){
    const y=+dnums.slice(0,4), mo=+dnums.slice(4,6), d=+dnums.slice(6,8);
    const hhmm = tnums.padStart(4,'0');
    return new Date(y,mo-1,d,+hhmm.slice(0,2),+hhmm.slice(2,4));
  }
  return null;
}
function toNumber(v){
  if(v === undefined || v === null) return null;
  if(typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if(!s || s === '-' || s.toLowerCase() === 'null') return null;
  const cleaned = s.replace(/,/g,'').replace(/㎥\/s|m³\/s|cms|cm|m/g,'').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
function val(row, keys){
  for(const k of keys){
    if(row && Object.prototype.hasOwnProperty.call(row,k)){
      const n = toNumber(row[k]);
      if(n !== null) return n;
    }
  }
  return null;
}
function metricStats(rows, keys){
  const stats=[];
  for(const k of keys){
    const vals=[];
    for(const r of rows){
      if(r && Object.prototype.hasOwnProperty.call(r,k)){
        const n=toNumber(r[k]);
        if(n!==null) vals.push(n);
      }
    }
    if(vals.length){
      const min=Math.min(...vals), max=Math.max(...vals);
      stats.push({key:k,count:vals.length,min,max,first:vals[0],last:vals[vals.length-1],allZero:vals.every(v=>Math.abs(v)<1e-9)});
    }
  }
  return stats;
}
function detectMetric(rows, keys, label){
  const stats=metricStats(rows,keys);
  if(!stats.length){ log(`[${label} 필드검증] 실패: 후보 필드 없음`); return {key:null,status:'실패',stats:[]}; }
  let chosen=stats.find(s=>!s.allZero && Math.abs(s.max-s.min)>1e-9) || stats.find(s=>!s.allZero) || stats[0];
  const suspicious = chosen.allZero || Math.abs(chosen.max-chosen.min)<1e-9;
  log(`[${label} 필드검증] 선택=${chosen.key} count=${chosen.count} min=${chosen.min} max=${chosen.max} first=${chosen.first} last=${chosen.last}${suspicious?' 검증필요':''}`);
  if(rows[0]) log(`[${label} 원자료 예시]`, sampleRow(rows[0], keys));
  return {key:chosen.key,status:suspicious?'검증필요':'실측',stats,chosen};
}
function sampleRow(row, keys){
  const out={};
  const baseKeys=['ymdhm','obstm','obsTime','tm','date','time',...keys];
  for(const k of baseKeys){ if(row && Object.prototype.hasOwnProperty.call(row,k)) out[k]=row[k]; }
  return out;
}
function nearest(rows,target,valueKeys,maxMin=MAX_NEAREST_MIN){
  let best=null, bestDiff=Infinity;
  for(const row of rows){ const t=parseObsTime(row); const v=val(row,valueKeys); if(!t || v===null) continue; const diff=Math.abs(t-target); if(diff<bestDiff){ best={time:t,value:v,row,diffMin:Math.round(diff/60000)}; bestDiff=diff; } }
  if(!best) return null;
  if(best.diffMin > maxMin) return {...best, stale:true};
  return best;
}
function trend(rows,target,valueKeys,minutes=60){
  const now=nearest(rows,target,valueKeys,MAX_NEAREST_MIN);
  const past=nearest(rows,new Date(target.getTime()-minutes*60000),valueKeys,MAX_NEAREST_MIN);
  if(!now || !past || now.stale || past.stale) return null;
  return {now,past,delta:Number((now.value-past.value).toFixed(2)), minutes};
}
function dataQualityForPoint(p){ if(!p) return '자료 없음'; return p.stale ? `검증필요: ${p.diffMin}분 차이` : `정상: ${p.diffMin}분 차이`; }

async function getWaterSeries(key, code, start, end){
  const url = `https://api.hrfco.go.kr/${encodeURIComponent(key)}/waterlevel/list/10M/${code}/${ymdhm(start)}/${ymdhm(end)}.json`;
  const j=await fetchJson(url); const rows=normalizeRows(j); log('[수위 행 수]', rows.length); if(rows.length) return rows;
  throw new Error('수위 기간조회 결과 없음');
}
async function getDamSeries(key, start, end){
  const url = `https://api.hrfco.go.kr/${encodeURIComponent(key)}/dam/list/10M/${DAM_CODE}/${ymdhm(start)}/${ymdhm(end)}.json`;
  const j=await fetchJson(url); const rows=normalizeRows(j); log('[댐 행 수]', rows.length); if(rows.length) return rows;
  throw new Error('댐 기간조회 결과 없음');
}
async function getTideRowsForDate(key, date){
  if(!key) throw new Error('조석 키 없음');
  const reqDate=ymd(date);
  // 공공데이터포털 캡처 기준 확정값:
  // End Point: https://apis.data.go.kr/1192136/tideFcstTime
  // 상세기능: /GetTideFcstTimeApiService
  // numOfRows 최대값: 300, min 최대값: 60
  const base='https://apis.data.go.kr/1192136/tideFcstTime/GetTideFcstTimeApiService';
  const variants=[key, encodeURIComponent(key), decodeURIComponentSafe(key)];
  const urls=[];
  for(const k of [...new Set(variants)]){
    urls.push(`${base}?serviceKey=${k}&pageNo=1&numOfRows=300&type=json&obsCode=${TIDE_STATION}&reqDate=${reqDate}&min=10`);
    urls.push(`${base}?serviceKey=${k}&pageNo=1&numOfRows=300&_type=json&obsCode=${TIDE_STATION}&reqDate=${reqDate}&min=10`);
  }
  let lastErr='';
  for(const u of urls){
    try{
      const j=await fetchJson(u);
      const msg=j?.response?.header?.resultMsg || j?.header?.resultMsg || j?.resultMsg || '';
      const rows=normalizeRows(j);
      log('[조석 후보]', reqDate, `rows=${rows.length}`, msg ? `msg=${msg}` : '');
      if(rows.length) return rows;
      lastErr=msg || 'rows=0';
    }catch(e){ lastErr=e.message; log('[조석 실패]', reqDate, e.message); }
  }
  throw new Error(`${reqDate} 조석 조회 실패: ${lastErr}`);
}
async function getTideRowsRange(key,start,end){
  const rows=[]; const seen=new Set();
  const d0=new Date(start.getFullYear(),start.getMonth(),start.getDate()-1);
  const d1=new Date(end.getFullYear(),end.getMonth(),end.getDate()+1);
  const days=Math.ceil((d1-d0)/86400000)+1;
  if(days>14) throw new Error('조석 조회 기간이 14일을 초과합니다. 기간을 줄여주세요.');
  let success=0, errors=[];
  for(let i=0;i<days;i++){
    const d=new Date(d0.getFullYear(),d0.getMonth(),d0.getDate()+i);
    try{
      const r=await getTideRowsForDate(key,d);
      success++;
      for(const row of r){ const t=parseObsTime(row); const k=t?`${t.getTime()}_${val(row,TIDE_KEYS)}`:JSON.stringify(row); if(!seen.has(k)){seen.add(k); rows.push(row);} }
    }catch(e){ errors.push(e.message); }
  }
  log('[조석 기간조회]', `성공일=${success}`, `총행=${rows.length}`, errors.length?`오류=${errors.slice(0,2).join(' / ')}`:'');
  if(rows.length) return rows;
  throw new Error('조석 기간조회 전체 실패: '+errors.slice(0,3).join(' / '));
}
function decodeURIComponentSafe(s){ try{return decodeURIComponent(s);}catch{return s;} }
function tideAt(rows,target,offsetMin=0){
  const shifted = new Date(target.getTime()-offsetMin*60000);
  const items=[];
  for(const r of rows){ const t=parseObsTime(r); const h=val(r,TIDE_KEYS); if(t&&h!==null) items.push({time:t,value:h,row:r}); }
  items.sort((a,b)=>a.time-b.time);
  if(!items.length) return null;
  let best=null,bestDiff=Infinity,bestIdx=-1;
  items.forEach((it,i)=>{ const d=Math.abs(it.time-shifted); if(d<bestDiff){best=it;bestDiff=d;bestIdx=i;} });
  const prev=items[Math.max(0,bestIdx-1)];
  const next=items[Math.min(items.length-1,bestIdx+1)];
  const delta = prev ? Number((best.value - prev.value).toFixed(1)) : null;
  const hours = prev ? Math.max((best.time - prev.time)/3600000, 1/60) : null;
  const rateCmHr = (delta!==null && hours) ? Number((delta / hours).toFixed(1)) : null;
  const phase = delta==null ? '확인중' : delta>0.3 ? '밀물 진행' : delta<-0.3 ? '썰물 진행' : '정체';
  const nextTurn = findNextTurn(items,bestIdx);
  return {best, prev, next, diffMin:Math.round(bestDiff/60000), delta, rateCmHr, phase, count:items.length, shifted, nextTurn};
}
function findNextTurn(items,idx){
  if(idx<1 || idx>=items.length-2) return null;
  let prevSign=Math.sign(items[idx].value-items[idx-1].value);
  for(let i=idx+1;i<items.length-1;i++){
    const sign=Math.sign(items[i+1].value-items[i].value);
    if(prevSign!==0 && sign!==0 && sign!==prevSign){
      const type=prevSign>0?'만조 전환':'간조 전환';
      return {type,time:items[i].time,value:items[i].value};
    }
    if(sign!==0) prevSign=sign;
  }
  return null;
}
function tideNumber(date){
  // 공식 음력 물때표가 아니라 조석예보 진폭 기반 참고 표시가 들어오기 전까지는 "참고"로만 표기한다.
  const base=new Date(2026,0,1);
  const days=Math.floor((new Date(date.getFullYear(),date.getMonth(),date.getDate())-base)/86400000);
  const n=((days%15)+15)%15 + 1;
  const label = (n===8?'조금권 참고':(n>=14||n<=2?'사리권 참고':(n>=3&&n<=7?'중간물 참고':'보통 참고')));
  return {n,label};
}
function speedLabel(wTrend, damImpact, tide){
  const wd = wTrend?.delta ?? null;
  const dam = damImpact?.value ?? null;
  const tr = Math.abs(tide?.rateCmHr ?? 0);
  if((wd!==null && Math.abs(wd)>=0.10) || (dam!==null && dam>=1000) || tr>=25) return '빠름 가능';
  if((wd!==null && Math.abs(wd)>=0.04) || (dam!==null && dam>=500) || tr>=10) return '보통 가능';
  return '완만 가능';
}
function directionLabel(b, wTrend, damImpact, tide){
  const damHigh = damImpact?.value!=null && damImpact.value>=1000;
  if(!b.tide) return damHigh ? '방류 영향 하류방향 우세 가능' : '조석 제외 · 자연 하류 흐름 가능';
  if(!tide) return damHigh ? '방류 영향 하류방향 가능' : '조석 미확인 · 혼합 가능';
  if(tide.phase.includes('밀물')){
    return damHigh ? '밀물 유입 + 방류 하류방향 충돌 가능' : '물이 들어오는 영향 가능';
  }
  if(tide.phase.includes('썰물')) return '물이 나가는 영향 가능';
  return damHigh ? '정체권 + 방류 하류방향 가능' : '정체·혼합 가능';
}
function makePointState(label,b,time,waterRows,damRows,tideRows,waterMetric,damMetric){
  const waterKeys = waterMetric?.key ? [waterMetric.key] : WATER_KEYS;
  const damKeys = damMetric?.key ? [damMetric.key] : DAM_KEYS;
  const water = nearest(waterRows,time,waterKeys);
  const wTrend = trend(waterRows,time,waterKeys,60);
  const damImpactTime = new Date(time.getTime() - (b.releaseLag||0)*60000);
  const damImpact = nearest(damRows,damImpactTime,damKeys,90);
  const tide = b.tide && tideRows.length ? tideAt(tideRows,time,b.offset||0) : null;
  const direction = directionLabel(b,wTrend,damImpact,tide);
  const speed = speedLabel(wTrend,damImpact,tide);
  const notes=[];
  if(wTrend) notes.push(`수위 1시간 ${wTrend.delta>0?'+':''}${wTrend.delta}m`); else notes.push('수위 변화 계산불가');
  if(damImpact) notes.push(`팔당 ${b.releaseLag}분 보정 ${damImpact.value.toFixed(1)}㎥/s`); else notes.push('방류량 보정값 없음');
  if(b.tide) notes.push(tide?`조석 ${tide.phase} ${tide.rateCmHr!==null?`(${tide.rateCmHr>0?'+':''}${tide.rateCmHr}cm/h)`:''}`:'조석 없음'); else notes.push('조석 제외');
  return {label,time,water,wTrend,damImpact,damImpactTime,tide,direction,speed,notes};
}
function flowDecisionFromState(state){
  return {direction:state.direction, parts:state.notes, speed:state.speed};
}
function fmtWaterPoint(p){ return p ? `${p.value.toFixed(2)}m · ${pretty(p.time)} · ${dataQualityForPoint(p)}` : '자료 없음'; }
function fmtTrend(t){ return t ? `${t.delta>0?'+':''}${t.delta}m / ${t.minutes}분` : '계산불가'; }
function fmtDamPoint(p, impactTime){ return p ? `${p.value.toFixed(1)}㎥/s · 팔당 ${pretty(p.time)} · 교량영향 기준 ${pretty(impactTime)} · ${dataQualityForPoint(p)}` : '자료 없음'; }
function fmtTidePoint(b,t){
  if(!b.tide) return '잠실수중보 상류: 조석 적용 제외';
  if(!t) return '조석 자료 없음';
  const turn = t.nextTurn ? ` · 다음 ${t.nextTurn.type} ${hhmm(t.nextTurn.time)} ${t.nextTurn.value.toFixed(1)}cm` : '';
  const rate = t.rateCmHr!==null ? ` · 변화율 ${t.rateCmHr>0?'+':''}${t.rateCmHr}cm/h` : '';
  return `${t.phase} · 조위 ${t.best.value.toFixed(1)}cm · 인천 기준 ${t.shifted ? pretty(t.shifted) : ''} 관측 보정${rate}${turn}`;
}
function renderPointCompare(b, incidentState, currentState){
  const row=(name,a,c)=>`<div class="kv"><b>${name}</b><span><strong>투신</strong> ${a}<br><strong>조회</strong> ${c}</span></div>`;
  const html = `
    ${row('수위',fmtWaterPoint(incidentState.water),fmtWaterPoint(currentState.water))}
    ${row('수위 변화',fmtTrend(incidentState.wTrend),fmtTrend(currentState.wTrend))}
    ${row('교량 영향 방류량',fmtDamPoint(incidentState.damImpact,incidentState.damImpactTime),fmtDamPoint(currentState.damImpact,currentState.damImpactTime))}
    ${row('조석 영향',fmtTidePoint(b,incidentState.tide),fmtTidePoint(b,currentState.tide))}
    ${row('물 방향',incidentState.direction,currentState.direction)}
    ${row('물살 판단',incidentState.speed,currentState.speed)}
    <p class="muted">물 방향·물살은 유속 실측값이 아니라 수위 변화, 팔당 방류량 지연 보정, 인천 조석 보정값을 조합한 참고판정입니다.</p>`;
  const el=$('pointCompare'); if(el) el.innerHTML=html;
}
function renderQuality(q={}){
  const labels=[['수위',q.water],['방류',q.dam],['조석',q.tide],['기상',q.weather]];
  $('qualityGrid').innerHTML = labels.map(([name,state])=>{
    const cls = state==='실측' || state==='정상' ? 'ok' : state==='미조회'||state==='제외'||!state ? 'hold' : 'fail';
    return `<div class="q"><strong>${name}</strong><span class="${cls}">${state||'대기'}</span></div>`;
  }).join('');
}
function renderSummary(b, incidentState, currentState, decision){
  const searchDt=parseLocal($('searchDate').value,$('searchTime').value);
  const tn=searchDt?tideNumber(searchDt):null;
  $('summary').innerHTML = `
    <div class="summary-big">${decision?.direction || '조회 전'} · ${decision?.speed || ''}</div>
    <span class="pill">대표 관측소: ${b.station}</span><span class="pill">${b.tide?'조석 적용':'조석 제외'}</span><span class="pill">교량 ${BRIDGES.length}개 등록</span>
    <div class="kv"><b>현재 수위</b><span>${fmtWaterPoint(currentState.water)} <small class="muted">수심 아님</small></span></div>
    <div class="kv"><b>투신 수위</b><span>${fmtWaterPoint(incidentState.water)}</span></div>
    <div class="kv"><b>현재 방류 영향</b><span>${fmtDamPoint(currentState.damImpact,currentState.damImpactTime)}</span></div>
    <div class="kv"><b>투신 방류 영향</b><span>${fmtDamPoint(incidentState.damImpact,incidentState.damImpactTime)}</span></div>
    <div class="kv"><b>인천 물때</b><span>${tn?`${tn.n}물 · ${tn.label}`:'미조회'} <small class="muted">공식 물때 검증 전 참고값</small></span></div>
    <div class="kv"><b>현재 조석</b><span>${fmtTidePoint(b,currentState.tide)}</span></div>
    <div class="kv"><b>근거</b><span>${decision?.parts?.join(' / ') || '-'}</span></div>`;
}
function renderModelInfo(b){
  $('modelInfo').innerHTML = `
    <div class="kv"><b>교량</b><span>${b.bridge}</span></div>
    <div class="kv"><b>구간</b><span>${b.zone}</span></div>
    <div class="kv"><b>수위관측소</b><span>${b.station} (${b.code})</span></div>
    <div class="kv"><b>조석 보정</b><span>${b.tide ? `인천 ${TIDE_STATION} 기준 +${b.offset}분` : '적용 제외'}</span></div>
    <div class="kv"><b>팔당 영향 지연</b><span>${b.releaseLag}분</span></div>
    <div class="kv"><b>매핑 근거</b><span>${b.reason}</span></div>`;
}
function rowsToPoints(rows, keys){ return rows.map(r=>({time:parseObsTime(r), value:val(r,keys)})).filter(p=>p.time&&p.value!=null); }
function normalizePoints(points){
  const vals=points.map(p=>p.value).filter(v=>v!=null);
  if(vals.length<2) return [];
  const min=Math.min(...vals), max=Math.max(...vals);
  return points.map(p=>({time:p.time, value: max===min ? 50 : (p.value-min)/(max-min)*100, raw:p.value}));
}
function drawLine(canvas, data, key='value', label=''){
  const ctx=canvas.getContext('2d'); const ratio=window.devicePixelRatio||1; canvas.width=canvas.clientWidth*ratio; canvas.height=canvas.clientHeight*ratio; ctx.setTransform(ratio,0,0,ratio,0,0);
  const cw=canvas.clientWidth, ch=canvas.clientHeight; ctx.clearRect(0,0,cw,ch); ctx.font='12px system-ui'; ctx.fillStyle='#667085'; ctx.fillText(label,12,18);
  const pts=data.filter(d=>d && d[key]!=null && d.time).sort((a,b)=>a.time-b.time);
  if(pts.length<2){ ctx.fillText('그래프 데이터 부족',12,48); return; }
  const xs=pts.map(p=>p.time.getTime()), ys=pts.map(p=>p[key]); const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys); const pad=38;
  const sx=x=>pad+(x-minX)/(maxX-minX||1)*(cw-pad*1.6); const sy=y=>ch-pad-(y-minY)/(maxY-minY||1)*(ch-pad*2);
  ctx.strokeStyle='#e5e7eb'; ctx.lineWidth=1; for(let i=0;i<4;i++){const y=pad+i*(ch-pad*2)/3;ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(cw-pad/2,y);ctx.stroke();}
  ctx.strokeStyle='#0f62fe'; ctx.lineWidth=2; ctx.beginPath(); pts.forEach((p,i)=>{const x=sx(p.time.getTime()), y=sy(p[key]); if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y);}); ctx.stroke();
  ctx.fillStyle='#172033'; const last=pts[pts.length-1]; ctx.beginPath(); ctx.arc(sx(last.time.getTime()),sy(last[key]),4,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#667085'; ctx.fillText(`${minY.toFixed(2)}`,4,sy(minY)); ctx.fillText(`${maxY.toFixed(2)}`,4,sy(maxY)+4); ctx.fillText(hhmm(pts[0].time),pad,ch-8); ctx.fillText(hhmm(last.time),cw-64,ch-8);
}
function drawMultiLine(canvas, series, label=''){
  const ctx=canvas.getContext('2d'); const ratio=window.devicePixelRatio||1; canvas.width=canvas.clientWidth*ratio; canvas.height=canvas.clientHeight*ratio; ctx.setTransform(ratio,0,0,ratio,0,0);
  const cw=canvas.clientWidth, ch=canvas.clientHeight; ctx.clearRect(0,0,cw,ch); ctx.font='12px system-ui'; ctx.fillStyle='#667085'; ctx.fillText(label,12,18);
  const all=series.flatMap(s=>s.points).filter(p=>p.time&&p.value!=null);
  if(all.length<2){ ctx.fillText('통합 그래프 데이터 부족',12,48); return; }
  const xs=all.map(p=>p.time.getTime()), minX=Math.min(...xs), maxX=Math.max(...xs), pad=38;
  const sx=x=>pad+(x-minX)/(maxX-minX||1)*(cw-pad*1.6); const sy=y=>ch-pad-(y/100)*(ch-pad*2);
  ctx.strokeStyle='#e5e7eb'; ctx.lineWidth=1; for(let i=0;i<5;i++){const y=pad+i*(ch-pad*2)/4;ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(cw-pad/2,y);ctx.stroke();}
  const colors=['#0f62fe','#b7791f','#078a4f'];
  series.forEach((s,si)=>{
    const pts=s.points.filter(p=>p.time&&p.value!=null).sort((a,b)=>a.time-b.time);
    if(pts.length<2) return;
    ctx.strokeStyle=colors[si%colors.length]; ctx.lineWidth=2; ctx.beginPath();
    pts.forEach((p,i)=>{const x=sx(p.time.getTime()), y=sy(p.value); if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y);}); ctx.stroke();
    ctx.fillStyle=colors[si%colors.length]; ctx.fillText(s.name,12+si*92,36);
  });
  ctx.fillStyle='#667085'; const first=new Date(minX), last=new Date(maxX); ctx.fillText(hhmm(first),pad,ch-8); ctx.fillText(hhmm(last),cw-64,ch-8); ctx.fillText('정규화 0~100',cw-110,18);
}
function renderBoard(results){
  $('bridgeBoard').innerHTML = BRIDGES.map(b=>{
    const r=results.find(x=>x.bridge===b.bridge);
    return `<div class="bridge-item"><h3>${b.bridge}</h3><div>${b.station}</div><div>${b.tide?'조석 적용':'조석 제외'}</div><div class="muted">${r?.direction||'조회 후 표시'}</div></div>`;
  }).join('');
}
async function runQuery(){
  clearLog();
  const key=$('hrfcoKey').value.trim(), tideKey=$('tideKey').value.trim();
  const b=BRIDGES[Number($('bridgeSelect').value)];
  const incident=parseLocal($('incidentDate').value,$('incidentTime').value), search=parseLocal($('searchDate').value,$('searchTime').value);
  if(!key){ $('inputStatus').textContent='한강홍수통제소 키를 입력하세요.'; return; }
  if(!incident||!search){ $('inputStatus').textContent='날짜/시간 형식을 확인하세요.'; return; }
  if(search<incident){ $('inputStatus').textContent='조회시각은 사고시각 이후여야 합니다.'; return; }
  if((search-incident)/3600000 > 168){ $('inputStatus').textContent='Phase 2.2는 7일 이내 구간 조회를 권장합니다.'; return; }
  $('inputStatus').textContent='조회 중...'; renderModelInfo(b);
  const start=new Date(incident.getTime()-Math.max(90,(b.releaseLag||0)+90)*60000);
  const end=new Date(search.getTime()+90*60000);
  const q={water:'대기',dam:'대기',tide:b.tide?'대기':'제외',weather:'미조회'}; renderQuality(q);
  let waterRows=[], damRows=[], tideRows=[];
  try{ waterRows=await getWaterSeries(key,b.code,start,end); }catch(e){ q.water='실패'; log('[수위 최종 실패]',e.message); }
  try{ damRows=await getDamSeries(key,start,end); }catch(e){ q.dam='실패'; log('[댐 최종 실패]',e.message); }
  if(b.tide){ try{ tideRows=await getTideRowsRange(tideKey||'', start, end); q.tide='정상'; }catch(e){ q.tide='실패'; log('[조석 최종 실패]',e.message); } }

  const waterMetric=detectMetric(waterRows,WATER_KEYS,'수위');
  const damMetric=detectMetric(damRows,DAM_KEYS,'방류량');
  if(waterRows.length) q.water=waterMetric.status; else q.water='실패';
  if(damRows.length) q.dam=damMetric.status; else q.dam='실패';
  renderQuality(q);

  const incidentState=makePointState('투신시점',b,incident,waterRows,damRows,tideRows,waterMetric,damMetric);
  const currentState=makePointState('조회시점',b,search,waterRows,damRows,tideRows,waterMetric,damMetric);
  const decision=flowDecisionFromState(currentState);
  renderSummary(b,incidentState,currentState,decision);
  renderPointCompare(b,incidentState,currentState);
  renderModelInfo(b);

  const waterKeys=waterMetric.key?[waterMetric.key]:WATER_KEYS;
  const damKeys=damMetric.key?[damMetric.key]:DAM_KEYS;
  const waterPts=rowsToPoints(waterRows,waterKeys);
  const damPts=rowsToPoints(damRows,damKeys);
  const tidePts=rowsToPoints(tideRows,TIDE_KEYS);
  drawMultiLine($('combinedChart'), [
    {name:'수위',points:normalizePoints(waterPts)},
    {name:'방류',points:normalizePoints(damPts)},
    {name:'조석',points:normalizePoints(tidePts)}
  ], `${b.bridge} · ${pretty(incident)} ~ ${pretty(search)}`);
  $('combinedChartNote').textContent = `단위가 다른 수위(m), 방류량(㎥/s), 조위(cm)를 0~100으로 정규화해 변화 방향만 비교합니다. 수위필드=${waterMetric.key||'없음'}, 방류필드=${damMetric.key||'없음'}`;
  drawLine($('waterChart'), waterPts, 'value', `${b.station} 수위(m) · ${pretty(incident)} ~ ${pretty(search)}`);
  $('waterChartNote').textContent = currentState.wTrend ? `조회시점 최근 1시간 변화: ${currentState.wTrend.delta>0?'+':''}${currentState.wTrend.delta}m` : '최근 1시간 변화 계산에 필요한 시계열이 부족합니다.';
  drawLine($('damChart'), damPts, 'value', `팔당댐 방류량(㎥/s)`);
  $('damChartNote').textContent = currentState.damImpact ? `조회시점 교량 영향 방류량: ${currentState.damImpact.value.toFixed(1)}㎥/s · 팔당 ${b.releaseLag}분 지연 보정 · ${dataQualityForPoint(currentState.damImpact)}` : '방류량 미조회';
  if(tideRows.length){ drawLine($('tideChart'), tidePts, 'value', `인천 조위(cm) · ${TIDE_STATION}`); $('tideChartNote').textContent = currentState.tide ? `교량 보정 후 ${currentState.tide.phase}, 기준값과 ${currentState.tide.diffMin}분 차이` : '조석 매칭 실패'; }
  else { drawLine($('tideChart'), [], 'value', '조석'); $('tideChartNote').textContent='조석 API 미조회'; }
  $('tideSummary').innerHTML = currentState.tide ? `<div class="summary-big">${currentState.tide.phase}</div><div>조위 ${currentState.tide.best.value.toFixed(1)}cm · 인천 기준 ${b.offset}분 보정${currentState.tide.nextTurn?` · 다음 ${currentState.tide.nextTurn.type} ${hhmm(currentState.tide.nextTurn.time)}`:''}</div>` : `<div class="summary-big">${b.tide?'조석 미조회':'조석 적용 제외'}</div>`;
  renderBoard([{bridge:b.bridge,direction:`${currentState.direction} · ${currentState.speed}`}]);
  $('inputStatus').textContent='조회 완료. 원자료 로그에서 수위/방류량 필드검증 결과를 확인하세요.';
}

document.addEventListener('DOMContentLoaded', init);
