/* HanRiver Environment Dashboard v1.0 Phase 3.5.0 SingokWeir
 * ================================================================
 * 핵심 변경 (Phase 3.5.0):
 *   1. 신곡수중보(2022510) 실측 수위 조회 → swl > 2.4m 이면 조석 전파 중 판정
 *   2. 교량별 조석 적용 여부를 실시간으로 결정 (고정 offset 제거)
 *   3. 정식 물때(1~13물, 사리/조금) 천문 기준 역산
 *   4. 수위 우선순위: HRFCO 실측 1순위, 없으면 계산값(추정) 라벨 필수
 *   5. 기존 API 조회 로직(getWaterSeries, getDamSeries, getTideRowsRange) 완전 유지
 *
 * 원칙:
 *   - 조회 실패 데이터는 추정값으로 대체하지 않고 반드시 "조회 실패"로 표시
 *   - 실시간값/과거값/계산값/추정값 구분 표시
 *   - 잠실수중보 상류 구간: 조석 영향 없음 (코드상 tide:false)
 *   - 신곡수중보: 고정 구조물, 개폐 여부 계산 로직 없음
 *   - swl 기준 조석 전파 판단: swl ≥ SINGOK_TIDE_THRESHOLD(2.4m) 이면 전파
 * ================================================================
 */

// ── 전역 유틸 ──────────────────────────────────────────────────
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

// ── 상수 ──────────────────────────────────────────────────────
const DAM_CODE = '1017310';               // 팔당댐
const SINGOK_BO_CODE = '2022510';         // 신곡수중보 (확인됨 2026-07-01)
const SINGOK_TIDE_THRESHOLD = 2.4;        // 신곡수중보 마루高 기준 (m), 이 이상이면 조석 전파
const TIDE_STATION = 'DT_0001';           // 인천 조위관측소
const MAX_NEAREST_MIN = 40;

// 수위/방류량 필드 후보
const WATER_FIXED_KEY = 'wl';
const WATER_FLOW_FIXED_KEY = 'fw';
const DAM_FIXED_KEY = 'tototf';
const WATER_KEYS = ['wl','WL','obswl','OBSWL','obsWl','obs_wl','wlevel','WLEVEL','waterLevel','WaterLevel','waterlevel','WATERLEVEL','swl','SWL','wlobs','WLOBS','wlv','WLV','rfwl','RFWL','fw','FW'];
const DAM_KEYS = ['tototf','TOTOTF','totOutflow','totalOutflow','tot_outflow','otf','OTF','edq','EDQ','outflow','OUTFLOW','discharge','DISCHARGE','fw','FW','tdsrf','TDSRF','flow','FLOW','q','Q'];
const TIDE_KEYS = ['tdlvHgt','tdlv_hgt','tideHeight','tideHgt','tide_hgt','tideLevel','tide_level','tphLevel','tph_level','level','obsLevel','obs_level','wl','value','fcstValue'];
const SINGOK_KEYS = ['swl','SWL']; // 신곡수중보 상류수위

// ── 신곡수중보 조석 전파 상태 (전역) ──────────────────────────
// {status:'active'|'blocked'|'unknown', swl:number|null, time:Date|null, checkedAt:Date}
let singokTideState = { status:'unknown', swl:null, time:null, checkedAt:null };

// ── 물때 계산 기준 ─────────────────────────────────────────────
// 한국천문연구원 기준 음력 사리 앵커: 2000-01-06 (확인된 사리 기준일)
// 반삭망월 주기: 14.7653일
const LUNAR_ANCHOR = new Date(2000, 0, 6, 0, 0, 0);
const LUNAR_CYCLE = 14.7653;

// ── 교량 정의 ──────────────────────────────────────────────────
// tide: 해당 교량이 조석 영향 구간인지 (잠실수중보 상류는 false)
// tideRealtime: true → 신곡수중보 swl로 실시간 조석 전파 여부 판단
// offset: 인천 기준 조석 지연 분 (신곡수중보 swl이 2.4m 이상일 때만 적용)
//         ※ 물리 계산: 인천→교량 하구거리(km) / 조석파 전파속도 12m/s
// releaseLag: 팔당→교량 방류 지연 분 (경험적 추정, 참고용)
const BRIDGES = [
  // ─── 잠실수중보 상류 (조석 완전 제외) ───────────────────────
  {bridge:'강동대교',    zone:'수중보 상류',       station:'서울시(광진교)',   code:'1018640', tide:false, tideRealtime:false, offset:null, releaseLag:330},
  {bridge:'구리암사대교',zone:'수중보 상류',        station:'서울시(광진교)',   code:'1018640', tide:false, tideRealtime:false, offset:null, releaseLag:330},
  {bridge:'천호대교',    zone:'수중보 상류',       station:'서울시(광진교)',   code:'1018640', tide:false, tideRealtime:false, offset:null, releaseLag:330},
  {bridge:'광진교',      zone:'수중보 상류',       station:'서울시(광진교)',   code:'1018640', tide:false, tideRealtime:false, offset:null, releaseLag:330},
  {bridge:'올림픽대교',  zone:'수중보 상류',       station:'서울시(광진교)',   code:'1018640', tide:false, tideRealtime:false, offset:null, releaseLag:330},
  {bridge:'잠실철교',    zone:'잠실수중보 상류',    station:'서울시(청담대교)', code:'1018662', tide:false, tideRealtime:false, offset:null, releaseLag:330},
  // ─── 잠실수중보 하류 (신곡수중보 swl 실시간 판단) ─────────────
  {bridge:'잠실대교',    zone:'수중보 하류(상)',    station:'서울시(청담대교)', code:'1018662', tide:true, tideRealtime:true, offset:85, releaseLag:330},
  {bridge:'청담대교',    zone:'중상류',            station:'서울시(청담대교)', code:'1018662', tide:true, tideRealtime:true, offset:85, releaseLag:330},
  {bridge:'영동대교',    zone:'중상류',            station:'서울시(청담대교)', code:'1018662', tide:true, tideRealtime:true, offset:85, releaseLag:330},
  {bridge:'성수대교',    zone:'중상류',            station:'서울시(청담대교)', code:'1018662', tide:true, tideRealtime:true, offset:80, releaseLag:325},
  {bridge:'동호대교',    zone:'중류',              station:'서울시(잠수교)',   code:'1018680', tide:true, tideRealtime:true, offset:75, releaseLag:315},
  {bridge:'한남대교',    zone:'중류',              station:'서울시(잠수교)',   code:'1018680', tide:true, tideRealtime:true, offset:75, releaseLag:315},
  {bridge:'잠수교',      zone:'중류',              station:'서울시(잠수교)',   code:'1018680', tide:true, tideRealtime:true, offset:70, releaseLag:310},
  {bridge:'반포대교',    zone:'중류',              station:'서울시(반포2교)',  code:'1018681', tide:true, tideRealtime:true, offset:70, releaseLag:310},
  {bridge:'동작대교',    zone:'중류',              station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:65, releaseLag:305},
  {bridge:'한강철교',    zone:'중류',              station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:65, releaseLag:305},
  {bridge:'한강대교',    zone:'중류',              station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:65, releaseLag:300},
  {bridge:'원효대교',    zone:'중류',              station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:62, releaseLag:300},
  {bridge:'마포대교',    zone:'중류',              station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:60, releaseLag:295},
  {bridge:'서강대교',    zone:'중류',              station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:58, releaseLag:290},
  {bridge:'당산철교',    zone:'중류',              station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:58, releaseLag:290},
  {bridge:'양화대교',    zone:'중하류',            station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:55, releaseLag:285},
  {bridge:'성산대교',    zone:'하류 조석',         station:'서울시(행주대교)', code:'1019630', tide:true, tideRealtime:true, offset:58, releaseLag:270},
  {bridge:'월드컵대교',  zone:'하류 조석',         station:'서울시(행주대교)', code:'1019630', tide:true, tideRealtime:true, offset:56, releaseLag:268},
  {bridge:'가양대교',    zone:'하류 조석',         station:'서울시(행주대교)', code:'1019630', tide:true, tideRealtime:true, offset:54, releaseLag:265},
  {bridge:'마곡대교',    zone:'하류 조석',         station:'서울시(행주대교)', code:'1019630', tide:true, tideRealtime:true, offset:53, releaseLag:263},
  {bridge:'방화대교',    zone:'하류 조석',         station:'서울시(행주대교)', code:'1019630', tide:true, tideRealtime:true, offset:53, releaseLag:262},
  {bridge:'행주대교',    zone:'하류 조석',         station:'서울시(행주대교)', code:'1019630', tide:true, tideRealtime:true, offset:53, releaseLag:260},
];

// ── 정식 물때 계산 ─────────────────────────────────────────────
// 인천 물때표 기준 (1물=사리, 8물=조금)
// 2000-01-06 사리 앵커 → 14.7653일 주기 역산
function tideNumber(date){
  const dayOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = (dayOnly - LUNAR_ANCHOR) / 86400000;
  const cyclePos = ((diffDays % LUNAR_CYCLE) + LUNAR_CYCLE) % LUNAR_CYCLE;
  const step = LUNAR_CYCLE / 15;
  let n = Math.floor(cyclePos / step) + 1;
  if(n > 15) n = 15;
  if(n < 1) n = 1;

  // 인천 물때 명칭 체계 (1물~13물, 14·15물은 "무시")
  let display, name;
  if(n === 1 || n === 2)      { display = n; name = '사리'; }
  else if(n >= 3 && n <= 7)   { display = n; name = '중간물(사리쪽)'; }
  else if(n === 8)             { display = n; name = '조금'; }
  else if(n >= 9 && n <= 13)  { display = n; name = '중간물(조금쪽)'; }
  else                         { display = n-13; name = '무시(사리 전)'; }

  return { n: display, raw: n, name, cyclePos: Number(cyclePos.toFixed(2)),
           basis: '천문 기준일 역산(2000-01-06 사리 앵커 · 14.7653일 주기)' };
}

// ── 신곡수중보 조석 전파 판단 ──────────────────────────────────
function isTideActiveAt(singokSwl){
  if(singokSwl === null || singokSwl === undefined) return null; // 알 수 없음
  return singokSwl >= SINGOK_TIDE_THRESHOLD;
}
function singokStatusLabel(swl){
  const active = isTideActiveAt(swl);
  if(active === null) return { text:'신곡수중보 수위 조회 실패 — 조석 전파 여부 판단 불가', cls:'warn', icon:'⚠' };
  if(active) return { text:`신곡수중보 상류수위 ${swl.toFixed(2)}m ≥ ${SINGOK_TIDE_THRESHOLD}m → 조석 전파 중`, cls:'ok', icon:'🌊' };
  return { text:`신곡수중보 상류수위 ${swl.toFixed(2)}m < ${SINGOK_TIDE_THRESHOLD}m → 조석 차단`, cls:'hold', icon:'⛔' };
}
// 해당 교량에 실제 조석이 영향을 주는지 (신곡수중보 실측 반영)
function bridgeTideActive(b, singokSwl){
  if(!b.tide) return false; // 잠실수중보 상류: 항상 제외
  if(!b.tideRealtime) return false;
  const active = isTideActiveAt(singokSwl);
  if(active === null) return null; // 알 수 없음 → null 반환
  return active;
}

// ── 날짜/시간 유틸 ────────────────────────────────────────────
function formatDateInput(v){ const d=v.replace(/\D/g,'').slice(0,8); if(d.length<=4)return d; if(d.length<=6)return `${d.slice(0,4)}-${d.slice(4)}`; return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6)}`; }
function formatTimeInput(v){ const d=v.replace(/\D/g,'').slice(0,4); if(d.length<=2)return d; return `${d.slice(0,2)}:${d.slice(2)}`; }
function validDate(s){ return /^\d{4}-\d{2}-\d{2}$/.test(s); }
function validTime(s){ if(!/^\d{2}:\d{2}$/.test(s))return false; const [h,m]=s.split(':').map(Number); return h>=0&&h<=23&&m>=0&&m<=59; }
function parseLocal(date,time){ if(!validDate(date)||!validTime(time)) return null; const [y,mo,d]=date.split('-').map(Number); const [h,mi]=time.split(':').map(Number); return new Date(y,mo-1,d,h,mi,0); }
function ymd(d){ return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }
function ymdhm(d){ return ymd(d)+String(d.getHours()).padStart(2,'0')+String(d.getMinutes()).padStart(2,'0'); }
function floorTo10Min(d){ const x=new Date(d); x.setSeconds(0,0); x.setMinutes(Math.floor(x.getMinutes()/10)*10); return x; }
function hrfcoWindow(start,end){ let s=floorTo10Min(start); let e=floorTo10Min(end); if(e<=s) e=new Date(s.getTime()+10*60000); return {start:s,end:e,startCode:ymdhm(s),endCode:ymdhm(e)}; }
function hhmm(d){ return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function pretty(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${hhmm(d)}`; }
function setDefaultTimes(){ const now=new Date(); const incident=new Date(now.getTime()-6*3600e3); $('incidentDate').value=formatDateInput(ymd(incident)); $('incidentTime').value=hhmm(incident); $('searchDate').value=formatDateInput(ymd(now)); $('searchTime').value=hhmm(now); }
function setNow(){ const now=new Date(); $('searchDate').value=formatDateInput(ymd(now)); $('searchTime').value=hhmm(now); $('inputStatus').textContent='조회시각을 현재시각으로 입력했습니다.'; }

// ── 키 관리 ──────────────────────────────────────────────────
function saveKeys(){ ['hrfcoKey','tideKey','weatherKey'].forEach(id=>localStorage.setItem(id,$(id).value.trim())); $('keyStatus').textContent='저장 완료'; }
function clearKeys(){ ['hrfcoKey','tideKey','weatherKey'].forEach(id=>{localStorage.removeItem(id);$(id).value='';}); $('keyStatus').textContent='삭제 완료'; }
function loadKeys(){ ['hrfcoKey','tideKey','weatherKey'].forEach(id=>{ $(id).value=localStorage.getItem(id)||''; $(id).type='password'; }); }
function toggleKey(id, btn){ const input=$(id); if(!input) return; input.type = input.type==='password'?'text':'password'; btn.textContent = input.type==='password'?'보기':'숨김'; }
function hrfcoKeyVariants(key){ const raw=String(key||'').trim(); if(!raw) throw new Error('한강홍수통제소 인증키 없음'); const v=[]; const add=(x)=>{if(x&&!v.includes(x))v.push(x);}; add(raw); try{add(encodeURIComponent(raw));}catch(e){} try{add(decodeURIComponent(raw));}catch(e){} return v; }
function decodeURIComponentSafe(s){ try{return decodeURIComponent(s);}catch{return s;} }

// ── fetch 공통 ────────────────────────────────────────────────
async function fetchJson(url, timeoutMs=10000){
  log('[FETCH]', url);
  const controller = new AbortController();
  let timer;
  const tp = new Promise((_,reject)=>{ timer=setTimeout(()=>{ try{controller.abort();}catch(e){} reject(new Error(`요청 타임아웃 ${Math.round(timeoutMs/1000)}초`)); }, timeoutMs); });
  const fp = (async()=>{ const r=await fetch(url,{signal:controller.signal,cache:'no-store'}); const text=await r.text(); if(!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0,160)}`); try{return JSON.parse(text);}catch(e){throw new Error('JSON 파싱 실패: '+text.slice(0,160));} })();
  try{ return await Promise.race([fp,tp]); }
  catch(e){ if(e.name==='AbortError') throw new Error(`요청 타임아웃 ${Math.round(timeoutMs/1000)}초`); throw e; }
  finally{ clearTimeout(timer); }
}

// ── 데이터 정규화 ─────────────────────────────────────────────
function normalizeRows(data){
  if(!data) return [];
  const cands=[data?.content,data?.list,data?.body?.items?.item,data?.response?.body?.items?.item,data?.items?.item,data?.data,data?.result?.data,data?.response?.body?.item];
  for(const c of cands){ if(Array.isArray(c)) return c; if(c&&typeof c==='object'){const nested=[c.content,c.list,c.data,c.items?.item,c.result?.data,c.body?.items?.item]; for(const n of nested){if(Array.isArray(n)) return n;} return [c];} }
  if(Array.isArray(data)) return data;
  return findBestArray(data);
}
function findBestArray(obj){ let best=[],bestScore=-1; const seen=new Set(); function walk(x,d=0){ if(!x||d>5)return; if(Array.isArray(x)){const s=scoreArray(x); if(s>bestScore){best=x;bestScore=s;} for(const it of x.slice(0,3))walk(it,d+1);return;} if(typeof x==='object'){if(seen.has(x))return;seen.add(x);for(const v of Object.values(x))walk(v,d+1);} } walk(obj,0); return bestScore>0?best:[]; }
function scoreArray(arr){ if(!arr||!arr.length)return 0; let s=Math.min(arr.length,50); for(const r of arr.slice(0,5)){const f=flatRow(r);const keys=Object.keys(f).join('|').toLowerCase(); if(/ymdhm|obsymdhm|obstm|obs_time|date|time|tm|predcdt|tdlvdt/.test(keys))s+=30; if(/(^|[.|_])(wl|obswl|waterlevel|wlevel|swl|fw|tototf|otf|outflow|discharge|tdlvhgt)([.|_]|$)/.test(keys))s+=50;} return s; }
function flatRow(row,prefix='',out={}){ if(row===undefined||row===null)return out; if(Array.isArray(row)){row.forEach((v,i)=>{out[`${prefix}col${i}`]=v;}); for(const v of row){const nums=String(v??'').replace(/\D/g,'');if(nums.length>=12&&!out.ymdhm){out.ymdhm=nums.slice(0,12);break;}} for(const v of row){const n=toNumber(v);const nums=String(v??'').replace(/\D/g,'');if(n!==null&&nums.length<10){out.value=n;break;}} return out;} if(typeof row!=='object'){out[prefix||'value']=row;return out;} for(const [k,v] of Object.entries(row)){const path=prefix?`${prefix}.${k}`:k; if(v&&typeof v==='object'&&!Array.isArray(v)){flatRow(v,path,out);}else{out[path]=v;if(!(k in out))out[k]=v;}} return out; }
function parseObsTime(row){ const r=flatRow(row); const raw=r.obstm||r.obsTime||r.obs_time||r.ymdhm||r.obsymdhm||r.ymdh||r.tm||r.datetime||r.dateTime||r.fcstDateTime||r.predcDt||r.obsvDt||r.tideTime||r.tide_time||r.tphTime||r.tph_time||r.tdlvTime||r.tdlv_time||r.time||r.date; let nums=raw?String(raw).replace(/\D/g,''):''; if(nums.length>=12){const y=+nums.slice(0,4),mo=+nums.slice(4,6),d=+nums.slice(6,8),h=+nums.slice(8,10),m=+nums.slice(10,12);return new Date(y,mo-1,d,h,m);} const dateRaw=r.reqDate||r.fcstDate||r.date||r.tideDate||r.tide_date||r.ymd; const timeRaw=r.hm||r.hhmm||r.tideTime||r.tide_time||r.tphTime||r.tph_time||r.time||r.tm; const dnums=dateRaw?String(dateRaw).replace(/\D/g,''):''; const tnums=timeRaw?String(timeRaw).replace(/\D/g,''):''; if(dnums.length>=8&&tnums.length>=3){const y=+dnums.slice(0,4),mo=+dnums.slice(4,6),d=+dnums.slice(6,8); const hm=tnums.padStart(4,'0'); return new Date(y,mo-1,d,+hm.slice(0,2),+hm.slice(2,4));} return null; }
function toNumber(v){ if(v===undefined||v===null)return null; if(typeof v==='number')return Number.isFinite(v)?v:null; const s=String(v).trim(); if(!s||s==='-'||s.toLowerCase()==='null')return null; const cleaned=s.replace(/,/g,'').replace(/[^0-9.+\-]/g,'').trim(); if(!cleaned||cleaned==='-'||cleaned==='+'||cleaned==='.'||cleaned==='-.') return null; const n=Number(cleaned); return Number.isFinite(n)?n:null; }
function val(row, keys){ const r=flatRow(row); for(const k of keys){if(Object.prototype.hasOwnProperty.call(r,k)){const n=toNumber(r[k]);if(n!==null)return n;}} return null; }
function hasNumericValue(rows, keys){ return Array.isArray(rows)&&rows.some(row=>{const r=flatRow(row);return keys.some(k=>{const v=r[k];return v!==null&&v!==undefined&&String(v).trim()!==''&&!isNaN(Number(v));});}); }

// ── 메트릭 감지 ──────────────────────────────────────────────
function metricStats(rows,keys){ const stats=[]; for(const k of keys){const vals=[];let exists=0,nonblank=0; for(const row of rows){const r=flatRow(row);if(Object.prototype.hasOwnProperty.call(r,k)){exists++;const raw=r[k];if(String(raw??'').trim()!=='')nonblank++;const n=toNumber(raw);if(n!==null)vals.push(n);}} if(exists||vals.length){const min=vals.length?Math.min(...vals):null,max=vals.length?Math.max(...vals):null; stats.push({key:k,count:vals.length,exists,nonblank,numeric:vals.length,min,max,first:vals[0]??null,last:vals[vals.length-1]??null,allZero:vals.length?vals.every(v=>Math.abs(v)<1e-9):false,blank:exists>0&&nonblank===0});}} return stats; }
function isMetricExcluded(k,label,n){ const s=String(k).toLowerCase(); if(/code|cd|id|name|nm|ymdh|ymd|date|time|dt|tm|lat|lon|page|row|count|num|no|seq|min|hour|addr/.test(s))return true; if(Math.abs(n)>1000000)return true; if(label==='수위'&&/attwl|wrnwl|almwl|srswl|wlobscd|obscd|flow|out|discharge|tototf|otf/.test(s))return true; return false; }
function metricKeyScore(k,label,min,max,count){ const s=String(k).toLowerCase(); let score=count; if(label==='수위'){if(/(^|[._])(wl|obswl|waterlevel|wlevel|swl|wlv|rfwl)([._]|$)/.test(s)||/water.*level/.test(s))score+=200; if(max>=-5&&max<=50)score+=30; if(max-min>0)score+=20;} else if(label==='방류량'){if(/tototf|otf|outflow|out_flow|discharge|edq|tdsrf|(^|[._])fw([._]|$)|flow/.test(s))score+=200; if(max>=0&&max<=100000)score+=20; if(max-min>0)score+=20;} return score; }
function autoMetricStats(rows,label){ const bucket={}; for(const row of rows){const r=flatRow(row); for(const [k,v] of Object.entries(r)){const n=toNumber(v);if(n===null)continue;if(isMetricExcluded(k,label,n))continue;(bucket[k]||=[]).push(n);}} const stats=[]; for(const [k,vals] of Object.entries(bucket)){if(vals.length<Math.max(2,Math.ceil(rows.length*0.25)))continue;const min=Math.min(...vals),max=Math.max(...vals);stats.push({key:k,count:vals.length,min,max,first:vals[0],last:vals[vals.length-1],allZero:vals.every(v=>Math.abs(v)<1e-9),auto:true,score:metricKeyScore(k,label,min,max,vals.length)});} stats.sort((a,b)=>b.score-a.score); return stats; }
function detectMetric(rows,keys,label){ const fixedKey=label==='수위'?WATER_FIXED_KEY:(label==='방류량'?DAM_FIXED_KEY:null); const stats=metricStats(rows,keys); let allStats=stats; const fixed=fixedKey?allStats.find(s=>String(s.key).toLowerCase()===fixedKey.toLowerCase()):null; if(fixed){log(`[${label} 고정필드]`,`${fixed.key} exists=${fixed.exists} nonblank=${fixed.nonblank} numeric=${fixed.numeric}`); if(fixed.numeric>0){const suspicious=fixed.allZero||(fixed.max!==null&&fixed.min!==null&&Math.abs(fixed.max-fixed.min)<1e-9);return{key:fixed.key,status:suspicious?'검증필요':'실측',stats:allStats,chosen:fixed,blank:false};} if(fixed.exists>0&&fixed.nonblank===0){log(`[${label} 통제소 응답 공백]`,`${fixed.key} 필드는 있으나 ${fixed.exists}행 모두 빈값`);return{key:fixed.key,status:'공백',stats:allStats,chosen:fixed,blank:true};}} if(!allStats.some(s=>s.numeric>0)){const auto=autoMetricStats(rows,label);allStats=[...allStats,...auto];log(`[${label} 자동탐지]`,`${auto.length}개`);} const numericStats=allStats.filter(s=>s.numeric>0||s.count>0); if(!numericStats.length){if(rows[0]){const f=flatRow(rows[0]);log(`[${label} 원자료 키]`,Object.keys(f).slice(0,80).join(', '));}return{key:fixedKey,status:'공백',stats:allStats,blank:true};} let chosen=numericStats.find(s=>!s.allZero&&s.max!==null&&s.min!==null&&Math.abs(s.max-s.min)>1e-9)||numericStats.find(s=>!s.allZero)||numericStats[0]; const suspicious=chosen.allZero||(chosen.max!==null&&chosen.min!==null&&Math.abs(chosen.max-chosen.min)<1e-9)||chosen.auto; log(`[${label}]`,`선택=${chosen.key} count=${chosen.count} min=${chosen.min} max=${chosen.max}${chosen.auto?' 자동탐지':''}${suspicious?' 검증필요':''}`); return{key:chosen.key,status:suspicious?'검증필요':'실측',stats:allStats,chosen,blank:false}; }
function sampleRow(row,keys){ const f=flatRow(row);const out={};const baseKeys=['ymdhm','obsymdhm','ymdh','obstm','obsTime','tm','date','time',...keys];for(const k of baseKeys){if(Object.prototype.hasOwnProperty.call(f,k))out[k]=f[k];}if(Object.keys(out).length===0){for(const k of Object.keys(f).slice(0,20))out[k]=f[k];}return out; }

// ── nearest / trend ──────────────────────────────────────────
function nearest(rows,target,valueKeys,maxMin=MAX_NEAREST_MIN){ let best=null,bestDiff=Infinity; for(const row of rows){const t=parseObsTime(row);const v=val(row,valueKeys);if(!t||v===null)continue;const diff=Math.abs(t-target);if(diff<bestDiff){best={time:t,value:v,row,diffMin:Math.round(diff/60000)};bestDiff=diff;}} if(!best)return null; if(best.diffMin>maxMin)return{...best,stale:true}; return best; }
function trend(rows,target,valueKeys,minutes=60){ const now=nearest(rows,target,valueKeys,MAX_NEAREST_MIN);const past=nearest(rows,new Date(target.getTime()-minutes*60000),valueKeys,MAX_NEAREST_MIN);if(!now||!past||now.stale||past.stale)return null;return{now,past,delta:Number((now.value-past.value).toFixed(2)),minutes}; }
function dataQualityForPoint(p){ if(!p)return '자료 없음'; return p.stale?`검증필요: 입력시각과 관측시각 ${p.diffMin}분 차이`:`정상: 입력시각과 관측시각 ${p.diffMin}분 차이`; }
function observationGapShort(p){ if(!p)return '자료 없음'; return `${pretty(p.time)} · ${p.diffMin}분 차이${p.stale?' · 검증필요':''}`; }

// ── API: 수위 ────────────────────────────────────────────────
async function getWaterSeries(key,code,start,end){ let lastErr=''; const w=hrfcoWindow(start,end); log('[HRFCO 수위]',`${code}`,`${w.startCode}/${w.endCode}`); for(const k of hrfcoKeyVariants(key)){const url=`https://api.hrfco.go.kr/${k}/waterlevel/list/10M/${code}/${w.startCode}/${w.endCode}.json`;try{const j=await fetchJson(url);const rows=normalizeRows(j);log('[수위 행수]',rows.length);if(rows.length)return rows;lastErr='결과 없음';}catch(e){lastErr=e.message;log('[수위 실패]',e.message);}} throw new Error(lastErr||'수위 조회 결과 없음'); }
async function getDamSeries(key,start,end){ let lastErr=''; const w=hrfcoWindow(start,end); log('[HRFCO 방류]',`${DAM_CODE}`,`${w.startCode}/${w.endCode}`); for(const k of hrfcoKeyVariants(key)){const url=`https://api.hrfco.go.kr/${k}/dam/list/10M/${DAM_CODE}/${w.startCode}/${w.endCode}.json`;try{const j=await fetchJson(url);const rows=normalizeRows(j);log('[방류 행수]',rows.length);if(rows.length)return rows;lastErr='결과 없음';}catch(e){lastErr=e.message;log('[방류 실패]',e.message);}} throw new Error(lastErr||'방류 조회 결과 없음'); }

// ── API: 신곡수중보 ────────────────────────────────────────────
async function getSingokBoData(key,start,end){
  let lastErr='';
  const w=hrfcoWindow(start,end);
  log('[신곡수중보]',`${SINGOK_BO_CODE}`,`${w.startCode}/${w.endCode}`);
  for(const k of hrfcoKeyVariants(key)){
    const url=`https://api.hrfco.go.kr/${k}/bo/list/10M/${SINGOK_BO_CODE}/${w.startCode}/${w.endCode}.json`;
    try{
      const j=await fetchJson(url);
      const rows=normalizeRows(j);
      log('[신곡수중보 행수]',rows.length);
      if(rows.length) return rows;
      lastErr='결과 없음';
    }catch(e){lastErr=e.message;log('[신곡수중보 실패]',e.message);}
  }
  throw new Error(lastErr||'신곡수중보 조회 결과 없음');
}

// ── API: 조석 ────────────────────────────────────────────────
async function getTideRowsForDate(key,date){
  if(!key) throw new Error('조석 키 없음');
  const reqDate=ymd(date);
  const base='https://apis.data.go.kr/1192136/tideFcstTime/GetTideFcstTimeApiService';
  const variants=[key,encodeURIComponent(key),decodeURIComponentSafe(key)];
  const urls=[];
  for(const k of [...new Set(variants)]){
    urls.push(`${base}?serviceKey=${k}&pageNo=1&numOfRows=300&type=json&obsCode=${TIDE_STATION}&reqDate=${reqDate}&min=10`);
    urls.push(`${base}?serviceKey=${k}&pageNo=1&numOfRows=300&_type=json&obsCode=${TIDE_STATION}&reqDate=${reqDate}&min=10`);
  }
  let lastErr='';
  for(const u of urls){
    try{
      const j=await fetchJson(u);
      const msg=j?.response?.header?.resultMsg||j?.header?.resultMsg||j?.resultMsg||'';
      const rows=normalizeRows(j);
      log('[조석]',reqDate,`rows=${rows.length}`,msg?`msg=${msg}`:'');
      if(rows.length) return rows;
      lastErr=msg||'rows=0';
    }catch(e){lastErr=e.message;log('[조석 실패]',reqDate,e.message);}
  }
  throw new Error(`${reqDate} 조석 조회 실패: ${lastErr}`);
}
async function getTideRowsRange(key,start,end){
  const rows=[];const seen=new Set();
  const d0=new Date(start.getFullYear(),start.getMonth(),start.getDate()-1);
  const d1=new Date(end.getFullYear(),end.getMonth(),end.getDate()+1);
  const days=Math.ceil((d1-d0)/86400000)+1;
  if(days>14) throw new Error('조석 조회 기간이 14일을 초과합니다.');
  let success=0,errors=[];
  for(let i=0;i<days;i++){
    const d=new Date(d0.getFullYear(),d0.getMonth(),d0.getDate()+i);
    try{const r=await getTideRowsForDate(key,d);success++;for(const row of r){const t=parseObsTime(row);const k=t?`${t.getTime()}_${val(row,TIDE_KEYS)}`:JSON.stringify(row);if(!seen.has(k)){seen.add(k);rows.push(row);}}}catch(e){errors.push(e.message);}
  }
  log('[조석 기간]',`성공일=${success}`,`총행=${rows.length}`,errors.length?`오류=${errors.slice(0,2).join('/')}` :'');
  if(rows.length) return rows;
  throw new Error('조석 기간조회 실패: '+errors.slice(0,3).join('/'));
}

// ── 조석 분석 ────────────────────────────────────────────────
function tideAt(rows,target,offsetMin=0){
  const shifted=new Date(target.getTime()-offsetMin*60000);
  const items=[];
  for(const r of rows){const t=parseObsTime(r);const h=val(r,TIDE_KEYS);if(t&&h!==null)items.push({time:t,value:h,row:r});}
  items.sort((a,b)=>a.time-b.time);
  if(!items.length) return null;
  let best=null,bestDiff=Infinity,bestIdx=-1;
  items.forEach((it,i)=>{const d=Math.abs(it.time-shifted);if(d<bestDiff){best=it;bestDiff=d;bestIdx=i;}});
  const prev=items[Math.max(0,bestIdx-1)];
  const delta=prev?Number((best.value-prev.value).toFixed(1)):null;
  const hours=prev?Math.max((best.time-prev.time)/3600000,1/60):null;
  const rateCmHr=(delta!==null&&hours)?Number((delta/hours).toFixed(1)):null;
  const phase=delta==null?'확인중':delta>0.3?'밀물 진행':delta<-0.3?'썰물 진행':'정체';
  const nextTurn=findNextTurn(items,bestIdx);
  return{best,prev,diffMin:Math.round(bestDiff/60000),delta,rateCmHr,phase,count:items.length,shifted,nextTurn};
}
function findNextTurn(items,idx){ if(idx<1||idx>=items.length-2)return null; let prevSign=Math.sign(items[idx].value-items[idx-1].value); for(let i=idx+1;i<items.length-1;i++){const sign=Math.sign(items[i+1].value-items[i].value);if(prevSign!==0&&sign!==0&&sign!==prevSign){const type=prevSign>0?'만조':'간조';return{type,time:items[i].time,value:items[i].value};}if(sign!==0)prevSign=sign;} return null; }

// ── fallback (최신 endpoint) ──────────────────────────────────
async function getLatestWaterRows(key,code){ let lastErr=''; for(const k of hrfcoKeyVariants(key)){const url=`https://api.hrfco.go.kr/${k}/waterlevel/list/10M/${code}.json`;try{const j=await fetchJson(url);const rows=normalizeRows(j);log('[수위 최신]',rows.length);if(rows.length)return rows;lastErr='결과 없음';}catch(e){lastErr=e.message;log('[수위 최신 실패]',e.message);}} throw new Error(lastErr||'수위 최신 결과 없음'); }
async function getLatestDamRows(key){ let lastErr=''; for(const k of hrfcoKeyVariants(key)){const url=`https://api.hrfco.go.kr/${k}/dam/list/10M/${DAM_CODE}.json`;try{const j=await fetchJson(url);const rows=normalizeRows(j);log('[방류 최신]',rows.length);if(rows.length)return rows;lastErr='결과 없음';}catch(e){lastErr=e.message;log('[방류 최신 실패]',e.message);}} throw new Error(lastErr||'방류 최신 결과 없음'); }
function mergeRowsByTime(base,extra){ const seen=new Set(base.map(r=>{const t=parseObsTime(r);return t?t.getTime():null;}).filter(Boolean)); return [...base,...extra.filter(r=>{const t=parseObsTime(r);return t&&!seen.has(t.getTime());})]; }
async function applyHrfcoFallbacks(key,b,waterRows,damRows){
  let waterFallback=false,damFallback=false;
  if(waterRows.length&&!hasNumericValue(waterRows,[WATER_FIXED_KEY,...WATER_KEYS])){log('[수위 기간 공백]','최신 endpoint 재조회');try{const latest=await getLatestWaterRows(key,b.code);if(hasNumericValue(latest,[WATER_FIXED_KEY,...WATER_KEYS])){waterRows=mergeRowsByTime(waterRows,latest);waterFallback=true;log('[수위 보강]','완료');}else log('[수위 최신도 공백]');}catch(e){log('[수위 보강 실패]',e.message);}}
  if(damRows.length&&!hasNumericValue(damRows,[DAM_FIXED_KEY,...DAM_KEYS])){log('[방류 기간 공백]','최신 endpoint 재조회');try{const latest=await getLatestDamRows(key);if(hasNumericValue(latest,[DAM_FIXED_KEY,...DAM_KEYS])){damRows=mergeRowsByTime(damRows,latest);damFallback=true;log('[방류 보강]','완료');}else log('[방류 최신도 공백]');}catch(e){log('[방류 보강 실패]',e.message);}}
  return{waterRows,damRows,waterFallback,damFallback};
}

// ── 수위 추정(Fallback) 계산 ──────────────────────────────────
// 우선순위: HRFCO 실측(1순위) → 계산값(2순위, "계산값(추정)" 라벨 필수)
function estimateWaterLevel(waterRows,waterKeys,time,tide,damImpact,damRows,damKeys){
  const dayAgo=new Date(time.getTime()-24*3600000);
  const samples=[];
  for(const row of waterRows){const t=parseObsTime(row);const v=val(row,waterKeys);if(t&&v!==null&&t>=dayAgo&&t<=time)samples.push(v);}
  if(samples.length<3) return null;
  const baseline=samples.reduce((a,b)=>a+b,0)/samples.length;
  let tideAdj=0;
  if(tide&&tide.rateCmHr!==null) tideAdj=(tide.rateCmHr/100)*0.6;
  let damAdj=0;
  if(damImpact&&Array.isArray(damRows)&&damRows.length){
    const damSamples=[];
    for(const row of damRows){const t=parseObsTime(row);const v=val(row,damKeys);if(t&&v!==null&&t>=dayAgo&&t<=time)damSamples.push(v);}
    if(damSamples.length>=3){const damBaseline=damSamples.reduce((a,b)=>a+b,0)/damSamples.length;if(damBaseline>0){const ratio=(damImpact.value-damBaseline)/damBaseline;damAdj=ratio*0.15;}}
  }
  const estimated=baseline+tideAdj+damAdj;
  return{value:Number(estimated.toFixed(2)),baseline:Number(baseline.toFixed(2)),tideAdj:Number(tideAdj.toFixed(3)),damAdj:Number(damAdj.toFixed(3)),sampleCount:samples.length,isEstimate:true};
}

// ── makePointState ────────────────────────────────────────────
function makePointState(label,b,time,waterRows,damRows,tideRows,waterMetric,damMetric,singokSwlAtTime){
  const waterKeys=waterMetric?.key?[waterMetric.key]:WATER_KEYS;
  const damKeys=damMetric?.key?[damMetric.key]:DAM_KEYS;
  let water=nearest(waterRows,time,waterKeys);
  const waterFlow=nearest(waterRows,time,[WATER_FLOW_FIXED_KEY,'FW','fw'],MAX_NEAREST_MIN);
  const wTrend=trend(waterRows,time,waterKeys,60);
  const damImpactTime=new Date(time.getTime()-(b.releaseLag||0)*60000);
  const damImpact=nearest(damRows,damImpactTime,damKeys,90);

  // 조석: 신곡수중보 실시간 판단
  const tideActive=bridgeTideActive(b,singokSwlAtTime);
  let tide=null;
  if(tideActive===true && tideRows.length){
    tide=tideAt(tideRows,time,b.offset||0);
  }
  const tideStatusNote = b.tide
    ? (tideActive===null?'신곡수중보 수위 조회 실패 → 조석 전파 여부 판단 불가'
      :tideActive?`신곡수중보 swl ${singokSwlAtTime?.toFixed(2)}m ≥ ${SINGOK_TIDE_THRESHOLD}m → 조석 전파 중`
      :`신곡수중보 swl ${singokSwlAtTime?.toFixed(2)}m < ${SINGOK_TIDE_THRESHOLD}m → 조석 차단`)
    : '잠실수중보 상류: 조석 적용 제외';

  // 수위 우선순위
  let waterSource='none';
  if(water&&!water.stale){
    waterSource='observed';
  } else {
    const est=estimateWaterLevel(waterRows,waterKeys,time,tide,damImpact,damRows,damKeys);
    if(est){
      if(!water){water={value:est.value,time,diffMin:0,stale:false,isEstimate:true,estimateDetail:est};waterSource='estimated';}
      else{water={...water,isEstimate:false,estimateDetail:est,estimateAvailable:true};waterSource='observed_stale';}
    } else if(water){ waterSource='observed_stale_noestimate'; }
  }

  const direction=directionLabel(b,wTrend,damImpact,tide,tideActive);
  const speed=speedLabel(wTrend,damImpact,tide);
  const notes=[];
  if(wTrend) notes.push(`수위 1시간 ${wTrend.delta>0?'+':''}${wTrend.delta}m`); else notes.push(waterMetric?.blank?'통제소 수위 응답 공백':'수위 변화 계산불가');
  if(damImpact) notes.push(`팔당 ${b.releaseLag}분 보정 ${damImpact.value.toFixed(1)}㎥/s`); else notes.push(damMetric?.blank?'통제소 방류 응답 공백':'방류량 보정값 없음');
  notes.push(tideStatusNote);
  if(waterSource==='estimated') notes.push('⚠ 수위 실측값 없음 → 계산값(추정)으로 대체');
  return{label,time,water,waterFlow,wTrend,damImpact,damImpactTime,tide,tideActive,tideStatusNote,direction,speed,notes,waterSource};
}

// ── 방향/속도 판정 ───────────────────────────────────────────
function directionLabel(b,wTrend,damImpact,tide,tideActive){
  const damHigh=damImpact?.value!=null&&damImpact.value>=1000;
  if(!b.tide) return damHigh?'방류 영향 하류방향 우세 가능':'조석 제외 · 자연 하류 흐름 가능';
  if(tideActive===null) return damHigh?'방류 영향 하류방향 가능 (신곡수중보 수위 미확인)':'신곡수중보 수위 미확인 · 조석 전파 여부 판단 불가';
  if(!tideActive) return damHigh?'방류 영향 하류방향 우세 가능 (조석 차단)':'조석 차단 (신곡수중보 낮음) · 자연 하류 흐름 가능';
  if(!tide) return damHigh?'방류 영향 하류방향 가능':'조석 전파 중 · 조위 자료 없음';
  if(tide.phase.includes('밀물')) return damHigh?'밀물 유입 + 방류 하류방향 충돌 가능':'물이 들어오는 영향 가능';
  if(tide.phase.includes('썰물')) return '물이 나가는 영향 가능';
  return damHigh?'정체권 + 방류 하류방향 가능':'정체·혼합 가능';
}
function speedLabel(wTrend,damImpact,tide){
  const wd=wTrend?.delta??null; const dam=damImpact?.value??null; const tr=Math.abs(tide?.rateCmHr??0);
  if((wd!==null&&Math.abs(wd)>=0.10)||(dam!==null&&dam>=1000)||tr>=25)return '빠름 가능';
  if((wd!==null&&Math.abs(wd)>=0.04)||(dam!==null&&dam>=500)||tr>=10)return '보통 가능';
  return '완만 가능';
}
function flowDecisionFromState(state){ return{direction:state.direction,parts:state.notes,speed:state.speed}; }

// ── 포맷 함수 ────────────────────────────────────────────────
function fmtWaterPoint(p){
  if(!p) return '자료 없음';
  if(p.isEstimate){
    const d=p.estimateDetail;
    return `<span style="color:#b7791f;font-weight:800">${p.value.toFixed(2)}m (계산값·추정)</span>` +
      `<br><small class="muted">HRFCO 실측 없음 → 베이스라인 ${d?d.baseline.toFixed(2):'-'}m + 조석 ${d?(d.tideAdj>=0?'+':'')+d.tideAdj:'-'}m + 방류 ${d?(d.damAdj>=0?'+':'')+d.damAdj:'-'}m</small>`;
  }
  let extra='';
  if(p.estimateAvailable&&p.estimateDetail){
    extra=`<br><small class="muted">참고 계산값: ${p.estimateDetail.value.toFixed(2)}m (실측 시간차 큼, 실측 우선)</small>`;
  }
  return `${p.value.toFixed(2)}m · ${observationGapShort(p)}${extra}`;
}
function fmtWaterFlowPoint(p){ return p?`${p.value.toFixed(1)} · ${observationGapShort(p)}`:'자료 없음'; }
function fmtTrend(t){ return t?`${t.delta>0?'+':''}${t.delta}m / ${t.minutes}분`:'계산불가'; }
function fmtDamPoint(p,impactTime){ return p?`${p.value.toFixed(1)}㎥/s · 팔당 관측 ${pretty(p.time)} · 교량영향 기준 ${pretty(impactTime)} · ${dataQualityForPoint(p)}`:'자료 없음'; }
function fmtTidePoint(b,t,tideActive){
  if(!b.tide) return '잠실수중보 상류: 조석 적용 제외';
  if(tideActive===false) return `⛔ 신곡수중보 수위 < ${SINGOK_TIDE_THRESHOLD}m → 조석 차단 (이 시점 조석 영향 없음)`;
  if(tideActive===null) return '⚠ 신곡수중보 수위 조회 실패 → 조석 전파 여부 판단 불가';
  if(!t) return '조석 전파 중이나 조위 자료 없음';
  const offset=b.offset||0;
  const bridgeBestTime=t.best?.time?new Date(t.best.time.getTime()+offset*60000):null;
  let turn='';
  if(t.nextTurn){const bridgeTurn=new Date(t.nextTurn.time.getTime()+offset*60000);turn=` · 다음 ${t.nextTurn.type}: 인천 ${hhmm(t.nextTurn.time)} / 교량보정 ${hhmm(bridgeTurn)} (${t.nextTurn.value.toFixed(1)}cm)`;}
  const rate=t.rateCmHr!==null?` · 변화율 ${t.rateCmHr>0?'+':''}${t.rateCmHr}cm/h`:'';
  const baseTxt=bridgeBestTime?`인천 관측 ${pretty(t.best.time)} + ${offset}분 보정 = 교량기준 ${pretty(bridgeBestTime)}`:`인천기준 ${t.shifted?pretty(t.shifted):''}`;
  return `${t.phase} · 인천 조위 ${t.best.value.toFixed(1)}cm · ${baseTxt}${rate}${turn}`;
}

// ── 물때 표시 ────────────────────────────────────────────────
function fmtTideNumber(date){
  const tn=tideNumber(date);
  return `${tn.n}물 · ${tn.name} <small class="muted">(${tn.basis})</small>`;
}

// ── 신뢰도 계산 ──────────────────────────────────────────────
function calcReliability(b,incidentState,currentState,q){
  let score=50;
  if(q.water==='실측') score+=15; else if(q.water==='검증필요') score+=5;
  if(q.dam==='실측') score+=15; else if(q.dam==='검증필요') score+=5;
  if(q.tide==='정상') score+=10;
  if(singokTideState.status!=='unknown') score+=5;
  if(currentState.waterSource==='observed') score+=5;
  return Math.min(score,95);
}

// ── 배지/뱃지 ────────────────────────────────────────────────
function dataBadge(state){
  if(state==='실측'||state==='정상') return '<span class="data-badge good">실측</span>';
  if(state==='검증필요') return '<span class="data-badge warn">검증필요</span>';
  if(state==='공백') return '<span class="data-badge bad">통제소 공백</span>';
  if(state==='제외') return '<span class="data-badge hold">제외</span>';
  return `<span class="data-badge hold">${state||'대기'}</span>`;
}
function fmtCorePoint(p,unit){
  if(!p) return '자료 없음';
  const value=unit==='m'?p.value.toFixed(2)+'m':unit==='cms'?p.value.toFixed(1)+'㎥/s':p.value.toFixed(1);
  if(p.isEstimate) return `<span style="color:#b7791f;font-weight:800">${value} (계산값·추정)</span><br><small>HRFCO 실측 없음</small>`;
  let extra=p.estimateAvailable?`<br><small style="color:#b7791f">참고계산 ${p.estimateDetail.value.toFixed(2)}${unit==='m'?'m':''}</small>`:'';
  return `${value}<br><small>${observationGapShort(p)}</small>${extra}`;
}

// ── 신곡수중보 상태 패널 ─────────────────────────────────────
function renderSingokStatus(){
  const el=$('singokStatus');
  if(!el) return;
  const s=singokTideState;
  if(s.status==='unknown'){
    el.innerHTML=`<div class="q"><strong>신곡수중보</strong><span class="hold">조회 전</span></div>`;return;
  }
  const lbl=singokStatusLabel(s.swl);
  const cls=lbl.cls==='ok'?'ok':lbl.cls==='warn'?'hold':'hold';
  el.innerHTML=`<div style="padding:10px 14px;border-radius:10px;border:1px solid var(--line);background:#fafbff">
    <strong style="font-size:13px">${lbl.icon} ${lbl.text}</strong>
    <div class="muted" style="font-size:12px;margin-top:4px">관측시각: ${s.time?pretty(s.time):'불명'} · 기준: swl ≥ ${SINGOK_TIDE_THRESHOLD}m 이면 전파</div>
  </div>`;
}

// ── 데이터 판정 패널 ─────────────────────────────────────────
function renderDataFirstPanel(b=null,incidentState=null,currentState=null,q={}){
  const el=$('dataFirstPanel'); if(!el) return;
  if(!b||!incidentState||!currentState){el.innerHTML='<div class="empty-panel">환경조회 후 수위·방류량·조석 핵심값을 먼저 표시합니다.</div>';return;}
  el.innerHTML=`
    <div class="data-card primary"><b>판정</b><strong>${currentState.direction}</strong><span>${currentState.speed}</span></div>
    <div class="data-card"><b>수위</b>${dataBadge(q.water)}<div class="data-grid-mini"><span>투신</span><span>${fmtCorePoint(incidentState.water,'m')}</span><span>조회</span><span>${fmtCorePoint(currentState.water,'m')}</span><span>fw</span><span>${fmtWaterFlowPoint(currentState.waterFlow)}</span></div></div>
    <div class="data-card"><b>방류</b>${dataBadge(q.dam)}<div class="data-grid-mini"><span>투신</span><span>${fmtCorePoint(incidentState.damImpact,'cms')}</span><span>조회</span><span>${fmtCorePoint(currentState.damImpact,'cms')}</span></div></div>
    <div class="data-card"><b>조석</b>${dataBadge(q.tide)}<div class="data-grid-mini"><span>투신</span><span>${fmtTidePoint(b,incidentState.tide,incidentState.tideActive)}</span><span>조회</span><span>${fmtTidePoint(b,currentState.tide,currentState.tideActive)}</span></div></div>`;
}

// ── 비교 패널 ────────────────────────────────────────────────
function renderPointCompare(b,incidentState,currentState){
  const row=(name,a,c)=>`<div class="kv"><b>${name}</b><span><strong>투신</strong> ${a}<br><strong>조회</strong> ${c}</span></div>`;
  const html=`
    ${row('수위',fmtWaterPoint(incidentState.water),fmtWaterPoint(currentState.water))}
    ${row('수위 변화',fmtTrend(incidentState.wTrend),fmtTrend(currentState.wTrend))}
    ${row('fw',fmtWaterFlowPoint(incidentState.waterFlow),fmtWaterFlowPoint(currentState.waterFlow))}
    ${row('교량 영향 방류량',fmtDamPoint(incidentState.damImpact,incidentState.damImpactTime),fmtDamPoint(currentState.damImpact,currentState.damImpactTime))}
    ${row('신곡수중보 조석 판단',incidentState.tideStatusNote,currentState.tideStatusNote)}
    ${row('조석 영향',fmtTidePoint(b,incidentState.tide,incidentState.tideActive),fmtTidePoint(b,currentState.tide,currentState.tideActive))}
    ${row('물 방향',incidentState.direction,currentState.direction)}
    ${row('물살 판단',incidentState.speed,currentState.speed)}
    <p class="muted">물 방향·물살은 유속 실측값이 아니라 수위변화·방류량·인천 조석·신곡수중보 실측 수위를 조합한 참고판정입니다.</p>`;
  const el=$('pointCompare'); if(el) el.innerHTML=html;
}

// ── 요약 패널 ────────────────────────────────────────────────
function renderSummary(b,incidentState,currentState,decision,tideRows){
  const searchDt=parseLocal($('searchDate').value,$('searchTime').value);
  const incidentDt=parseLocal($('incidentDate').value,$('incidentTime').value);
  $('summary').innerHTML=`
    <div class="summary-big">${decision?.direction||'조회 전'} · ${decision?.speed||''}</div>
    <span class="pill">대표 관측소: ${b.station}</span>
    <span class="pill">${b.tide?'조석 구간':'조석 제외'}</span>
    <span class="pill">교량 ${BRIDGES.length}개 등록</span>
    <div class="kv"><b>투신 수위</b><span>${fmtWaterPoint(incidentState.water)}</span></div>
    <div class="kv"><b>현재 수위</b><span>${fmtWaterPoint(currentState.water)} <small class="muted">수심 아님</small></span></div>
    <div class="kv"><b>현재 방류 영향</b><span>${fmtDamPoint(currentState.damImpact,currentState.damImpactTime)}</span></div>
    <div class="kv"><b>투신 방류 영향</b><span>${fmtDamPoint(incidentState.damImpact,incidentState.damImpactTime)}</span></div>
    <div class="kv"><b>투신시점 물때</b><span>${incidentDt?fmtTideNumber(incidentDt):'날짜 미입력'}</span></div>
    <div class="kv"><b>조회시점 물때</b><span>${searchDt?fmtTideNumber(searchDt):'날짜 미입력'}</span></div>
    <div class="kv"><b>신곡수중보</b><span>${singokStatusLabel(singokTideState.swl).text}</span></div>
    <div class="kv"><b>현재 조석</b><span>${fmtTidePoint(b,currentState.tide,currentState.tideActive)}</span></div>
    <div class="kv"><b>근거</b><span>${decision?.parts?.join(' / ')||'-'}</span></div>`;
}

// ── 모델 정보 ────────────────────────────────────────────────
function renderModelInfo(b){
  $('modelInfo').innerHTML=`
    <div class="kv"><b>교량</b><span>${b.bridge}</span></div>
    <div class="kv"><b>구간</b><span>${b.zone}</span></div>
    <div class="kv"><b>수위관측소</b><span>${b.station} (${b.code})</span></div>
    <div class="kv"><b>조석 판단</b><span>${b.tide?`신곡수중보(2022510) swl 실시간 기준 · ${SINGOK_TIDE_THRESHOLD}m 이상이면 인천${TIDE_STATION}+${b.offset}분 보정 적용`:'잠실수중보 상류: 조석 제외'}</span></div>
    <div class="kv"><b>팔당 지연</b><span>${b.releaseLag}분 (추정)</span></div>`;
}

// ── 신뢰도 패널 ──────────────────────────────────────────────
function renderReasonPanel(b,incidentState,currentState,q){
  const sec=$('reasonSection'),panel=$('reasonPanel');if(!sec||!panel)return;
  if(!currentState){sec.style.display='none';return;}
  const reliability=calcReliability(b,incidentState,currentState,q);
  const items=[
    {label:'신곡수중보', value:singokTideState.swl!==null?`swl ${singokTideState.swl.toFixed(2)}m`:'조회 실패',
     score:singokTideState.status!=='unknown'?0:0, desc:singokStatusLabel(singokTideState.swl).text},
    {label:'조석 상태', value:currentState.tide?currentState.tide.phase:'전파 없음/조회 불가', score:currentState.tideActive===true?(currentState.tide?.phase?.includes('밀물')?+2:-2):0, desc:currentState.tideStatusNote},
    {label:'방류량', value:currentState.damImpact?`${currentState.damImpact.value.toFixed(0)}㎥/s`:'자료 없음', score:currentState.damImpact?.value>=1000?-2:currentState.damImpact?.value>=500?-1:0, desc:currentState.damImpact?`팔당 ${b.releaseLag}분 보정`:'방류 자료 없음'},
    {label:'수위 변화', value:currentState.wTrend?`${currentState.wTrend.delta>=0?'+':''}${currentState.wTrend.delta}m`:'계산 불가', score:currentState.wTrend?.delta>0.05?+1:currentState.wTrend?.delta<-0.05?-1:0, desc:currentState.waterSource==='estimated'?'계산값(추정)':'HRFCO 실측'},
  ];
  const itemsHtml=items.map(it=>{const ss=it.score>0?`+${it.score}`:String(it.score);const sc=it.score>0?'color:#2563eb':it.score<0?'color:#f97316':'color:#6b7280';return`<div class="reason-item"><div class="reason-item-label">${it.label}</div><div class="reason-item-value">${it.value}</div><div class="reason-item-score">${it.desc} <span style="${sc};font-weight:800">(${ss})</span></div></div>`;}).join('');
  const finalDir=currentState.direction||'판정 불가';
  const rcolor=reliability>=80?'#0f62fe':reliability>=60?'#b7791f':'#c53030';
  panel.innerHTML=`<div class="reason-grid">${itemsHtml}<div class="reason-final"><div class="reason-final-label">최종 판단</div><div class="reason-final-value">${finalDir}</div><div class="reliability-badge">신뢰도 ${reliability}%</div><div class="reliability-bar"><div class="reliability-fill" style="width:${reliability}%;background:${rcolor}"></div></div></div></div><p class="muted" style="margin-top:10px">※ 신곡수중보 swl 실측 기반 판정. 신뢰도는 관측자료 유효성 기반 참고값입니다.</p>`;
  sec.style.display='block';
}

// ── 변화량 패널 ──────────────────────────────────────────────
function renderDeltaPanel(incidentState,currentState){
  const sec=$('deltaSection');if(!sec)return;
  if(!incidentState||!currentState){sec.style.display='none';return;}
  const wInc=incidentState.water?.value??null,wSrch=currentState.water?.value??null,wDelta=(wInc!==null&&wSrch!==null)?wSrch-wInc:null;
  const dInc=incidentState.damImpact?.value??null,dSrch=currentState.damImpact?.value??null,dDelta=(dInc!==null&&dSrch!==null)?dSrch-dInc:null;
  const tidePhase=currentState.tideActive===false?'차단':currentState.tide?currentState.tide.phase:null;
  function deltaHtml(label,delta,unit){
    if(delta===null)return`<div class="delta-card"><div class="delta-label">${label}</div><div class="delta-value neutral">—</div><div class="delta-unit">자료 없음</div></div>`;
    const sign=delta>0?'▲':delta<0?'▼':'—';const cls=delta>0.005?'up':delta<-0.005?'down':'neutral';
    return`<div class="delta-card"><div class="delta-label">${label}</div><div class="delta-value ${cls}">${sign} ${delta>=0?'+':''}${delta.toFixed(unit==='m'?2:1)}${unit}</div><div class="delta-unit">사고 → 조회 변화량</div></div>`;
  }
  let tideCls='neutral',tideIcon='—',tideTxt=tidePhase||'자료 없음/제외';
  if(tidePhase&&tidePhase.includes('밀물')){tideCls='tide-in';tideIcon='↑';}
  else if(tidePhase&&(tidePhase.includes('썰물')||tidePhase==='차단')){tideCls='tide-out';tideIcon='↓';}
  const tideHtml=`<div class="delta-card"><div class="delta-label">조석 상태</div><div class="delta-value ${tideCls}">${tideIcon} ${tideTxt}</div><div class="delta-unit">조회시점 기준</div></div>`;
  $('deltaPanel').innerHTML=deltaHtml('수위 변화',wDelta,'m')+deltaHtml('방류량 변화',dDelta,'㎥/s')+tideHtml;
  sec.style.display='block';
}

// ── 교량 현황판 ──────────────────────────────────────────────
function flowClass(dir){ if(!dir)return'flow-na'; if(dir.includes('들어오')||dir.includes('밀물'))return'flow-in'; if(dir.includes('나가')||dir.includes('썰물')||dir.includes('하류'))return'flow-out'; return'flow-na'; }
function stationGroupLabel(b){ if(!b.tide)return'조석 제외'; if(b.zone.includes('상류'))return'상류'; if(b.zone.includes('중상류'))return'중상류'; if(b.zone.includes('중류'))return'중류'; if(b.zone.includes('하류'))return'하류'; return b.zone||'기타'; }
function renderBoard(results=[],selectedBridge=null,currentState=null){
  const selectedName=selectedBridge?.bridge||results[0]?.bridge;
  $('bridgeBoard').innerHTML=BRIDGES.map(b=>{
    const isSel=b.bridge===selectedName,sameSta=selectedBridge&&b.code===selectedBridge.code;
    const stInfo=`${b.station.replace('서울시(','').replace(')','').replace('서울시','서울')} · ${b.code}`;
    let status='';
    if(isSel&&currentState){const fc=flowClass(currentState.direction);status=`<div class="bridge-status strong ${fc}">${currentState.direction}</div><div class="muted">${currentState.speed}</div><div class="muted">수위 ${currentState.water?currentState.water.value.toFixed(2)+'m':'자료 없음'} · 방류 ${currentState.damImpact?currentState.damImpact.value.toFixed(1)+'㎥/s':'자료 없음'}</div>`;}
    else if(sameSta&&currentState){const fc=flowClass(currentState.direction);status=`<div class="bridge-status ${fc}">동일 관측소 참고</div><div class="muted">${currentState.direction}</div>`;}
    else status=`<div class="bridge-status flow-na">선택 시 재계산</div>`;
    return`<div class="bridge-item ${isSel?'selected':''}"><div class="bridge-top"><h3>${b.bridge}</h3><span>${stationGroupLabel(b)}</span></div><div>${stInfo}</div><div>${b.tide?(singokTideState.status==='active'?'🌊 조석 전파 중':singokTideState.status==='blocked'?'⛔ 조석 차단':'조석 구간'):'조석 제외'}</div>${status}<div class="muted small-note">${b.zone}</div></div>`;
  }).join('');
}

// ── 신뢰도 패널 (품질 그리드) ────────────────────────────────
function renderQuality(q={}){
  const labels=[['수위',q.water],['방류',q.dam],['조석',q.tide],['신곡수중보',q.singok||'대기']];
  $('qualityGrid').innerHTML=labels.map(([name,state])=>{
    const cls=state==='실측'||state==='정상'?'ok':(state==='검증필요'||state==='미조회'||state==='제외'||!state?'hold':'fail');
    return`<div class="q"><strong>${name}</strong><span class="${cls}">${state||'대기'}</span></div>`;
  }).join('');
}

// ── 그래프 ──────────────────────────────────────────────────
function rowsToPoints(rows,keys){ return rows.map(r=>({time:parseObsTime(r),value:val(r,keys)})).filter(p=>p.time&&p.value!=null); }
function normalizePoints(points){ const vals=points.map(p=>p.value).filter(v=>v!=null);if(vals.length<2)return[];const min=Math.min(...vals),max=Math.max(...vals);return points.map(p=>({time:p.time,value:max===min?50:(p.value-min)/(max-min)*100,raw:p.value})); }
function drawTimeMarker(ctx,x,padT,ch,padB,label,color){ ctx.save();ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.setLineDash([5,4]);ctx.beginPath();ctx.moveTo(x,padT);ctx.lineTo(x,ch-padB);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=color;ctx.font='700 12px system-ui';ctx.textAlign='center';const safeX=Math.max(42,Math.min(ctx.canvas.clientWidth-42,x));ctx.fillText(label,safeX,padT-18);ctx.restore(); }
function drawLine(canvas,data,key='value',label='',markers=[],range=null){
  const ctx=canvas.getContext('2d');const ratio=window.devicePixelRatio||1;canvas.width=canvas.clientWidth*ratio;canvas.height=canvas.clientHeight*ratio;ctx.setTransform(ratio,0,0,ratio,0,0);
  const cw=canvas.clientWidth,ch=canvas.clientHeight;ctx.clearRect(0,0,cw,ch);ctx.font='14px system-ui';ctx.fillStyle='#172033';ctx.fillText(label,14,24);
  let pts=data.filter(d=>d&&d[key]!=null&&d.time).sort((a,b)=>a.time-b.time);
  if(range&&range.start&&range.end){const rs=range.start.getTime(),re=range.end.getTime();pts=pts.filter(p=>p.time.getTime()>=rs&&p.time.getTime()<=re);}
  if(pts.length<2){ctx.fillStyle='#667085';ctx.fillText('그래프 데이터 부족',14,58);return;}
  const xs=pts.map(p=>p.time.getTime()),ys=pts.map(p=>p[key]);
  const minX=range&&range.start?range.start.getTime():Math.min(...xs),maxX=range&&range.end?range.end.getTime():Math.max(...xs);
  const minY=Math.min(...ys),maxY=Math.max(...ys);
  const padL=62,padR=34,padT=66,padB=44;
  const sx=x=>padL+(x-minX)/(maxX-minX||1)*(cw-padL-padR);const sy=y=>ch-padB-(y-minY)/(maxY-minY||1)*(ch-padT-padB);
  ctx.strokeStyle='#e5e7eb';ctx.lineWidth=1;
  for(let i=0;i<5;i++){const y=padT+i*(ch-padT-padB)/4;ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(cw-padR,y);ctx.stroke();ctx.fillStyle='#8a95a8';ctx.font='12px system-ui';const v=maxY-(maxY-minY)*i/4;ctx.fillText(v.toFixed(2),12,y+4);}
  markers.filter(m=>m&&m.time).forEach(m=>{const tx=m.time.getTime();if(tx>=minX&&tx<=maxX)drawTimeMarker(ctx,sx(tx),padT,ch,padB,m.label,m.color||'#c53030');});
  ctx.strokeStyle='#0f62fe';ctx.lineWidth=3;ctx.beginPath();pts.forEach((p,i)=>{const x=sx(p.time.getTime()),y=sy(p[key]);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.stroke();
  ctx.fillStyle='#172033';const last=pts[pts.length-1];ctx.beginPath();ctx.arc(sx(last.time.getTime()),sy(last[key]),5,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#667085';ctx.font='13px system-ui';ctx.fillText(hhmm(new Date(minX)),padL,ch-12);ctx.fillText(hhmm(new Date(maxX)),cw-78,ch-12);

  // ★ 클릭 핀: 클릭한 시점의 수위/방류량 상세 말풍선 표시 (다시 클릭하면 해제)
  canvas._drawState={pts,minX,maxX,minY,maxY,padL,padR,padT,padB,sx,sy,key,cw,ch};
  const drawPin = (pin) => {
    if(!pin) return;
    const ds=canvas._drawState;
    const px=ds.sx(pin.time.getTime()), py=ds.sy(pin[ds.key]);
    ctx.save();
    ctx.strokeStyle='#f59e0b';ctx.lineWidth=2;ctx.setLineDash([4,3]);
    ctx.beginPath();ctx.moveTo(px,ds.padT);ctx.lineTo(px,ds.ch-ds.padB);ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle='#f59e0b';ctx.beginPath();ctx.arc(px,py,7,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(px,py,3,0,Math.PI*2);ctx.fill();
    const bw=190,bh=58,bx=Math.min(px+10,ds.cw-bw-8),by=Math.max(ds.padT+4,py-66);
    ctx.fillStyle='rgba(16,24,40,0.93)';
    ctx.beginPath();if(ctx.roundRect)ctx.roundRect(bx,by,bw,bh,8);else ctx.rect(bx,by,bw,bh);ctx.fill();
    ctx.fillStyle='#f59e0b';ctx.font='700 13px system-ui';ctx.textAlign='left';
    ctx.fillText(hhmm(pin.time),bx+12,by+20);
    ctx.fillStyle='#e2e8f0';ctx.font='14px system-ui';
    const unitLabel=key==='value'?(label.includes('m)')?' m':label.includes('㎥')?' ㎥/s':' cm'):'';
    ctx.fillText(Number(pin[key]).toFixed(2)+unitLabel,bx+12,by+42);
    ctx.restore();
  };
  canvas._drawPin=drawPin;
  if(canvas._pin) drawPin(canvas._pin); // 재그리기 시 기존 핀 유지
  canvas.onclick=function(e){
    const rect=canvas.getBoundingClientRect();
    const clickX=(e.clientX-rect.left);
    const ds=canvas._drawState; if(!ds) return;
    const tClick=ds.minX+(clickX-ds.padL)/(ds.cw-ds.padL-ds.padR)*(ds.maxX-ds.minX);
    let best=null,bestDiff=Infinity;
    ds.pts.forEach(p=>{const d=Math.abs(p.time.getTime()-tClick);if(d<bestDiff){bestDiff=d;best=p;}});
    if(!best) return;
    // 같은 포인트 다시 클릭하면 해제
    const same=canvas._pin&&Math.abs(canvas._pin.time.getTime()-best.time.getTime())<30000;
    canvas._pin=same?null:best;
    // 그래프 전체를 다시 그리기 위해 drawLine 재호출
    drawLine(canvas,data,key,label,markers,range);
  };
  canvas.style.cursor='crosshair';
}
function drawMultiLine(canvas,series,label='',markers=[]){
  const ctx=canvas.getContext('2d');const ratio=window.devicePixelRatio||1;canvas.width=canvas.clientWidth*ratio;canvas.height=canvas.clientHeight*ratio;ctx.setTransform(ratio,0,0,ratio,0,0);
  const cw=canvas.clientWidth,ch=canvas.clientHeight;ctx.clearRect(0,0,cw,ch);
  const all=series.flatMap(s=>s.points).filter(p=>p.time&&p.value!=null);
  ctx.font='700 15px system-ui';ctx.fillStyle='#172033';ctx.fillText(label,16,24);
  if(all.length<2){ctx.fillStyle='#667085';ctx.fillText('통합 그래프 데이터 부족',16,60);return;}
  const xs=all.map(p=>p.time.getTime()),minX=Math.min(...xs),maxX=Math.max(...xs);
  const padL=62,padR=38,padT=112,padB=48;
  const sx=x=>padL+(x-minX)/(maxX-minX||1)*(cw-padL-padR);const sy=y=>ch-padB-(y/100)*(ch-padT-padB);
  const colors=['#0f62fe','#b7791f','#078a4f'];
  const legends=[{label:'수위(m) 정규화',desc:'파란선',color:colors[0]},{label:'방류량(㎥/s) 정규화',desc:'갈색선',color:colors[1]},{label:'조석(cm) 정규화',desc:'초록선',color:colors[2]}];
  legends.forEach((l,i)=>{const x=18+i*260;ctx.fillStyle=l.color;ctx.fillRect(x,44,34,8);ctx.fillStyle='#172033';ctx.font='14px system-ui';ctx.fillText(`${l.desc} = ${l.label}`,x+44,52);});
  ctx.fillStyle='#667085';ctx.font='12px system-ui';ctx.fillText('※ 0~100 정규화 비교 (서로 단위 다름)',18,80);
  markers.filter(m=>m&&m.time).forEach((m,i)=>{ctx.fillStyle=m.color||'#c53030';ctx.font='700 12px system-ui';ctx.fillText(`${m.label} ${hhmm(m.time)}`,18+i*150,99);});
  ctx.strokeStyle='#e5e7eb';ctx.lineWidth=1;
  for(let i=0;i<5;i++){const y=padT+i*(ch-padT-padB)/4;ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(cw-padR,y);ctx.stroke();ctx.fillStyle='#8a95a8';ctx.font='12px system-ui';ctx.fillText(String(100-i*25),18,y+4);}
  markers.filter(m=>m&&m.time).forEach(m=>{const tx=m.time.getTime();if(tx>=minX&&tx<=maxX)drawTimeMarker(ctx,sx(tx),padT,ch,padB,m.label,m.color||'#c53030');});
  series.forEach((s,si)=>{const pts=s.points.filter(p=>p.time&&p.value!=null).sort((a,b)=>a.time-b.time);if(pts.length<2)return;ctx.strokeStyle=colors[si%colors.length];ctx.lineWidth=4;ctx.beginPath();pts.forEach((p,i)=>{const x=sx(p.time.getTime()),y=sy(p.value);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.stroke();const last=pts[pts.length-1];ctx.fillStyle=colors[si%colors.length];ctx.beginPath();ctx.arc(sx(last.time.getTime()),sy(last.value),6,0,Math.PI*2);ctx.fill();ctx.fillStyle=colors[si%colors.length];ctx.font='13px system-ui';ctx.fillText(s.name,Math.min(cw-80,sx(last.time.getTime())+8),Math.max(padT+12,Math.min(ch-padB-6,sy(last.value))));});
  ctx.fillStyle='#667085';ctx.font='13px system-ui';const first=new Date(minX),last2=new Date(maxX);ctx.fillText(hhmm(first),padL,ch-14);ctx.fillText(hhmm(last2),cw-78,ch-14);
}

// ── 토글 유틸 ─────────────────────────────────────────────────
function bindToggle(btnId,sectionId,labelOpen,labelClose){
  const btn=$(btnId),sec=$(sectionId);if(!btn||!sec)return;
  btn.addEventListener('click',()=>{const open=sec.style.display==='none';sec.style.display=open?'block':'none';btn.textContent=open?labelClose:labelOpen;btn.setAttribute('aria-expanded',open?'true':'false');});
}

// ── 초기화 ──────────────────────────────────────────────────
function init(){
  $('bridgeSelect').innerHTML=BRIDGES.map((b,i)=>`<option value="${i}">${b.bridge} · ${b.station}</option>`).join('');
  $('bridgeCount').textContent=`교량 ${BRIDGES.length}개 등록 · 신곡수중보(2022510) 실측 연동`;
  loadKeys(); setDefaultTimes(); bindInputs(); renderQuality(); renderModelInfo(BRIDGES[0]); renderBoard([]); renderDataFirstPanel();
  bindToggle('combinedToggle','combinedSection','▶ 통합 참고 그래프 (고급 사용자용)','▼ 통합 참고 그래프 접기');
  bindToggle('logToggle','logSection','▶ 원자료 로그 보기','▼ 원자료 로그 숨기기');
  log('[초기화]',`교량 ${BRIDGES.length}개`,`Phase 3.5.0 SingokWeir · 신곡수중보 실측 기반 조석 판단`);
  renderDataFirstPanel();
}
function bindInputs(){
  ['incidentDate','searchDate'].forEach(id=>$(id).addEventListener('input',e=>e.target.value=formatDateInput(e.target.value)));
  ['incidentTime','searchTime'].forEach(id=>$(id).addEventListener('input',e=>e.target.value=formatTimeInput(e.target.value)));
  document.querySelectorAll('[data-toggle-key]').forEach(btn=>btn.addEventListener('click',()=>toggleKey(btn.dataset.toggleKey,btn)));
  $('saveKeys').onclick=saveKeys; $('clearKeys').onclick=clearKeys; $('setNow').onclick=setNow; $('runQuery').onclick=runQuery;
  $('bridgeSelect').addEventListener('change',()=>renderModelInfo(BRIDGES[Number($('bridgeSelect').value)]));
}

// ── 메인 조회 ────────────────────────────────────────────────
async function runQuery(){
  clearLog();
  const key=$('hrfcoKey').value.trim(),tideKey=$('tideKey').value.trim();
  const b=BRIDGES[Number($('bridgeSelect').value)];
  const incident=parseLocal($('incidentDate').value,$('incidentTime').value);
  const search=parseLocal($('searchDate').value,$('searchTime').value);
  if(!key){$('inputStatus').textContent='한강홍수통제소 키를 입력하세요.';return;}
  if(!incident||!search){$('inputStatus').textContent='날짜/시간 형식을 확인하세요.';return;}
  if(search<incident){$('inputStatus').textContent='조회시각은 사고시각 이후여야 합니다.';return;}
  if((search-incident)/3600000>168){$('inputStatus').textContent='7일 이내 구간 조회를 권장합니다.';return;}
  $('inputStatus').textContent='조회 중...';renderModelInfo(b);

  const start=floorTo10Min(new Date(incident.getTime()-Math.max(90,(b.releaseLag||0)+90)*60000));
  const nowLimit=floorTo10Min(new Date(Date.now()-90*60000));
  const rawEnd=floorTo10Min(new Date(search.getTime()+90*60000));
  const end=rawEnd>nowLimit?nowLimit:rawEnd;
  const dataCapped=end<search;
  const effectiveSearch=dataCapped?end:search;
  log('[조회시각]',`사고=${pretty(incident)}`,`조회=${pretty(search)}`,`HRFCO종료=${pretty(end)}`,dataCapped?`⚠ ${Math.round((search-end)/60000)}분 앞당김`:'');

  const q={water:'대기',dam:'대기',tide:b.tide?'대기':'제외',singok:'대기',weather:'미조회'};
  renderQuality(q);

  let waterRows=[],damRows=[],tideRows=[],singokRows=[];

  // ① 신곡수중보 수위 조회 (조석 판단 핵심)
  try{
    singokRows=await getSingokBoData(key,start,end);
    const singokAtSearch=nearest(singokRows,search,SINGOK_KEYS,60);
    const singokAtIncident=nearest(singokRows,incident,SINGOK_KEYS,60);
    // 조회시점 기준으로 전역 상태 업데이트
    if(singokAtSearch){
      const swl=singokAtSearch.value;
      singokTideState={status:swl>=SINGOK_TIDE_THRESHOLD?'active':'blocked',swl,time:singokAtSearch.time,checkedAt:new Date()};
      q.singok=swl>=SINGOK_TIDE_THRESHOLD?`전파 중 (${swl.toFixed(2)}m)`:`차단 (${swl.toFixed(2)}m)`;
    } else {
      singokTideState={status:'unknown',swl:null,time:null,checkedAt:new Date()};
      q.singok='조회 실패';
    }
    log('[신곡수중보]',`조회시점 swl=${singokAtSearch?.value?.toFixed(2)??'없음'}m`,`사고시점 swl=${singokAtIncident?.value?.toFixed(2)??'없음'}m`,`기준: ≥${SINGOK_TIDE_THRESHOLD}m → 조석 전파`);
  }catch(e){ singokTideState={status:'unknown',swl:null,time:null,checkedAt:new Date()}; q.singok='조회 실패'; log('[신곡수중보 실패]',e.message); }
  renderSingokStatus();

  // ② 수위 조회
  try{ waterRows=await getWaterSeries(key,b.code,start,end); }catch(e){ q.water='실패';log('[수위 실패]',e.message); }
  // ③ 방류량 조회
  try{ damRows=await getDamSeries(key,start,end); }catch(e){ q.dam='실패';log('[방류 실패]',e.message); }
  // ④ fallback
  try{ const p=await applyHrfcoFallbacks(key,b,waterRows,damRows);waterRows=p.waterRows;damRows=p.damRows; }catch(e){ log('[fallback 오류]',e.message); }
  // ⑤ 조석 조회 (조석 구간만)
  if(b.tide){
    try{ tideRows=await getTideRowsRange(tideKey||'',start,end);q.tide='정상'; }
    catch(e){ q.tide='실패';log('[조석 실패]',e.message); }
  }

  // 메트릭 감지
  const waterMetric=detectMetric(waterRows,WATER_KEYS,'수위');
  const damMetric=detectMetric(damRows,DAM_KEYS,'방류량');
  if(waterRows.length)q.water=waterMetric.status;else q.water='실패';
  if(damRows.length)q.dam=damMetric.status;else q.dam='실패';
  renderQuality(q);

  // 신곡수중보 swl을 시점별로 추출
  const singokSwlAtSearch  = nearest(singokRows,search,SINGOK_KEYS,60)?.value??null;
  const singokSwlAtIncident= nearest(singokRows,incident,SINGOK_KEYS,60)?.value??null;

  // 포인트 상태 계산
  const incidentState=makePointState('투신시점',b,incident,waterRows,damRows,tideRows,waterMetric,damMetric,singokSwlAtIncident);
  const currentState =makePointState('조회시점',b,search,  waterRows,damRows,tideRows,waterMetric,damMetric,singokSwlAtSearch);
  const decision=flowDecisionFromState(currentState);

  // 렌더링
  renderSummary(b,incidentState,currentState,decision,tideRows);
  renderPointCompare(b,incidentState,currentState);
  renderDataFirstPanel(b,incidentState,currentState,q);
  renderDeltaPanel(incidentState,currentState);
  renderReasonPanel(b,incidentState,currentState,q);
  renderModelInfo(b);

  const waterKeys=waterMetric.key?[waterMetric.key]:WATER_KEYS;
  const damKeys=damMetric.key?[damMetric.key]:DAM_KEYS;
  const waterPts=rowsToPoints(waterRows,waterKeys);
  const damPts=rowsToPoints(damRows,damKeys);
  const tidePts=rowsToPoints(tideRows,TIDE_KEYS);
  const markers=[{time:incident,label:'투신 시점',color:'#0f62fe'},{time:effectiveSearch,label:dataCapped?'최신 관측':'현 시점',color:'#c53030'}];

  drawMultiLine($('combinedChart'),[{name:'수위',points:normalizePoints(waterPts)},{name:'방류',points:normalizePoints(damPts)},{name:'조석',points:normalizePoints(tidePts)}],`${b.bridge} · ${pretty(incident)} ~ ${pretty(effectiveSearch)}`,markers);
  $('combinedChartNote').textContent=`파란선=수위(m), 갈색선=방류량(㎥/s), 초록선=조석(cm). 0~100 정규화 비교용.${dataCapped?` ⚠ 조회시각보다 ${Math.round((search-end)/60000)}분 이전 데이터까지 표시`:''}`;

  drawLine($('waterChart'),waterPts,'value',`${b.station} 수위(m) · ${hhmm(incident)} ~ ${hhmm(effectiveSearch)}`,markers,{start:incident,end:effectiveSearch});
  $('waterChartNote').textContent=(currentState.wTrend?`최근 1시간 수위 변화: ${currentState.wTrend.delta>0?'+':''}${currentState.wTrend.delta}m`:'최근 1시간 변화 계산에 필요한 시계열이 부족합니다.')+(dataCapped?` ⚠ HRFCO 데이터 ${Math.round((search-end)/60000)}분 지연`:' (그래프 범위: 투신~조회시점)');

  // 방류량 통계 바
  (function(){
    const el=$('damStatBar');if(!el)return;
    const vals=damPts.map(p=>p.value).filter(v=>v!=null);
    if(!vals.length){el.innerHTML='';return;}
    const maxV=Math.max(...vals),minV=Math.min(...vals),curV=currentState.damImpact?.value??vals[vals.length-1];
    el.innerHTML=`<div class="dam-stat-item high"><b>최대 방류량</b><span>${maxV.toFixed(0)} ㎥/s</span></div><div class="dam-stat-item current"><b>조회시점 방류량</b><span>${curV!=null?curV.toFixed(0)+'㎥/s':'자료 없음'}</span></div><div class="dam-stat-item low"><b>최소 방류량</b><span>${minV.toFixed(0)} ㎥/s</span></div>`;
  })();

  drawLine($('damChart'),damPts,'value',`팔당댐 방류량(㎥/s) · ${hhmm(incident)} ~ ${hhmm(effectiveSearch)}`,markers,{start:incident,end:effectiveSearch});
  $('damChartNote').textContent=(currentState.damImpact?`조회시점 교량 영향 방류량: ${currentState.damImpact.value.toFixed(1)}㎥/s · 팔당 ${b.releaseLag}분 지연 보정 · ${dataQualityForPoint(currentState.damImpact)}`:'방류량 미조회')+(dataCapped?` ⚠ HRFCO 데이터 ${Math.round((search-end)/60000)}분 지연`:' (그래프 범위: 투신~조회시점)');

  // 조석 다음 전환 표시
  (function(){
    const el=$('tideNextTurn');if(!el)return;
    if(!currentState.tide||currentState.tideActive!==true){el.innerHTML='';return;}
    const t=currentState.tide,offset=b.offset||0;
    let html=`<div class="tide-turn-item"><b>현재 조석</b><span>${t.phase}</span><div class="tide-ref-note">인천(${TIDE_STATION}) + ${offset}분 보정 · 신곡수중보 swl ${singokSwlAtSearch?.toFixed(2)??'?'}m</div></div>`;
    if(t.nextTurn){const bt=new Date(t.nextTurn.time.getTime()+offset*60000);html+=`<div class="tide-turn-item"><b>다음 ${t.nextTurn.type}</b><span>${hhmm(bt)}</span><div class="tide-ref-note">교량 보정(+${offset}분) · 인천 ${hhmm(t.nextTurn.time)}</div></div>`;}
    if(t.rateCmHr!==null)html+=`<div class="tide-turn-item"><b>변화율</b><span>${t.rateCmHr>0?'+':''}${t.rateCmHr}cm/h</span><div class="tide-ref-note">인천 기준</div></div>`;
    el.innerHTML=html;
  })();

  const tideRangeStart=new Date(incident.getTime()-30*60000);
  const tideRangeEnd=new Date(effectiveSearch.getTime()+30*60000);
  if(tideRows.length){
    drawLine($('tideChart'),tidePts,'value',`인천 조위(cm) · ${TIDE_STATION} · ${hhmm(tideRangeStart)} ~ ${hhmm(tideRangeEnd)}`,markers,{start:tideRangeStart,end:tideRangeEnd});
    $('tideChartNote').textContent=(currentState.tide?`인천 조석값에 교량별 지연시간(${b.offset||0}분)을 더해 교량 기준으로 보정했습니다.`:'조석 매칭 실패')+(dataCapped?` ⚠ 데이터 ${Math.round((search-end)/60000)}분 지연`:' (그래프 범위: 투신 30분전 ~ 조회 30분후)');
  } else {
    drawLine($('tideChart'),[],'value','조석',[]);
    $('tideChartNote').textContent=b.tide?'조석 API 미조회':'조석 적용 제외 구간';
  }

  $('tideSummary').innerHTML=currentState.tide?`<div class="summary-big">${currentState.tide.phase}</div><div>${fmtTidePoint(b,currentState.tide,currentState.tideActive)}</div>`:`<div class="summary-big">${!b.tide?'조석 적용 제외':currentState.tideActive===false?'⛔ 조석 차단 (신곡수중보 낮음)':singokTideState.status==='unknown'?'신곡수중보 수위 조회 실패':'조석 미조회'}</div>`;

  renderBoard([{bridge:b.bridge,direction:`${currentState.direction} · ${currentState.speed}`}],b,currentState);
  $('inputStatus').textContent=`조회 완료${dataCapped?` · ⚠ HRFCO 데이터 ${Math.round((search-end)/60000)}분 지연`:''} · 신곡수중보 swl=${singokTideState.swl?.toFixed(2)??'조회실패'}m`;
}

document.addEventListener('DOMContentLoaded', init);
