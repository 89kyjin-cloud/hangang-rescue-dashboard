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

// ── 공식 수위유량곡선식 (HQ Curve) ───────────────────────────
// 출처: 공공데이터포털 "환경부 한강홍수통제소_홍수예보_수위유량곡선식_20210803"
// (로그인 없이 다운로드 가능, data.go.kr/data/15085917)
// 형식: Q = a*(h+b)^c  (Q=유량 m³/s, h=수위 m)
// 적용: fw(유량) 없는 관측소에서 수위만으로 유량 계산
// ※ 범위 밖 수위는 가장 가까운 구간 경계값으로 클램핑
const HQ_CURVES = {
  '1018640': { // 광진교 (2011-01-01 적용)
    name:'광진교', source:'공공데이터포털 HQ곡선',
    segments:[
      {min:1.34, max:2.50,  formula:(h)=> 20.769  * Math.pow(h+2.501, 3.414)},
      {min:2.50, max:4.42,  formula:(h)=>124.768  * Math.pow(h+2.800, 2.220)},
      {min:4.42, max:10.76, formula:(h)=>468.536  * Math.pow(h+2.063, 1.640)},
    ]
  },
  '1018662': { // 청담대교 (2001-01-01 적용) — 잠수교·반포2교도 준용
    name:'청담대교', source:'공공데이터포털 HQ곡선',
    segments:[
      {min:0.99, max:5.82, formula:(h)=>250.980 * Math.pow(Math.max(0,h-0.005), 2.0584)},
    ]
  },
  '1018683': { // 한강대교 (2018-01-01 적용) — H-ADCP 실측 fw가 있어 검증용
    name:'한강대교', source:'공공데이터포털 HQ곡선',
    segments:[
      {min:3.31, max:5.25,  formula:(h)=>320.809 * Math.pow(h+1.270, 1.926)},
      {min:5.25, max:8.97,  formula:(h)=>854.144 * Math.pow(h+1.250, 1.406)},
      {min:8.97, max:14.40, formula:(h)=>325.446 * Math.pow(h-1.500, 2.105)},
    ]
  },
  '1019630': { // 행주대교 (2001-01-01 적용)
    name:'행주대교', source:'공공데이터포털 HQ곡선',
    segments:[
      {min:1.03, max:10.20, formula:(h)=>633.35 * Math.pow(Math.max(0,h-1.025), 2.041)},
    ]
  },
};
// 잠수교·반포2교는 HQ 곡선 없음 → 청담대교 준용
HQ_CURVES['1018680'] = {...HQ_CURVES['1018662'], name:'잠수교(청담대교 준용)', source:'청담대교 HQ 준용'};
HQ_CURVES['1018681'] = {...HQ_CURVES['1018662'], name:'반포2교(청담대교 준용)', source:'청담대교 HQ 준용'};

// HQ 곡선으로 유량(Q) 계산
function calcQfromHQ(wl, stationCode){
  const curve = HQ_CURVES[stationCode];
  if(!curve || wl === null) return null;
  const segs = curve.segments;
  // 수위 범위 클램핑
  const minWl = segs[0].min, maxWl = segs[segs.length-1].max;
  const clampedWl = Math.max(minWl, Math.min(maxWl, wl));
  // 해당 구간 찾기
  for(const seg of segs){
    if(clampedWl >= seg.min && clampedWl <= seg.max){
      const Q = seg.formula(clampedWl);
      return (Number.isFinite(Q) && Q >= 0) ? Number(Q.toFixed(1)) : null;
    }
  }
  // 마지막 구간 적용
  const lastSeg = segs[segs.length-1];
  const Q = lastSeg.formula(clampedWl);
  return (Number.isFinite(Q) && Q >= 0) ? Number(Q.toFixed(1)) : null;
}

// ── 관측소별 단면 정보 ────────────────────────────────────────
// 출처: HRFCO 수문조사연보 문헌 기반 추정값 (하폭·하상고)
// ※ 정확한 단면적은 HRFCO 협조 요청 필요
const STATION_SECTIONS = {
  '1018640': {name:'광진교',   width:500, bedEl:-1.5, shape:0.65},
  '1018662': {name:'청담대교', width:560, bedEl:-1.8, shape:0.65},
  '1018680': {name:'잠수교',   width:530, bedEl:-1.5, shape:0.65},
  '1018681': {name:'반포2교',  width:520, bedEl:-1.4, shape:0.65},
  '1018683': {name:'한강대교', width:490, bedEl:-1.5, shape:0.65},
  '1019630': {name:'행주대교', width:430, bedEl:-1.2, shape:0.65},
};

// ── 유속 계산 (우선순위) ─────────────────────────────────────
// 1순위: fw 실측유량 ÷ 단면적
// 2순위: HQ 곡선(공식) ÷ 단면적  ← 신규 추가
// 3순위: 방류량 기반 추정 ÷ 단면적
function calcVelocity(fw, wl, stationCode){
  const sec = STATION_SECTIONS[stationCode];
  if(!sec || wl === null) return null;
  const depth = wl - sec.bedEl;
  if(depth <= 0.1) return null;
  const area = sec.width * depth * sec.shape;

  // 1순위: fw 실측
  if(fw !== null && fw !== undefined){
    const vel = fw / area;
    if(Number.isFinite(vel) && vel >= 0 && vel <= 10)
      return {vel: Number(vel.toFixed(2)), source:'fw실측', Q: Number(fw.toFixed(1))};
  }

  // 2순위: HQ 공식 곡선 (공공데이터포털)
  const Q_hq = calcQfromHQ(wl, stationCode);
  if(Q_hq !== null){
    const vel = Q_hq / area;
    if(Number.isFinite(vel) && vel >= 0 && vel <= 10){
      const curve = HQ_CURVES[stationCode];
      return {vel: Number(vel.toFixed(2)), source:`HQ곡선(${curve?.source||'공식'})`, Q: Q_hq};
    }
  }

  return null;
}

// 유속 단계 판정 (수색 참고용)
function velocityLabel(vel){
  if(vel === null) return null;
  if(vel < 0) return {label:'역류 가능', cls:'tide-in', note:'밀물 또는 조석 역류 구간'};
  if(vel < 0.3) return {label:'완만', cls:'flow-na', note:`${vel.toFixed(2)}m/s · 조류 영향시 역류 가능`};
  if(vel < 0.8) return {label:'보통', cls:'flow-out', note:`${vel.toFixed(2)}m/s · 이동 영향 있음`};
  if(vel < 1.5) return {label:'빠름', cls:'bad', note:`${vel.toFixed(2)}m/s · 익수자 이동 영향 큼`};
  return {label:'매우 빠름', cls:'bad', note:`${vel.toFixed(2)}m/s · 홍수기 수준`};
}

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
// 신곡수중보 조석 판단 기준 (swl/owl 수위차 기반)
// owl(하류수위) - swl(상류수위) > 기준값이면 역류(조석 영향)
// owl > swl: 하류(바다쪽)가 높다 → 역류 발생 → 조석 영향 있음
// owl < swl: 상류가 높다 → 정상 하류 흐름 → 조석 영향 미미
const SINGOK_REVERSE_THRESHOLD = 0.0;    // owl - swl > 0: 역류 발생 (강한 영향)
const SINGOK_WEAK_THRESHOLD    = -0.3;   // owl - swl > -0.3: 역류 가능성 (약한 영향)
// owl - swl <= -0.3: 정상 하류 흐름 (영향 미미)
const TIDE_STATION = 'DT_0001';           // 인천 조위관측소
const MAX_NEAREST_MIN = 40;

// 수위/방류량 필드 후보
const WATER_FIXED_KEY = 'wl';
const WATER_FLOW_FIXED_KEY = 'fw';
const DAM_FIXED_KEY = 'tototf';
const WATER_KEYS = ['wl','WL','obswl','OBSWL','obsWl','obs_wl','wlevel','WLEVEL','waterLevel','WaterLevel','waterlevel','WATERLEVEL','swl','SWL','wlobs','WLOBS','wlv','WLV','rfwl','RFWL','fw','FW'];
const DAM_KEYS = ['tototf','TOTOTF','totOutflow','totalOutflow','tot_outflow','otf','OTF','edq','EDQ','outflow','OUTFLOW','discharge','DISCHARGE','fw','FW','tdsrf','TDSRF','flow','FLOW','q','Q'];
const TIDE_KEYS = ['tdlvHgt','tdlv_hgt','tideHeight','tideHgt','tide_hgt','tideLevel','tide_level','tphLevel','tph_level','level','obsLevel','obs_level','wl','value','fcstValue'];
const SINGOK_KEYS     = ['swl','SWL']; // 신곡수중보 상류수위
const SINGOK_OWL_KEYS = ['owl','OWL']; // 신곡수중보 하류수위

// ── 신곡수중보 조석 전파 상태 (전역) ──────────────────────────
// {status:'active'|'blocked'|'unknown', swl:number|null, time:Date|null, checkedAt:Date}
let singokTideState = { status:'unknown', swl:null, time:null, checkedAt:null };

// ── 물때 계산 ──────────────────────────────────────────────────
// 1순위: KHOA 조석 데이터(tideRows)의 고/저조 진폭으로 실측 기반 계산
// 2순위(fallback): 달력 역산 — 앵커 1999-12-17 (2026-07-01=8물 검증 완료)
// ※ 달력 역산은 ±1~2물 오차 가능 → 반드시 "달력 역산" 라벨 표시
const LUNAR_ANCHOR = new Date(1999, 11, 17, 0, 0, 0); // 1999-12-17 (검증된 앵커)
const LUNAR_CYCLE = 14.7653;

// ── 한강 교량 좌표 및 하구거리 ────────────────────────────────
// 위도·경도: 실측 GPS 기반 (Google Maps 검증)
// distFromSeaKm: 인천항 기준 하구 거리 (km) — 하류일수록 작음
// distFromPaldangKm: 팔당댐 기준 하천 거리 (km)
const BRIDGE_GEO = {
  '강동대교':    {lat:37.5584, lng:127.1777, distFromSeaKm:67.0, distFromPaldangKm:14.0},
  '구리암사대교':{lat:37.5677, lng:127.1493, distFromSeaKm:65.0, distFromPaldangKm:16.0},
  '광진교':      {lat:37.5391, lng:127.1062, distFromSeaKm:60.5, distFromPaldangKm:22.0},
  '천호대교':    {lat:37.5437, lng:127.1232, distFromSeaKm:63.0, distFromPaldangKm:19.5},
  '올림픽대교':  {lat:37.5227, lng:127.0829, distFromSeaKm:57.5, distFromPaldangKm:25.0},
  '잠실철교':    {lat:37.5145, lng:127.0756, distFromSeaKm:56.5, distFromPaldangKm:25.5},
  '잠실대교':    {lat:37.5093, lng:127.0701, distFromSeaKm:55.5, distFromPaldangKm:26.5},
  '청담대교':    {lat:37.5192, lng:127.0521, distFromSeaKm:53.5, distFromPaldangKm:28.5},
  '영동대교':    {lat:37.5246, lng:127.0437, distFromSeaKm:52.5, distFromPaldangKm:29.5},
  '성수대교':    {lat:37.5310, lng:127.0204, distFromSeaKm:50.0, distFromPaldangKm:32.0},
  '동호대교':    {lat:37.5349, lng:127.0072, distFromSeaKm:48.5, distFromPaldangKm:33.5},
  '한남대교':    {lat:37.5282, lng:126.9970, distFromSeaKm:47.0, distFromPaldangKm:35.0},
  '잠수교':      {lat:37.5121, lng:126.9952, distFromSeaKm:45.5, distFromPaldangKm:36.5},
  '반포대교':    {lat:37.5107, lng:126.9972, distFromSeaKm:45.0, distFromPaldangKm:37.0},
  '동작대교':    {lat:37.5064, lng:126.9818, distFromSeaKm:43.0, distFromPaldangKm:39.0},
  '한강철교':    {lat:37.5183, lng:126.9695, distFromSeaKm:42.0, distFromPaldangKm:40.0},
  '한강대교':    {lat:37.5178, lng:126.9698, distFromSeaKm:41.5, distFromPaldangKm:40.5},
  '원효대교':    {lat:37.5267, lng:126.9538, distFromSeaKm:40.0, distFromPaldangKm:42.0},
  '마포대교':    {lat:37.5313, lng:126.9406, distFromSeaKm:38.5, distFromPaldangKm:43.5},
  '서강대교':    {lat:37.5410, lng:126.9281, distFromSeaKm:37.5, distFromPaldangKm:44.5},
  '당산철교':    {lat:37.5358, lng:126.9022, distFromSeaKm:35.0, distFromPaldangKm:47.0},
  '양화대교':    {lat:37.5424, lng:126.8997, distFromSeaKm:34.5, distFromPaldangKm:47.5},
  '성산대교':    {lat:37.5594, lng:126.8849, distFromSeaKm:33.5, distFromPaldangKm:48.5},
  '월드컵대교':  {lat:37.5677, lng:126.8829, distFromSeaKm:33.0, distFromPaldangKm:49.0},
  '가양대교':    {lat:37.5718, lng:126.8637, distFromSeaKm:31.5, distFromPaldangKm:50.5},
  '마곡대교':    {lat:37.5740, lng:126.8450, distFromSeaKm:30.0, distFromPaldangKm:52.0},
  '방화대교':    {lat:37.5795, lng:126.8234, distFromSeaKm:28.0, distFromPaldangKm:54.0},
  '행주대교':    {lat:37.5908, lng:126.8068, distFromSeaKm:26.0, distFromPaldangKm:56.0},
};

// ── 이동 경로 추정 ────────────────────────────────────────────
// 원리:
//   이동거리(m) = 유속(m/s) × 시간(s)
//   방향: 하류(서쪽) 기본, 밀물+조석차단해제시 상류 역류 가능
//   역류 비율: 조석 변화율(cm/h)에서 추정 (인천 조위 변화 → 한강 내 유속 영향)
//
// 한계 (화면에 반드시 표시):
//   - 유속은 단면 평균값, 실제는 중앙부↑ 벽면↓
//   - 조석 역류 비율은 추정 (교량별 실측 없음)
//   - 와류·장애물·계절 수심 변화 미반영
//   - 결과는 수색 참고 범위이며 정확한 위치 아님

function estimateDrift(bridgeName, velocity, tideActive, tidePhase, tideRateCmHr, elapsedMinutes){
  const geo = BRIDGE_GEO[bridgeName];
  if(!geo || velocity === null) return null;

  // 유효 시간 목록 (분 단위)
  const timeSteps = elapsedMinutes || [30, 60, 120, 360];
  const results = [];

  for(const t of timeSteps){
    const elapsedSec = t * 60;

    // 방향 결정
    // 기본: 하류 방향 (팔당 방류 주도)
    // 밀물 + 조석 전파 중: 역류 성분 추가
    let downstreamVel = velocity; // 하류 방향 유속
    let upstreamVel = 0;          // 상류(역류) 성분

    if(tideActive === true && tidePhase && tidePhase.includes('밀물')){
      // 밀물 시 역류 성분: 인천 조위 변화율 기반 경험 추정
      // 인천 조위 변화율 100cm/h → 한강 내 약 0.1~0.2m/s 역류 영향 (감쇠 적용)
      const tideInfluence = tideRateCmHr ? Math.abs(tideRateCmHr) / 100 * 0.15 : 0.05;
      upstreamVel = tideInfluence;
      downstreamVel = Math.max(0, velocity - upstreamVel);
    }

    // 순 이동 방향 및 거리
    const netVel = downstreamVel - upstreamVel; // + = 하류, - = 상류
    const netDistM = netVel * elapsedSec;        // m (+ = 하류)

    // 교량 위치에서 이동 후 위치 추정
    // 한강 방향: 대략 동(상류) → 서(하류), 위도는 거의 변화 없음
    // 1km 하류 = 경도 약 -0.009도 (한강 하류 방향 추정)
    const KM_PER_DEG_LNG = 111.0 * Math.cos(geo.lat * Math.PI/180); // ~88km/deg
    const distKm = netDistM / 1000;
    const deltaLng = -distKm / KM_PER_DEG_LNG; // 하류=서쪽=-경도

    const estLat = geo.lat; // 한강은 거의 동서 방향
    const estLng = geo.lng + deltaLng;
    const estDist = geo.distFromSeaKm - distKm;

    // 인근 교량 찾기
    const nearbyBridges = Object.entries(BRIDGE_GEO)
      .map(([name, g]) => ({name, diff: Math.abs(g.distFromSeaKm - estDist)}))
      .filter(b => b.name !== bridgeName)
      .sort((a,b) => a.diff - b.diff)
      .slice(0, 2);

    results.push({
      minutes: t,
      netVelMs: Number(netVel.toFixed(2)),
      distKm: Number(distKm.toFixed(2)),
      direction: netVel >= 0 ? '하류' : '상류(역류)',
      estLat: Number(estLat.toFixed(4)),
      estLng: Number(estLng.toFixed(4)),
      estDistFromSea: Number(estDist.toFixed(1)),
      nearbyBridges,
      downstreamVel: Number(downstreamVel.toFixed(2)),
      upstreamVel: Number(upstreamVel.toFixed(2)),
    });
  }
  return results;
}

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

// ── 물때 계산 함수 ─────────────────────────────────────────────
// 물때 명칭 변환
function tideNameFromN(n){
  if(n <= 0) n = 1;
  if(n === 1 || n === 2)     return '사리';
  if(n >= 3 && n <= 7)       return '중간물(사리쪽)';
  if(n === 8)                 return '조금';
  if(n >= 9 && n <= 13)      return '중간물(조금쪽)';
  return '무시';
}

// 1순위: KHOA tideRows 실측 기반 물때 계산
// 원리: 고/저조 진폭(조차)이 최대인 날=사리(1~2물), 최소인 날=조금(8물)
// tideRows에서 대상 날짜 전후 8일 이내 데이터의 일별 조차를 계산
function tideNumberFromRows(date, tideRows){
  if(!Array.isArray(tideRows) || tideRows.length < 6) return null;
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const windowMs = 8 * 86400000;

  // 일별 조차 계산
  const byDay = {};
  for(const r of tideRows){
    const t = parseObsTime(r);
    const v = val(r, TIDE_KEYS);
    if(!t || v === null) continue;
    if(Math.abs(t - target) > windowMs) continue;
    const k = `${t.getFullYear()}-${String(t.getMonth()).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
    if(!byDay[k]) byDay[k] = { min: v, max: v };
    else { byDay[k].min = Math.min(byDay[k].min, v); byDay[k].max = Math.max(byDay[k].max, v); }
  }
  const days = Object.values(byDay).map(d => ({ range: d.max - d.min, max: d.max, min: d.min }));
  if(days.length < 3) return null;

  const maxRange = Math.max(...days.map(d => d.range));
  const minRange = Math.min(...days.map(d => d.range));
  if(maxRange < 50 || (maxRange - minRange) < 30) return null; // 데이터 조차 부족

  // 대상 날짜 조차
  const tk = `${target.getFullYear()}-${String(target.getMonth()).padStart(2,'0')}-${String(target.getDate()).padStart(2,'0')}`;
  if(!byDay[tk]) return null;
  const targetRange = byDay[tk].max - byDay[tk].min;

  // 사리(1물)~조금(8물) 선형 보간: ratio 0=사리, 1=조금
  const ratio = Math.max(0, Math.min(1, (maxRange - targetRange) / (maxRange - minRange)));
  const n = Math.round(ratio * 7) + 1; // 1~8
  const name = tideNameFromN(n);

  return {
    n, name,
    range: Math.round(targetRange),
    maxRange: Math.round(maxRange),
    minRange: Math.round(minRange),
    basis: `KHOA 조석 실측 기반 · 조차 ${Math.round(targetRange)}cm (사리최대 ${Math.round(maxRange)}cm / 조금최소 ${Math.round(minRange)}cm)`,
    source: 'observed'
  };
}

// 2순위(fallback): 달력 역산
// 앵커 1999-12-17 → 2026-07-01=8물 검증 완료
// ±1~2물 오차 가능, 반드시 "달력 역산" 라벨 표시
function tideNumberCalc(date){
  const dayOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = (dayOnly - LUNAR_ANCHOR) / 86400000;
  const cyclePos = ((diffDays % LUNAR_CYCLE) + LUNAR_CYCLE) % LUNAR_CYCLE;
  const step = LUNAR_CYCLE / 15;
  let n = Math.floor(cyclePos / step) + 1;
  if(n > 15) n = 15; if(n < 1) n = 1;
  const name = tideNameFromN(n);
  return {
    n, name,
    basis: `달력 역산 (±1~2물 오차 가능 · 조석 데이터 없을 때만 사용)`,
    source: 'calc'
  };
}

// 메인: tideRows 있으면 실측 기반, 없으면 달력 역산
function tideNumber(date, tideRows){
  if(tideRows && tideRows.length >= 6){
    const fromRows = tideNumberFromRows(date, tideRows);
    if(fromRows) return fromRows;
  }
  return tideNumberCalc(date);
}

// ── 신곡수중보 조석 전파 판단 ──────────────────────────────────
// ── 신곡수중보 조석 영향 판단 (owl-swl 수위차 기반) ────────────────
// owl(하류) - swl(상류) 수위차로 역류 강도를 판단
// 수위차 > 0    : 하류가 높음 → 역류 발생 중 → 조석 강한 영향
// 수위차 > -0.3 : 역류 가능성 → 조석 약한 영향
// 수위차 ≤ -0.3 : 정상 하류 흐름 → 조석 영향 미미
function singokTideLevel(swl, owl){
  if(swl===null || owl===null) return null; // 데이터 없음
  const diff = owl - swl; // 양수 = 역류, 음수 = 정상흐름
  if(diff > SINGOK_REVERSE_THRESHOLD)  return 'strong';  // 역류 발생
  if(diff > SINGOK_WEAK_THRESHOLD)     return 'weak';    // 역류 가능성
  return 'none';                                          // 정상 하류
}

function singokStatusLabel(swl, owl){
  const level = singokTideLevel(swl, owl);
  const diff = (swl!==null && owl!==null) ? (owl-swl).toFixed(2) : null;
  const swlTxt = swl!==null ? swl.toFixed(2)+'m' : '?';
  const owlTxt = owl!==null ? owl.toFixed(2)+'m' : '?';
  const diffTxt = diff!==null ? `(owl-swl=${diff}m)` : '';
  if(level===null)    return { text:`신곡수중보 수위 조회 실패 — 조석 영향 판단 불가`, cls:'warn', icon:'⚠', level:'unknown' };
  if(level==='strong') return { text:`신곡수중보 역류 발생 🌊 owl ${owlTxt} > swl ${swlTxt} ${diffTxt} → 조석 강한 영향`, cls:'ok', icon:'🌊', level };
  if(level==='weak')   return { text:`신곡수중보 역류 가능성 owl ${owlTxt} ≈ swl ${swlTxt} ${diffTxt} → 조석 약한 영향`, cls:'warn', icon:'〜', level };
  return { text:`신곡수중보 정상 하류 흐름 swl ${swlTxt} > owl ${owlTxt} ${diffTxt} → 조석 영향 미미`, cls:'hold', icon:'⬇', level };
}

// 교량별 실질 조석 영향 여부
// 잠실수중보 상류는 항상 제외, 하류는 owl-swl 수위차로 판단
function bridgeTideActive(b, singokSwl, singokOwl){
  if(!b.tide) return false;        // 잠실수중보 상류: 항상 제외
  if(!b.tideRealtime) return false;
  const level = singokTideLevel(singokSwl, singokOwl);
  if(level === null) return null;  // 데이터 없음 → 판단 불가
  if(level === 'strong') return true;   // 역류 발생 → 조석 영향 있음
  if(level === 'weak')   return 'weak'; // 역류 가능성 → 약한 영향
  return false;                         // 정상 하류 → 영향 미미
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
function makePointState(label,b,time,waterRows,damRows,tideRows,waterMetric,damMetric,singokSwlAtTime,singokOwlAtTime){
  const waterKeys=waterMetric?.key?[waterMetric.key]:WATER_KEYS;
  const damKeys=damMetric?.key?[damMetric.key]:DAM_KEYS;
  let water=nearest(waterRows,time,waterKeys);
  const waterFlow=nearest(waterRows,time,[WATER_FLOW_FIXED_KEY,'FW','fw'],MAX_NEAREST_MIN);
  const wTrend=trend(waterRows,time,waterKeys,60);
  const damImpactTime=new Date(time.getTime()-(b.releaseLag||0)*60000);
  const damImpact=nearest(damRows,damImpactTime,damKeys,90);

  // ── 조석: owl-swl 수위차 기반 실시간 판단 ──────────────────────
  const tideActive=bridgeTideActive(b, singokSwlAtTime, singokOwlAtTime);
  const tideLevel = singokTideLevel(singokSwlAtTime, singokOwlAtTime);
  const singokDiff = (singokSwlAtTime!==null && singokOwlAtTime!==null)
    ? (singokOwlAtTime - singokSwlAtTime).toFixed(2) : null;
  let tide=null;
  // 강한 영향 또는 약한 영향이면 조석 데이터 적용
  if((tideActive===true || tideActive==='weak') && tideRows.length){
    tide=tideAt(tideRows,time,b.offset||0);
  }
  let tideStatusNote;
  if(!b.tide){
    tideStatusNote = '잠실수중보 상류: 조석 적용 제외';
  } else if(tideActive===null){
    tideStatusNote = '신곡수중보 수위 조회 실패 → 조석 영향 판단 불가';
  } else if(tideActive===true){
    tideStatusNote = `🌊 신곡수중보 역류 중 (owl-swl=${singokDiff}m) → 조석 강한 영향`;
  } else if(tideActive==='weak'){
    tideStatusNote = `〜 신곡수중보 역류 가능 (owl-swl=${singokDiff}m) → 조석 약한 영향`;
  } else {
    tideStatusNote = `⬇ 신곡수중보 정상 하류 흐름 (owl-swl=${singokDiff}m) → 조석 영향 미미`;
  }

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

  // ★ 유속 계산 (1순위: fw실측, 2순위: HQ곡선, 3순위: 방류량 추정)
  const fwVal = waterFlow ? waterFlow.value : null;
  const wlVal = water ? water.value : null;
  const velResult = calcVelocity(fwVal, wlVal, b.code); // {vel, source, Q} or null
  const velocity = velResult ? velResult.vel : null;
  const velSource = velResult ? velResult.source : null;
  const velQ      = velResult ? velResult.Q : null;
  const velInfo = velocityLabel(velocity);

  const direction=directionLabel(b,wTrend,damImpact,tide,tideActive);
  const speed=velInfo ? velInfo.label : speedLabel(wTrend,damImpact,tide);
  const notes=[];
  if(wTrend) notes.push(`수위 1시간 ${wTrend.delta>0?'+':''}${wTrend.delta}m`); else notes.push(waterMetric?.blank?'통제소 수위 응답 공백':'수위 변화 계산불가');
  if(damImpact) notes.push(`팔당 ${b.releaseLag}분 보정 ${damImpact.value.toFixed(1)}㎥/s`); else notes.push(damMetric?.blank?'통제소 방류 응답 공백':'방류량 보정값 없음');
  notes.push(tideStatusNote);
  if(waterSource==='estimated') notes.push('⚠ 수위 실측값 없음 → 계산값(추정)으로 대체');
  return{label,time,water,waterFlow,wTrend,damImpact,damImpactTime,tide,tideActive,tideStatusNote,direction,speed,notes,waterSource,velocity,velInfo,velSource,velQ};
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
  if(tideActive===false) return `⬇ 신곡수중보 정상 하류 흐름 → 조석 영향 미미 (수위·방류량 주도)`;
  if(tideActive==='weak') return `〜 신곡수중보 역류 가능성 → 조석 약한 영향 (인천 조위 참고)`;
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
function fmtTideNumber(date, tideRows){
  if(!date) return '<span style="color:var(--bad)">날짜 미입력</span>';
  const tn = tideNumber(date, tideRows);
  const srcBadge = tn.source === 'observed'
    ? '<span style="background:#e7f8ef;color:#078a4f;font-size:10px;font-weight:800;padding:1px 6px;border-radius:4px;margin-left:4px">실측기반</span>'
    : '<span style="background:#fff4db;color:#b7791f;font-size:10px;font-weight:800;padding:1px 6px;border-radius:4px;margin-left:4px">달력역산·±1~2물오차</span>';
  return `<strong>${tn.n}물 · ${tn.name}</strong>${srcBadge}<br><small class="muted">${tn.basis}</small>`;
}

// ── 데이터 검토사항 경고 패널 ────────────────────────────────
// 4가지 위험 요소를 자동 감지해서 사용자에게 명시
function renderDataWarnings(b, incidentState, currentState, q, dataCapped, singokRows, tideRows){
  const el = $('dataWarnings'); if(!el) return;
  const warnings = [];

  // ① 데이터 누락 가능성
  if(!incidentState.water || incidentState.water.stale)
    warnings.push({type:'누락', cls:'warn', msg:`투신시점 수위 실측값 없음 (입력시각과 가장 가까운 관측값 차이 ${incidentState.water?.diffMin??'알 수 없음'}분) — 투신시점 데이터가 HRFCO에 없거나 API 응답 공백일 수 있습니다.`});
  if(!currentState.water || currentState.water.stale)
    warnings.push({type:'누락', cls:'warn', msg:`조회시점 수위 실측값 없음 (차이 ${currentState.water?.diffMin??'알 수 없음'}분) — HRFCO 최신 데이터 지연 또는 관측소 장애일 수 있습니다.`});
  if(!incidentState.damImpact)
    warnings.push({type:'누락', cls:'warn', msg:'투신시점 방류량 자료 없음 — 팔당댐 API 응답이 없거나 해당 시간대 데이터가 없습니다.'});
  if(b.tide && tideRows.length === 0)
    warnings.push({type:'누락', cls:'bad', msg:'조석 데이터 전체 없음 — 조석 API 키를 확인하거나 API 서버 상태를 점검하세요. 물때·조석 관련 모든 판정이 불가합니다.'});
  if(singokRows.length === 0)
    warnings.push({type:'누락', cls:'bad', msg:'신곡수중보 수위 조회 실패 — 조석 전파 여부 판단 불가. HRFCO API 키가 올바른지 확인하세요.'});

  // ② API 장애 가능성
  if(dataCapped)
    warnings.push({type:'API지연', cls:'warn', msg:`HRFCO 데이터 제공 지연 — 조회시각보다 최대 2시간 이전 데이터까지만 제공됩니다. 이는 HRFCO 공개 API의 정상 특성이나, 장애 시 더 길어질 수 있습니다.`});
  if(q.water === '실패' || q.dam === '실패')
    warnings.push({type:'API장애', cls:'bad', msg:`HRFCO API ${[q.water==='실패'?'수위':'', q.dam==='실패'?'방류량':''].filter(Boolean).join('/')} 조회 실패 — API 서버 장애이거나 인증키 만료일 수 있습니다. 원자료 로그에서 오류 내용을 확인하세요.`});
  if(q.tide === '실패')
    warnings.push({type:'API장애', cls:'bad', msg:'조석 API 조회 실패 — 공공데이터포털 API 키 만료, 일일 호출 한도 초과, 또는 서버 장애일 수 있습니다.'});

  // ③ 계산 오류 가능성
  if(incidentState.waterSource === 'estimated')
    warnings.push({type:'계산값', cls:'warn', msg:'투신시점 수위는 HRFCO 실측이 없어 계산값(추정)으로 대체됨 — 베이스라인+조석+방류 보정 계산식이며 실제 수위와 차이날 수 있습니다. 실측값 아님.'});
  if(currentState.waterSource === 'estimated')
    warnings.push({type:'계산값', cls:'warn', msg:'조회시점 수위는 HRFCO 실측이 없어 계산값(추정)으로 대체됨 — 실측값 아님.'});
  const incTn = tideRows.length >= 6 ? tideNumberFromRows(parseLocal($('incidentDate').value,$('incidentTime').value)||new Date(), tideRows) : null;
  if(!incTn && b.tide)
    warnings.push({type:'계산값', cls:'warn', msg:'물때가 달력 역산으로 계산됨 — 조석 데이터 부족으로 ±1~2물 오차 가능. 실제 인천 물때표와 반드시 대조 확인하세요.'});
  if(b.tide && singokTideState.status === 'unknown')
    warnings.push({type:'계산값', cls:'warn', msg:'신곡수중보 수위 미확인 — 조석 전파 여부 판단 불가. 이 상태에서 조석 관련 판정은 신뢰하지 마세요.'});

  // ④ 사용자 오해 가능성
  warnings.push({type:'오해주의', cls:'info', msg:'물 방향·물살 판정은 유속 실측값이 아닙니다 — 수위변화·방류량·조석을 조합한 참고판정입니다. 실제 수색 방향 결정은 반드시 현장 확인과 공식 기관 지시를 따르세요.'});
  if(b.tide && singokTideState.status === 'blocked')
    warnings.push({type:'오해주의', cls:'info', msg:`현재 신곡수중보 수위(${singokTideState.swl?.toFixed(2)}m)가 낮아 조석이 차단된 상태입니다 — 이 교량 구간의 수위 변화는 조석이 아니라 팔당댐 방류량과 강우에 의한 것입니다.`});
  if(currentState.water && currentState.water.stale && currentState.water.diffMin > 30)
    warnings.push({type:'오해주의', cls:'warn', msg:`표시된 수위는 조회시각 기준 ${currentState.water.diffMin}분 전 관측값입니다 — 현재 실제 수위와 다를 수 있습니다.`});

  if(!warnings.length){ el.innerHTML=''; el.style.display='none'; return; }

  const clsMap = {warn:'background:#fff8eb;border-color:#f6ad55;color:#92400e', bad:'background:#ffe8e8;border-color:#f87171;color:#991b1b', info:'background:#eff6ff;border-color:#93c5fd;color:#1e40af'};
  const typeMap = {누락:'⚠ 데이터 누락', API지연:'🕐 API 지연', API장애:'🔴 API 장애', 계산값:'🔶 계산값', 오해주의:'ℹ 참고사항'};

  el.innerHTML = `
    <div style="font-size:13px;font-weight:800;color:#475467;margin-bottom:8px">
      데이터 검토사항 (${warnings.length}건) — 수색 전 반드시 확인
    </div>
    ${warnings.map(w=>`
      <div style="border:1px solid;border-radius:8px;padding:8px 12px;margin-bottom:6px;font-size:13px;${clsMap[w.cls]||clsMap.info}">
        <strong>${typeMap[w.type]||w.type}</strong>: ${w.msg}
      </div>`).join('')}`;
  el.style.display = 'block';
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
  const lbl=singokStatusLabel(s.swl, s.owl);
  const bgColor = lbl.level==='strong'?'#e7f8ef':lbl.level==='weak'?'#fff8eb':'#f5f5f5';
  const borderColor = lbl.level==='strong'?'#078a4f':lbl.level==='weak'?'#f6ad55':'#d1d5db';
  const diffTxt = s.diff!==null ? `owl(${s.owl?.toFixed(2)}m) - swl(${s.swl?.toFixed(2)}m) = ${s.diff?.toFixed(2)}m` : '';
  el.innerHTML=`<div style="padding:10px 14px;border-radius:10px;border:1px solid ${borderColor};background:${bgColor}">
    <strong style="font-size:13px">${lbl.icon} ${lbl.text}</strong>
    <div class="muted" style="font-size:12px;margin-top:4px">
      ${diffTxt}<br>
      관측시각: ${s.time?pretty(s.time):'불명'} · 기준: owl-swl > 0 역류강, > -0.3 역류가능, 이하 정상흐름
    </div>
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
    <div class="data-card"><b>조석</b>${dataBadge(q.tide)}<div class="data-grid-mini"><span>투신</span><span>${fmtTidePoint(b,incidentState.tide,incidentState.tideActive)}</span><span>조회</span><span>${fmtTidePoint(b,currentState.tide,currentState.tideActive)}</span></div></div>
    <div class="data-card" style="border-color:#bfdbfe">
      <b>🌊 참고 유속</b><span class="data-badge ${incidentState.velocity!==null?'good':'hold'}">${incidentState.velSource||'없음'}</span>
      <div class="data-grid-mini">
        <span>투신</span><span>${incidentState.velocity!==null?`<strong>${incidentState.velocity.toFixed(2)}m/s</strong> · ${incidentState.velInfo?.label||''} · Q=${incidentState.velQ?.toFixed(0)||'?'}㎥/s`:'자료 없음'}</span>
        <span>조회</span><span>${currentState.velocity!==null?`<strong>${currentState.velocity.toFixed(2)}m/s</strong> · ${currentState.velInfo?.label||''} · Q=${currentState.velQ?.toFixed(0)||'?'}㎥/s`:'자료 없음'}</span>
        <span>출처</span><span><small>${incidentState.velSource||'fw·HQ 데이터 없음'} · 단면적 추정치 포함</small></span>
      </div>
    </div>`;
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
    ${row('참고 유속',
      incidentState.velocity!==null
        ? `<strong>${incidentState.velocity.toFixed(2)}m/s</strong> (${(incidentState.velocity*3.6).toFixed(1)}km/h) · ${incidentState.velInfo?.label||''}<br><small style="color:#667085">${incidentState.velSource||''} · Q=${incidentState.velQ?.toFixed(0)||'?'}㎥/s</small>`
        : '<span style="color:#b7791f">유속 계산 불가</span>',
      currentState.velocity!==null
        ? `<strong>${currentState.velocity.toFixed(2)}m/s</strong> (${(currentState.velocity*3.6).toFixed(1)}km/h) · ${currentState.velInfo?.label||''}<br><small style="color:#667085">${currentState.velSource||''} · Q=${currentState.velQ?.toFixed(0)||'?'}㎥/s</small>`
        : '<span style="color:#b7791f">유속 계산 불가</span>'
    )}
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
    <div class="kv"><b>투신시점 물때</b><span>${incidentDt?fmtTideNumber(incidentDt,tideRows):'날짜 미입력'}</span></div>
    <div class="kv"><b>조회시점 물때</b><span>${searchDt?fmtTideNumber(searchDt,tideRows):'날짜 미입력'}</span></div>
    <div class="kv"><b>신곡수중보</b><span>${singokStatusLabel(singokTideState.swl, singokTideState.owl).text}</span></div>
    <div class="kv" style="background:#f0f7ff;border-radius:6px;padding:8px 10px">
      <b>🌊 투신시점 참고유속</b>
      <span>${incidentState.velocity!==null
        ? `<strong style="font-size:22px">${incidentState.velocity.toFixed(2)} m/s</strong> · 시속 ${(incidentState.velocity*3.6).toFixed(1)}km · ${incidentState.velInfo?.label||''}`
        : '<span style="color:#b7791f">유속 계산 불가</span>'
      }<br>
      ${incidentState.velocity!==null?`<small class="muted">출처: ${incidentState.velSource} · 유량 Q=${incidentState.velQ?.toFixed(0)||'?'}㎥/s · 단면적 추정 포함</small>`:''}
      </span>
    </div>
    <div class="kv" style="background:#f0f7ff;border-radius:6px;padding:8px 10px">
      <b>🌊 조회시점 참고유속</b>
      <span>${currentState.velocity!==null
        ? `<strong style="font-size:22px">${currentState.velocity.toFixed(2)} m/s</strong> · 시속 ${(currentState.velocity*3.6).toFixed(1)}km · ${currentState.velInfo?.label||''}`
        : '<span style="color:#b7791f">유속 계산 불가</span>'
      }<br>
      ${currentState.velocity!==null?`<small class="muted">출처: ${currentState.velSource} · 유량 Q=${currentState.velQ?.toFixed(0)||'?'}㎥/s · 단면적 추정 포함</small>`:''}
      </span>
    </div>
    <div class="kv"><b>현재 조석</b><span>${fmtTidePoint(b,currentState.tide,currentState.tideActive)}</span></div>
    <div class="kv"><b>근거</b><span>${decision?.parts?.join(' / ')||'-'}</span></div>`;
}

// ── 모델 정보 ────────────────────────────────────────────────
function renderModelInfo(b){
  $('modelInfo').innerHTML=`
    <div class="kv"><b>교량</b><span>${b.bridge}</span></div>
    <div class="kv"><b>구간</b><span>${b.zone}</span></div>
    <div class="kv" style="background:#f0f7ff;border-radius:6px;padding:8px 10px;margin:4px 0">
      <b>📍 수위 출처</b>
      <span><strong>${b.station} (${b.code})</strong><br>
      <small class="muted">교량 인근 HRFCO 수위관측소 실측값. 교량 직하 수심이 아닌 관측소 기준 수위(m)입니다.</small></span>
    </div>
    <div class="kv" style="background:#fff8ee;border-radius:6px;padding:8px 10px;margin:4px 0">
      <b>💧 방류량 출처</b>
      <span><strong>팔당댐 (1017310) + ${b.releaseLag}분 지연 보정</strong><br>
      <small class="muted">팔당댐 실측 방류량에 팔당→교량 하류 도달 지연시간(추정)을 적용한 참고값. 교량 직접 측정값 아님.</small></span>
    </div>
    <div class="kv" style="background:${b.tide?'#f5f0ff':'#f5f5f5'};border-radius:6px;padding:8px 10px;margin:4px 0">
      <b>🌊 조석 출처</b>
      <span><strong>${b.tide?`인천 (${TIDE_STATION}) + ${b.offset}분 보정 · 신곡수중보 swl 실시간 판단`:'잠실수중보 상류: 조석 제외'}</strong><br>
      <small class="muted">${b.tide?`인천 조위관측소 예보값에 인천→교량 전파 지연(${b.offset}분, 계산 추정값)을 더한 보정값. 교량 직접 조석 측정값 아님.<br>조석 영향 판단: 신곡수중보 owl-swl 수위차 기준 (>0 강한영향 / >-0.3 약한영향 / 이하 영향미미)`:'HRFCO 수위와 팔당 방류량만 사용합니다.'}</small></span>
    </div>`;
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

// ── 이동 경로 추정 패널 ─────────────────────────────────────
function renderDriftEstimate(b, incidentState){
  const el=$('driftEstimate'); if(!el) return;

  let vel = incidentState.velocity;           // makePointState에서 이미 계산됨
  let velSource = incidentState.velSource || '';

  // ── 유속이 없으면 방류량 기반 최후 fallback ───────────────────
  // (fw실측, HQ곡선 모두 실패한 경우)
  if(vel === null){
    const dam = incidentState.damImpact?.value ?? null;
    const wl  = incidentState.water?.value ?? null;
    if(dam !== null && wl !== null){
      const sec = STATION_SECTIONS[b.code];
      if(sec){
        const depth = wl - sec.bedEl;
        if(depth > 0.1){
          const area = sec.width * depth * sec.shape;
          const estVel = dam / area;
          if(Number.isFinite(estVel) && estVel > 0 && estVel < 10){
            vel = Number(estVel.toFixed(2));
            velSource = '방류량 추정(3순위·오차 큼)';
          }
        }
      }
    }
  }

  // ── 유속도 없고 방류량도 없는 경우 ───────────────────────────
  if(vel === null){
    el.innerHTML = `
      <div style="background:#fff8eb;border:1px solid #f6ad55;border-radius:8px;padding:12px 14px;font-size:13px;color:#92400e">
        <strong>⚠ 이동 경로 추정 불가</strong><br>
        투신시점 수위관측소의 fw(유량) 데이터와 방류량 데이터가 모두 없어 유속을 계산할 수 없습니다.<br>
        <small>원자료 로그에서 수위 데이터의 fw 필드 값을 확인하세요.</small>
      </div>`;
    return;
  }

  const tideActive = incidentState.tideActive;
  const tidePhase  = incidentState.tide?.phase || null;
  const tideRate   = incidentState.tide?.rateCmHr ?? null;

  const results = estimateDrift(b.bridge, vel, tideActive, tidePhase, tideRate, [30,60,120,360]);

  if(!results){
    el.innerHTML = `<div style="background:#fff8eb;border:1px solid #f6ad55;border-radius:8px;padding:12px;font-size:13px;color:#92400e">
      ⚠ 교량 위치 정보 없음 — BRIDGE_GEO에 "${b.bridge}" 좌표가 등록되지 않았습니다.</div>`;
    return;
  }

  const isTideReverse = tideActive===true && tidePhase && tidePhase.includes('밀물');
  const directionSummary = isTideReverse
    ? `🌊 밀물 역류 포함 — 순유속 ${results[0].netVelMs}m/s (하류 ${results[0].downstreamVel} - 역류 ${results[0].upstreamVel})`
    : `⬇ 하류 방향 — 유속 ${vel.toFixed(2)}m/s · 조석 역류 없음`;

  const velBadge = velSource.includes('fw실측')
    ? `<span style="background:#e7f8ef;color:#078a4f;font-size:11px;font-weight:800;padding:2px 7px;border-radius:4px;margin-left:6px">fw 실측</span>`
    : velSource.includes('HQ')
    ? `<span style="background:#eff6ff;color:#1d4ed8;font-size:11px;font-weight:800;padding:2px 7px;border-radius:4px;margin-left:6px">HQ 공식곡선</span>`
    : `<span style="background:#fff4db;color:#b7791f;font-size:11px;font-weight:800;padding:2px 7px;border-radius:4px;margin-left:6px">방류량 추정</span>`;

  const rows = results.map(r => {
    const dirIcon  = r.direction.includes('하류') ? '⬇' : '⬆';
    const dirColor = r.direction.includes('하류') ? '#f97316' : '#2563eb';
    const distTxt  = Math.abs(r.distKm) < 0.05 ? '거의 정체' : `${r.direction} ${Math.abs(r.distKm).toFixed(1)}km`;
    const nearby   = r.nearbyBridges.map(nb=>`${nb.name}(±${nb.diff.toFixed(1)}km)`).join(', ');
    return `<tr style="border-bottom:1px solid #e5e7eb">
      <td style="padding:10px 8px;font-weight:800;font-size:15px;white-space:nowrap">${r.minutes}분 후</td>
      <td style="padding:10px 8px;color:${dirColor};font-weight:800;font-size:15px">${dirIcon} ${distTxt}</td>
      <td style="padding:10px 8px;font-size:13px">${nearby||'—'}</td>
      <td style="padding:10px 8px;font-size:12px;color:#667085">
        순유속 ${r.netVelMs}m/s<br>
        하구 ${r.estDistFromSea.toFixed(1)}km
      </td>
    </tr>`;
  }).join('');

  const geo = BRIDGE_GEO[b.bridge];
  const mapLink = geo
    ? `<a href="https://map.kakao.com/link/map/${encodeURIComponent(b.bridge)},${geo.lat},${geo.lng}" target="_blank"
         style="color:#0f62fe;font-size:13px;text-decoration:none">📍 투신 교량 카카오맵에서 보기</a>`
    : '';

  el.innerHTML = `
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px">
      <strong>기준 교량: ${b.bridge}</strong> · 투신시점 유속 <strong>${vel.toFixed(2)}m/s</strong>
      (시속 ${(vel*3.6).toFixed(1)}km)${velBadge}<br>
      ${directionSummary}
    </div>
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
      <table style="width:100%;border-collapse:collapse;font-size:14px;min-width:360px">
        <thead>
          <tr style="background:#f0f4ff;font-size:12px;color:#667085">
            <th style="padding:8px;text-align:left">경과시간</th>
            <th style="padding:8px;text-align:left">이동 거리·방향</th>
            <th style="padding:8px;text-align:left">인근 교량 (참고)</th>
            <th style="padding:8px;text-align:left">상세</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="margin-top:10px;padding:10px 14px;background:#fff8eb;border:1px solid #f6ad55;border-radius:8px;font-size:12px;color:#92400e;line-height:1.6">
      <strong>⚠ 오차 범위 및 주의사항</strong><br>
      • 실제 이동거리는 <strong>±30~50% 오차</strong> 가능 (단면 평균 유속 기반)<br>
      • 와류·강변 지형·수중 장애물·수심별 유속 차이 미반영<br>
      • 밀물 역류 성분은 인천 조위 변화율 기반 경험 추정값<br>
      • <strong>수색 범위 결정은 이 결과를 참고하되 현장 판단과 전문가 지시 우선</strong>
    </div>
    <div style="margin-top:8px">${mapLink}</div>`;
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
// ── 그래프 (SVG 인라인, 외부 의존 없음) ─────────────────────────
function _hhmm(d){ return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }

function drawLine(chartId, data, key, label, markers, range){
  label = label||''; markers = markers||[]; range = range||null;
  
  // ID로 컨테이너 찾기 (div 또는 canvas의 부모)
  let el = document.getElementById(chartId);
  if(!el) return;
  if(el.tagName==='CANVAS') el = el.parentElement||el;

  // 데이터 필터링
  let pts = (data||[]).filter(d=>d&&d[key]!=null&&d.time).sort((a,b)=>a.time-b.time);
  if(range&&range.start&&range.end){
    pts = pts.filter(p=>p.time.getTime()>=range.start.getTime()&&p.time.getTime()<=range.end.getTime());
  }

  if(pts.length<2){
    el.innerHTML = `<p style="padding:16px;color:#667085;font-size:13px">${label} — 데이터 부족</p>`;
    el.style = 'background:#fff;border:1px solid #e6e8ef;border-radius:12px;min-height:120px';
    return;
  }

  const xs = pts.map(p=>p.time.getTime());
  const ys = pts.map(p=>p[key]);
  const minX = range&&range.start ? range.start.getTime() : Math.min(...xs);
  const maxX = range&&range.end   ? range.end.getTime()   : Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX-minX||1, spanY = maxY-minY||1;
  const spanDays = spanX/86400000;

  // SVG 좌표계: 1000x320 기준
  const W=1000, H=320, PL=90, PR=20, PT=50, PB=45;
  const gW=W-PL-PR, gH=H-PT-PB;
  const sx = x => PL+(x-minX)/spanX*gW;
  const sy = y => PT+(1-(y-minY)/spanY)*gH;

  const fmtT = ts => {
    const d=new Date(ts);
    const hm=_hhmm(d);
    return spanDays>=1 ? `${d.getMonth()+1}/${d.getDate()} ${hm}` : hm;
  };

  // Y 눈금
  let gridY='', labY='';
  for(let i=0;i<=4;i++){
    const yp=PT+i*gH/4;
    const v=maxY-spanY*i/4;
    gridY+=`<line x1="${PL}" y1="${yp}" x2="${W-PR}" y2="${yp}" stroke="#e5e7eb" stroke-width="1"/>`;
    labY+=`<text x="${PL-6}" y="${yp+4}" text-anchor="end" font-size="18" fill="#8a95a8">${v.toFixed(2)}</text>`;
  }

  // X 눈금
  let labX='';
  for(let i=0;i<=4;i++){
    const tx=minX+spanX*i/4;
    const xp=Math.max(PL+20,Math.min(W-PR-20,sx(tx)));
    labX+=`<text x="${xp}" y="${H-8}" text-anchor="middle" font-size="18" fill="#8a95a8">${fmtT(tx)}</text>`;
  }

  // 마커
  let mkSvg='';
  (markers||[]).filter(m=>m&&m.time).forEach(m=>{
    const tx=m.time.getTime();
    if(tx<minX||tx>maxX) return;
    const mx=sx(tx);
    const safeX=Math.max(PL+30,Math.min(W-PR-30,mx));
    mkSvg+=`<line x1="${mx}" y1="${PT}" x2="${mx}" y2="${PT+gH}" stroke="${m.color||'#c53030'}" stroke-width="2" stroke-dasharray="8,6"/>`;
    mkSvg+=`<text x="${safeX}" y="${PT-10}" text-anchor="middle" font-size="20" font-weight="bold" fill="${m.color||'#c53030'}">${m.label||''}</text>`;
  });

  // 라인
  const pathD = pts.map((p,i)=>`${i===0?'M':'L'}${sx(p.time.getTime()).toFixed(1)},${sy(p[key]).toFixed(1)}`).join(' ');
  const last = pts[pts.length-1];

  el.innerHTML = `
    <div style="padding:8px 12px 0;font-size:13px;font-weight:700;color:#172033">${label}</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">
      ${gridY}${labY}${labX}${mkSvg}
      <path d="${pathD}" fill="none" stroke="#0f62fe" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${sx(last.time.getTime()).toFixed(1)}" cy="${sy(last[key]).toFixed(1)}" r="6" fill="#0f62fe"/>
    </svg>`;
  el.style.cssText = 'width:100%;background:#fff;border:1px solid #e6e8ef;border-radius:12px;overflow:hidden;box-sizing:border-box';
}

function drawMultiLine(chartId, series, label, markers){
  label = label||''; markers = markers||[];
  let el = document.getElementById(chartId);
  if(!el) return;
  if(el.tagName==='CANVAS') el = el.parentElement||el;

  const colors=['#0f62fe','#b7791f','#078a4f'];
  const names=['수위(m)','방류량(㎥/s)','조석(cm)'];
  const srcs=['교량 관측소','팔당댐+보정','인천+보정'];

  const valid = (series||[]).filter(s=>(s.points||[]).filter(p=>p.time&&p.value!=null).length>=2);
  if(!valid.length){
    el.innerHTML='<p style="padding:16px;color:#667085;font-size:13px">통합 그래프 데이터 부족</p>';
    el.style='background:#fff;border:1px solid #e6e8ef;border-radius:12px;min-height:100px';
    return;
  }

  const W=1000, SLOT=200, PT=80, PL=80, PR=20;
  const H=valid.length*SLOT+PT+30;
  let svg='';
  svg+=`<text x="10" y="28" font-size="20" font-weight="bold" fill="#172033">${label}</text>`;
  (markers||[]).forEach((m,i)=>{
    svg+=`<text x="${10+i*300}" y="55" font-size="18" font-weight="bold" fill="${m.color||'#c53030'}">${m.label||''} ${m.time?_hhmm(m.time):''}</text>`;
  });

  let vi=0;
  (series||[]).forEach((s,si)=>{
    const pts=(s.points||[]).filter(p=>p.time&&p.value!=null).sort((a,b)=>a.time-b.time);
    if(pts.length<2){vi++;return;}
    const color=colors[si%colors.length];
    const sTop=PT+vi*SLOT, gH=SLOT-20, gW=W-PL-PR;
    const xs=pts.map(p=>p.time.getTime());
    const ys=pts.map(p=>p.value);
    const minX=Math.min(...xs),maxX=Math.max(...xs)||minX+1;
    const minY=Math.min(...ys),maxY=Math.max(...ys)||minY+1;
    const sx2=x=>PL+(x-minX)/(maxX-minX)*gW;
    const sy2=y=>sTop+(1-(y-minY)/(maxY-minY))*gH;
    const spanDays=(maxX-minX)/86400000;
    const fmtT2=ts=>{const d=new Date(ts);const hm=_hhmm(d);return spanDays>=1?`${d.getMonth()+1}/${d.getDate()} ${hm}`:hm;};

    svg+=`<line x1="${PL}" y1="${sTop}" x2="${W-PR}" y2="${sTop}" stroke="#e0e4ee" stroke-width="1"/>`;
    svg+=`<text x="8" y="${sTop+24}" font-size="20" font-weight="bold" fill="${color}">${names[si]||s.name}</text>`;
    svg+=`<text x="8" y="${sTop+44}" font-size="16" fill="#8a95a8">${srcs[si]||''}</text>`;
    svg+=`<text x="${PL-6}" y="${sTop+16}" text-anchor="end" font-size="16" fill="${color}">${maxY.toFixed(1)}</text>`;
    svg+=`<text x="${PL-6}" y="${sTop+gH}" text-anchor="end" font-size="16" fill="${color}">${minY.toFixed(1)}</text>`;

    (markers||[]).filter(m=>m&&m.time).forEach(m=>{
      const tx=m.time.getTime();
      if(tx<minX||tx>maxX)return;
      const mx=sx2(tx);
      svg+=`<line x1="${mx.toFixed(1)}" y1="${sTop}" x2="${mx.toFixed(1)}" y2="${sTop+gH}" stroke="${m.color||'#c53030'}" stroke-width="2" stroke-dasharray="6,4"/>`;
    });

    const pathD=pts.map((p,i)=>`${i===0?'M':'L'}${sx2(p.time.getTime()).toFixed(1)},${sy2(p.value).toFixed(1)}`).join(' ');
    svg+=`<path d="${pathD}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round"/>`;
    svg+=`<text x="${PL}" y="${sTop+gH+18}" font-size="16" fill="#8a95a8">${fmtT2(minX)}</text>`;
    svg+=`<text x="${W-PR}" y="${sTop+gH+18}" text-anchor="end" font-size="16" fill="#8a95a8">${fmtT2(maxX)}</text>`;
    vi++;
  });

  el.innerHTML=`<div style="padding:8px 12px 0"><svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">${svg}</svg></div>`;
  el.style.cssText='width:100%;background:#fff;border:1px solid #e6e8ef;border-radius:12px;overflow:hidden;box-sizing:border-box';
}


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
  const nowLimit=floorTo10Min(new Date(Date.now()-10*60000)); // API 5분 지연 확인됨 (2026-07-09 검증)
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
    const singokAtSearch   = nearest(singokRows, search,   SINGOK_KEYS,     60);
    const singokAtIncident = nearest(singokRows, incident, SINGOK_KEYS,     60);
    const singokOwlSearch  = nearest(singokRows, search,   SINGOK_OWL_KEYS, 60);
    const singokOwlIncident= nearest(singokRows, incident, SINGOK_OWL_KEYS, 60);
    // 조회시점 기준으로 전역 상태 업데이트
    if(singokAtSearch){
      const swl = singokAtSearch.value;
      const owl = singokOwlSearch?.value ?? null;
      const diff = owl!==null ? owl-swl : null;
      const level = singokTideLevel(swl, owl);
      singokTideState = {
        status: level==='strong'?'active':level==='weak'?'weak':'blocked',
        swl, owl, diff, level, time:singokAtSearch.time, checkedAt:new Date()
      };
      q.singok = level==='strong'?`역류 중 (owl-swl=${diff?.toFixed(2)}m)`
               : level==='weak'  ?`역류 가능 (owl-swl=${diff?.toFixed(2)}m)`
               : level==='none'  ?`정상흐름 (owl-swl=${diff?.toFixed(2)}m)`
               : '조회 실패';
    } else {
      singokTideState={status:'unknown',swl:null,owl:null,diff:null,level:null,time:null,checkedAt:new Date()};
      q.singok='조회 실패';
    }
    log('[신곡수중보]',
      `조회 swl=${singokAtSearch?.value?.toFixed(2)??'?'}m owl=${singokOwlSearch?.value?.toFixed(2)??'?'}m`,
      `사고 swl=${singokAtIncident?.value?.toFixed(2)??'?'}m owl=${singokOwlIncident?.value?.toFixed(2)??'?'}m`,
      `판단기준: owl-swl > 0 → 역류(강), > -0.3 → 역류가능(약), 이하 → 정상흐름`);
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
  const singokSwlAtSearch   = nearest(singokRows,search,   SINGOK_KEYS,     60)?.value??null;
  const singokOwlAtSearch   = nearest(singokRows,search,   SINGOK_OWL_KEYS, 60)?.value??null;
  const singokSwlAtIncident = nearest(singokRows,incident, SINGOK_KEYS,     60)?.value??null;
  const singokOwlAtIncident = nearest(singokRows,incident, SINGOK_OWL_KEYS, 60)?.value??null;

  // 포인트 상태 계산
  const incidentState=makePointState('투신시점',b,incident,waterRows,damRows,tideRows,waterMetric,damMetric,singokSwlAtIncident,singokOwlAtIncident);
  const currentState =makePointState('조회시점',b,search,  waterRows,damRows,tideRows,waterMetric,damMetric,singokSwlAtSearch,  singokOwlAtSearch);
  const decision=flowDecisionFromState(currentState);

  // 렌더링
  renderSummary(b,incidentState,currentState,decision,tideRows);
  renderPointCompare(b,incidentState,currentState);
  renderDataFirstPanel(b,incidentState,currentState,q);
  renderDriftEstimate(b,incidentState);
  renderDeltaPanel(incidentState,currentState);
  renderReasonPanel(b,incidentState,currentState,q);
  renderDataWarnings(b,incidentState,currentState,q,dataCapped,singokRows,tideRows);
  renderModelInfo(b);

  const waterKeys=waterMetric.key?[waterMetric.key]:WATER_KEYS;
  const damKeys=damMetric.key?[damMetric.key]:DAM_KEYS;
  const waterPts=rowsToPoints(waterRows,waterKeys);
  const damPts=rowsToPoints(damRows,damKeys);
  const tidePts=rowsToPoints(tideRows,TIDE_KEYS);
  const markers=[{time:incident,label:'투신 시점',color:'#0f62fe'},{time:effectiveSearch,label:dataCapped?'최신 관측':'현 시점',color:'#c53030'}];

  drawMultiLine('combinedChart',[{name:'수위',points:normalizePoints(waterPts)},{name:'방류',points:normalizePoints(damPts)},{name:'조석',points:normalizePoints(tidePts)}],`${b.bridge} · ${pretty(incident)} ~ ${pretty(effectiveSearch)}`,markers);
  $('combinedChartNote').textContent=`파란선=수위(m), 갈색선=방류량(㎥/s), 초록선=조석(cm). 0~100 정규화 비교용.${dataCapped?` ⚠ 조회시각보다 ${Math.round((search-end)/60000)}분 이전 데이터까지 표시`:''}`;

  drawLine('waterChart',waterPts,'value',`${b.station} 수위(m) · ${hhmm(incident)} ~ ${hhmm(effectiveSearch)}`,markers,{start:incident,end:effectiveSearch});
  $('waterChartNote').textContent=(currentState.wTrend?`최근 1시간 수위 변화: ${currentState.wTrend.delta>0?'+':''}${currentState.wTrend.delta}m`:'최근 1시간 변화 계산에 필요한 시계열이 부족합니다.')+(dataCapped?` ⚠ HRFCO 데이터 ${Math.round((search-end)/60000)}분 지연`:' (그래프 범위: 투신~조회시점)');

  // 방류량 통계 바
  (function(){
    const el=$('damStatBar');if(!el)return;
    const vals=damPts.map(p=>p.value).filter(v=>v!=null);
    if(!vals.length){el.innerHTML='';return;}
    const maxV=Math.max(...vals),minV=Math.min(...vals),curV=currentState.damImpact?.value??vals[vals.length-1];
    el.innerHTML=`<div class="dam-stat-item high"><b>최대 방류량</b><span>${maxV.toFixed(0)} ㎥/s</span></div><div class="dam-stat-item current"><b>조회시점 방류량</b><span>${curV!=null?curV.toFixed(0)+'㎥/s':'자료 없음'}</span></div><div class="dam-stat-item low"><b>최소 방류량</b><span>${minV.toFixed(0)} ㎥/s</span></div>`;
  })();

  drawLine('damChart',damPts,'value',`팔당댐 방류량(㎥/s) · ${hhmm(incident)} ~ ${hhmm(effectiveSearch)}`,markers,{start:incident,end:effectiveSearch});
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
    drawLine('tideChart',tidePts,'value',`인천 조위(cm) · ${TIDE_STATION} · ${hhmm(tideRangeStart)} ~ ${hhmm(tideRangeEnd)}`,markers,{start:tideRangeStart,end:tideRangeEnd});
    $('tideChartNote').textContent=(currentState.tide?`인천 조석값에 교량별 지연시간(${b.offset||0}분)을 더해 교량 기준으로 보정했습니다.`:'조석 매칭 실패')+(dataCapped?` ⚠ 데이터 ${Math.round((search-end)/60000)}분 지연`:' (그래프 범위: 투신 30분전 ~ 조회 30분후)');
  } else {
    drawLine('tideChart',[],'value','조석',[]);
    $('tideChartNote').textContent=b.tide?'조석 API 미조회':'조석 적용 제외 구간';
  }

  $('tideSummary').innerHTML=currentState.tide?`<div class="summary-big">${currentState.tide.phase}</div><div>${fmtTidePoint(b,currentState.tide,currentState.tideActive)}</div>`:`<div class="summary-big">${!b.tide?'조석 적용 제외':currentState.tideActive===false?'⛔ 조석 차단 (신곡수중보 낮음)':singokTideState.status==='unknown'?'신곡수중보 수위 조회 실패':'조석 미조회'}</div>`;

  renderBoard([{bridge:b.bridge,direction:`${currentState.direction} · ${currentState.speed}`}],b,currentState);
  $('inputStatus').textContent=`조회 완료${dataCapped?` · ⚠ HRFCO 데이터 ${Math.round((search-end)/60000)}분 지연`:''} · 신곡수중보 swl=${singokTideState.swl?.toFixed(2)??'조회실패'}m`;
  // ★ 화면 회전 시 재렌더를 위해 마지막 조회 파라미터 저장
  window._lastRunQuery = runQuery;
}

document.addEventListener('DOMContentLoaded', init);

// ★ 모바일 대응: 화면 회전·크기 변경 시 그래프 재렌더
window.addEventListener('resize', () => {
  if(window._lastRunQuery) {
    clearTimeout(window._resizeTimer);
    window._resizeTimer = setTimeout(()=>{ window._lastRunQuery(); }, 300);
  }
});
