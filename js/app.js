/* HanRiver Environment Dashboard v1.0 Phase 3.4.9 InteractiveChartWaterInsight
 * 원칙: 확인된 원자료/계산값/검증필요를 구분한다.
 * 수정: 수위/방류 숫자값 우선, 공백·타임아웃 분리, 핵심 데이터 판정판을 추가한다.
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
// 수위/방류량 필드는 한강홍수통제소 API 종류와 응답 버전에 따라 표기가 달라질 수 있다.
// 1차 후보 + 2차 자동탐지로 처리하며, 실패 시 원자료 샘플과 키 목록을 로그에 남긴다.
const WATER_FIXED_KEY = 'wl';
const WATER_FLOW_FIXED_KEY = 'fw';
const DAM_FIXED_KEY = 'tototf';
const WATER_KEYS = ['wl','WL','obswl','OBSWL','obsWl','obs_wl','wlevel','WLEVEL','waterLevel','WaterLevel','waterlevel','WATERLEVEL','swl','SWL','wlobs','WLOBS','wlv','WLV','rfwl','RFWL','fw','FW'];
const DAM_KEYS = ['tototf','TOTOTF','totOutflow','totalOutflow','tot_outflow','otf','OTF','edq','EDQ','outflow','OUTFLOW','discharge','DISCHARGE','fw','FW','tdsrf','TDSRF','flow','FLOW','q','Q'];
const TIDE_KEYS = ['tdlvHgt','tdlv_hgt','tideHeight','tideHgt','tide_hgt','tideLevel','tide_level','tphLevel','tph_level','level','obsLevel','obs_level','wl','value','fcstValue'];

// 대표 관측소 기준은 Phase 1 모델 + 추가 교량 확장안입니다. 좌표 기반 최종 검증 전까지는 "운영 매핑안"으로 표시합니다.
const BRIDGES = [
  {bridge:'강동대교',zone:'수중보 상류',station:'서울시(광진교)',code:'1018640',tide:false,offset:null,releaseLag:330,reason:'잠실수중보 상류: 조석 적용 제외'},
  {bridge:'구리암사대교',zone:'수중보 상류',station:'서울시(광진교)',code:'1018640',tide:false,offset:null,releaseLag:330,reason:'잠실수중보 상류: 조석 적용 제외'},
  {bridge:'천호대교',zone:'수중보 상류',station:'서울시(광진교)',code:'1018640',tide:false,offset:null,releaseLag:330,reason:'잠실수중보 상류: 조석 적용 제외'},
  {bridge:'광진교',zone:'수중보 상류',station:'서울시(광진교)',code:'1018640',tide:false,offset:null,releaseLag:330,reason:'잠실수중보 상류: 조석 적용 제외'},
  {bridge:'올림픽대교',zone:'수중보 상류',station:'서울시(광진교)',code:'1018640',tide:false,offset:null,releaseLag:330,reason:'잠실수중보 상류: 조석 적용 제외'},
  {bridge:'잠실철교',zone:'잠실수중보 상류',station:'서울시(청담대교)',code:'1018662',tide:false,offset:null,releaseLag:330,reason:'잠실수중보 상류: 조석/물때 적용 제외'},
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
  log('[초기화]', `교량 ${BRIDGES.length}개`, 'Phase 3.4.9 InteractiveChartWaterInsight'); renderDataFirstPanel();
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
function floorTo10Min(d){
  const x=new Date(d);
  x.setSeconds(0,0);
  x.setMinutes(Math.floor(x.getMinutes()/10)*10);
  return x;
}
function ceilTo10Min(d){
  const x=new Date(d);
  x.setSeconds(0,0);
  const m=x.getMinutes();
  if(m%10!==0) x.setMinutes(Math.ceil(m/10)*10);
  return x;
}
function ymdhm10(d){ return ymdhm(floorTo10Min(d)); }
function hrfcoWindow(start,end){
  let s=floorTo10Min(start);
  let e=floorTo10Min(end);
  if(e<=s) e=new Date(s.getTime()+10*60000);
  return {start:s,end:e,startCode:ymdhm(s),endCode:ymdhm(e)};
}
function hhmm(d){ return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function pretty(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${hhmm(d)}`; }
function setDefaultTimes(){ const now=new Date(); const incident=new Date(now.getTime()-6*3600e3); $('incidentDate').value=formatDateInput(ymd(incident)); $('incidentTime').value=hhmm(incident); $('searchDate').value=formatDateInput(ymd(now)); $('searchTime').value=hhmm(now); }
function setNow(){ const now=new Date(); $('searchDate').value=formatDateInput(ymd(now)); $('searchTime').value=hhmm(now); $('inputStatus').textContent='조회시각을 현재시각으로 입력했습니다.'; }
function saveKeys(){ ['hrfcoKey','tideKey','weatherKey'].forEach(id=>localStorage.setItem(id,$(id).value.trim())); $('keyStatus').textContent='저장 완료 · 화면 기본값은 계속 숨김입니다.'; }
function clearKeys(){ ['hrfcoKey','tideKey','weatherKey'].forEach(id=>{localStorage.removeItem(id);$(id).value='';}); $('keyStatus').textContent='삭제 완료'; }
function loadKeys(){ ['hrfcoKey','tideKey','weatherKey'].forEach(id=>{ $(id).value=localStorage.getItem(id)||''; $(id).type='password'; }); }

function hrfcoKeyVariants(key){
  const raw = String(key || '').trim();
  if(!raw) throw new Error('한강홍수통제소 인증키 없음');
  const variants = [];
  const add = (v) => { if(v && !variants.includes(v)) variants.push(v); };
  add(raw);
  try { add(encodeURIComponent(raw)); } catch(e) {}
  try { add(decodeURIComponent(raw)); } catch(e) {}
  return variants;
}


async function fetchJson(url, timeoutMs=10000){
  log('[FETCH]', url);
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { controller.abort(); } catch(e) {}
      reject(new Error(`요청 타임아웃 ${Math.round(timeoutMs/1000)}초`));
    }, timeoutMs);
  });
  const fetchPromise = (async () => {
    const r = await fetch(url, {signal: controller.signal, cache:'no-store'});
    const text = await r.text();
    if(!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0,160)}`);
    try{return JSON.parse(text);}catch(e){ throw new Error('JSON 파싱 실패: '+text.slice(0,160)); }
  })();
  try{
    return await Promise.race([fetchPromise, timeoutPromise]);
  }catch(e){
    if(e.name === 'AbortError') throw new Error(`요청 타임아웃 ${Math.round(timeoutMs/1000)}초`);
    throw e;
  }finally{
    clearTimeout(timer);
  }
}
function normalizeRows(data){
  if(!data) return [];
  const cands = [
    data?.content,
    data?.list,
    data?.body?.items?.item,
    data?.response?.body?.items?.item,
    data?.items?.item,
    data?.data,
    data?.result?.data,
    data?.response?.body?.item
  ];
  for(const c of cands){
    if(Array.isArray(c)) return c;
    if(c && typeof c==='object') {
      // content가 {list:[...]}처럼 한 단계 더 감싸진 경우까지 확인
      const nested = [c.content,c.list,c.data,c.items?.item,c.result?.data,c.body?.items?.item];
      for(const n of nested){ if(Array.isArray(n)) return n; }
      return [c];
    }
  }
  if(Array.isArray(data)) return data;
  const deep = findBestArray(data);
  if(deep.length) return deep;
  return [];
}
function findBestArray(obj){
  let best=[]; let bestScore=-1; const seen=new Set();
  function walk(x,depth=0){
    if(!x || depth>5) return;
    if(Array.isArray(x)){
      const score = scoreArray(x);
      if(score>bestScore){ best=x; bestScore=score; }
      for(const it of x.slice(0,3)) walk(it,depth+1);
      return;
    }
    if(typeof x==='object'){
      if(seen.has(x)) return; seen.add(x);
      for(const v of Object.values(x)) walk(v,depth+1);
    }
  }
  walk(obj,0);
  return bestScore>0 ? best : [];
}
function scoreArray(arr){
  if(!arr || !arr.length) return 0;
  let score=Math.min(arr.length,50);
  for(const r of arr.slice(0,5)){
    const f=flatRow(r);
    const keys=Object.keys(f).join('|').toLowerCase();
    if(/ymdhm|obsymdhm|obstm|obs_time|date|time|tm|predcdt|tdlvdt/.test(keys)) score+=30;
    if(/(^|[.|_])(wl|obswl|waterlevel|wlevel|swl|fw|tototf|otf|outflow|discharge|tdlvhgt)([.|_]|$)/.test(keys)) score+=50;
  }
  return score;
}
function flatRow(row,prefix='',out={}){
  if(row === undefined || row === null) return out;
  if(Array.isArray(row)){
    row.forEach((v,i)=>{ out[`${prefix}col${i}`]=v; });
    // 배열 응답일 경우 첫 12자리 시간값과 첫 숫자값을 보조 필드로 만든다.
    for(const v of row){ const nums=String(v??'').replace(/\D/g,''); if(nums.length>=12 && !out.ymdhm){ out.ymdhm=nums.slice(0,12); break; } }
    for(const v of row){ const n=toNumber(v); const nums=String(v??'').replace(/\D/g,''); if(n!==null && nums.length<10){ out.value=n; break; } }
    return out;
  }
  if(typeof row!=='object'){ out[prefix||'value']=row; return out; }
  for(const [k,v] of Object.entries(row)){
    const path = prefix ? `${prefix}.${k}` : k;
    if(v && typeof v==='object' && !Array.isArray(v)){
      flatRow(v,path,out);
    }else{
      out[path]=v;
      if(!(k in out)) out[k]=v;
    }
  }
  return out;
}
function parseObsTime(row){
  const r=flatRow(row);
  const raw = r.obstm || r.obsTime || r.obs_time || r.ymdhm || r.obsymdhm || r.ymdh || r.tm || r.datetime || r.dateTime || r.fcstDateTime || r.predcDt || r.obsvDt || r.tideTime || r.tide_time || r.tphTime || r.tph_time || r.tdlvTime || r.tdlv_time || r.time || r.date;
  let nums = raw ? String(raw).replace(/\D/g,'') : '';
  if(nums.length>=12){ const y=+nums.slice(0,4), mo=+nums.slice(4,6), d=+nums.slice(6,8), h=+nums.slice(8,10), m=+nums.slice(10,12); return new Date(y,mo-1,d,h,m); }
  const dateRaw = r.reqDate || r.fcstDate || r.date || r.tideDate || r.tide_date || r.ymd;
  const timeRaw = r.hm || r.hhmm || r.tideTime || r.tide_time || r.tphTime || r.tph_time || r.time || r.tm;
  const dnums = dateRaw ? String(dateRaw).replace(/\D/g,'') : '';
  const tnums = timeRaw ? String(timeRaw).replace(/\D/g,'') : '';
  if(dnums.length>=8 && tnums.length>=3){
    const y=+dnums.slice(0,4), mo=+dnums.slice(4,6), d=+dnums.slice(6,8);
    const hm = tnums.padStart(4,'0');
    return new Date(y,mo-1,d,+hm.slice(0,2),+hm.slice(2,4));
  }
  return null;
}
function toNumber(v){
  if(v === undefined || v === null) return null;
  if(typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if(!s || s === '-' || s.toLowerCase() === 'null') return null;
  const cleaned = s.replace(/,/g,'').replace(/[^0-9.+\-]/g,'').trim();
  if(!cleaned || cleaned==='-' || cleaned==='+' || cleaned==='.' || cleaned==='-.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
function val(row, keys){
  const r=flatRow(row);
  for(const k of keys){
    if(Object.prototype.hasOwnProperty.call(r,k)){
      const n = toNumber(r[k]);
      if(n !== null) return n;
    }
  }
  return null;
}
function hasNumericValue(rows, keys){
  return Array.isArray(rows) && rows.some(row => {
    const r = flatRow(row);
    return keys.some(k => {
      const v = r[k];
      return v !== null && v !== undefined && String(v).trim() !== '' && !isNaN(Number(v));
    });
  });
}
function metricStats(rows, keys){
  const stats=[];
  for(const k of keys){
    const vals=[]; let exists=0, nonblank=0;
    for(const row of rows){
      const r=flatRow(row);
      if(Object.prototype.hasOwnProperty.call(r,k)){
        exists++;
        const raw = r[k];
        if(String(raw ?? '').trim() !== '') nonblank++;
        const n=toNumber(raw);
        if(n!==null) vals.push(n);
      }
    }
    if(exists || vals.length){
      const min=vals.length?Math.min(...vals):null, max=vals.length?Math.max(...vals):null;
      stats.push({key:k,count:vals.length,exists,nonblank,numeric:vals.length,min,max,first:vals[0]??null,last:vals[vals.length-1]??null,allZero:vals.length?vals.every(v=>Math.abs(v)<1e-9):false,blank:exists>0&&nonblank===0});
    }
  }
  return stats;
}
function autoMetricStats(rows,label){
  const bucket={};
  for(const row of rows){
    const r=flatRow(row);
    for(const [k,v] of Object.entries(r)){
      const n=toNumber(v);
      if(n===null) continue;
      if(isMetricExcluded(k,label,n)) continue;
      (bucket[k] ||= []).push(n);
    }
  }
  const stats=[];
  for(const [k,vals] of Object.entries(bucket)){
    if(vals.length < Math.max(2, Math.ceil(rows.length*0.25))) continue;
    const min=Math.min(...vals), max=Math.max(...vals);
    stats.push({key:k,count:vals.length,min,max,first:vals[0],last:vals[vals.length-1],allZero:vals.every(v=>Math.abs(v)<1e-9),auto:true,score:metricKeyScore(k,label,min,max,vals.length)});
  }
  stats.sort((a,b)=>b.score-a.score);
  return stats;
}
function isMetricExcluded(k,label,n){
  const s=String(k).toLowerCase();
  if(/code|cd|id|name|nm|ymdh|ymd|date|time|dt|tm|lat|lon|page|row|count|num|no|seq|min|hour|addr/.test(s)) return true;
  if(Math.abs(n)>1000000) return true;
  if(label==='수위' && /attwl|wrnwl|almwl|srswl|wlobscd|obscd|flow|out|discharge|tototf|otf/.test(s)) return true;
  if(label==='방류량' && /tdlv|tide|lat|lon/.test(s) && !/fw|flow|out|discharge|tototf|otf|swl|inf|sfw|ecpc/.test(s)) return true;
  return false;
}
function metricKeyScore(k,label,min,max,count){
  const s=String(k).toLowerCase();
  let score=count;
  if(label==='수위'){
    if(/(^|[._])(wl|obswl|waterlevel|wlevel|swl|wlv|rfwl)([._]|$)/.test(s) || /water.*level/.test(s)) score+=200;
    if(max>=-5 && max<=50) score+=30;
    if(max-min>0) score+=20;
  }else if(label==='방류량'){
    if(/tototf|otf|outflow|out_flow|discharge|edq|tdsrf|(^|[._])fw([._]|$)|flow/.test(s)) score+=200;
    if(max>=0 && max<=100000) score+=20;
    if(max-min>0) score+=20;
  }
  return score;
}
function detectMetric(rows, keys, label){
  const fixedKey = label==='수위' ? WATER_FIXED_KEY : (label==='방류량' ? DAM_FIXED_KEY : null);
  const stats=metricStats(rows,keys);
  let allStats=stats;
  const fixed = fixedKey ? allStats.find(s=>String(s.key).toLowerCase()===fixedKey.toLowerCase()) : null;
  if(fixed){
    log(`[${label} 고정필드] ${fixed.key} exists=${fixed.exists} nonblank=${fixed.nonblank} numeric=${fixed.numeric}`);
    if(rows[0]) log(`[${label} 첫 행]`, sampleRow(rows[0], [fixed.key,...keys]));
    if(rows.length>1) log(`[${label} 마지막 행]`, sampleRow(rows[rows.length-1], [fixed.key,...keys]));
    if(fixed.numeric>0){
      const suspicious = fixed.allZero || (fixed.max!==null && fixed.min!==null && Math.abs(fixed.max-fixed.min)<1e-9);
      return {key:fixed.key,status:suspicious?'검증필요':'실측',stats:allStats,chosen:fixed,blank:false};
    }
    if(fixed.exists>0 && fixed.nonblank===0){
      log(`[${label} 통제소 응답 공백] ${fixed.key} 필드는 있으나 ${fixed.exists}행 모두 빈값입니다. 임의값으로 대체하지 않습니다.`);
      return {key:fixed.key,status:'공백',stats:allStats,chosen:fixed,blank:true};
    }
    log(`[${label} 고정필드 숫자 없음] ${fixed.key} exists=${fixed.exists} nonblank=${fixed.nonblank} numeric=0`);
  }
  if(!allStats.some(s=>s.numeric>0)){
    const auto=autoMetricStats(rows,label);
    allStats=[...allStats,...auto];
    log(`[${label} 필드검증] 고정필드 숫자 없음 → 자동탐지 ${auto.length}개`);
  }
  const numericStats=allStats.filter(s=>s.numeric>0 || s.count>0);
  if(!numericStats.length){
    log(`[${label} 필드검증] 실패: 숫자값 있는 후보 필드 없음`);
    if(rows[0]){
      const f=flatRow(rows[0]);
      log(`[${label} 원자료 첫 행 전체키]`, Object.keys(f).slice(0,80).join(', '));
      log(`[${label} 원자료 첫 행]`, f);
    }
    return {key:fixedKey,status:'공백',stats:allStats,blank:true};
  }
  let chosen=numericStats.find(s=>!s.allZero && s.max!==null && s.min!==null && Math.abs(s.max-s.min)>1e-9) || numericStats.find(s=>!s.allZero) || numericStats[0];
  const suspicious = chosen.allZero || (chosen.max!==null && chosen.min!==null && Math.abs(chosen.max-chosen.min)<1e-9) || chosen.auto;
  log(`[${label} 필드검증] 선택=${chosen.key} count=${chosen.count} min=${chosen.min} max=${chosen.max} first=${chosen.first} last=${chosen.last}${chosen.auto?' 자동탐지':''}${suspicious?' 검증필요':''}`);
  if(rows[0]) log(`[${label} 원자료 예시]`, sampleRow(rows[0], [chosen.key,...keys]));
  return {key:chosen.key,status:suspicious?'검증필요':'실측',stats:allStats,chosen,blank:false};
}
function sampleRow(row, keys){
  const f=flatRow(row);
  const out={};
  const baseKeys=['ymdhm','obsymdhm','ymdh','obstm','obsTime','tm','date','time',...keys];
  for(const k of baseKeys){ if(Object.prototype.hasOwnProperty.call(f,k)) out[k]=f[k]; }
  if(Object.keys(out).length===0){
    for(const k of Object.keys(f).slice(0,20)) out[k]=f[k];
  }
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
function dataQualityForPoint(p){ if(!p) return '자료 없음'; return p.stale ? `검증필요: 입력시각과 관측시각 ${p.diffMin}분 차이` : `정상: 입력시각과 관측시각 ${p.diffMin}분 차이`; }
function observationGapShort(p){
  if(!p) return '자료 없음';
  return `${pretty(p.time)} · 입력시각과 관측값 ${p.diffMin}분 차이${p.stale?' · 검증필요':''}`;
}

async function getWaterSeries(key, code, start, end){
  let lastErr='';
  const w=hrfcoWindow(start,end);
  log('[HRFCO 10분격자]', `수위 ${code}`, `${pretty(w.start)}~${pretty(w.end)}`, `${w.startCode}/${w.endCode}`);
  for(const k of hrfcoKeyVariants(key)){
    const url = `https://api.hrfco.go.kr/${k}/waterlevel/list/10M/${code}/${w.startCode}/${w.endCode}.json`;
    try{
      const j=await fetchJson(url); const rows=normalizeRows(j); log('[수위 기간 행 수]', rows.length); if(rows.length) return rows;
      lastErr='기간조회 결과 없음';
    }catch(e){ lastErr=e.message; log('[수위 기간조회 실패]', e.message); }
  }
  throw new Error(lastErr || '수위 기간조회 결과 없음');
}
async function getDamSeries(key, start, end){
  let lastErr='';
  const w=hrfcoWindow(start,end);
  log('[HRFCO 10분격자]', `방류 ${DAM_CODE}`, `${pretty(w.start)}~${pretty(w.end)}`, `${w.startCode}/${w.endCode}`);
  for(const k of hrfcoKeyVariants(key)){
    const url = `https://api.hrfco.go.kr/${k}/dam/list/10M/${DAM_CODE}/${w.startCode}/${w.endCode}.json`;
    try{
      const j=await fetchJson(url); const rows=normalizeRows(j); log('[댐 기간 행 수]', rows.length); if(rows.length) return rows;
      lastErr='기간조회 결과 없음';
    }catch(e){ lastErr=e.message; log('[댐 기간조회 실패]', e.message); }
  }
  throw new Error(lastErr || '댐 기간조회 결과 없음');
}
async function getLatestWaterRows(key, code){
  let lastErr='';
  for(const k of hrfcoKeyVariants(key)){
    const url = `https://api.hrfco.go.kr/${k}/waterlevel/list/10M/${code}.json`;
    try{
      const j=await fetchJson(url); const rows=normalizeRows(j); log('[수위 최신 행 수]', rows.length); if(rows.length) return rows;
      lastErr='최신조회 결과 없음';
    }catch(e){ lastErr=e.message; log('[수위 최신조회 실패]', e.message); }
  }
  throw new Error(lastErr || '수위 최신조회 결과 없음');
}
async function getLatestDamRows(key){
  let lastErr='';
  for(const k of hrfcoKeyVariants(key)){
    const url = `https://api.hrfco.go.kr/${k}/dam/list/10M/${DAM_CODE}.json`;
    try{
      const j=await fetchJson(url); const rows=normalizeRows(j); log('[댐 최신 행 수]', rows.length); if(rows.length) return rows;
      lastErr='최신조회 결과 없음';
    }catch(e){ lastErr=e.message; log('[댐 최신조회 실패]', e.message); }
  }
  throw new Error(lastErr || '댐 최신조회 결과 없음');
}
async function applyHrfcoFallbacks(key, b, waterRows, damRows){
  let waterFallback=false, damFallback=false;
  if(waterRows.length && !hasNumericValue(waterRows, [WATER_FIXED_KEY, ...WATER_KEYS])){
    log('[수위 기간조회 공백]', '기간조회 wl/fw가 전부 공백 → 최신값 endpoint 재조회');
    try{
      const latest=await getLatestWaterRows(key,b.code);
      if(hasNumericValue(latest, [WATER_FIXED_KEY, ...WATER_KEYS])){
        waterRows=mergeRowsByTime(waterRows, latest); waterFallback=true;
        log('[수위 최신값 보강]', `추가행=${latest.length}`, '현재시점 참고값으로만 사용');
      }else{ log('[수위 최신값도 공백]', '통제소 최신 endpoint도 숫자값 없음'); }
    }catch(e){ log('[수위 최신값 보강 실패]', e.message); }
  }
  if(damRows.length && !hasNumericValue(damRows, [DAM_FIXED_KEY, ...DAM_KEYS])){
    log('[방류 기간조회 공백]', '기간조회 tototf가 전부 공백 → 최신값 endpoint 재조회');
    try{
      const latest=await getLatestDamRows(key);
      if(hasNumericValue(latest, [DAM_FIXED_KEY, ...DAM_KEYS])){
        damRows=mergeRowsByTime(damRows, latest); damFallback=true;
        log('[방류 최신값 보강]', `추가행=${latest.length}`, '현재시점 참고값으로만 사용');
      }else{ log('[방류 최신값도 공백]', '통제소 최신 endpoint도 숫자값 없음'); }
    }catch(e){ log('[방류 최신값 보강 실패]', e.message); }
  }
  return {waterRows, damRows, waterFallback, damFallback};
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
  const waterFlow = nearest(waterRows,time,[WATER_FLOW_FIXED_KEY,'FW','fw'],MAX_NEAREST_MIN);
  const wTrend = trend(waterRows,time,waterKeys,60);
  const damImpactTime = new Date(time.getTime() - (b.releaseLag||0)*60000);
  const damImpact = nearest(damRows,damImpactTime,damKeys,90);
  const tide = b.tide && tideRows.length ? tideAt(tideRows,time,b.offset||0) : null;
  const direction = directionLabel(b,wTrend,damImpact,tide);
  const speed = speedLabel(wTrend,damImpact,tide);
  const notes=[];
  if(wTrend) notes.push(`수위 1시간 ${wTrend.delta>0?'+':''}${wTrend.delta}m`); else notes.push(waterMetric?.blank?'통제소 수위 응답 공백':'수위 변화 계산불가');
  if(damImpact) notes.push(`팔당 ${b.releaseLag}분 보정 ${damImpact.value.toFixed(1)}㎥/s`); else notes.push(damMetric?.blank?'통제소 방류 응답 공백':'방류량 보정값 없음');
  if(b.tide) notes.push(tide?`조석 ${tide.phase} ${tide.rateCmHr!==null?`(${tide.rateCmHr>0?'+':''}${tide.rateCmHr}cm/h)`:''}`:'조석 없음'); else notes.push('조석 제외');
  return {label,time,water,waterFlow,wTrend,damImpact,damImpactTime,tide,direction,speed,notes};
}
function flowDecisionFromState(state){
  return {direction:state.direction, parts:state.notes, speed:state.speed};
}
function fmtWaterPoint(p){ return p ? `${p.value.toFixed(2)}m · ${observationGapShort(p)}` : '자료 없음'; }
function fmtWaterFlowPoint(p){ return p ? `${p.value.toFixed(1)} · ${observationGapShort(p)}` : '자료 없음'; }
function fmtTrend(t){ return t ? `${t.delta>0?'+':''}${t.delta}m / ${t.minutes}분` : '계산불가'; }
function fmtDamPoint(p, impactTime){ return p ? `${p.value.toFixed(1)}㎥/s · 팔당 관측 ${pretty(p.time)} · 교량영향 기준 ${pretty(impactTime)} · ${dataQualityForPoint(p)}` : '자료 없음'; }
function fmtTidePoint(b,t){
  if(!b.tide) return '잠실수중보 상류: 조석 적용 제외';
  if(!t) return '조석 자료 없음';
  const offset = b.offset || 0;
  const bridgeBestTime = t.best?.time ? new Date(t.best.time.getTime() + offset*60000) : null;
  let turn = '';
  if(t.nextTurn){
    const bridgeTurn = new Date(t.nextTurn.time.getTime() + offset*60000);
    turn = ` · 다음 전환: 인천 기준 ${hhmm(t.nextTurn.time)} / 교량 보정 ${hhmm(bridgeTurn)} · 조위 ${t.nextTurn.value.toFixed(1)}cm`;
  }
  const rate = t.rateCmHr!==null ? ` · 변화율 ${t.rateCmHr>0?'+':''}${t.rateCmHr}cm/h` : '';
  const baseTxt = bridgeBestTime ? `인천 관측 ${pretty(t.best.time)} + ${offset}분 보정 = 교량 기준 ${pretty(bridgeBestTime)}` : `인천 기준 ${t.shifted ? pretty(t.shifted) : ''}`;
  return `${t.phase} · 인천 조위 ${t.best.value.toFixed(1)}cm · ${baseTxt}${rate}${turn}`;
}

function dataBadge(state){
  if(state==='실측'||state==='정상') return '<span class="data-badge good">실측</span>';
  if(state==='검증필요') return '<span class="data-badge warn">검증필요</span>';
  if(state==='공백') return '<span class="data-badge bad">통제소 공백</span>';
  if(state==='제외') return '<span class="data-badge hold">제외</span>';
  return `<span class="data-badge hold">${state||'대기'}</span>`;
}
function fmtCorePoint(p, unit){
  if(!p) return '자료 없음';
  const value = unit==='m' ? p.value.toFixed(2)+'m' : unit==='cms' ? p.value.toFixed(1)+'㎥/s' : p.value.toFixed(1);
  return `${value}<br><small>${observationGapShort(p)}</small>`;
}

function signedDelta(current, incident, unit, digits=2){
  if(!current || !incident) return {text:'자료 없음', cls:'neutral', arrow:'·', value:null};
  const d = current.value - incident.value;
  const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '─';
  const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'neutral';
  return {text:`${arrow} ${d>0?'+':''}${d.toFixed(digits)}${unit}`, cls, arrow, value:d};
}
function tideShort(t){
  if(!t) return '자료 없음/제외';
  const rate = t.rateCmHr!==null ? ` · ${t.rateCmHr>0?'+':''}${t.rateCmHr}cm/h` : '';
  return `${t.phase}${rate}`;
}
function decisionScoreParts(state){
  const parts=[];
  const tidePhase = state?.tide?.phase || '';
  if(tidePhase.includes('밀물')) parts.push({name:'조석', value:'밀물 진행', score:+2, note:'상류 방향 유입 영향'});
  else if(tidePhase.includes('썰물')) parts.push({name:'조석', value:'썰물 진행', score:-2, note:'하류 방향 배출 영향'});
  else if(tidePhase) parts.push({name:'조석', value:tidePhase, score:0, note:'전환/정체권'});
  else parts.push({name:'조석', value:'자료 없음/제외', score:0, note:'판정 제외'});
  const wd = state?.wTrend?.delta;
  if(wd!==null && wd!==undefined) parts.push({name:'수위', value:`${wd>0?'+':''}${wd.toFixed(2)}m / 1시간`, score: wd>0 ? +1 : wd<0 ? -1 : 0, note: wd>0?'상승':'하강 또는 정체'});
  else parts.push({name:'수위', value:'변화 계산불가', score:0, note:'자료 부족'});
  const dam = state?.damImpact?.value;
  if(dam!==null && dam!==undefined) parts.push({name:'방류', value:`${dam.toFixed(1)}㎥/s`, score: dam>=1000 ? -2 : dam>=500 ? -1 : 0, note: dam>=500?'하류 방향 영향 고려':'방류 영향 낮음'});
  else parts.push({name:'방류', value:'자료 없음', score:0, note:'판정 약화'});
  return parts;
}
function confidenceScore(q, incidentState, currentState){
  let score=100;
  [incidentState?.water,currentState?.water,incidentState?.damImpact,currentState?.damImpact].forEach(p=>{
    if(!p) score-=18; else if(p.stale) score-=10; else if(p.diffMin>40) score-=8;
  });
  if(q.water!=='실측' && q.water!=='정상') score-=10;
  if(q.dam!=='실측' && q.dam!=='정상') score-=10;
  if(q.tide!=='정상' && q.tide!=='제외') score-=12;
  return Math.max(0, Math.min(100, Math.round(score)));
}
function renderChangeEvidence(b, incidentState, currentState, q){
  const waterD=signedDelta(currentState.water, incidentState.water, 'm', 2);
  const damD=signedDelta(currentState.damImpact, incidentState.damImpact, '㎥/s', 1);
  const conf=confidenceScore(q, incidentState, currentState);
  const parts=decisionScoreParts(currentState);
  const total=parts.reduce((s,p)=>s+p.score,0);
  return `
    <div class="change-grid">
      <div class="change-card"><b>수위 변화</b><strong class="${waterD.cls}">${waterD.text}</strong><span>현재 - 투신시점</span></div>
      <div class="change-card"><b>방류량 변화</b><strong class="${damD.cls}">${damD.text}</strong><span>교량 영향시각 기준</span></div>
      <div class="change-card"><b>조석 상태</b><strong>${tideShort(currentState.tide)}</strong><span>${b.tide?'교량 보정 반영':'조석 제외'}</span></div>
      <div class="change-card"><b>신뢰도</b><strong>${conf}%</strong><span>자료시차·유효성 기준</span></div>
    </div>
    <div class="evidence-card">
      <h3>판정 근거</h3>
      <div class="evidence-list">
        ${parts.map(p=>`<div><b>${p.name}</b><span>${p.value}</span><em>${p.score>0?'+':''}${p.score}점 · ${p.note}</em></div>`).join('')}
      </div>
      <div class="evidence-total"><b>종합</b><span>${total>0?'유입 영향 우세':total<0?'배출/하류 영향 우세':'혼합·경합'} · ${currentState.direction}</span></div>
      <p class="muted">판정은 유속 실측이 아니라 수위 변화, 팔당 방류량 지연 보정, 조석 보정 기반 참고값입니다.</p>
    </div>`;
}
function filterPointsRange(points,start,end){
  return points.filter(p=>p.time && p.time>=start && p.time<=end);
}
function graphStatsText(points, unit, digits=2){
  const vals=points.map(p=>p.value).filter(v=>v!==null && v!==undefined && Number.isFinite(Number(v)));
  if(!vals.length) return '그래프 통계 없음';
  const min=Math.min(...vals), max=Math.max(...vals), cur=vals[vals.length-1];
  return `최대 ${max.toFixed(digits)}${unit} · 현재 ${cur.toFixed(digits)}${unit} · 최소 ${min.toFixed(digits)}${unit}`;
}

function chartUnitFromLabel(label){
  if(/방류|㎥|m³/.test(label)) return {unit:'㎥/s', digits:1};
  if(/조위|조석|cm/.test(label)) return {unit:'cm', digits:1};
  if(/수위|\(m\)|m\)/.test(label)) return {unit:'m', digits:2};
  return {unit:'', digits:2};
}
function fmtChartValue(v, unit='', digits=2){
  if(v===null || v===undefined || !Number.isFinite(Number(v))) return '자료 없음';
  return `${Number(v).toFixed(digits)}${unit}`;
}
function ensureChartTooltip(canvas){
  if(!canvas) return null;
  let tip=document.getElementById(`${canvas.id}Tooltip`);
  if(!tip){
    tip=document.createElement('div');
    tip.id=`${canvas.id}Tooltip`;
    tip.className='chart-tooltip muted';
    tip.textContent='그래프를 누르면 해당 시점의 값을 확인할 수 있습니다.';
    canvas.insertAdjacentElement('afterend', tip);
  }
  return tip;
}
function bindChartClick(canvas){
  if(!canvas || canvas._chartClickBound) return;
  canvas._chartClickBound=true;
  canvas.addEventListener('click', (ev)=>{
    const meta=canvas._chartMeta;
    const tip=ensureChartTooltip(canvas);
    if(!meta || !meta.pts || !meta.pts.length){ if(tip) tip.textContent='클릭 가능한 그래프 데이터가 없습니다.'; return; }
    const rect=canvas.getBoundingClientRect();
    const x=ev.clientX-rect.left;
    let best=null, bestDx=Infinity;
    for(const p of meta.pts){
      const px=meta.sx(p.time.getTime());
      const dx=Math.abs(px-x);
      if(dx<bestDx){best=p; bestDx=dx;}
    }
    if(!best){ if(tip) tip.textContent='가까운 데이터가 없습니다.'; return; }
    const y=meta.sy(best[meta.key]);
    meta.lastClick={time:best.time,value:best[meta.key],x:meta.sx(best.time.getTime()),y};
    const {unit,digits}=meta.unitInfo;
    if(tip) tip.innerHTML=`<strong>클릭 지점</strong> ${pretty(best.time)} · ${meta.labelName}: <b>${fmtChartValue(best[meta.key],unit,digits)}</b>`;
    // 클릭 위치 표시를 위해 그래프를 다시 그린다.
    drawLine(canvas, meta.data, meta.key, meta.title, meta.markers, meta.labelName);
  });
}
function findNearestChartPoint(points, time){
  if(!points || !points.length || !time) return null;
  let best=null, diff=Infinity;
  for(const p of points){
    if(!p.time || p.value==null) continue;
    const d=Math.abs(p.time.getTime()-time.getTime());
    if(d<diff){best=p; diff=d;}
  }
  return best;
}
function markerValueLabel(points, time, label, unit='', digits=2){
  const p=findNearestChartPoint(points,time);
  return p ? `${label} ${fmtChartValue(p.value,unit,digits)}` : label;
}
function renderWaterInsight(b, incidentState, currentState, waterPoints=[]){
  const box=document.getElementById('waterInsight'); if(!box) return;
  const cur=currentState?.water, inc=incidentState?.water;
  if(!cur){ box.innerHTML='<b>현재 수위 직관화</b><span>현재 수위 자료 없음</span>'; return; }
  const vals=(waterPoints||[]).filter(p=>p&&p.value!=null&&p.time).map(p=>p.value);
  const min=vals.length?Math.min(...vals):null, max=vals.length?Math.max(...vals):null;
  const diffInc=inc?cur.value-inc.value:null;
  const diffMin=min!==null?cur.value-min:null;
  const diffMax=max!==null?cur.value-max:null;
  const line1=`${b.station} 관측소 기준 현재 ${cur.value.toFixed(2)}m`;
  const line2=diffInc!==null?`투신시점 대비 ${diffInc>=0?'+':''}${diffInc.toFixed(2)}m`:'투신시점 대비 계산불가';
  const line3=diffMin!==null?`조회구간 최저 대비 +${diffMin.toFixed(2)}m · 최고 대비 ${diffMax>=0?'+':''}${diffMax.toFixed(2)}m`:'조회구간 최저/최고 대비 계산불가';
  box.innerHTML=`<b>현재 수위 직관화</b><strong>${line1}</strong><span>${line2}</span><span>${line3}</span><em>교각 실제 높이 기준 환산은 교각 기준고 자료가 없어 표시하지 않습니다. 현재 표시는 관측소 수위 기준입니다.</em>`;
}
function renderDataFirstPanel(b=null, incidentState=null, currentState=null, q={}){
  const el=$('dataFirstPanel'); if(!el) return;
  if(!b || !incidentState || !currentState){
    el.innerHTML='<div class="empty-panel">환경조회 후 수위·방류량·조석 핵심값을 먼저 표시합니다.</div>';
    return;
  }
  el.innerHTML = `
    <div class="data-card primary"><b>판정</b><strong>${currentState.direction}</strong><span>${currentState.speed}</span></div>
    <div class="data-card"><b>수위</b>${dataBadge(q.water)}<div class="data-grid-mini"><span>투신</span><span>${fmtCorePoint(incidentState.water,'m')}</span><span>조회</span><span>${fmtCorePoint(currentState.water,'m')}</span><span>관측소 fw</span><span>${fmtWaterFlowPoint(currentState.waterFlow)}</span></div></div>
    <div class="data-card"><b>방류</b>${dataBadge(q.dam)}<div class="data-grid-mini"><span>투신</span><span>${fmtCorePoint(incidentState.damImpact,'cms')}</span><span>조회</span><span>${fmtCorePoint(currentState.damImpact,'cms')}</span></div></div>
    <div class="data-card"><b>조석</b>${dataBadge(q.tide)}<div class="data-grid-mini"><span>투신</span><span>${incidentState.tide?fmtTidePoint(b,incidentState.tide):'자료 없음/제외'}</span><span>조회</span><span>${currentState.tide?fmtTidePoint(b,currentState.tide):'자료 없음/제외'}</span></div></div>
    <div id="waterInsight" class="water-insight"><b>현재 수위 직관화</b><span>그래프 데이터 확정 후 표시합니다.</span></div>
    ${renderChangeEvidence(b, incidentState, currentState, q)}
  `;
}

function renderPointCompare(b, incidentState, currentState){
  const row=(name,a,c)=>`<div class="kv"><b>${name}</b><span><strong>투신</strong> ${a}<br><strong>조회</strong> ${c}</span></div>`;
  const html = `
    ${row('수위',fmtWaterPoint(incidentState.water),fmtWaterPoint(currentState.water))}
    ${row('수위 변화',fmtTrend(incidentState.wTrend),fmtTrend(currentState.wTrend))}
    ${row('수위관측소 fw',fmtWaterFlowPoint(incidentState.waterFlow),fmtWaterFlowPoint(currentState.waterFlow))}
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
    const cls = state==='실측' || state==='정상' ? 'ok' : (state==='검증필요' || state==='미조회'||state==='제외'||!state ? 'hold' : 'fail');
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
function drawTimeMarker(ctx, x, padT, ch, padB, label, color){
  ctx.save();
  ctx.strokeStyle=color; ctx.lineWidth=1.5; ctx.setLineDash([5,4]);
  ctx.beginPath(); ctx.moveTo(x,padT); ctx.lineTo(x,ch-padB); ctx.stroke();
  ctx.setLineDash([]); ctx.fillStyle=color; ctx.font='700 12px system-ui'; ctx.textAlign='center';
  const safeX=Math.max(42, Math.min(ctx.canvas.clientWidth-42, x));
  ctx.fillText(label, safeX, padT-18);
  ctx.restore();
}
function drawLine(canvas, data, key='value', label='', markers=[], labelName='값'){
  const ctx=canvas.getContext('2d'); const ratio=window.devicePixelRatio||1; canvas.width=canvas.clientWidth*ratio; canvas.height=canvas.clientHeight*ratio; ctx.setTransform(ratio,0,0,ratio,0,0);
  const cw=canvas.clientWidth, ch=canvas.clientHeight; ctx.clearRect(0,0,cw,ch); ctx.font='14px system-ui'; ctx.fillStyle='#172033'; ctx.fillText(label,14,24);
  const pts=data.filter(d=>d && d[key]!=null && d.time).sort((a,b)=>a.time-b.time);
  const unitInfo=chartUnitFromLabel(label);
  ensureChartTooltip(canvas); bindChartClick(canvas);
  if(pts.length<2){ ctx.fillStyle='#667085'; ctx.fillText('그래프 데이터 부족',14,58); canvas._chartMeta={pts:[],data,key,title:label,markers,labelName,unitInfo}; return; }
  const xs=pts.map(p=>p.time.getTime()), ys=pts.map(p=>p[key]); const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const padL=62, padR=40, padT=76, padB=52;
  const sx=x=>padL+(x-minX)/(maxX-minX||1)*(cw-padL-padR); const sy=y=>ch-padB-(y-minY)/(maxY-minY||1)*(ch-padT-padB);
  canvas._chartMeta={pts,data,key,title:label,markers,labelName,unitInfo,sx,sy};
  ctx.strokeStyle='#e5e7eb'; ctx.lineWidth=1;
  for(let i=0;i<5;i++){const y=padT+i*(ch-padT-padB)/4;ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(cw-padR,y);ctx.stroke(); ctx.fillStyle='#8a95a8'; ctx.font='12px system-ui'; const val=maxY-(maxY-minY)*i/4; ctx.fillText(val.toFixed(unitInfo.digits),12,y+4);}
  markers.filter(m=>m&&m.time).forEach(m=>{ const tx=m.time.getTime(); if(tx>=minX&&tx<=maxX) drawTimeMarker(ctx,sx(tx),padT,ch,padB,m.label,m.color||'#c53030'); });
  ctx.strokeStyle='#0f62fe'; ctx.lineWidth=3; ctx.beginPath(); pts.forEach((p,i)=>{const x=sx(p.time.getTime()), y=sy(p[key]); if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y);}); ctx.stroke();
  // 투신/조회 기준 시점의 실제값 마커
  markers.filter(m=>m&&m.time).forEach(m=>{
    const p=findNearestChartPoint(pts,m.time); if(!p) return;
    const x=sx(p.time.getTime()), y=sy(p[key]);
    ctx.fillStyle=m.color||'#c53030'; ctx.beginPath(); ctx.arc(x,y,6,0,Math.PI*2); ctx.fill();
    ctx.font='700 12px system-ui'; ctx.textAlign='center';
    const txt=m.valueLabel || `${m.label} ${fmtChartValue(p[key],unitInfo.unit,unitInfo.digits)}`;
    ctx.fillText(txt, Math.max(55,Math.min(cw-55,x)), Math.max(padT+14,y-14));
  });
  // 클릭한 지점 표시
  if(canvas._chartMeta?.lastClick){
    const c=canvas._chartMeta.lastClick;
    ctx.fillStyle='#101828'; ctx.beginPath(); ctx.arc(c.x,c.y,7,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.stroke();
  }
  ctx.fillStyle='#172033'; const last=pts[pts.length-1]; ctx.beginPath(); ctx.arc(sx(last.time.getTime()),sy(last[key]),5,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#667085'; ctx.font='13px system-ui'; ctx.textAlign='left'; ctx.fillText(hhmm(pts[0].time),padL,ch-16); ctx.fillText(hhmm(last.time),cw-78,ch-16);
}
function drawMultiLine(canvas, series, label='', markers=[]){
  const ctx=canvas.getContext('2d'); const ratio=window.devicePixelRatio||1; canvas.width=canvas.clientWidth*ratio; canvas.height=canvas.clientHeight*ratio; ctx.setTransform(ratio,0,0,ratio,0,0);
  const cw=canvas.clientWidth, ch=canvas.clientHeight; ctx.clearRect(0,0,cw,ch);
  const all=series.flatMap(s=>s.points).filter(p=>p.time&&p.value!=null);
  ctx.font='700 15px system-ui'; ctx.fillStyle='#172033'; ctx.fillText(label,16,24);
  if(all.length<2){ ctx.fillStyle='#667085'; ctx.fillText('통합 그래프 데이터 부족',16,60); return; }
  const xs=all.map(p=>p.time.getTime()), minX=Math.min(...xs), maxX=Math.max(...xs);
  const padL=62, padR=38, padT=112, padB=48;
  const sx=x=>padL+(x-minX)/(maxX-minX||1)*(cw-padL-padR); const sy=y=>ch-padB-(y/100)*(ch-padT-padB);
  const colors=['#0f62fe','#b7791f','#078a4f'];
  const legends=[
    {label:'수위(m) 정규화', desc:'파란선', color:colors[0]},
    {label:'방류량(㎥/s) 정규화', desc:'갈색선', color:colors[1]},
    {label:'조석(cm) 정규화', desc:'초록선', color:colors[2]}
  ];
  legends.forEach((l,i)=>{const x=18+i*260; ctx.fillStyle=l.color; ctx.fillRect(x,44,34,8); ctx.fillStyle='#172033'; ctx.font='14px system-ui'; ctx.fillText(`${l.desc} = ${l.label}`,x+44,52);});
  ctx.fillStyle='#667085'; ctx.font='12px system-ui'; ctx.fillText('※ 서로 단위가 달라 실제값이 아니라 0~100 정규화로 변화 방향만 비교합니다.',18,80);
  markers.filter(m=>m&&m.time).forEach((m,i)=>{ctx.fillStyle=m.color||'#c53030'; ctx.font='700 12px system-ui'; ctx.fillText(`${m.label} ${hhmm(m.time)}`,18+i*150,99);});
  ctx.strokeStyle='#e5e7eb'; ctx.lineWidth=1;
  for(let i=0;i<5;i++){const y=padT+i*(ch-padT-padB)/4;ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(cw-padR,y);ctx.stroke(); ctx.fillStyle='#8a95a8'; ctx.font='12px system-ui'; ctx.fillText(String(100-i*25),18,y+4);}
  markers.filter(m=>m&&m.time).forEach(m=>{ const tx=m.time.getTime(); if(tx>=minX&&tx<=maxX) drawTimeMarker(ctx,sx(tx),padT,ch,padB,m.label,m.color||'#c53030'); });
  series.forEach((s,si)=>{
    const pts=s.points.filter(p=>p.time&&p.value!=null).sort((a,b)=>a.time-b.time);
    if(pts.length<2) return;
    ctx.strokeStyle=colors[si%colors.length]; ctx.lineWidth=4; ctx.beginPath();
    pts.forEach((p,i)=>{const x=sx(p.time.getTime()), y=sy(p.value); if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y);}); ctx.stroke();
    const last=pts[pts.length-1]; ctx.fillStyle=colors[si%colors.length]; ctx.beginPath(); ctx.arc(sx(last.time.getTime()),sy(last.value),6,0,Math.PI*2); ctx.fill();
    ctx.fillStyle=colors[si%colors.length]; ctx.font='13px system-ui'; ctx.fillText(s.name, Math.min(cw-80, sx(last.time.getTime())+8), Math.max(padT+12, Math.min(ch-padB-6, sy(last.value))));
  });
  ctx.fillStyle='#667085'; ctx.font='13px system-ui'; const first=new Date(minX), last=new Date(maxX); ctx.fillText(hhmm(first),padL,ch-14); ctx.fillText(hhmm(last),cw-78,ch-14);
}
function stationGroupLabel(b){
  if(!b.tide) return '조석 제외';
  if(b.zone.includes('상류')) return '상류권';
  if(b.zone.includes('중상류')) return '중상류';
  if(b.zone.includes('중류')) return '중류';
  if(b.zone.includes('하류')) return '하류';
  return b.zone || '기타';
}
function renderBoard(results=[], selectedBridge=null, currentState=null){
  const selectedName = selectedBridge?.bridge || results[0]?.bridge;
  $('bridgeBoard').innerHTML = BRIDGES.map(b=>{
    const isSelected = b.bridge===selectedName;
    const sameStation = selectedBridge && b.code===selectedBridge.code;
    const stationInfo = `${b.station.replace('서울시(','').replace(')','')} · ${b.code}`;
    let status = '';
    if(isSelected && currentState){
      status = `<div class="bridge-status strong">${currentState.direction}</div><div class="muted">${currentState.speed}</div><div class="muted">수위 ${currentState.water?currentState.water.value.toFixed(2)+'m':'자료 없음'} · 방류 ${currentState.damImpact?currentState.damImpact.value.toFixed(1)+'㎥/s':'자료 없음'}</div>`;
    }else if(sameStation && currentState){
      status = `<div class="bridge-status">동일 관측소 참고</div><div class="muted">${currentState.direction}</div>`;
    }else{
      status = `<div class="bridge-status muted">선택 시 재계산</div>`;
    }
    const dirClass = currentState?.direction?.includes('들어오는') || currentState?.direction?.includes('유입') ? 'inflow' : (currentState?.direction?.includes('나가는') || currentState?.direction?.includes('하류') ? 'outflow' : 'unknown');
    return `<div class="bridge-item ${isSelected?'selected':''} ${sameStation?'same-station':''} ${isSelected||sameStation?dirClass:''}"><div class="bridge-top"><h3>${b.bridge}</h3><span>${stationGroupLabel(b)}</span></div><div>${stationInfo}</div><div>${b.tide?'조석 적용':'조석 제외'}</div>${status}<div class="muted small-note">${b.zone}</div></div>`;
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
  const start=floorTo10Min(new Date(incident.getTime()-Math.max(90,(b.releaseLag||0)+90)*60000));
  // HRFCO 10M API는 임의 분(:13 등) 또는 너무 최근 시각에서 공백 행을 반환하는 경우가 있어 10분 격자와 충분한 지연을 강제한다.
  const nowLimit=floorTo10Min(new Date(Date.now()-90*60000));
  const rawEnd=floorTo10Min(new Date(search.getTime()+90*60000));
  const end=rawEnd>nowLimit ? nowLimit : rawEnd;
  log('[조회시각 보정]', `입력 조회시각=${pretty(search)}`, `HRFCO 종료=${pretty(end)}`, '10분 단위·현재-90분 제한');
  const q={water:'대기',dam:'대기',tide:b.tide?'대기':'제외',weather:'미조회'}; renderQuality(q);
  let waterRows=[], damRows=[], tideRows=[];
  try{ waterRows=await getWaterSeries(key,b.code,start,end); }catch(e){ q.water='실패'; log('[수위 최종 실패]',e.message); }
  try{ damRows=await getDamSeries(key,start,end); }catch(e){ q.dam='실패'; log('[댐 최종 실패]',e.message); }
  try{
    const patched=await applyHrfcoFallbacks(key,b,waterRows,damRows);
    waterRows=patched.waterRows; damRows=patched.damRows;
    if(patched.waterFallback) log('[수위 보강 적용]', '기간그래프는 공백일 수 있고, 현재값은 최신 endpoint 기준입니다.');
    if(patched.damFallback) log('[방류 보강 적용]', '기간그래프는 공백일 수 있고, 현재값은 최신 endpoint 기준입니다.');
  }catch(e){ log('[HRFCO 보강 처리 오류]', e.message); }
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
  renderDataFirstPanel(b, incidentState, currentState, q);
  renderModelInfo(b);

  const waterKeys=waterMetric.key?[waterMetric.key]:WATER_KEYS;
  const damKeys=damMetric.key?[damMetric.key]:DAM_KEYS;
  const waterPts=rowsToPoints(waterRows,waterKeys);
  const damPts=rowsToPoints(damRows,damKeys);
  const tidePts=rowsToPoints(tideRows,TIDE_KEYS);
  const waterDisplayPts=filterPointsRange(waterPts, incident, search);
  const damStart=new Date(incident.getTime()-(b.releaseLag||0)*60000);
  const damEnd=new Date(search.getTime()-(b.releaseLag||0)*60000);
  const damDisplayPts=filterPointsRange(damPts, damStart, damEnd);
  const tideStart=b.tide?new Date(incident.getTime()-(b.offset||0)*60000):incident;
  const tideEnd=b.tide?new Date(search.getTime()-(b.offset||0)*60000):search;
  const tideDisplayPts=filterPointsRange(tidePts, tideStart, tideEnd);
  drawMultiLine($('combinedChart'), [
    {name:'수위',points:normalizePoints(waterDisplayPts)},
    {name:'방류',points:normalizePoints(damDisplayPts)},
    {name:'조석',points:normalizePoints(tideDisplayPts)}
  ], `${b.bridge} · 통합 참고 그래프`, [
    {time:incident, label:'투신', color:'#0f62fe'},
    {time:search, label:'조회', color:'#c53030'}
  ]);
  $('combinedChartNote').textContent = `파란선=수위, 갈색선=방류량, 초록선=조석. 단위가 달라 0~100 정규화한 참고 그래프입니다.`;
  renderWaterInsight(b, incidentState, currentState, waterDisplayPts);
  drawLine($('waterChart'), waterDisplayPts, 'value', `${b.station} 수위(m) · 투신~조회`, [
    {time:incident, label:'투신', color:'#0f62fe', valueLabel:markerValueLabel(waterDisplayPts,incident,'투신','m',2)},
    {time:search, label:'조회', color:'#c53030', valueLabel:markerValueLabel(waterDisplayPts,search,'조회','m',2)}
  ], '수위');
  $('waterChartNote').textContent = `${graphStatsText(waterDisplayPts,'m',2)} · ${currentState.wTrend ? `조회시점 기준 최근 1시간 변화 ${currentState.wTrend.delta>0?'+':''}${currentState.wTrend.delta}m` : '최근 1시간 변화 계산불가'} · 관측값 시간차는 입력시각과 가장 가까운 HRFCO 관측시각의 차이입니다.`;
  drawLine($('damChart'), damDisplayPts, 'value', `팔당댐 방류량(㎥/s) · 교량 영향시각 기준`, [
    {time:damStart, label:'투신 영향', color:'#0f62fe', valueLabel:markerValueLabel(damDisplayPts,damStart,'투신 영향','㎥/s',1)},
    {time:damEnd, label:'조회 영향', color:'#c53030', valueLabel:markerValueLabel(damDisplayPts,damEnd,'조회 영향','㎥/s',1)}
  ], '방류량');
  $('damChartNote').textContent = `${graphStatsText(damDisplayPts,'㎥/s',1)} · ${currentState.damImpact ? `조회시점 교량 영향 방류량 ${currentState.damImpact.value.toFixed(1)}㎥/s · 팔당 ${b.releaseLag}분 지연 보정` : '방류량 미조회'}`;
  if(tideRows.length){ drawLine($('tideChart'), tideDisplayPts, 'value', `인천 조위(cm) · 교량 보정 기준`, [
    {time:tideStart, label:'투신 보정', color:'#0f62fe', valueLabel:markerValueLabel(tideDisplayPts,tideStart,'투신 보정','cm',1)},
    {time:tideEnd, label:'조회 보정', color:'#c53030', valueLabel:markerValueLabel(tideDisplayPts,tideEnd,'조회 보정','cm',1)}
  ], '조위'); $('tideChartNote').textContent = currentState.tide ? `현재 ${currentState.tide.phase}. 전환시각은 ${currentState.tide.nextTurn?`인천 ${hhmm(currentState.tide.nextTurn.time)} / 교량 ${hhmm(new Date(currentState.tide.nextTurn.time.getTime()+(b.offset||0)*60000))}`:'자료 부족'} · 입력시각과 조석 기준값 차이 ${currentState.tide.diffMin}분.` : '조석 매칭 실패'; }
  else { drawLine($('tideChart'), [], 'value', '조석', [], '조위'); $('tideChartNote').textContent='조석 API 미조회'; }
  $('tideSummary').innerHTML = currentState.tide ? `<div class="summary-big">${currentState.tide.phase}</div><div>${fmtTidePoint(b,currentState.tide)}</div>` : `<div class="summary-big">${b.tide?'조석 미조회':'조석 적용 제외'}</div>`;
  renderBoard([{bridge:b.bridge,direction:`${currentState.direction} · ${currentState.speed}`}], b, currentState);
  $('inputStatus').textContent='조회 완료. 시간차 표기는 입력시각과 가장 가까운 관측자료 시각의 차이입니다.';
}

document.addEventListener('DOMContentLoaded', init);
