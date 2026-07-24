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
  '1018640': { // 광진교
    // ★ 2026-07-24 재수정: WAMIS 공식 수위-유량곡선식 확인됨(영진님 확인, 2010년 환경부
    //   자료, 38개 실측치 기반 — 가장 최신). 이전 임시조치(자체 회귀)를 이 공식 곡선으로 교체.
    //   최하단 구간(0.92~1.40m)은 원본에 잠실수중보 "보 개방"/"보 폐쇄" 두 공식이 있음 —
    //   앱이 보 게이트 상태를 추적하지 않아 하나를 골라야 했는데, 실측 205일(2026-01~07)
    //   대조 결과 "보 폐쇄" 가정이 평균오차 113%로 "보 개방"(255%)보다 훨씬 잘 맞아 채택함
    //   (보통 보는 평상시 폐쇄, 홍수 때만 개방되므로 물리적으로도 타당).
    //   ⚠ 이 최하단 구간은 WAMIS 원본에도 "1.10m 이하 외삽"이라고 명시된 구간이라, 실측
    //   대조 오차 113%는 앱의 문제가 아니라 공식 곡선 자체의 알려진 한계임 — 참고로 표시.
    name:'광진교', source:'WAMIS 수위-유량관계곡선식(2010,환경부, 확인 2026-07-24) — 최하단은 보폐쇄 가정',
    segments:[
      {min:0.92, max:1.40, formula:(h)=>17925.556 * Math.pow(Math.max(0.001,h-0.920), 2.900)}, // 보폐쇄 가정, 1.10m 이하 공식 외삽구간
      {min:1.40, max:2.20, formula:(h)=>  747.686 * Math.pow(h+0.430, 1.735)},
      {min:2.20, max:3.50, formula:(h)=>  513.591 * Math.pow(h+0.890, 1.820)},
      {min:3.50, max:7.50, formula:(h)=>  409.059 * Math.pow(h+2.060, 1.702)},
    ]
  },
  '1018662': { // 청담대교 (2001-01-01 적용) — 잠수교·반포2교도 준용
    name:'청담대교', source:'공공데이터포털 HQ곡선',
    segments:[
      {min:0.99, max:5.82, formula:(h)=>250.980 * Math.pow(Math.max(0,h-0.005), 2.0584)},
    ]
  },
  '1018683': { // 한강대교 (2018-01-01 적용) — H-ADCP 실측 fw가 있어 검증용
    // ★ 2026-07-24 수정: WAMIS 공식 수위-유량곡선식 대조(영진님 확인, 2010년 환경부 자료 기준)
    //   0.05~3.31m 저수위 구간 곡선이 통째로 빠져있었음. 이 범위는 한강대교 실측 수위
    //   (최근 관측 2.1~2.9m대)가 실제로 항상 걸쳐있는 구간이라, 지금까지 h<3.31일 때
    //   3.31m로 클램핑된 잘못된 값을 써왔음(calcQfromHQ 폴백 경로 한정, 연속방정식은 영향 없음).
    name:'한강대교', source:'공공데이터포털 HQ곡선 + WAMIS 대조(2026-07-24)',
    segments:[
      {min:0.05, max:3.31,  formula:(h)=>378.173 * Math.pow(Math.max(0,h-0.050), 2.331)},
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
  '1018680': { // 잠수교 — ★ 2026-07-24 신규: WAMIS 공식 곡선 확인됨(영진님 확인).
    // 기존엔 "곡선 없음"으로 보고 청담대교 걸 그대로 썼으나, WAMIS에 잠수교 전용
    // 수위-유량곡선식이 있었음. 가장 최신(2000.12 한강홍수통제소 유량측정보고서,
    // 95/98/99/00년 자료 기준) 곡선으로 대체.
    name:'잠수교', source:'WAMIS 수위-유량관계곡선식(2000.12 한강홍수통제소, 확인 2026-07-24)',
    segments:[
      {min:2.50, max:11.71, formula:(h)=>89.920 * Math.pow(Math.max(0,h-0.75), 2.394)},
    ]
  },
};
// 반포2교는 여전히 전용 HQ 곡선을 못 찾아 청담대교 준용
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

// 거리순 정렬 목록 (구간 수면적 적분용) — BRIDGE_GEO가 아래에 정의되므로 지연 평가
let _geoSorted=null;
function geoSorted(){
  if(!_geoSorted){
    _geoSorted=Object.entries(BRIDGE_GEO)
      .filter(([,g])=>g.distJamsilKm!=null && g.widthM!=null)
      .map(([name,g])=>({name, distKm:g.distJamsilKm, widthM:g.widthM}))
      .sort((a,b)=>a.distKm-b.distKm);
  }
  return _geoSorted;
}

// 잠실보 ~ 지정 거리(km)까지의 수면적(m²) — 사다리꼴 적분
// 실측 강폭이 교량마다 다르므로 단순 평균 대신 거리에 따라 적분한다.
function reachSurfaceArea(distKm){
  if(!(distKm>0)) return 0;
  const G=geoSorted();
  let area=0;
  for(let i=0;i<G.length-1;i++){
    const a=G[i], b=G[i+1];
    if(a.distKm>=distKm) break;
    const segEnd=Math.min(b.distKm, distKm);
    const segLen=(segEnd-a.distKm)*1000;              // m
    if(segLen<=0) continue;
    const span=(b.distKm-a.distKm)||1;
    const wEnd=a.widthM+(b.widthM-a.widthM)*((segEnd-a.distKm)/span);
    area += (a.widthM+wEnd)/2 * segLen;               // 사다리꼴
  }
  return area;
}

// ── 연속방정식용 관측소 위치 (잠실보 기준 거리) ───────────────
// 각 관측소가 대표하는 지점의 거리 — 구간별 저류 계산에 사용
const CONT_STATIONS = [
  {code:'1018662', name:'청담대교', distKm:2.5},
  {code:'1018680', name:'잠수교',   distKm:9.5},
  {code:'1018681', name:'반포2교',  distKm:9.5},
  {code:'1018683', name:'한강대교', distKm:13},
  {code:'1019630', name:'행주대교', distKm:29},
];

// 구간별 저류 증가율 계산 (관측소 실측 변화율 사용)
// stationRates: [{distKm, rateCmHr}] — 관측소별 실측 수위 변화율
// 잠실보(0km, 조석 영향 없음 → 변화율 0으로 간주)부터 targetKm까지
// 각 지점의 변화율을 거리 선형보간해 사다리꼴 적분한다.
// → 조석 진폭이 상류로 갈수록 줄어드는 실제 감쇠를 반영 (균일 가정의 과대평가 해소)
function reachStorageRate(targetKm, stationRates){
  if(!(targetKm>0) || !stationRates?.length) return null;
  // 잠실보 지점(0km)은 조석 감쇠 후이므로 변화율 0으로 두고 시작
  const pts=[{distKm:0, rateCmHr:0}, ...stationRates.filter(s=>s.rateCmHr!=null)]
    .sort((a,b)=>a.distKm-b.distKm);
  if(pts.length<2) return null;
  const rateAt=(km)=>{
    if(km<=pts[0].distKm) return pts[0].rateCmHr;
    if(km>=pts[pts.length-1].distKm) return pts[pts.length-1].rateCmHr;
    for(let i=0;i<pts.length-1;i++){
      if(km>=pts[i].distKm && km<=pts[i+1].distKm){
        const f=(km-pts[i].distKm)/((pts[i+1].distKm-pts[i].distKm)||1);
        return pts[i].rateCmHr+(pts[i+1].rateCmHr-pts[i].rateCmHr)*f;
      }
    }
    return pts[pts.length-1].rateCmHr;
  };
  const widthAt=(km)=>{
    const G=geoSorted();
    if(km<=G[0].distKm) return G[0].widthM;
    if(km>=G[G.length-1].distKm) return G[G.length-1].widthM;
    for(let i=0;i<G.length-1;i++){
      if(km>=G[i].distKm && km<=G[i+1].distKm){
        const f=(km-G[i].distKm)/((G[i+1].distKm-G[i].distKm)||1);
        return G[i].widthM+(G[i+1].widthM-G[i].widthM)*f;
      }
    }
    return G[G.length-1].widthM;
  };
  // 0.5km 간격 수치적분: dV/dt = ∫ width(x) · dh/dt(x) dx
  const step=0.5;
  let dVdt=0, area=0;
  for(let km=0; km<targetKm; km+=step){
    const segEnd=Math.min(km+step, targetKm);
    const segLen=(segEnd-km)*1000;
    const wMid=widthAt((km+segEnd)/2);
    const rMid=rateAt((km+segEnd)/2)/100/3600;  // m/s
    dVdt += wMid*segLen*rMid;
    area += wMid*segLen;
  }
  return {dVdt, surfArea:area};
}

// ── 연속방정식(저류법) 유속 ──────────────────────────────────
// 원리: 질량보존. 잠실수중보(상류 경계, 유량=팔당 방류)부터 대상 교량까지를
//       하나의 저류 구간으로 보면
//         저류 증가율 dV/dt = (구간 수면적) × (수위 상승률)
//         Q_교량 = Q_팔당 − dV/dt      ← 음수면 상류 방향(역류)
//         유속   = Q_교량 ÷ 교량 단면적
// 장점: HQ곡선(평상시 수위-유량 관계)과 달리 조석 역류 구간에서도 성립하고,
//       임의 계수가 아닌 물리 법칙에 근거한다.
// 한계: ① 구간 전체의 수위 상승률을 대상 교량 값으로 근사(조석 위상차가
//          서울 구간에서 조석 주기의 약 5% 수준이라 허용 가능한 근사)
//       ② 지천(중랑천·탄천·홍제천 등) 유입 미계측 — 강우 시 오차 증가
//       ③ 하상고·형상계수는 여전히 추정값
function calcContinuityVelocity(b, wl, rateCmHr, damCms, stationRates){
  const geo=BRIDGE_GEO[b.bridge];
  const sec=STATION_SECTIONS[b.code];
  if(!geo || !sec || wl==null || rateCmHr==null || damCms==null) return null;
  if(geo.distJamsilKm==null || !geo.widthM) return null;
  if(!(geo.distJamsilKm>0)) return null;   // 잠실대교=0km는 구간이 없어 계산 불가

  let dVdt, surfArea, method, reliable;
  const multi = stationRates?.length ? reachStorageRate(geo.distJamsilKm, stationRates) : null;
  if(multi){
    // ★ 관측소별 실측 변화율로 구간 적분 — 조석 진폭 감쇠 반영
    dVdt=multi.dVdt; surfArea=multi.surfArea;
    method='관측소 실측 구간적분'; reliable=true;
  } else {
    // 폴백: 구간 전체를 대상 교량 변화율로 근사 (구간이 길수록 과대평가)
    surfArea=reachSurfaceArea(geo.distJamsilKm);
    dVdt=surfArea*(rateCmHr/100/3600);
    method='단일 관측소 근사'; reliable = geo.distJamsilKm<=15;
  }
  const Q = damCms - dVdt;
  // ★ 수심: 해도 실측(방류 200㎥/s 기준 최소 수심) 우선. 없으면 추정 하상고 폴백.
  //   최소 수심을 쓰면 단면적이 작게 나와 유속이 크게 산출됨 → 안전 측 보수적.
  const cd = chartDepthFor(b.bridge, b.code, wl);
  const depth = cd?.main ?? (wl!=null && sec.bedEl!=null ? wl - sec.bedEl : null);
  if(!(depth>0)) return null;
  const depthSrc = cd?.main ? (cd.corrected?`해도 실시간보정(Δh=${cd.deltaH>=0?'+':''}${cd.deltaH}m,${cd.reliability})`:'해도 실측(방류200 기준, 정적)') : '추정 하상고';
  const area = geo.widthM * depth * sec.shape;
  const vel = Q/area;
  // 물리적 타당성 검사: 한강 조석 구간에서 |유속| 2m/s 초과는 비현실적
  if(Math.abs(vel)>2.0) reliable=false;
  return {
    vel:Number(vel.toFixed(2)),
    Q:Math.round(Q),
    dVdt:Math.round(dVdt),
    surfAreaKm2:Number((surfArea/1e6).toFixed(2)),
    sectionArea:Math.round(area),
    reachKm:geo.distJamsilKm,
    depth, depthSrc,
    method, reliable,
    dir: vel<-0.03?'up' : vel>0.03?'down' : 'slack'
  };
}

// width(하폭): ★ Phase 3.6.1 — 현장 실측값으로 교체
//   [수정 이유] 기존 값은 "HRFCO 수문조사연보 문헌 기반 추정"이었으나 현장 실측 대비
//   28~70% 과소평가되어 있었다(단면적이 작게 계산되어 유속이 과대평가됨).
//   [현재 값] 현장 실측 강폭 기준.
//     청담대교 790 / 잠수교 760(반포대교 하단) / 반포2교 760 / 행주대교 730
//     한강대교 625 = 남단~노들섬 350 + 북단~노들섬 275 (노들섬이 하도를 분할)
//   [미검증] 광진교(1018640)는 실측 미확보 — 잠실대교(860m) 인접 구간 참고 잠정값.
// bedEl(하상고)·shape(형상계수)는 여전히 추정값 — 단면적 오차 요인으로 남아 있음.
const STATION_SECTIONS = {
  '1018640': {name:'광진교',   width:800, bedEl:-1.5, shape:0.65, widthSrc:'잠정(실측 미확보)'},
  '1018662': {name:'청담대교', width:790, bedEl:-1.8, shape:0.65, widthSrc:'현장 실측'},
  '1018680': {name:'잠수교',   width:760, bedEl:-1.5, shape:0.65, widthSrc:'현장 실측(반포대교 하단)'},
  '1018681': {name:'반포2교',  width:760, bedEl:-1.4, shape:0.65, widthSrc:'현장 실측 준용(반포대교)'},
  '1018683': {name:'한강대교', width:625, bedEl:-1.5, shape:0.65, widthSrc:'현장 실측(350+275, 노들섬 분할)'},
  '1019630': {name:'행주대교', width:730, bedEl:-1.2, shape:0.65, widthSrc:'현장 실측'},
};

// ── 유속 계산 (우선순위) ─────────────────────────────────────
// 1순위: fw 실측유량 ÷ 단면적
// 2순위: HQ 곡선(공식) ÷ 단면적  ← 신규 추가
// 3순위: 방류량 기반 추정 ÷ 단면적
function calcVelocity(fw, wl, stationCode, bridgeName){
  const sec = STATION_SECTIONS[stationCode];
  if(!sec || wl === null) return null;
  // ★ 해도 실측 수심(방류 200㎥/s 기준) 우선 — 기존 `wl − 하상고`는 전제가 틀렸음
  const cd = bridgeName ? chartDepthFor(bridgeName, stationCode, wl) : null;
  const depth = cd?.main ?? (wl - sec.bedEl);
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

// ── 정조(Slack Water) 판정 ───────────────────────────────────
// 정조 = 조석 흐름이 방향을 바꾸는 순간 = 교량 수위가 극값(만조/간조)에
//        도달해 변화율이 0에 가까워지는 시점. 이때 유속이 가장 약해
//        수색 진입에 상대적으로 안전한 구간.
// 원칙: 실측 수위 변화율 기반. 조석 구간(tide:true)에서만 의미 있음.
const SLACK_RATE_THRESHOLD = 4;    // ★ 2026-07-21 수정: 15→4cm/h. directionLabel의 실측
                                    // 캘리브레이션 기준(FLOW_RATE_SLACK=4)과 불일치했던 값.
                                    // 15cm/h(20분 창 기준 약 5cm 변화)는 한강에서 급조기가
                                    // 아니면 거의 항상 밑도는 수준이라, 대부분의 조회가
                                    // 실제 흐름과 무관하게 무조건 '정조'로 나오는 원인이었음.
const SLACK_NEAR_MINUTES   = 40;   // 다음 극값까지 40분 이내 → 정조 임박

// waterPts: 교량 실측 수위 포인트 [{time,value}] (시간 오름차순)
// nowTime: 기준 시각 / rateCmHr: 현재 수위 변화율(cm/h)
// 반환: {state, nextSlackTime, minutesToSlack, slackType} 또는 null
function calcSlackWater(waterPts, nowTime, rateCmHr){
  if(!Array.isArray(waterPts) || waterPts.length<3) return null;
  const pts=[...waterPts].sort((a,b)=>a.time-b.time);
  // 현재 시각 이후 첫 극값(봉우리/저점) 탐색 = 다음 정조
  let nextExtreme=null;
  for(let i=1;i<pts.length-1;i++){
    if(pts[i].time <= nowTime) continue;
    const sb=Math.sign(pts[i].value-pts[i-1].value);
    const sa=Math.sign(pts[i+1].value-pts[i].value);
    if(sb!==0 && sa!==0 && sa!==sb){
      nextExtreme={type: sb>0?'고조(만조) 정조':'저조(간조) 정조', time:pts[i].time, value:pts[i].value};
      break;
    }
  }
  const absRate = (rateCmHr!==null && rateCmHr!==undefined) ? Math.abs(rateCmHr) : null;
  // ★ 변화율을 못 구했으면 정조라고 단정하지 않는다 (가짜 정조 방지)
  const atSlackNow = absRate!==null && absRate < SLACK_RATE_THRESHOLD;
  let minutesToSlack=null;
  if(nextExtreme) minutesToSlack=Math.round((nextExtreme.time - nowTime)/60000);

  let state;
  if(atSlackNow) state='정조 부근 (유속 최소)';
  else if(minutesToSlack!==null && minutesToSlack<=SLACK_NEAR_MINUTES) state='정조 임박';
  else if(rateCmHr!==null && rateCmHr>0) state='창조(밀물) 진행 — 유속 증가/역류 성분';
  else if(rateCmHr!==null && rateCmHr<0) state='낙조(썰물) 진행 — 하류 유속 강화';
  else state='판단 자료 부족';

  return {
    state,
    atSlackNow,
    nextSlackTime: nextExtreme?nextExtreme.time:null,
    nextSlackType: nextExtreme?nextExtreme.type:null,
    minutesToSlack,
    rateCmHr
  };
}

// ── 조석 역류 반영 유속 (방향 신뢰 · 크기 참고) ─────────────────
// 지금까지 유속은 항상 하류(양수)로만 계산됨. 밀물 역류 시 실제로는
// 상류(음수) 흐름이 발생하므로, 신곡보 역류 판정 + 수위 변화율로 방향을 보정한다.
// 원칙:
//  - 방향(부호): 신곡보 owl-swl 역류 판정 + 교량 수위 상승/하강으로 결정 → 신뢰도 중~높음
//  - 크기: HQ곡선 또는 수위변화율 경험식 → 신뢰도 낮음(참고용)
// 반환: {signedVel, absVel, dir, dirLabel, note} 또는 null
function applyReverseFlow(hqVel, tideActive, rateCmHr, slackState, damRise, cont){
  const absHq = hqVel!=null ? Math.abs(hqVel) : null;

  const damSurging = damRise!=null && damRise >= 100; // 방류 급증(㎥/s/h)

  // ★ 2026-07-24 수정: "수위 변화율≈0 → 정조" 사전판정을 최상위에서 제거함.
  //   이 가정은 저유량·조석지배 상황에서만 유효함 — 고유량(홍수) 상황에서는
  //   유입=유출 균형(steady state)이라 수위는 안 변해도 실제 유속은 매우 클 수 있음
  //   (HQ곡선 기울기가 고유량 구간에서 평평해지기 때문). 실측 사례: 방류
  //   3,358㎥/s(기준 200의 17배)에서 수위변화 -4cm/h로 "정조" 오판정 발생.
  //   연속방정식(cont)은 유량(Q) 자체로 정조를 판정하므로(Math.abs(Q/area)<0.03m/s)
  //   방류량 크기와 무관하게 정확함 — 그래서 cont가 있으면 항상 cont를 우선한다.
  // ★ 1순위: 연속방정식(질량보존) — 조석 역류 구간에서도 성립
  if(cont){
    const v=cont.vel, a=Math.abs(v);
    const detail=`구간 ${cont.reachKm}km·수면적 ${cont.surfAreaKm2}km² · 저류 ${cont.dVdt>0?'+':''}${cont.dVdt}㎥/s · 통과유량 ${cont.Q}㎥/s`;
    if(cont.dir==='up'){
      return {signedVel:-a, absVel:a, dir:'up', dirLabel:'상류향 역류',
              src:'연속방정식(저류법)',
              note:`밀물 역류 — ${detail}${damSurging?' ⚠ 방류 급증 동반, 오차 증가':''}`};
    }
    if(cont.dir==='slack'){
      return {signedVel:0, absVel:0, dir:'slack', dirLabel:'정조(유속 최소)',
              src:'연속방정식(저류법)', note:`통과유량 ≈0 — ${detail}`};
    }
    return {signedVel:a, absVel:a, dir:'down', dirLabel:'하류향',
            src:'연속방정식(저류법)', note:`하류 흐름 — ${detail}`};
  }

  // 2순위(연속방정식 불가 시): 수위 변화율 기반 정조 판정 + 실측 변화율 방향 + 경험식 크기
  //   ⚠ 이 경로는 저유량·조석지배 상황을 전제로 한 근사이며, 고유량 상황에선 부정확할 수 있음
  if(slackState && slackState.atSlackNow){
    return {signedVel:0, absVel:0, dir:'slack', dirLabel:'정조(유속 최소)',
            src:'실측 변화율≈0(연속방정식 불가, 저유량 가정)',
            note:'정조 부근 — 방향 전환 중, 곧 반대 흐름 강화 가능. ⚠ 고유량 상황이면 부정확할 수 있음'};
  }
  if(hqVel==null) return null;
  const rate = rateCmHr;
  const risingFast = rate!=null && rate >= FLOW_RATE_WEAK;
  const fallingFast= rate!=null && rate <= -FLOW_RATE_WEAK;
  if(risingFast && !damSurging){
    const gateBoost = tideActive===true?0.05 : tideActive==='weak'?0.02 : 0;
    const mag = Math.max(Math.abs(rate)/100*0.15 + gateBoost, 0.05);
    return {signedVel:-Number(mag.toFixed(2)), absVel:Number(mag.toFixed(2)), dir:'up',
            dirLabel:'상류향 역류', src:'경험식(미검증)',
            note:`실측 수위 +${rate}cm/h 상승 — 밀물 유입. 방향만 신뢰, 크기는 미검증 추정`};
  }
  if(risingFast && damSurging){
    return {signedVel:absHq, absVel:absHq, dir:'mixed', dirLabel:'혼합·불확실', src:'판단 보류',
            note:`수위 상승(+${rate}cm/h) 중이나 방류 급증(+${Math.round(damRise)}㎥/s/h) 동반 — 현장 확인 필수`};
  }
  if(fallingFast){
    return {signedVel:absHq, absVel:absHq, dir:'down', dirLabel:'하류향 (낙조)', src:'HQ곡선',
            note:`실측 수위 ${rate}cm/h 하강 — 하류 흐름, 크기는 HQ곡선 참고`};
  }
  return {signedVel:absHq, absVel:absHq, dir:'down', dirLabel:'하류향', src:'HQ곡선',
          note:'뚜렷한 수위 변화 없음 — 하류 흐름 추정'};
}

// 유속 단계 판정 (수색 참고용)
function velocityLabel(vel){
  if(vel === null) return null;
  if(vel < 0) return {label:'역류 가능', cls:'tide-in', note:'밀물 또는 조석 역류 구간'};
  if(vel < 0.3) return {label:'완만', cls:'flow-na', note:`${vel.toFixed(2)}m/s (${(vel*3.6).toFixed(1)}km/h) · 조류 영향시 역류 가능`};
  if(vel < 0.8) return {label:'보통', cls:'flow-out', note:`${vel.toFixed(2)}m/s (${(vel*3.6).toFixed(1)}km/h) · 이동 영향 있음`};
  if(vel < 1.5) return {label:'빠름', cls:'bad', note:`${vel.toFixed(2)}m/s (${(vel*3.6).toFixed(1)}km/h) · 익수자 이동 영향 큼`};
  return {label:'매우 빠름', cls:'bad', note:`${vel.toFixed(2)}m/s (${(vel*3.6).toFixed(1)}km/h) · 홍수기 수준`};
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
const SINGOK_WEAK_THRESHOLD    = -0.5;   // ★ 2026-07-21 보수적 조정: -0.3→-0.5.
                                          // 기존 -0.3m는 근거·검증 기록이 없던 임의값이었음.
                                          // 범위를 넓혀(더 많은 경우를 '약한 영향'으로 분류)
                                          // '차단(영향 미미)' 확정 조건을 더 엄격하게 만듦 —
                                          // 안전 우선(과소평가보다 과대평가가 낫다는 원칙).
                                          // owl - swl > -0.5: 역류 가능성 (약한 영향)
// owl - swl <= -0.5: 정상 하류 흐름 (영향 미미)
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
let LAST_QUERY_CTX = null; // ★ 2026-07-21: 물때표(예측) 기능용 — 마지막 조회의 b/currentState/키 저장

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
  // lat/lng: 실측 GPS (Google Maps 검증)
  // distFromSeaKm / distFromPaldangKm: 기존 문헌 추정값
  // ★ distJamsilKm / widthM: 현장 실측값 (2026-07-16 추가)
  //   distJamsilKm — 잠실수중보(≈잠실대교) 기준 하류 하천거리 (km)
  //   widthM       — 강폭 (m). 하도가 섬으로 갈리면 합산.
  //   비조석 구간(잠실보 상류)은 연속방정식 대상이 아니므로 미기입.
  '강동대교':    {lat:37.5584, lng:127.1777, distFromSeaKm:67.0, distFromPaldangKm:14.0},
  '구리암사대교':{lat:37.5677, lng:127.1493, distFromSeaKm:65.0, distFromPaldangKm:16.0},
  '천호대교':    {lat:37.5437, lng:127.1232, distFromSeaKm:63.0, distFromPaldangKm:19.5},
  '광진교':      {lat:37.5391, lng:127.1062, distFromSeaKm:60.5, distFromPaldangKm:22.0},
  '올림픽대교':  {lat:37.5227, lng:127.0829, distFromSeaKm:57.5, distFromPaldangKm:25.0},
  '잠실철교':    {lat:37.5145, lng:127.0756, distFromSeaKm:56.5, distFromPaldangKm:25.5},
  '잠실대교':    {lat:37.5093, lng:127.0701, distFromSeaKm:55.5, distFromPaldangKm:26.5, distJamsilKm:0,    widthM:860},
  '청담대교':    {lat:37.5192, lng:127.0521, distFromSeaKm:53.5, distFromPaldangKm:28.5, distJamsilKm:2.5,  widthM:790},
  '영동대교':    {lat:37.5246, lng:127.0437, distFromSeaKm:52.5, distFromPaldangKm:29.5, distJamsilKm:3.2,  widthM:680},
  '성수대교':    {lat:37.5310, lng:127.0204, distFromSeaKm:50.0, distFromPaldangKm:32.0, distJamsilKm:5.3,  widthM:650},
  '동호대교':    {lat:37.5349, lng:127.0072, distFromSeaKm:48.5, distFromPaldangKm:33.5, distJamsilKm:6.4,  widthM:910},
  '한남대교':    {lat:37.5282, lng:126.9970, distFromSeaKm:47.0, distFromPaldangKm:35.0, distJamsilKm:7.6,  widthM:620},
  '잠수교':      {lat:37.5121, lng:126.9952, distFromSeaKm:45.5, distFromPaldangKm:36.5, distJamsilKm:9.5,  widthM:760},
  '반포대교':    {lat:37.5107, lng:126.9972, distFromSeaKm:45.0, distFromPaldangKm:37.0, distJamsilKm:9.5,  widthM:760},
  '동작대교':    {lat:37.5064, lng:126.9818, distFromSeaKm:43.0, distFromPaldangKm:39.0, distJamsilKm:11,   widthM:940},
  // ★ 한강대교(13km)가 한강철교(14km)보다 상류 — 기존 코드는 역순이었음(경도로 검증)
  '한강대교':    {lat:37.5178, lng:126.9698, distFromSeaKm:42.0, distFromPaldangKm:40.0, distJamsilKm:13,   widthM:625},
  '한강철교':    {lat:37.5183, lng:126.9695, distFromSeaKm:41.5, distFromPaldangKm:40.5, distJamsilKm:14,   widthM:760},
  '원효대교':    {lat:37.5267, lng:126.9538, distFromSeaKm:40.0, distFromPaldangKm:42.0, distJamsilKm:15,   widthM:1000},
  '마포대교':    {lat:37.5313, lng:126.9406, distFromSeaKm:38.5, distFromPaldangKm:43.5, distJamsilKm:16,   widthM:1000},
  '서강대교':    {lat:37.5410, lng:126.9281, distFromSeaKm:37.5, distFromPaldangKm:44.5, distJamsilKm:17,   widthM:850},
  '당산철교':    {lat:37.5358, lng:126.9022, distFromSeaKm:35.0, distFromPaldangKm:47.0, distJamsilKm:18.5, widthM:830},
  '양화대교':    {lat:37.5424, lng:126.8997, distFromSeaKm:34.5, distFromPaldangKm:47.5, distJamsilKm:19,   widthM:850},
  '성산대교':    {lat:37.5594, lng:126.8849, distFromSeaKm:33.5, distFromPaldangKm:48.5, distJamsilKm:20.5, widthM:950},
  '월드컵대교':  {lat:37.5677, lng:126.8829, distFromSeaKm:33.0, distFromPaldangKm:49.0, distJamsilKm:21,   widthM:1000},
  '가양대교':    {lat:37.5718, lng:126.8637, distFromSeaKm:31.5, distFromPaldangKm:50.5, distJamsilKm:23.7, widthM:900},
  '마곡대교':    {lat:37.5740, lng:126.8450, distFromSeaKm:30.0, distFromPaldangKm:52.0, distJamsilKm:26,   widthM:1000},
  '방화대교':    {lat:37.5795, lng:126.8234, distFromSeaKm:28.0, distFromPaldangKm:54.0, distJamsilKm:27.5, widthM:1000},
  '행주대교':    {lat:37.5908, lng:126.8068, distFromSeaKm:26.0, distFromPaldangKm:56.0, distJamsilKm:29,   widthM:730},
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
//
// offset: 인천 기준 조석 지연 분 — ★ Phase 3.6.1 실측 기반 전면 수정
//   [수정 이유] 기존 값(53~85분)은 "조석파 전파속도 12m/s" 가정으로 계산된 값이었으나,
//   12m/s는 깊은 외해의 천해파 속도이며 한강 하구(얕고 좁으며 신곡수중보로 차단됨)에는
//   적용할 수 없다. 조석 시차 로그 실측 결과 실제 전파속도는 약 2.2m/s 수준으로,
//   기존 값은 실제의 약 1/4에 불과했다(예: 한강대교 실측 250~270분 vs 기존 65분).
//   [현재 값] 2026-07-14~15 조석 시차 로그 실측치를 기준점으로 삼고, 관측소가 없는
//   교량은 하류→상류 순서에 맞춰 보간. 저방류(약 280㎥/s) 조건 기준.
//   실측 기준점: 행주대교 250 / 한강대교 270 / 잠수교 270 / 청담대교 270~290
//   [한계] 표본이 적고(관측소당 4~5건) 모두 사리 기간이며, 방류량에 따라 크게 변한다
//   (고방류 1700~1900㎥/s에서 20~60분 짧아짐). 여전히 잠정값이며 참고용이다.
//
// releaseLag: 팔당→교량 방류 지연 분 — ★ Phase 3.6.1 순서 오류 수정
//   [수정 이유] 기존 값은 상류(강동대교 330분)가 하류(행주대교 260분)보다 큰,
//   물리적으로 불가능한 역순이었다. 팔당댐 물은 강동대교를 먼저, 행주대교를 나중에
//   지나므로 하류로 갈수록 지연이 커져야 한다. 하류로 갈수록 증가하도록 순서를 바로잡았다.
//   [한계] 절대값은 여전히 미검증 경험 추정치이며, 방류량이 클수록 홍수파가 빨라져
//   실제로는 유량에 따라 변한다(고정 상수로는 부정확). 방류 시차 로그로 실측 검증 필요.
const BRIDGES = [
  // ─── 잠실수중보 상류 (조석 완전 제외) ───────────────────────
  {bridge:'강동대교',    zone:'수중보 상류',       station:'서울시(광진교)',   code:'1018640', tide:false, tideRealtime:false, offset:null, releaseLag:260},
  {bridge:'구리암사대교',zone:'수중보 상류',        station:'서울시(광진교)',   code:'1018640', tide:false, tideRealtime:false, offset:null, releaseLag:262},
  {bridge:'천호대교',    zone:'수중보 상류',       station:'서울시(광진교)',   code:'1018640', tide:false, tideRealtime:false, offset:null, releaseLag:265},
  {bridge:'광진교',      zone:'수중보 상류',       station:'서울시(광진교)',   code:'1018640', tide:false, tideRealtime:false, offset:null, releaseLag:266},
  {bridge:'올림픽대교',  zone:'수중보 상류',       station:'서울시(광진교)',   code:'1018640', tide:false, tideRealtime:false, offset:null, releaseLag:268},
  {bridge:'잠실철교',    zone:'잠실수중보 상류',    station:'서울시(청담대교)', code:'1018662', tide:false, tideRealtime:false, offset:null, releaseLag:270},
  // ─── 잠실수중보 하류 (신곡수중보 swl 실시간 판단) ─────────────
  {bridge:'잠실대교',    zone:'수중보 하류(상)',    station:'서울시(청담대교)', code:'1018662', tide:true, tideRealtime:true, offset:282, releaseLag:272},
  {bridge:'청담대교',    zone:'중상류',            station:'서울시(청담대교)', code:'1018662', tide:true, tideRealtime:true, offset:280, releaseLag:274},
  {bridge:'영동대교',    zone:'중상류',            station:'서울시(청담대교)', code:'1018662', tide:true, tideRealtime:true, offset:278, releaseLag:276},
  {bridge:'성수대교',    zone:'중상류',            station:'서울시(청담대교)', code:'1018662', tide:true, tideRealtime:true, offset:277, releaseLag:280},
  {bridge:'동호대교',    zone:'중류',              station:'서울시(잠수교)',   code:'1018680', tide:true, tideRealtime:true, offset:275, releaseLag:284},
  {bridge:'한남대교',    zone:'중류',              station:'서울시(잠수교)',   code:'1018680', tide:true, tideRealtime:true, offset:274, releaseLag:286},
  {bridge:'잠수교',      zone:'중류',              station:'서울시(잠수교)',   code:'1018680', tide:true, tideRealtime:true, offset:272, releaseLag:290},
  {bridge:'반포대교',    zone:'중류',              station:'서울시(반포2교)',  code:'1018681', tide:true, tideRealtime:true, offset:272, releaseLag:290},
  {bridge:'동작대교',    zone:'중류',              station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:271, releaseLag:294},
  {bridge:'한강철교',    zone:'중류',              station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:270, releaseLag:296},
  {bridge:'한강대교',    zone:'중류',              station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:270, releaseLag:300},
  {bridge:'원효대교',    zone:'중류',              station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:268, releaseLag:302},
  {bridge:'마포대교',    zone:'중류',              station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:266, releaseLag:305},
  {bridge:'서강대교',    zone:'중류',              station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:265, releaseLag:308},
  {bridge:'당산철교',    zone:'중류',              station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:264, releaseLag:312},
  {bridge:'양화대교',    zone:'중하류',            station:'서울시(한강대교)', code:'1018683', tide:true, tideRealtime:true, offset:262, releaseLag:314},
  {bridge:'성산대교',    zone:'하류 조석',         station:'서울시(행주대교)', code:'1019630', tide:true, tideRealtime:true, offset:259, releaseLag:316},
  {bridge:'월드컵대교',  zone:'하류 조석',         station:'서울시(행주대교)', code:'1019630', tide:true, tideRealtime:true, offset:257, releaseLag:318},
  {bridge:'가양대교',    zone:'하류 조석',         station:'서울시(행주대교)', code:'1019630', tide:true, tideRealtime:true, offset:255, releaseLag:322},
  {bridge:'마곡대교',    zone:'하류 조석',         station:'서울시(행주대교)', code:'1019630', tide:true, tideRealtime:true, offset:253, releaseLag:325},
  {bridge:'방화대교',    zone:'하류 조석',         station:'서울시(행주대교)', code:'1019630', tide:true, tideRealtime:true, offset:252, releaseLag:328},
  {bridge:'행주대교',    zone:'하류 조석',         station:'서울시(행주대교)', code:'1019630', tide:true, tideRealtime:true, offset:250, releaseLag:330},
];

// ★ 2026-07-24 신규: 만조/간조 offset 분리
// ─────────────────────────────────────────────────────────────
// [발견 근거] 조석 시차 로그 42건 분석(영진님 CSV 제공) 결과, 기존 offset 공식은
//   만조 데이터로는 잘 맞지만(평균오차 -8분, 표준편차 32분) 간조엔 전혀 안 맞음
//   (평균오차 -62분, 표준편차 104분) — 즉 만조와 간조는 서로 다른 속도로 전파된다.
// [방법] 관측소별 (간조 관측평균 − 만조 관측평균) 델타를 구해서, 기존 offset(만조 기준으로
//   검증된 값)에 이 델타를 더해 간조용 offset을 만든다. 회귀식의 거리·방류량 계수는
//   부호가 물리적으로 말이 안 되는 경우가 있어(표본 부족) 채택하지 않았다 — 대신 이미
//   검증된 거리-감쇠 구조(기존 offset)에 관측소별 상수 보정만 얹는 보수적 방법을 썼다.
// [표본] 청담대교 n=3, 잠수교 n=4, 한강대교 n=6 — 전부 표본 적음, 참고용.
//   행주대교는 n=1이고 부호까지 반대라 신뢰 불가 → 미적용. 반포2교는 데이터 자체 없음 → 미적용.
const STATION_LOWTIDE_DELTA = {
  '1018662': {delta:-71,   n:3, note:'청담대교: 간조 187분(n=3) vs 만조 258분(n=4)'},
  '1018680': {delta:-27.5, n:4, note:'잠수교: 간조 228분(n=4) vs 만조 255분(n=8)'},
  '1018683': {delta:-62,   n:6, note:'한강대교: 간조 207분(n=6) vs 만조 269분(n=10)'},
  // '1019630' 행주대교, '1018681' 반포2교: 표본 부족/모순으로 미적용(기존 단일 offset 유지)
};
// 교량의 만조용/간조용 offset을 반환. tideType이 없거나 델타 자료가 없으면 기존 offset 그대로.
function offsetForTideType(b, tideType){
  const base = b.offset||0;
  if(tideType!=='간조') return base;
  const d = STATION_LOWTIDE_DELTA[b.code];
  return d ? base + d.delta : base;
}

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
// 수위차 > -0.5 : 역류 가능성 → 조석 약한 영향
// 수위차 ≤ -0.5 : 정상 하류 흐름 → 조석 영향 미미
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
function mdhhmm(d){ return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${hhmm(d)}`; }
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
// 변화 추세 계산
// ★ Phase 3.6.3 버그 수정: '가짜 정조(0cm/h)' 문제
//   [증상] 조회시각이 최신 관측시각보다 뒤일 때(HRFCO 지연 등) '지금'과
//          'N분 전' 조회가 둘 다 같은 최신 관측점으로 수렴 → 변화량 항상 0
//          → 실제로는 물이 움직이는데 '정조·유속 0'으로 잘못 표시됨.
//   [수정] ① 기준시각을 최신 관측시각으로 당겨서(clamp) 실제 최근 구간으로 계산
//          ② 그래도 두 관측점 간격이 요청 구간의 절반 미만이면 산출 불가(null)
//          ③ 변화율 정규화는 요청 구간이 아닌 '실제 간격'으로 계산
function latestRowTime(rows,valueKeys){
  let t=null;
  for(const row of rows){ const rt=parseObsTime(row); if(!rt||val(row,valueKeys)===null) continue; if(!t||rt>t) t=rt; }
  return t;
}
function trend(rows,target,valueKeys,minutes=60){
  if(!rows?.length) return null;
  // ① 조회시각이 최신 관측보다 뒤면 최신 관측시각 기준으로 계산
  const latest=latestRowTime(rows,valueKeys);
  const anchor=(latest && target>latest) ? latest : target;
  const now=nearest(rows,anchor,valueKeys,MAX_NEAREST_MIN);
  const past=nearest(rows,new Date(anchor.getTime()-minutes*60000),valueKeys,MAX_NEAREST_MIN);
  if(!now||!past||now.stale||past.stale)return null;
  const actualMin=(now.time-past.time)/60000;
  // ② 같은 점(0분)이거나 간격이 너무 짧으면 변화율을 신뢰할 수 없음
  if(actualMin < minutes*0.5) return null;
  return{now,past,delta:Number((now.value-past.value).toFixed(2)),minutes:actualMin,requestedMin:minutes,
         anchoredToLatest:anchor!==target};
}
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

// ══════════════════════════════════════════════════════════════
// ★ 2026-07-21 신규: 물때표 (교량별 방류·조석 예측 타임테이블)
// ══════════════════════════════════════════════════════════════
// [신뢰도가 항목별로 다름 — 반드시 라벨링해서 표시]
// - 조석 시각(고조/저조): KHOA 예보 + 검증된 offset 사용 → 신뢰도 비교적 높음
// - 방향·유속: 팔당댐 방류량이 "지금 값 그대로 유지"된다는 가정 위에서만 계산됨.
//   방류량 예보 API 자체가 없어 미래 방류량은 원천적으로 알 수 없음 → 방류량이
//   실제로 바뀌는 순간 이 값은 바로 틀려짐. 반드시 "참고용" 라벨과 함께 표시.
// - 실측 단기 변화율(20분 cm/h) 대신 조석 예보곡선의 기울기(tideAt().rateCmHr)를
//   대리 신호로 사용 — 실시간 판정(정조 임계값 4cm/h 등)과 동일 기준 재사용.
function buildTideTable(b, currentState, futureTideRows, hours=12, stepMin=60){
  if(!b || !b.tide) return null; // 조석 제외 구간(잠실보 상류)은 물때표 의미 없음
  if(!futureTideRows || !futureTideRows.length) return null;
  const damCms = currentState?.damImpact?.value ?? null;
  const wlNow  = currentState?.water?.value ?? null;
  const now = new Date();
  const n = Math.max(1, Math.floor(hours*60/stepMin));
  const rows=[];
  for(let i=0;i<=n;i++){
    const t = new Date(now.getTime() + i*stepMin*60000);
    let ta = tideAt(futureTideRows, t, b.offset||0);
    if(ta && ta.phase && ta.phase.includes('썰물')){
      const lowOffset = offsetForTideType(b,'간조');
      if(lowOffset !== (b.offset||0)){
        const taLow = tideAt(futureTideRows, t, lowOffset);
        if(taLow) ta = taLow;
      }
    }
    const rateCmHr = ta?.rateCmHr ?? null;
    let cont=null, flowDir=null;
    if(rateCmHr!=null && damCms!=null && wlNow!=null){
      cont = calcContinuityVelocity(b, wlNow, rateCmHr, damCms, null); // 관측소 실측 없이 단일근사만(미래라 당연)
      const slackState = { atSlackNow: Math.abs(rateCmHr) < SLACK_RATE_THRESHOLD };
      flowDir = applyReverseFlow(null, true, rateCmHr, slackState, null, cont);
    }
    rows.push({ t, phase: ta?.phase ?? '?', tideVal: ta?.best?.value ?? null, rateCmHr, flowDir });
  }
  return rows;
}

function renderTideTableRows(rows, offsetMin){
  if(!rows || !rows.length) return '<p class="muted small">데이터 없음</p>';
  const trs = rows.map(r=>{
    const timeTxt = hhmm(r.t);
    const tideTxt = r.tideVal!=null ? `${r.phase} (${r.tideVal.toFixed(0)}cm)` : '조회 실패';
    let dirTxt='—', dirColor='var(--muted)';
    if(r.flowDir){
      if(r.flowDir.dir==='slack'){ dirTxt='⏸ 정조'; dirColor='#0ea56b'; }
      else if(r.flowDir.dir==='up'){ dirTxt=`↑상류 ${r.flowDir.absVel.toFixed(2)}m/s`; dirColor='#3b82f6'; }
      else if(r.flowDir.dir==='down'){ dirTxt=`↓하류 ${r.flowDir.absVel.toFixed(2)}m/s`; dirColor='#f59e0b'; }
      else { dirTxt='혼합/불확실'; dirColor='#b7791f'; }
    }
    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:5px 6px;font-size:12px;white-space:nowrap">${timeTxt}</td>
      <td style="padding:5px 6px;font-size:12px">${tideTxt}</td>
      <td style="padding:5px 6px;font-size:12px;font-weight:700;color:${dirColor}">${dirTxt}</td>
    </tr>`;
  }).join('');
  return `<table style="width:100%;border-collapse:collapse">
    <thead><tr style="border-bottom:1px solid var(--border)">
      <th style="text-align:left;font-size:11px;color:var(--muted);padding:4px 6px">시각(교량 도달추정)</th>
      <th style="text-align:left;font-size:11px;color:var(--muted);padding:4px 6px">조석(인천+${offsetMin}분, 신뢰도 높음)</th>
      <th style="text-align:left;font-size:11px;color:var(--muted);padding:4px 6px">방향·유속(추정, 참고용)</th>
    </tr></thead>
    <tbody>${trs}</tbody>
  </table>`;
}

async function renderTideTable(){
  const el=$('tideTablePanel'); if(!el) return;
  if(!LAST_QUERY_CTX){ el.innerHTML='<p class="muted small">먼저 위에서 환경 조회를 1회 실행한 뒤 열어주세요 (교량·방류량 정보 필요).</p>'; return; }
  const {b, currentState, tideKey} = LAST_QUERY_CTX;
  if(!b.tide){ el.innerHTML='<p class="muted small">이 교량은 잠실수중보 상류(조석 제외 구간)라 물때표가 의미 없습니다.</p>'; return; }
  if(!tideKey){ el.innerHTML='<p class="muted small">조석 API 키가 필요합니다 (위 API 키 설정에서 입력).</p>'; return; }
  el.innerHTML='<p class="muted small">예측 조회 중...</p>';
  try{
    const now=new Date();
    const future=new Date(now.getTime()+13*3600000);
    const futureTideRows = await getTideRowsRange(tideKey, now, future);
    const rows = buildTideTable(b, currentState, futureTideRows, 12, 60);
    if(!rows){ el.innerHTML='<p class="muted small">예측 데이터를 만들 수 없습니다 (조석 조회 실패 또는 조회 이력 없음).</p>'; return; }
    const damCms = currentState?.damImpact?.value ?? null;
    el.innerHTML = `
      <div style="background:#1a1405;border:1px solid #b7791f;border-radius:8px;padding:10px;margin-bottom:8px;font-size:12px;line-height:1.6">
        ⚠ <b>가정 기반 예측입니다</b> — 팔당댐 방류량을 지금 값(${damCms!=null?Math.round(damCms)+'㎥/s':'조회 안됨'})으로
        고정한 채, 인천 조석 예보(KHOA)에 이 교량 offset(${b.offset||0}분)만 더해 추정한 표입니다.<br>
        <b>조석 시각(고조·저조)</b>은 신뢰도가 비교적 높지만, <b>방향·유속</b>은 방류량이 실제로 바뀌면
        바로 틀려지는 참고용 수치입니다 — 절대 단독 판단 근거로 쓰지 마세요.
      </div>
      ${renderTideTableRows(rows, b.offset||0)}
    `;
  }catch(e){
    el.innerHTML = `<p class="muted small">예측 조회 실패: ${e.message}</p>`;
    log('[물때표 오류]', e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// ★ Phase 3.6.0: 조석 시차 로그 (인천 ↔ 신곡보 극값 자동 매칭·누적)
// ══════════════════════════════════════════════════════════════
// 목적: 고정 offset을 쓰지 않고, 조회할 때마다 실측 극값 쌍을 자동으로
//       찾아 localStorage에 누적 → 추후 방류량/사리조금별 시차 패턴 분석용
// 원칙: 이 로그는 참고·분석용이며, 실시간 조석 판정(swl/owl 기반)에는
//       어떠한 영향도 주지 않는다 (판정 로직과 완전 분리)
const TIDE_LAG_LOG_KEY = 'tideLagLog';
const TIDE_LAG_MAX_ENTRIES = 500;
const TIDE_LAG_MAX_WINDOW_MIN = 360; // 인천 극값 후 6시간 이내 극값만 매칭 인정
const TIDE_LAG_MIN_WINDOW_MIN = 60;  // 60분 미만 시차는 물리적으로 불가 → 오탐으로 제외
const EXTREMA_EDGE_MARGIN_MIN = 30;  // 시계열 양 끝 30분 이내 극값은 잘린 봉우리일 수 있어 제외

// 시계열에서 완결된 극값(피크·저점)을 전부 스캔
// minProminence: 직전 극값 대비 이 값(m) 이상 오르내린 극값만 인정 (노이즈 오탐 억제)
// 추가: 시계열 양 끝(EXTREMA_EDGE_MARGIN_MIN) 이내 극값은 구간이 잘려 생긴 가짜일 수
//       있으므로 제외 → 조회 구간 끝자락에서 시차 10분 같은 비물리적 값이 생기는 것 방지
function findAllExtrema(items, minProminence=0.15){
  const raw=[];
  if(!Array.isArray(items) || items.length<3) return raw;
  const tStart=items[0].time.getTime();
  const tEnd=items[items.length-1].time.getTime();
  const marginMs=EXTREMA_EDGE_MARGIN_MIN*60000;
  let prevSign=0;
  for(let i=1;i<items.length-1;i++){
    const signBefore=Math.sign(items[i].value-items[i-1].value);
    const signAfter=Math.sign(items[i+1].value-items[i].value);
    if(signBefore!==0) prevSign=signBefore;
    if(prevSign!==0 && signAfter!==0 && signAfter!==prevSign){
      const t=items[i].time.getTime();
      // 구간 가장자리 극값 제외 (잘린 봉우리 오탐 방지)
      if(t-tStart < marginMs || tEnd-t < marginMs){ prevSign=signAfter; continue; }
      raw.push({type:prevSign>0?'high':'low', time:items[i].time, value:items[i].value});
      prevSign=signAfter;
    }
  }
  // 진폭 필터: 직전 채택 극값과의 수위차가 minProminence 미만이면 노이즈로 간주해 제외
  const out=[];
  for(const e of raw){
    if(!out.length){ out.push(e); continue; }
    const last=out[out.length-1];
    if(Math.abs(e.value-last.value)>=minProminence) out.push(e);
  }
  return out;
}

// 인천 조위 극값 ↔ 신곡보 swl 극값을 유형·시간순으로 매칭해 시차(분) 산출
function matchTideLagPairs(tideRows, singokRows){
  const tidePts=rowsToPoints(tideRows, TIDE_KEYS).sort((a,b)=>a.time-b.time);
  const singokPts=rowsToPoints(singokRows, SINGOK_KEYS).sort((a,b)=>a.time-b.time);
  const tideExtrema=findAllExtrema(tidePts);
  const singokExtrema=findAllExtrema(singokPts);
  const pairs=[];
  const usedSingok=new Set();   // 신곡보 극값 1회만 사용
  const usedTide=new Set();     // 인천 극값 1회만 사용
  // 가능한 모든 (인천, 신곡보) 후보쌍을 시차 오름차순으로 정렬 후, 서로 겹치지 않게 그리디 선택
  const candidates=[];
  tideExtrema.forEach((te,ti)=>{
    singokExtrema.forEach((se,si)=>{
      const diffMin=(se.time-te.time)/60000;
      if(diffMin<TIDE_LAG_MIN_WINDOW_MIN || diffMin>TIDE_LAG_MAX_WINDOW_MIN) return;
      if(se.type!==te.type) return;
      candidates.push({ti,si,diffMin,te,se});
    });
  });
  candidates.sort((a,b)=>a.diffMin-b.diffMin);
  for(const c of candidates){
    if(usedTide.has(c.ti) || usedSingok.has(c.si)) continue;
    usedTide.add(c.ti); usedSingok.add(c.si);
    pairs.push({
      tideType: c.te.type==='high'?'만조':'간조',
      incheonTime: c.te.time, incheonValue: c.te.value,
      singokTime: c.se.time, singokValue: c.se.value,
      lagMinutes: Math.round(c.diffMin)
    });
  }
  pairs.sort((a,b)=>a.incheonTime-b.incheonTime);
  return pairs;
}

function loadTideLagLog(){
  try{ const raw=localStorage.getItem(TIDE_LAG_LOG_KEY); return raw?JSON.parse(raw):[]; }catch(e){ return []; }
}
// 이미 저장된 비물리적 기록(시차 하한 미만) 정리 — 기존 오염 데이터 자동 제거
function purgeInvalidTideLagLog(){
  const all=loadTideLagLog();
  if(!all.length) return 0;
  const clean=all.filter(e=>typeof e.lagMinutes!=='number' || e.lagMinutes>=TIDE_LAG_MIN_WINDOW_MIN);
  const removed=all.length-clean.length;
  if(removed>0) saveTideLagLog(clean);
  return removed;
}
function saveTideLagLog(entries){
  try{ localStorage.setItem(TIDE_LAG_LOG_KEY, JSON.stringify(entries.slice(-TIDE_LAG_MAX_ENTRIES))); }catch(e){ log('[조석시차로그 저장실패]', e.message); }
}

// 인천 조위 극값 ↔ 임의 교량 수위 극값 매칭 (교량 관측소 실측 수위 시계열 사용)
// waterPts: 선택 교량 관측소의 실측 수위 포인트 배열 [{time,value}]
function matchBridgeLagPairs(tideRows, waterPts){
  const tidePts=rowsToPoints(tideRows, TIDE_KEYS).sort((a,b)=>a.time-b.time);
  const bPts=[...waterPts].sort((a,b)=>a.time-b.time);
  const tideExtrema=findAllExtrema(tidePts, 0.15);      // 인천 조위: 15cm 이상 진폭
  const bridgeExtrema=findAllExtrema(bPts, 0.10);        // 교량 수위: 10cm 이상 진폭 (변동폭 작음)
  const pairs=[];
  const usedB=new Set(), usedT=new Set();
  const cand=[];
  tideExtrema.forEach((te,ti)=>{
    bridgeExtrema.forEach((be,bi)=>{
      const d=(be.time-te.time)/60000;
      if(d<TIDE_LAG_MIN_WINDOW_MIN || d>TIDE_LAG_MAX_WINDOW_MIN) return;
      if(be.type!==te.type) return;
      cand.push({ti,bi,diffMin:d,te,be});
    });
  });
  cand.sort((a,b)=>a.diffMin-b.diffMin);
  for(const c of cand){
    if(usedT.has(c.ti)||usedB.has(c.bi)) continue;
    usedT.add(c.ti); usedB.add(c.bi);
    pairs.push({
      tideType:c.te.type==='high'?'만조':'간조',
      incheonTime:c.te.time, incheonValue:c.te.value,
      bridgeTime:c.be.time, bridgeValue:c.be.value,
      lagMinutes:Math.round(c.diffMin)
    });
  }
  pairs.sort((a,b)=>a.incheonTime-b.incheonTime);
  return pairs;
}

// 조회 1회당 호출: 인천↔교량 실측 시차를 로그에 누적 (조석 구간 교량만)
// waterPts 있으면 교량 실측 기준, 없으면 기존 신곡보 기준으로 폴백
function accumulateTideLag(b, tideRows, damRows, singokRows, searchDate, waterPts){
  // 조석 영향 구간(tide:true)에서만 인천↔교량 시차 기록 (상류 구간은 조석 무의미)
  const useBridge = b.tide===true && Array.isArray(waterPts) && waterPts.length>=3;
  const pairs = useBridge
    ? matchBridgeLagPairs(tideRows, waterPts)
    : matchTideLagPairs(tideRows, singokRows).map(p=>({...p, bridgeTime:p.singokTime, bridgeValue:p.singokValue}));
  if(!pairs.length) return {added:0, pairs:[]};
  const damPts=rowsToPoints(damRows, DAM_KEYS);
  const tn=tideNumber(searchDate, tideRows);
  // 시차 기준점을 '관측소'로 통일 (같은 관측소 공유 교량들의 중복 적재 방지)
  const refLabel = useBridge ? (b.station||b.bridge) : '신곡보';
  const refCode  = useBridge ? (b.code||'') : 'singok';
  const existing=loadTideLagLog();
  const seen=new Set(existing.map(e=>`${e.refCode||e.bridge}_${e.tideType||''}_${Math.floor(new Date(e.incheonTime).getTime()/60000)}`));
  let added=0;
  for(const p of pairs){
    const key=`${refCode||refLabel}_${p.tideType||''}_${Math.floor(p.incheonTime.getTime()/60000)}`;
    if(seen.has(key)) continue;
    seen.add(key);
    const winStart=p.incheonTime.getTime()-3600000, winEnd=p.bridgeTime.getTime()+3600000;
    const damWin=damPts.filter(d=>d.time.getTime()>=winStart && d.time.getTime()<=winEnd).map(d=>d.value);
    const damAvg=damWin.length?Number((damWin.reduce((a,v)=>a+v,0)/damWin.length).toFixed(1)):null;
    // ★ 2026-07-24 신규: 신곡보 owl/swl(교량 반응 시점 기준) 기록 — 조석차단 임계값(-0.5m) 검증용
    const singokSwl=nearest(singokRows, p.bridgeTime, SINGOK_KEYS, 90);
    const singokOwl=nearest(singokRows, p.bridgeTime, SINGOK_OWL_KEYS, 90);
    const singokDiff=(singokSwl && singokOwl && !singokSwl.stale && !singokOwl.stale)
      ? Number((singokOwl.value - singokSwl.value).toFixed(3)) : null;
    existing.push({
      bridge:b.bridge,             // 조회 당시 선택 교량 (참고)
      refPoint:refLabel,           // 시차 기준 관측소명
      refCode,                     // 관측소 코드 (중복제거 키)
      tideType:p.tideType,
      incheonTime:p.incheonTime.toISOString(),
      incheonValue:p.incheonValue,
      bridgeTime:p.bridgeTime.toISOString(),
      bridgeValue:p.bridgeValue,
      lagMinutes:p.lagMinutes,
      damAvg,
      singokSwl: singokSwl && !singokSwl.stale ? singokSwl.value : null,
      singokOwl: singokOwl && !singokOwl.stale ? singokOwl.value : null,
      singokOwlMinusSwl: singokDiff,
      tideNumberN:tn?.n??null,
      tideNumberName:tn?.name??null,
      tideNumberSource:tn?.source??null,
      loggedAt:new Date().toISOString()
    });
    added++;
  }
  if(added) saveTideLagLog(existing);
  return {added, pairs};
}

// ── 방류량 구간별 시차 통계 ──────────────────────────────────
// 전체 평균은 저방류·고방류가 섞여 무의미하므로, 방류량 구간으로 나눠 본다.
// 만조/간조는 방류에 반대로 반응하는 경향이 있어 유형별로 분리 표시.
const DAM_BANDS = [
  {label:'~500',      min:0,    max:500},
  {label:'500~1000',  min:500,  max:1000},
  {label:'1000~2000', min:1000, max:2000},
  {label:'2000~',     min:2000, max:Infinity}
];
function avgOf(arr){ return arr.length?Math.round(arr.reduce((a,v)=>a+v,0)/arr.length):null; }

function damBandStatsHtml(logData){
  const usable=logData.filter(e=>typeof e.lagMinutes==='number' && e.damAvg!=null);
  if(usable.length<2) return '<p class="muted small">방류량 구간별 통계는 데이터가 더 쌓이면 표시됩니다.</p>';
  let rows='';
  for(const band of DAM_BANDS){
    const inBand=usable.filter(e=>e.damAvg>=band.min && e.damAvg<band.max);
    if(!inBand.length) continue;
    const hi=inBand.filter(e=>e.tideType==='만조').map(e=>e.lagMinutes);
    const lo=inBand.filter(e=>e.tideType==='간조').map(e=>e.lagMinutes);
    const hiAvg=avgOf(hi), loAvg=avgOf(lo);
    rows+=`<tr><td><b>${band.label}</b></td><td>${inBand.length}건</td>`
        + `<td>${hiAvg!==null?`${hiAvg}분 <small>(${hi.length})</small>`:'-'}</td>`
        + `<td>${loAvg!==null?`${loAvg}분 <small>(${lo.length})</small>`:'-'}</td></tr>`;
  }
  if(!rows) return '';
  return `<p class="muted small" style="margin-top:10px"><b>방류량 구간별 평균 시차</b> · 표본이 적으면 신뢰도 낮음</p>`
       + `<table class="cmp-table"><thead><tr><th>방류량(㎥/s)</th><th>건수</th><th>만조 평균</th><th>간조 평균</th></tr></thead>`
       + `<tbody>${rows}</tbody></table>`;
}

// 로그 요약 렌더 (구간별 통계 + 최근 N개)
function renderTideLagPanel(){
  const el=$('tideLagPanel'); if(!el) return;
  const logData=loadTideLagLog();
  if(!logData.length){ el.innerHTML='<p class="muted">아직 누적된 시차 데이터가 없습니다. 조회를 반복하면 자동으로 쌓입니다.</p>'; return; }
  const lags=logData.map(e=>e.lagMinutes).filter(v=>typeof v==='number');
  const min=lags.length?Math.min(...lags):null;
  const max=lags.length?Math.max(...lags):null;
  const recent=[...logData].sort((a,b)=>new Date(b.incheonTime)-new Date(a.incheonTime)).slice(0,12);
  const withSingok = logData.filter(e=>e.singokOwlMinusSwl!=null).length;
  let html=`<p class="muted small">누적 ${logData.length}건 · 시차 범위 ${min??'?'}~${max??'?'}분 · <b>참고용, 실시간 판정에는 미반영</b><br>`
         + `<small>${withSingok}건은 신곡보 owl/swl도 같이 기록됨(조석차단 임계값 검증용, CSV에서 확인) — 전체 평균은 저방류·고방류가 섞여 의미가 없으므로 아래 구간별로 확인하세요.</small></p>`;
  html+=damBandStatsHtml(logData);
  html+='<p class="muted small" style="margin-top:10px"><b>최근 기록</b></p>';
  html+='<table class="cmp-table"><thead><tr><th>인천</th><th>유형</th><th>관측소</th><th>도달</th><th>시차</th><th>방류량</th><th>물때</th></tr></thead><tbody>';
  for(const e of recent){
    const refT = e.bridgeTime ?? e.singokTime;
    // 관측소명 정리: '서울시(잠수교)' → '잠수교', 구버전 교량명은 그대로
    let refName = e.refPoint ?? '신곡보';
    const m = refName.match(/\(([^)]+)\)/);
    if(m) refName = m[1];
    html+=`<tr><td>${mdhhmm(new Date(e.incheonTime))}</td><td>${e.tideType}</td><td>${refName}</td><td>${refT?mdhhmm(new Date(refT)):'-'}</td><td>${e.lagMinutes}분</td><td>${e.damAvg!=null?e.damAvg+'㎥/s':'-'}</td><td>${e.tideNumberName??'-'}</td></tr>`;
  }
  html+='</tbody></table>';
  el.innerHTML=html;
}

// CSV 내보내기 (엑셀 분석용) · localStorage는 브라우저별 저장이라 주기적 백업 필요
function exportTideLagLog(){
  const logData=loadTideLagLog();
  if(!logData.length){ alert('내보낼 로그가 없습니다.'); return; }
  const headers=['bridge','refPoint','refCode','tideType','incheonTime','incheonValue','bridgeTime','bridgeValue','lagMinutes','damAvg','singokSwl','singokOwl','singokOwlMinusSwl','tideNumberN','tideNumberName','tideNumberSource','loggedAt'];
  const rows=logData.map(e=>headers.map(h=>{
    // 구버전 호환: bridgeTime/bridgeValue 없으면 singok 필드로 대체
    if(h==='bridgeTime') return e.bridgeTime??e.singokTime??'';
    if(h==='bridgeValue') return e.bridgeValue??e.singokValue??'';
    if(h==='refPoint') return e.refPoint??'신곡보';
    return e[h]??'';
  }).join(','));
  const csv=[headers.join(','), ...rows].join('\n');
  const blob=new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=`tide_lag_log_${Date.now()}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function clearTideLagLog(){
  if(!confirm('누적된 조석 시차 로그를 모두 삭제할까요? 되돌릴 수 없습니다.')) return;
  localStorage.removeItem(TIDE_LAG_LOG_KEY);
  renderTideLagPanel();
}

// ══════════════════════════════════════════════════════════════
// ★ 2026-07-24 신규: 방류 시차 로그 (releaseLag 실측 검증용)
// ══════════════════════════════════════════════════════════════
// [원리] 팔당댐 방류량이 계단식으로 크게 바뀌는 시점(이벤트)을 찾고, 그 변화가
//   같은 방향(증가→상승/감소→하강)으로 교량 수위에 나타나는 첫 시점을 찾아 그 차이를 시차로 기록.
// [범위 제한 — 중요] 조석 구간(tide:true) 교량은 절대 기록하지 않음. 조석 신호와
//   방류 신호가 수위 변화에 뒤섞여서 방류 시차만 순수하게 뽑아낼 수 없기 때문.
//   비조석 구간(강동·구리암사·천호·광진교·올림픽대교·잠실철교, 잠실보 상류)만 기록 —
//   이 구간은 조석 영향이 없어 수위 변화 = 방류 변화로 봐도 되는 유일한 곳.
// [한계] 자연 유량 변동(강우 등)과 댐 방류 변화를 구분 못함 — 표본 많이 쌓여야 신뢰도 상승.
const RELEASE_LAG_LOG_KEY = 'releaseLagLog';
const RELEASE_LAG_MAX_ENTRIES = 500;
const RELEASE_LAG_MIN_WINDOW_MIN = 60;   // 60분 미만 시차는 물리적으로 불가 → 오탐 제외
const RELEASE_LAG_MAX_WINDOW_MIN = 1440; // ★ 2026-07-24 수정: 480→1440분(24시간). 실측 그래프 대조 결과
                                          // 비조석 상류 구간은 반응이 8시간 이후(최대 하루 가까이)에야 나타남 —
                                          // 8시간 창은 실제 상승 국면을 놓치고 그 이전의 무관한 하강 국면을 보고 있었음.
                                          // 24시간 이상은 강우 등 다른 요인 개입 가능성 커져 여전히 상한선을 둠.
const DAM_STEP_THRESHOLD = 150;          // ㎥/s — 이 이상 변해야 "방류 변경 이벤트"로 인정(노이즈 제외)
const WATER_RESPONSE_THRESHOLD_CMHR = 1.0; // cm/h — 2시간창 평균 변화율 기준(비조석 상류는 반응이 완만해서 하향 조정)
const WATER_RESPONSE_WINDOW_MIN = 120;      // ★ 2026-07-24 수정: 20분→120분. 상류 구간은 반응이 스텝이 아니라
                                             // 며칠에 걸쳐 완만하게 누적되는 형태라, 20분 순간변화율로는
                                             // 절대 안 걸림(실측 사례: 광진교 4일간 1.3→1.85m 상승, 20분 순간
                                             // 변화율은 노이즈에 묻혀 3cm/h를 넘은 적이 없었음). 2시간 평균으로 완화.

// 방류량 시계열에서 유의미한 계단식 변화 시작점(이벤트) 탐지
function findDamStepEvents(damPts, stepThreshold=DAM_STEP_THRESHOLD, windowMin=30){
  if(!Array.isArray(damPts) || damPts.length<3) return [];
  const events=[];
  for(let i=1;i<damPts.length;i++){
    const t=damPts[i].time.getTime();
    let j=i-1;
    while(j>0 && (t-damPts[j].time.getTime())<windowMin*60000) j--;
    const delta=damPts[i].value-damPts[j].value;
    if(Math.abs(delta)<stepThreshold) continue;
    if(i>1){
      const tPrev=damPts[i-1].time.getTime();
      let k=i-2;
      while(k>0 && (tPrev-damPts[k].time.getTime())<windowMin*60000) k--;
      const prevDelta=damPts[i-1].value-damPts[k].value;
      if(Math.abs(prevDelta)>=stepThreshold) continue; // 같은 이벤트의 연속분 → 중복 스킵(rising-edge만 채택)
    }
    events.push({time:damPts[i].time, before:damPts[j].value, after:damPts[i].value, delta, direction:Math.sign(delta)});
  }
  return events;
}
// 방류 이벤트 이후, 같은 방향으로 수위가 반응하기 시작하는 첫 시점 탐색
function findWaterResponseTime(waterPts, afterTime, direction, minWin=RELEASE_LAG_MIN_WINDOW_MIN, maxWin=RELEASE_LAG_MAX_WINDOW_MIN, rateThreshold=WATER_RESPONSE_THRESHOLD_CMHR){
  const searchStart=afterTime.getTime()+minWin*60000;
  const searchEnd=afterTime.getTime()+maxWin*60000;
  for(let i=1;i<waterPts.length;i++){
    const t=waterPts[i].time.getTime();
    if(t<searchStart) continue;
    if(t>searchEnd) break;
    let j=i-1;
    while(j>0 && (t-waterPts[j].time.getTime())<WATER_RESPONSE_WINDOW_MIN*60000) j--;
    const dtHr=(t-waterPts[j].time.getTime())/3600000;
    if(!(dtHr>0)) continue;
    const rateCmHr=((waterPts[i].value-waterPts[j].value)*100)/dtHr;
    if(direction>0 && rateCmHr>=rateThreshold) return {time:waterPts[i].time, value:waterPts[i].value, rateCmHr:Number(rateCmHr.toFixed(1))};
    if(direction<0 && rateCmHr<=-rateThreshold) return {time:waterPts[i].time, value:waterPts[i].value, rateCmHr:Number(rateCmHr.toFixed(1))};
  }
  return null;
}
function matchReleaseLagPairs(damPts, waterPts){
  const events=findDamStepEvents(damPts);
  const pairs=[];
  for(const ev of events){
    const resp=findWaterResponseTime(waterPts, ev.time, ev.direction);
    if(!resp) continue;
    const lagMinutes=Math.round((resp.time-ev.time)/60000);
    if(lagMinutes<RELEASE_LAG_MIN_WINDOW_MIN || lagMinutes>RELEASE_LAG_MAX_WINDOW_MIN) continue;
    pairs.push({
      direction: ev.direction>0?'증가':'감소',
      damTime:ev.time, damBefore:Math.round(ev.before), damAfter:Math.round(ev.after), damDelta:Math.round(ev.delta),
      waterTime:resp.time, waterValue:resp.value, waterRateCmHr:resp.rateCmHr,
      lagMinutes
    });
  }
  return pairs;
}
function loadReleaseLagLog(){ try{ const raw=localStorage.getItem(RELEASE_LAG_LOG_KEY); return raw?JSON.parse(raw):[]; }catch(e){ return []; } }
function saveReleaseLagLog(entries){ try{ localStorage.setItem(RELEASE_LAG_LOG_KEY, JSON.stringify(entries.slice(-RELEASE_LAG_MAX_ENTRIES))); }catch(e){ log('[방류시차로그 저장실패]', e.message); } }

// 조회 1회당 호출: 비조석 구간 교량에서만 방류→수위 시차를 로그에 누적
function maxRateInWindow(waterPts, afterTime, minWin, maxWin, avgWindowMin){
  const searchStart=afterTime.getTime()+minWin*60000;
  const searchEnd=afterTime.getTime()+maxWin*60000;
  let maxAbs=0, maxSigned=0;
  for(let i=1;i<waterPts.length;i++){
    const t=waterPts[i].time.getTime();
    if(t<searchStart) continue;
    if(t>searchEnd) break;
    let j=i-1;
    while(j>0 && (t-waterPts[j].time.getTime())<avgWindowMin*60000) j--;
    const dtHr=(t-waterPts[j].time.getTime())/3600000;
    if(!(dtHr>0)) continue;
    const rateCmHr=((waterPts[i].value-waterPts[j].value)*100)/dtHr;
    if(Math.abs(rateCmHr)>maxAbs){ maxAbs=Math.abs(rateCmHr); maxSigned=rateCmHr; }
  }
  return {maxAbs:Number(maxAbs.toFixed(2)), maxSigned:Number(maxSigned.toFixed(2))};
}
function accumulateReleaseLag(b, damRows, waterPts){
  if(b.tide!==false) return {added:0, reason:'조석 구간 교량이라 제외됨(비조석 6개 교량만 기록)'};
  if(!Array.isArray(waterPts) || waterPts.length<3) return {added:0, reason:'수위 데이터 부족(3개 미만)'};
  const damPts=rowsToPoints(damRows, DAM_KEYS);
  const events=findDamStepEvents(damPts);
  const pairs=matchReleaseLagPairs(damPts, waterPts);
  if(!pairs.length){
    let reason;
    if(events.length){
      const detail=events.map(ev=>{
        const r=maxRateInWindow(waterPts, ev.time, RELEASE_LAG_MIN_WINDOW_MIN, RELEASE_LAG_MAX_WINDOW_MIN, WATER_RESPONSE_WINDOW_MIN);
        return `[${mdhhmm(ev.time)} Δ${ev.delta>0?'+':''}${Math.round(ev.delta)}㎥/s → 창내 최대반응 ${r.maxSigned>=0?'+':''}${r.maxSigned}cm/h(임계값 ${WATER_RESPONSE_THRESHOLD_CMHR})]`;
      }).join(' ');
      reason=`방류 이벤트 ${events.length}건 감지, 전부 반응 임계값 미달 — ${detail}`;
    } else {
      reason=`방류량이 이 조회구간 안에서 ${DAM_STEP_THRESHOLD}㎥/s 이상 계단식으로 변한 적 없음(damPts ${damPts.length}개, 범위 ${damPts.length?Math.round(Math.min(...damPts.map(d=>d.value)))+'~'+Math.round(Math.max(...damPts.map(d=>d.value))):'?'}㎥/s)`;
    }
    return {added:0, reason};
  }
  const existing=loadReleaseLagLog();
  const seen=new Set(existing.map(e=>`${e.code}_${Math.floor(new Date(e.damTime).getTime()/60000)}`));
  let added=0;
  for(const p of pairs){
    const key=`${b.code}_${Math.floor(p.damTime.getTime()/60000)}`;
    if(seen.has(key)) continue;
    seen.add(key);
    existing.push({
      bridge:b.bridge, code:b.code, direction:p.direction,
      damTime:p.damTime.toISOString(), damBefore:p.damBefore, damAfter:p.damAfter, damDelta:p.damDelta,
      waterTime:p.waterTime.toISOString(), waterValue:p.waterValue, waterRateCmHr:p.waterRateCmHr,
      lagMinutes:p.lagMinutes, loggedAt:new Date().toISOString()
    });
    added++;
  }
  if(added) saveReleaseLagLog(existing);
  return {added};
}
function renderReleaseLagPanel(){
  const el=$('releaseLagPanel'); if(!el) return;
  const logData=loadReleaseLagLog();
  if(!logData.length){
    el.innerHTML='<p class="muted">아직 누적된 방류 시차 데이터가 없습니다. 비조석 구간 교량(강동·구리암사·천호·광진교·올림픽대교·잠실철교)을 조회하면, 그 사이 방류량이 크게 바뀔 때 자동으로 쌓입니다.</p>';
    return;
  }
  const lags=logData.map(e=>e.lagMinutes);
  const min=Math.min(...lags), max=Math.max(...lags);
  const byBridge={};
  for(const e of logData){ (byBridge[e.bridge]=byBridge[e.bridge]||[]).push(e.lagMinutes); }
  let html=`<p class="muted small">누적 ${logData.length}건 · 시차 범위 ${min}~${max}분 · <b>참고용, 코드의 releaseLag 값엔 아직 미반영</b><br>`
         + `<small>비조석 구간(강동·구리암사·천호·광진교·올림픽대교·잠실철교)에서만 기록됩니다 — 조석 구간은 신호가 뒤섞여 제외.</small></p>`;
  html+='<table class="cmp-table"><thead><tr><th>교량</th><th>건수</th><th>평균 시차</th></tr></thead><tbody>';
  for(const [br,arr] of Object.entries(byBridge)){
    const avg=Math.round(arr.reduce((a,v)=>a+v,0)/arr.length);
    html+=`<tr><td>${br}</td><td>${arr.length}건</td><td>${avg}분</td></tr>`;
  }
  html+='</tbody></table>';
  const recent=[...logData].sort((a,b)=>new Date(b.damTime)-new Date(a.damTime)).slice(0,12);
  html+='<p class="muted small" style="margin-top:10px"><b>최근 기록</b></p>';
  html+='<table class="cmp-table"><thead><tr><th>교량</th><th>방류 변화</th><th>방향</th><th>시차</th><th>수위 반응</th></tr></thead><tbody>';
  for(const e of recent){
    html+=`<tr><td>${e.bridge}</td><td>${mdhhmm(new Date(e.damTime))} (${e.damBefore}→${e.damAfter})</td><td>${e.direction}</td><td>${e.lagMinutes}분</td><td>${mdhhmm(new Date(e.waterTime))} (${e.waterRateCmHr>0?'+':''}${e.waterRateCmHr}cm/h)</td></tr>`;
  }
  html+='</tbody></table>';
  el.innerHTML=html;
}
function exportReleaseLagLog(){
  const logData=loadReleaseLagLog();
  if(!logData.length){ alert('내보낼 로그가 없습니다.'); return; }
  const headers=['bridge','code','direction','damTime','damBefore','damAfter','damDelta','waterTime','waterValue','waterRateCmHr','lagMinutes','loggedAt'];
  const rows=logData.map(e=>headers.map(h=>e[h]??'').join(','));
  const csv=[headers.join(','), ...rows].join('\n');
  const blob=new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=`release_lag_log_${Date.now()}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function clearReleaseLagLog(){
  if(!confirm('누적된 방류 시차 로그를 모두 삭제할까요? 되돌릴 수 없습니다.')) return;
  localStorage.removeItem(RELEASE_LAG_LOG_KEY);
  renderReleaseLagPanel();
}

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
function makePointState(label,b,time,waterRows,damRows,tideRows,waterMetric,damMetric,singokSwlAtTime,singokOwlAtTime,contStationRows){
  const waterKeys=waterMetric?.key?[waterMetric.key]:WATER_KEYS;
  const damKeys=damMetric?.key?[damMetric.key]:DAM_KEYS;
  let water=nearest(waterRows,time,waterKeys);
  const waterFlow=nearest(waterRows,time,[WATER_FLOW_FIXED_KEY,'FW','fw'],MAX_NEAREST_MIN);
  const wTrend=trend(waterRows,time,waterKeys,60);
  // ★ 방향·정조 판정용 단기 변화율(20분)
  // 1시간 평균은 구간 중심이 30분 전이라 정조·방향 전환을 30분 늦게 잡는다.
  // (예: 급상승 후 정조에 들어가도 1시간 평균은 여전히 '상승 중'으로 표시)
  // 따라서 방향·정조 판정에는 최근 20분 변화율을 쓴다. (60분값은 표시·추세용으로 유지)
  const wTrendShort=trend(waterRows,time,waterKeys,20) || wTrend;
  const damImpactTime=new Date(time.getTime()-(b.releaseLag||0)*60000);
  const damImpact=nearest(damRows,damImpactTime,damKeys,90);
  // 방류 추세(1시간) — 수위 상승 원인이 밀물 유입인지 방류 증가인지 구분용
  const damTrend=trend(damRows,damImpactTime,damKeys,60);

  // ── 조석: owl-swl 수위차 기반 실시간 판단 ──────────────────────
  const tideActive=bridgeTideActive(b, singokSwlAtTime, singokOwlAtTime);
  const tideLevel = singokTideLevel(singokSwlAtTime, singokOwlAtTime);
  const singokDiff = (singokSwlAtTime!==null && singokOwlAtTime!==null)
    ? (singokOwlAtTime - singokSwlAtTime).toFixed(2) : null;
  let tide=null;
  // 강한 영향 또는 약한 영향이면 조석 데이터 적용
  if((tideActive===true || tideActive==='weak') && tideRows.length){
    tide=tideAt(tideRows,time,b.offset||0);
    // ★ 2026-07-24: 썰물(간조 접근) 구간이면 간조용 offset으로 재조회 — 위 STATION_LOWTIDE_DELTA 참고
    if(tide && tide.phase && tide.phase.includes('썰물')){
      const lowOffset = offsetForTideType(b,'간조');
      if(lowOffset !== (b.offset||0)){
        const tideLow = tideAt(tideRows,time,lowOffset);
        if(tideLow){ tideLow.offsetUsed='간조보정'; tide = tideLow; }
      }
    }
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
  const velResult = calcVelocity(fwVal, wlVal, b.code, b.bridge); // {vel, source, Q} or null
  const velocity = velResult ? velResult.vel : null;
  const velSource = velResult ? velResult.source : null;
  const velQ      = velResult ? velResult.Q : null;
  const velInfo = velocityLabel(velocity);

  // ★ 정조·역류·유속 판정 (조석 구간) — 방향 판정보다 먼저 계산해
  //   '물 방향'과 '참고 유속'이 같은 근거(연속방정식)를 쓰도록 통일
  let slack=null;
  let flowDir=null;
  const rateCmHrForFlow = rateCmHrOf(wTrendShort);
  let cont=null;
  if(b.tide){
    // 관측소별 실측 변화율 산출 (20분 창) — 구간 저류 적분용
    let stationRates=null;
    if(contStationRows){
      stationRates=CONT_STATIONS.map(st=>{
        const rows=contStationRows[st.code];
        if(!rows?.length) return null;
        const t=trend(rows,time,WATER_KEYS,20);
        const r=rateCmHrOf(t);
        return r==null?null:{distKm:st.distKm, rateCmHr:r};
      }).filter(Boolean);
      if(!stationRates.length) stationRates=null;
    }
    cont=calcContinuityVelocity(b, water?.value ?? null, rateCmHrForFlow, damImpact?.value ?? null, stationRates);
    const wPts=rowsToPoints(waterRows, waterKeys);
    slack=calcSlackWater(wPts, time, rateCmHrForFlow);
    flowDir=applyReverseFlow(velocity, tideActive, rateCmHrForFlow, slack, damTrend?.delta ?? null, cont);
  }

  const direction=directionLabel(b,wTrendShort,damImpact,tide,tideActive,damTrend,wTrend,flowDir);
  const speed=velInfo ? velInfo.label : speedLabel(wTrend,damImpact,tide);

  const notes=[];
  if(wTrend) notes.push(`수위 1시간 ${wTrend.delta>0?'+':''}${wTrend.delta}m`); else notes.push(waterMetric?.blank?'통제소 수위 응답 공백':'수위 변화 계산불가');
  if(damImpact) notes.push(`팔당 ${b.releaseLag}분 보정 ${damImpact.value.toFixed(1)}㎥/s`); else notes.push(damMetric?.blank?'통제소 방류 응답 공백':'방류량 보정값 없음');
  notes.push(tideStatusNote);
  if(waterSource==='estimated') notes.push('⚠ 수위 실측값 없음 → 계산값(추정)으로 대체');
  return{label,time,water,waterFlow,wTrend,wTrendShort,damImpact,damImpactTime,damTrend,tide,tideActive,tideStatusNote,direction,speed,notes,waterSource,velocity,velInfo,velSource,velQ,slack,flowDir,cont};
}

// ── 방향/속도 판정 ───────────────────────────────────────────
// trend 객체 → cm/h 환산 (구간 길이 무관하게 시간당 비율로 정규화)
function rateCmHrOf(t){
  if(!t || t.delta==null || !t.minutes) return null;
  return Number((t.delta*100*(60/t.minutes)).toFixed(1));
}

// ── 표시용 실효 유속 ─────────────────────────────────────────
// HQ곡선은 "수위가 높다 = 유량이 많다"를 전제로 한 평상시 유량 공식이다.
// 조석 역류 시에는 바닷물이 밀려들어와 수위가 높아진 것이므로 강물 유량이
// 많은 게 아니다 → HQ곡선이 유량·유속을 크게 과대평가한다(예: 4m/s 이상).
// 따라서 역류가 실측된 경우 HQ 유속을 무효 처리하고 역류 추정치를 쓴다.
function effectiveVelocity(state){
  const f=state.flowDir;
  const hq=state.velocity;
  if(!f) return {value:hq, label:state.velInfo?.label??'', source:state.velSource??'', dir:'down', invalid:false};

  const byCont = f.src && f.src.includes('연속방정식');
  if(f.dir==='slack'){
    return {value:0, label:'정조(유속 최소)', source:f.src||'실측 변화율 ≈0', dir:'slack', invalid:false,
            note:f.note||'정조 부근 — 곧 반대 방향 흐름 강화 가능'};
  }
  if(f.dir==='up'){
    return {value:f.absVel, signed:f.signedVel, label:'상류향 역류',
            source:f.src||'추정', dir:'up', invalid:!byCont,
            note:`${f.note||''}${hq!=null?` · HQ곡선 원값 ${hq.toFixed(2)}m/s는 조석 역류 구간에서 무효라 제외`:''}`};
  }
  if(f.dir==='mixed'){
    return {value:hq, label:'불확실', source:f.src||'', dir:'mixed', invalid:true, note:f.note};
  }
  // 하류: 연속방정식이 있으면 그 값을 우선
  if(byCont){
    return {value:f.absVel, label:velocityLabel(f.absVel)?.label??'', source:f.src, dir:'down', invalid:false, note:f.note};
  }
  return {value:hq, label:state.velInfo?.label??'', source:state.velSource??'', dir:'down', invalid:false};
}

// ── 물 방향 판정 (실측 우선) ─────────────────────────────────
// 원칙: 인천 조석 위상은 '인천 기준'이며, 상류 교량엔 3~5시간 늦게 도달한다.
//       따라서 인천 위상으로 교량 방향을 정하면 실제와 반대로 나올 수 있다.
//       → 그 교량 관측소가 실제로 잰 수위 변화율(cm/h)을 1순위 근거로 삼는다.
// 수치 기준 (cm/h, 1시간 실측 변화):
//   |rate| < 4      → 정체·정조 부근
//   4 ≤ |rate| < 10 → 약함
//   10 ≤ |rate| < 30→ 보통
//   |rate| ≥ 30     → 강함
const FLOW_RATE_SLACK = 4;    // 이하: 정체
const FLOW_RATE_WEAK  = 10;
const FLOW_RATE_STRONG= 30;

function flowStrengthLabel(absRate){
  if(absRate>=FLOW_RATE_STRONG) return '강하게';
  if(absRate>=FLOW_RATE_WEAK)   return '보통 세기로';
  return '약하게';
}

function directionLabel(b,wTrendShort,damImpact,tide,tideActive,damTrend,wTrendLong,flowDir){
  const damHigh=damImpact?.value!=null&&damImpact.value>=1000;
  // 비조석 구간: 기존 로직 유지 (조석 무의미)
  if(!b.tide) return damHigh?'방류 영향 하류방향 우세 가능':'조석 제외 · 자연 하류 흐름 가능';

  const rate = rateCmHrOf(wTrendShort); // cm/h
  const rateLong = rateCmHrOf(wTrendLong);
  const damRise = damTrend && damTrend.delta!=null ? damTrend.delta : null;
  const damSurging = damRise!==null && damRise >= 100;

  // 감속 여부(정조 임박)는 '방향'이 아니라 '수식어'로만 쓴다.
  // 물이 느려지는 중이어도 아직 흐르고 있으면 방향은 그대로다.
  const decelerating = rate!=null && rateLong!=null
                     && Math.abs(rateLong)>=FLOW_RATE_WEAK
                     && Math.sign(rate)===Math.sign(rateLong)
                     && Math.abs(rate) < Math.abs(rateLong)*0.5;
  const turnSoon = decelerating ? ' · ⏳ 전환 임박(둔화 중)' : '';
  const rateTxt = rate!=null ? `실측 ${rate>0?'+':''}${rate}cm/h` : '변화율 자료 없음';

  // ★ 1순위: 연속방정식(질량보존) 결과를 방향의 단일 근거로 사용
  //   ('참고 유속' 카드와 반드시 같은 결론이 나오도록 통일)
  if(flowDir && flowDir.src && flowDir.src.includes('연속방정식')){
    if(flowDir.dir==='up')
      return `⬆ 물이 들어오는 중 · 상류향 역류 ${flowDir.absVel.toFixed(2)}m/s (${rateTxt})${turnSoon}`;
    if(flowDir.dir==='down')
      return `⬇ 물이 나가는 중 · 하류향 ${flowDir.absVel.toFixed(2)}m/s (${rateTxt})${turnSoon}`;
    if(flowDir.dir==='slack')
      return `⏸ 정조 — 통과유량 ≈0 (${rateTxt})`;
    if(flowDir.dir==='mixed')
      return `혼합·불확실 — 수위 상승과 방류 급증 동반 (${rateTxt}) · 현장 확인 필수`;
  }

  // 2순위: 실측 변화율 부호
  if(rate!==null){
    const abs=Math.abs(rate);
    if(abs < FLOW_RATE_SLACK) return `⏸ 정체·정조 부근 (${rateTxt})`;
    if(rate > 0){
      if(damSurging)
        return `수위 ${flowStrengthLabel(abs)} 상승 (${rateTxt}) · 방류 급증(+${Math.round(damRise)}㎥/s/h) — 역류 여부 불확실`;
      return `⬆ 물이 ${flowStrengthLabel(abs)} 들어오는 중 (${rateTxt} · 밀물 유입/역류)${turnSoon}`;
    }
    return `⬇ 물이 ${flowStrengthLabel(abs)} 나가는 중 (${rateTxt} · 하류 흐름)${turnSoon}`;
  }

  // 2순위(실측 없을 때만): 기존 조석 위상 기반 추정
  if(tideActive===null) return damHigh?'방류 영향 하류방향 가능 (신곡수중보 수위 미확인)':'신곡수중보 수위 미확인 · 조석 전파 여부 판단 불가';
  if(!tideActive) return damHigh?'방류 영향 하류방향 우세 가능 (조석 차단)':'조석 차단 (신곡수중보 낮음) · 자연 하류 흐름 가능';
  if(!tide) return damHigh?'방류 영향 하류방향 가능':'조석 전파 중 · 조위 자료 없음';
  if(tide.phase.includes('밀물')) return damHigh?'밀물 유입 + 방류 하류방향 충돌 가능 (추정·인천 기준)':'물이 들어오는 영향 가능 (추정·인천 기준)';
  if(tide.phase.includes('썰물')) return '물이 나가는 영향 가능 (추정·인천 기준)';
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
function fmtEffVel(state){
  const ev=effectiveVelocity(state);
  if(ev.value===null||ev.value===undefined) return '<span style="color:#b7791f">유속 계산 불가</span>';
  const sign = ev.dir==='up'?'−':'';
  const main = `<strong>${sign}${ev.value.toFixed(2)}m/s</strong> (${(ev.value*3.6).toFixed(1)}km/h) · ${ev.label||''}`;
  const src  = `<br><small style="color:#667085">${ev.source||''}</small>`;
  const note = ev.note?`<br><small style="color:#b7791f">${ev.note}</small>`:'';
  return main+src+note;
}

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
  const offset=(t.offsetUsed==='간조보정') ? offsetForTideType(b,'간조') : (b.offset||0);
  const bridgeBestTime=t.best?.time?new Date(t.best.time.getTime()+offset*60000):null;
  let turn='';
  if(t.nextTurn){const turnOffset=offsetForTideType(b,t.nextTurn.type);const bridgeTurn=new Date(t.nextTurn.time.getTime()+turnOffset*60000);turn=` · 다음 ${t.nextTurn.type} 교량 도달추정 ${hhmm(bridgeTurn)} (인천 실제 ${hhmm(t.nextTurn.time)}, ${t.nextTurn.value.toFixed(1)}cm)`;}
  const rate=t.rateCmHr!==null?` · 변화율 ${t.rateCmHr>0?'+':''}${t.rateCmHr}cm/h`:'';
  const baseTxt=bridgeBestTime?`인천 관측 ${pretty(t.best.time)} + ${offset}분${t.offsetUsed==='간조보정'?'(간조보정)':''} 보정 = 교량기준 ${pretty(bridgeBestTime)}`:`인천기준 ${t.shifted?pretty(t.shifted):''}`;
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
      관측시각: ${s.time?pretty(s.time):'불명'} · 기준: owl-swl > 0 역류강, > -0.5 역류가능, 이하 정상흐름
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
        <span>투신</span><span>${incidentState.velocity!==null?`<strong>${incidentState.velocity.toFixed(2)}m/s (${(incidentState.velocity*3.6).toFixed(1)}km/h)</strong> · ${incidentState.velInfo?.label||''} · Q=${incidentState.velQ?.toFixed(0)||'?'}㎥/s`:'자료 없음'}</span>
        <span>조회</span><span>${currentState.velocity!==null?`<strong>${currentState.velocity.toFixed(2)}m/s (${(currentState.velocity*3.6).toFixed(1)}km/h)</strong> · ${currentState.velInfo?.label||''} · Q=${currentState.velQ?.toFixed(0)||'?'}㎥/s`:'자료 없음'}</span>
        ${flowDirRow(currentState)}
        <span>출처</span><span><small>${incidentState.velSource||'fw·HQ 데이터 없음'} · 단면적 추정치 포함</small></span>
        <span>⚠ 주의</span><span><small style="color:#e05252;font-weight:700">미검증 추정치 — 강폭·수심·형상계수 근사가 곱해진 값. 방향은 참고할 수 있으나 숫자(m/s, km/h)는 판단 근거로 쓰지 말 것.</small></span>
      </div>
    </div>${slackCardHtml(currentState)}`;
}

// 조석 역류 반영 방향 행 (조석 구간에서만)
function flowDirRow(state){
  const f=state.flowDir;
  if(!f) return '';
  const color = f.dir==='up' ? 'var(--flow-in)' : f.dir==='slack' ? '#078a4f' : f.dir==='mixed' ? '#b7791f' : 'var(--flow-out)';
  const signed = f.dir==='slack' ? '≈0' : f.dir==='mixed' ? '?' : (f.signedVel>0?'+':'')+f.signedVel.toFixed(2)+'m/s';
  return `<span>방향</span><span><strong style="color:${color}">${signed} · ${f.dirLabel}</strong><br><small>${f.note}</small></span>`;
}

// 정조(slack) 카드 HTML — 조석 구간에서만 표시
function slackCardHtml(state){
  const s=state.slack;
  if(!s) return '';
  const near = s.atSlackNow || (s.minutesToSlack!==null && s.minutesToSlack>=0 && s.minutesToSlack<=SLACK_NEAR_MINUTES);
  const badgeCls = s.atSlackNow ? 'good' : near ? 'warn' : 'hold';
  const badgeTxt = s.atSlackNow ? '정조 부근' : near ? '정조 임박' : '흐름 진행';
  const rateTxt = s.rateCmHr!==null ? `${s.rateCmHr>0?'+':''}${s.rateCmHr}cm/h` : '변화율 자료 없음';
  let nextTxt='다음 정조 미검출';
  if(s.nextSlackTime){
    const mins=s.minutesToSlack;
    nextTxt = `${s.nextSlackType} @ ${hhmm(new Date(s.nextSlackTime))}` + (mins!==null&&mins>=0?` (약 ${mins}분 후)`:'');
  }
  const border = s.atSlackNow ? '#078a4f' : near ? '#b7791f' : '#bfdbfe';
  return `
    <div class="data-card" style="border-color:${border}">
      <b>🛟 정조 판단 (유속 최소 시점)</b><span class="data-badge ${badgeCls}">${badgeTxt}</span>
      <div class="data-grid-mini">
        <span>상태</span><span><strong>${s.state}</strong></span>
        <span>변화율</span><span>${rateTxt} <small>(실측 수위 기준)</small></span>
        <span>다음</span><span>${nextTxt}</span>
        <span>참고</span><span><small>정조 부근은 유속이 약해지나, 정조 직후 반대 방향 흐름이 급격히 강해질 수 있음. 현장 확인 우선.</small></span>
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
    ${row('참고 유속', fmtEffVel(incidentState), fmtEffVel(currentState))}
    ${row('물살 판단',incidentState.speed,currentState.speed)}
    <p class="muted">물 방향·물살은 유속 실측값이 아니라 수위변화·방류량·인천 조석·신곡수중보 실측 수위를 조합한 참고판정입니다.</p>
    <p style="color:#e05252;font-weight:700;font-size:12px">⚠ 참고 유속(m/s, km/h) 숫자는 미검증 추정치입니다. 교량에 유속계가 없어 강폭·수심·형상계수 근사로 역산한 값이며, 방향(상류/하류/정조)만 참고하고 크기는 현장 판단에 쓰지 마세요.</p>`;
  const el=$('pointCompare'); if(el) el.innerHTML=html;
}

// ── 요약 패널 ────────────────────────────────────────────────
// ── 실시간 수심 카드 ──────────────────────────────────────────
let NAV_CHART_DB = null;

async function loadNavChartDB(){
  if(NAV_CHART_DB) return NAV_CHART_DB;
  try{
    const r = await fetch('data/hangang_navigation_chart.json');
    if(!r.ok) return null;
    NAV_CHART_DB = await r.json();
    return NAV_CHART_DB;
  }catch(e){ return null; }
}

function getBedElForBridge(bridgeName, db){
  if(!db || !db.bedLevels) return null;
  const entry = db.bedLevels[bridgeName];
  if(!entry || !entry.representative) return null;
  return {
    bedEl_main: entry.representative.bedEl_main_channel ?? null,
    bedEl_deep: entry.representative.bedEl_deepest ?? null,
    bedEl_warn: entry.representative.bedEl_shallow_warn ?? -2.0,
    verticalClearance: entry.verticalClearance_m ?? null,
    source: entry.source ?? '운항기준도 2026.05',
    note: entry.note ?? '',
    piers: entry.piers ?? null,   // ★ 2026-07-21: 구간별(교각별) 상세 수심 — 기존엔 로드만 하고 미사용
  };
}

// ★ 2026-07-21 신규: 교각/구간별 수심 상세 렌더링
// piers 객체의 각 zone: {bedEl_max(얕은쪽), bedEl_min(깊은쪽, 없으면 deepest), bedEl_repr, location, note}
// bedEl_max가 0에 더 가까움(덜 음수) = 그 구간에서 가장 얕은 지점 = 안전상 가장 중요한 값
function renderPierZones(piers){
  if(!piers || !Object.keys(piers).length) return '';
  const zones = Object.entries(piers).map(([key,z])=>{
    const shallow = z.bedEl_max!=null ? chartDepth(z.bedEl_max) : null;
    const deepV   = z.bedEl_min!=null ? chartDepth(z.bedEl_min) : (z.deepest!=null ? chartDepth(z.deepest) : null);
    return {key, shallow, deep:deepV, location:z.location||key, note:z.note||''};
  }).filter(z=>z.shallow!==null || z.deep!==null)
    .sort((a,b)=>(a.shallow??a.deep??99)-(b.shallow??b.deep??99)); // 얕은 구간(위험) 먼저

  if(!zones.length) return '';
  const rows = zones.map(z=>{
    const danger = z.note.includes('🚫') || z.note.includes('진입 금지');
    const warn   = !danger && (z.note.includes('⚠') || z.note.includes('🔴') || (z.shallow!==null && z.shallow<3));
    const color  = danger ? 'var(--red)' : warn ? 'var(--yellow)' : 'var(--muted)';
    const rangeTxt = (z.shallow!==null && z.deep!==null && Math.abs(z.shallow-z.deep)>0.05)
      ? `${z.shallow.toFixed(1)}~${z.deep.toFixed(1)}m` : `${(z.shallow??z.deep).toFixed(1)}m`;
    return `<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="flex:1;font-size:12px">${z.location}${danger?' 🚫':warn?' ⚠':''}</span>
      <span style="font-weight:700;color:${color};white-space:nowrap">${rangeTxt}</span>
    </div>${z.note?`<div style="font-size:11px;color:${color};margin:-2px 0 4px">${z.note}</div>`:''}`;
  }).join('');

  return `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:10px;margin-top:8px">
    <div style="font-size:12px;font-weight:700;margin-bottom:4px">📍 구간별(교각별) 상세 수심 — 가장 얕은 구간 우선 표시</div>
    ${rows}
    <div style="font-size:10px;color:var(--muted);margin-top:4px">해도 원본 실측 샘플 기반. 대표값(주항로/최심)은 이 구간들의 대표치일 뿐 — 특정 교각·저수심 경계 근처 수색 시 이 표를 우선 확인.</div>
  </div>`;
}

// ★ Phase 3.6.4 중대 수정: 해도값의 의미 정정
//   [기존 오류] 해도 숫자를 '하상고(EL.m)'로 보고 `수심 = 실시간 수위 − 하상고`로 계산했다.
//     이 전제는 운항기준도를 디지털화할 때 넣은 '해석'이었을 뿐, 원본 근거가 없었다.
//   [원본 NOTES] "도면에 표시된 **수심**은 팔당댐 방류량 200㎥/s를 기준으로 산출된 값이므로,
//     실제 운항시에는 방류량 및 조석 변화에 따라 가항 수심이 달라질 수 있음" (시트 5~7/8 공통)
//   → 해도 숫자는 '하상고'가 아니라 **방류량 200㎥/s 조건의 실제 수심**이다. (음수는 표기 관행)
//   [정정] 수심 = |해도값|. 실시간 수위를 빼지 않는다.
//   [운영 방침] 방류·조석이 늘면 실제 수심은 이보다 깊어지므로, 해도값을 **최소 수심**으로 쓴다.
//     수색 안전상 얕게 잡는 쪽이 보수적이며, 별도 보정은 하지 않는다(보정 기준선 미확보).
const CHART_DEPTH_BASE_DAM = 200; // ㎥/s — 해도 수심의 기준 방류량
function chartDepth(v){
  if(v===null || v===undefined) return null;
  return Number(Math.abs(v).toFixed(2));
}

// ★ 2026-07-21 신규: 방류 200㎥/s 기준수위 역산(HQ곡선) → 실시간 수심 보정
// ─────────────────────────────────────────────────────────────
// [전제 확인, 영진님 확인 2026-07-21] 해도 수심표는 표고(EL)가 아니라 '수면~바닥' 거리이므로,
//   절대 기준면이 같은지 몰라도 상관없다. 필요한 건 "200㎥/s일 때 수위(h_200)"와
//   "지금 실측 수위(wl_now)"의 차이(Δh = wl_now − h_200)뿐 — 같은 관측소·같은 시간축 비교라 유효.
//   실시간 수심 = 해도 수심(200㎥/s 기준) + Δh
// [적용 범위 제한] HQ곡선이 200㎥/s 부근을 실제로 다루는 관측소만 신뢰 가능:
//   - 행주대교(1019630): h≈1.59m일 때 Q≈200㎥/s, 곡선 유효범위(1.03~10.20m) 안 → 'valid'
//   - 청담대교(1018662, 잠수교·반포2교 준용): 최저 보정범위가 h=0.99m→Q≈243㎥/s라
//     200㎥/s는 그 바로 아래(h≈0.90m, 소폭 외삽) → 'marginal'
//   - 광진교(1018640)·한강대교(1018683): 최저 캘리브레이션 수위에서 이미 Q≈2,000~6,000㎥/s대라
//     200㎥/s는 곡선이 전혀 다루지 않는 구간 → 보정 불가('none'), 기존 정적값(200기준+안내문) 유지
const DEPTH_CORR_STATIONS = { '1019630':'valid', '1018662':'marginal', '1018680':'marginal', '1018681':'marginal' };

// HQ곡선 수치 역산 (이진탐색) — Q(h)는 구간별로 단조증가라고 가정
function invertHQ(stationCode, targetQ){
  const curve = HQ_CURVES[stationCode];
  if(!curve) return null;
  const segs = curve.segments;
  const qAt = (h) => { for(const seg of segs){ if(h>=seg.min && h<=seg.max) return seg.formula(h); } return segs[segs.length-1].formula(h); };
  const hMin = segs[0].min, hMax = segs[segs.length-1].max;
  let lo = hMin - 2.0, hi = hMax + 1.0; // 소폭 외삽만 허용 (청담대교 케이스 커버)
  const qLo = qAt(lo), qHi = qAt(hi);
  if(!(Number.isFinite(qLo) && Number.isFinite(qHi)) || targetQ < qLo || targetQ > qHi) return null;
  for(let i=0;i<60;i++){ const mid=(lo+hi)/2; if(qAt(mid) < targetQ) lo=mid; else hi=mid; }
  const h=(lo+hi)/2;
  return { h:Number(h.toFixed(3)), inRange: h>=hMin && h<=hMax };
}
let _h200Cache = {};
function getH200(stationCode){
  if(!(stationCode in DEPTH_CORR_STATIONS)) return null;
  if(_h200Cache[stationCode]!==undefined) return _h200Cache[stationCode];
  const r = invertHQ(stationCode, CHART_DEPTH_BASE_DAM);
  return _h200Cache[stationCode] = r;
}

// 교량명 → 해도 기준 수심(방류 200㎥/s) {main, deepest} · stationCode+wl 주면 가능한 경우 실시간 보정
// 보정 불가/미제공 시 기존과 동일하게 200㎥/s 기준 정적값(최소 수심) 반환
function chartDepthFor(bridgeName, stationCode, wl){
  const info = getBedElForBridge(bridgeName, NAV_CHART_DB);
  if(!info) return null;
  const base = { main: chartDepth(info.bedEl_main), deepest: chartDepth(info.bedEl_deep), warn: chartDepth(info.bedEl_warn) };
  if(stationCode==null || wl==null) return {...base, corrected:false};
  const h200 = getH200(stationCode);
  if(!h200) return {...base, corrected:false}; // 이 관측소는 보정 불가(광진교·한강대교 등)
  const deltaH = Number((wl - h200.h).toFixed(2));
  const corrMain = base.main!=null ? Number(Math.max(0.1, base.main+deltaH).toFixed(2)) : null;
  const corrDeep = base.deepest!=null ? Number(Math.max(0.1, base.deepest+deltaH).toFixed(2)) : null;
  return {
    main:corrMain, deepest:corrDeep, warn:base.warn, corrected:true,
    baseMain:base.main, baseDeep:base.deepest, deltaH,
    reliability: DEPTH_CORR_STATIONS[stationCode], h200:h200.h, h200InRange:h200.inRange,
  };
}


function depthLabel(depth){
  if(depth === null) return null;
  if(depth < 2.0) return {cls:'bad',   label:'🚫 잠수 불가', note:`수심 ${depth.toFixed(1)}m — 2m 이하 저수심`};
  if(depth < 3.0) return {cls:'warn',  label:'⚠ 주의',      note:`수심 ${depth.toFixed(1)}m — 수중수색 주의`};
  if(depth < 5.0) return {cls:'hold',  label:'보통',          note:`수심 ${depth.toFixed(1)}m`};
  if(depth < 10.0)return {cls:'ok',    label:'양호',          note:`수심 ${depth.toFixed(1)}m`};
  if(depth < 15.0)return {cls:'warn',  label:'⚠ 깊음',      note:`수심 ${depth.toFixed(1)}m — 감압 계획 필요`};
  return              {cls:'bad',       label:'🔴 매우 깊음', note:`수심 ${depth.toFixed(1)}m — 감압 필수`};
}

function renderDepthCard(b, incidentState, currentState, db){
  const el = $('depthCard'); if(!el) return;

  const wlNow = currentState.water?.value ?? null;
  const cd = chartDepthFor(b.bridge, b.code, wlNow);
  if(!cd){
    el.innerHTML = `<div style="color:var(--muted);font-size:13px">
      "${b.bridge}" 수심 데이터 없음 — 운항기준도 DB 미등록 교량
    </div>`;
    return;
  }
  const bedInfo = getBedElForBridge(b.bridge, db); // note·source·piers 표시용

  // ★ 2026-07-21: 관측소 HQ곡선이 200㎥/s를 다루는 경우(cd.corrected) 실시간 보정값,
  //   아니면 기존과 동일하게 200㎥/s 기준 정적 최소수심.
  const depMain = cd.main;
  const depDeep = cd.deepest;

  const lblCur = depthLabel(depMain);
  const lblDeep = depthLabel(depDeep);

  // 수직여유고 (교각 하부 통과 가능 높이)
  const vcTxt = bedInfo?.verticalClearance
    ? `교각 수직여유고 ${bedInfo.verticalClearance.toFixed(1)}m (EL 기준)`
    : '';

  // 감압 경고
  const decompWarn = (depDeep && depDeep >= 10)
    ? `<div style="background:#1a0505;border:1px solid #ef4444;border-radius:8px;padding:10px;margin-top:8px;font-size:13px;color:#f87171">
        🔴 <strong>감압 주의</strong> — 주항로 최심 수심 ${depDeep.toFixed(1)}m<br>
        10m 이상 잠수 시 감압병 위험. 반드시 감압 계획 수립 후 입수하세요.
      </div>` : '';

  const damCur = currentState.damImpact?.value ?? null;

  let banner;
  if(cd.corrected){
    const relTxt = cd.reliability==='valid' ? '신뢰도 높음 — HQ곡선 유효범위 안' : '참고용 — HQ곡선 소폭 외삽 포함';
    banner = `<div style="background:#0a1f14;border:1px solid #1e8a4a;border-radius:8px;padding:10px;margin-bottom:8px;font-size:12px;line-height:1.6">
      📏 <b>실시간 보정 수심</b> (HQ곡선 역산, ${relTxt})<br>
      200㎥/s 기준값(${cd.baseMain!=null?cd.baseMain.toFixed(1):'?'}m)에 지금 수위와 200㎥/s 기준수위(${cd.h200}m)의
      차이(Δh=${cd.deltaH>=0?'+':''}${cd.deltaH}m)를 더한 값입니다.
      ${cd.reliability==='marginal'?'<br>⚠ 이 관측소는 HQ곡선 유효범위를 살짝 벗어나 소폭 외삽 포함 — 절대값은 참고만.':''}
    </div>`;
  } else {
    const damNote = damCur!=null
      ? (damCur > CHART_DEPTH_BASE_DAM*1.5
          ? `현재 방류 ${Math.round(damCur)}㎥/s — 기준(${CHART_DEPTH_BASE_DAM})보다 많아 <b>실제 수심은 아래 값보다 깊음</b>`
          : `현재 방류 ${Math.round(damCur)}㎥/s — 기준(${CHART_DEPTH_BASE_DAM}㎥/s)과 유사`)
      : '';
    banner = `<div style="background:#0d1a26;border:1px solid #1e5a8a;border-radius:8px;padding:10px;margin-bottom:8px;font-size:12px;line-height:1.6">
      📏 <b>방류량 ${CHART_DEPTH_BASE_DAM}㎥/s 기준 최소 수심</b> (운항기준도 원본 기준)<br>
      이 관측소는 HQ곡선이 저유량 구간을 다루지 않아 실시간 보정이 불가합니다. 방류·조석이 늘면 실제 수심은 이보다 <b>깊어집니다</b> — 얕게 잡은 보수적 값입니다.
      ${damNote?'<br>'+damNote:''}
    </div>`;
  }

  el.innerHTML = `
    ${banner}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px">
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px">주항로 ${cd.corrected?'실시간':'최소'} 수심</div>
        <div style="font-size:22px;font-weight:900;color:${depMain?depMain<3?'var(--red)':depMain<10?'var(--green)':'var(--yellow)':'var(--muted)'}">
          ${depMain !== null ? depMain.toFixed(1)+'m' : '—'}
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px">${lblCur ? lblCur.label : ''}</div>
      </div>
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px">
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px">교각 최심부</div>
        <div style="font-size:22px;font-weight:900;color:${lblDeep?.cls==='bad'?'var(--red)':lblDeep?.cls==='warn'?'var(--yellow)':'var(--green)'}">
          ${depDeep !== null ? depDeep.toFixed(1)+'m' : '—'}
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px">${lblDeep?.label ?? ''}</div>
      </div>
    </div>
    ${vcTxt?`<div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:10px;font-size:13px">${vcTxt}</div>`:''}
    ${decompWarn}
    ${renderPierZones(bedInfo?.piers)}
    <div style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.5">
      출처: ${bedInfo?.source||'운항기준도'}<br>
      ${bedInfo?.note ? '※ '+bedInfo.note.slice(0,60) : ''}
      <br>⚠ 하상 변화·국부 세굴로 실제와 다를 수 있음 — 현장 확인 우선
    </div>`;
}

// ── 3초 판단 카드 업데이트 ────────────────────────────────────
function renderDecisionCard(b, currentState, incidentState, results, tideRows, searchDt){
  // 교량명 + 조회시각 (년.월.일 HH:MM 형식)
  const sd=$('searchDate')?.value||'', st=$('searchTime')?.value||'';
  let timeTxt = '';
  if(sd.length===8){
    timeTxt = `${sd.slice(0,4)}.${sd.slice(4,6)}.${sd.slice(6,8)}`;
    if(st.length>=4) timeTxt += ` ${st.slice(0,2)}:${st.slice(2,4)}`;
  }
  $('decisionBridge') && ($('decisionBridge').textContent = b.bridge);
  $('decisionTime')   && ($('decisionTime').textContent   = timeTxt);

  // 물 방향
  const dirEl=$('dc-direction'), dirSub=$('dc-direction-sub');
  if(dirEl){
    const dir = currentState.direction||'—';
    const f = currentState.flowDir;
    // ★ 방향은 flowDir(연속방정식)을 단일 근거로 사용 — 문자열 매칭 금지
    //   ('정조 임박'을 '정조'로 오인 표시하던 문제 방지: 임박은 아직 흐르는 중)
    let kind;
    if(f) kind = f.dir;                                   // up/down/slack/mixed
    else if(dir.includes('정조 부근')||dir.includes('정체')) kind='slack';
    else if(dir.includes('나가')||dir.includes('하류')) kind='down';
    else if(dir.includes('들어오')||dir.includes('역류')||dir.includes('밀물')) kind='up';
    else kind='mixed';
    const turnSoon = dir.includes('전환 임박');
    const label = kind==='slack'?'⏸ 정조' : kind==='down'?'↓ 하류' : kind==='up'?'↑ 상류' : '— 혼합';
    dirEl.textContent = label + (turnSoon&&kind!=='slack'?' (전환 임박)':'');
    dirEl.className   = 'dc-value '+(kind==='slack'?'color-green':kind==='down'?'color-orange':kind==='up'?'color-blue':'color-muted');
    if(dirSub) dirSub.textContent = dir;
  }

  // 유속 — 시속(km/h) 메인, (m/s) 보조 · 조석 역류 시 HQ곡선 무효 처리
  const velEl=$('dc-velocity'), velSub=$('dc-velocity-sub');
  if(velEl){
    const ev=effectiveVelocity(currentState);
    if(ev.value!==null && ev.value!==undefined){
      const v=ev.value, kmh=(v*3.6).toFixed(1);
      const lvl=ev.label||'';
      let cls;
      if(ev.dir==='up') cls='color-blue';
      else if(ev.dir==='slack') cls='color-green';
      else if(ev.dir==='mixed') cls='color-yellow';
      else cls=(lvl==='빠름'||lvl==='매우 빠름')?'color-red':lvl==='보통'?'color-yellow':'color-green';
      const arrow = ev.dir==='up'?'↑ ':ev.dir==='slack'?'':'↓ ';
      const signTxt = ev.dir==='up'?`(−${v.toFixed(2)}m/s 상류)`:`(${v.toFixed(2)}m/s)`;
      velEl.innerHTML=`<span class="${cls}" style="font-size:26px;font-weight:900">${arrow}${kmh}</span><span style="font-size:13px;color:var(--muted);font-weight:600"> km/h</span><span style="font-size:11px;color:var(--muted);margin-left:4px">${signTxt}</span>`;
      velEl.className='dc-value';
      if(velSub) velSub.innerHTML=`${lvl} · ${ev.source||''}<br><small style="color:#e05252;font-weight:700">⚠ 미검증 추정치 — 숫자는 참고용, ${ev.invalid?'방향도 불확실':'방향만 신뢰'}</small>`;
    } else {
      velEl.textContent='—';
      velEl.className='dc-value color-muted';
      if(velSub) velSub.textContent='유속 데이터 없음';
    }
  }

  // 수위
  const wEl=$('dc-water'), wSub=$('dc-water-sub');
  if(wEl){
    if(currentState.water){
      const w=currentState.water.value;
      const wInc=incidentState.water?.value??null;
      const diff=wInc!==null?w-wInc:null;
      const cls=diff===null?'color-muted':diff>0.05?'color-red':diff<-0.05?'color-blue':'color-green';
      wEl.textContent=w.toFixed(2)+'m';
      wEl.className='dc-value '+cls;
      if(wSub){
        const diffTxt=diff!==null?(diff>=0?'▲+':'▼')+diff.toFixed(2)+'m vs 투신':'';
        const src=currentState.water.isEstimate?'계산값(추정)':'실측';
        wSub.textContent=`${diffTxt} · ${src}${currentState.water.stale?' · 시간차 큼':''}`;
      }
    } else {
      wEl.textContent='—'; wEl.className='dc-value color-muted';
      if(wSub) wSub.textContent='수위 데이터 없음';
    }
  }

  // 조석 + 물때
  const tEl=$('dc-tide'), tSub=$('dc-tide-sub');
  if(tEl){
    if(!b.tide){
      tEl.innerHTML='<span style="font-size:20px">제외</span>';
      tEl.className='dc-value color-muted';
      if(tSub) tSub.textContent='잠실수중보 상류 구간';
    } else if(currentState.tideActive===false){
      // 물때는 조석 차단 여부와 무관하게 표시
      const tnCur = tideNumber(searchDt||new Date(), tideRows);
      const tnTxt = tnCur ? `${tnCur.n}물 · ${tnCur.name}` : '';
      tEl.innerHTML=`<span style="font-size:20px;color:var(--muted)">차단</span>`;
      tEl.className='dc-value';
      if(tSub) tSub.innerHTML=`신곡수중보 정상 하류흐름<br>${tnTxt?`<strong style="color:var(--text)">${tnTxt}</strong>`:''}`;
    } else if(currentState.tide){
      const phase=currentState.tide.phase;
      const isMi=phase.includes('밀물');
      const tnCur = tideNumber(searchDt||new Date(), tideRows);
      const tnTxt = tnCur ? `${tnCur.n}물 · ${tnCur.name}` : '';
      tEl.innerHTML=`<span style="font-size:22px;font-weight:900;color:${isMi?'var(--blue)':'var(--orange)'}">${isMi?'밀물':'썰물'}</span>`;
      tEl.className='dc-value';
      if(tSub){
        let nextTxt='';
        if(currentState.tide.nextTurn){
          const nt=currentState.tide.nextTurn;
          const bt=new Date(nt.time.getTime()+(b.offset||0)*60000);
          nextTxt=`다음전환 ${String(bt.getHours()).padStart(2,'0')}:${String(bt.getMinutes()).padStart(2,'0')}`;
        }
        tSub.innerHTML=`${nextTxt?nextTxt+'<br>':''}<strong style="color:var(--text)">${tnTxt}</strong>`;
      }
    } else {
      tEl.textContent='미확인'; tEl.className='dc-value color-muted';
      if(tSub) tSub.textContent='조석 데이터 없음';
    }
  }

  // 이동경로 표시 제거 (신뢰도 40% — 현장 혼란 우려로 삭제)
}

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
      ${incidentState.velocity!==null?`<small class="muted">출처: ${incidentState.velSource} · 유량 Q=${incidentState.velQ?.toFixed(0)||'?'}㎥/s · 단면적 추정 포함</small><br><small style="color:#e05252;font-weight:700">⚠ 미검증 추정치 — 숫자는 참고용, 방향만 신뢰</small>`:''}
      </span>
    </div>
    <div class="kv" style="background:#f0f7ff;border-radius:6px;padding:8px 10px">
      <b>🌊 조회시점 참고유속</b>
      <span>${currentState.velocity!==null
        ? `<strong style="font-size:22px">${currentState.velocity.toFixed(2)} m/s</strong> · 시속 ${(currentState.velocity*3.6).toFixed(1)}km · ${currentState.velInfo?.label||''}`
        : '<span style="color:#b7791f">유속 계산 불가</span>'
      }<br>
      ${currentState.velocity!==null?`<small class="muted">출처: ${currentState.velSource} · 유량 Q=${currentState.velQ?.toFixed(0)||'?'}㎥/s · 단면적 추정 포함</small><br><small style="color:#e05252;font-weight:700">⚠ 미검증 추정치 — 숫자는 참고용, 방향만 신뢰</small>`:''}
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
      <small class="muted">${b.tide?`인천 조위관측소 예보값에 인천→교량 전파 지연(${b.offset}분, <b>조석 시차 로그 실측 기반 잠정값</b>)을 더한 보정값. 교량 직접 조석 측정값 아님.<br>⚠ 표본이 적고 저방류·사리 조건 기준 — 방류량이 크면 20~60분 짧아질 수 있음.<br>조석 영향 판단: 신곡수중보 owl-swl 수위차 기준 (>0 강한영향 / >-0.5 약한영향 / 이하 영향미미, 2026-07-21 보수적 조정)`:'HRFCO 수위와 팔당 방류량만 사용합니다.'}</small></span>
    </div>`;
}

// ── 신뢰도 패널 ──────────────────────────────────────────────
function renderReasonPanel(b,incidentState,currentState,q){
  const sec=$('reasonSection'),panel=$('reasonPanel');if(!sec||!panel)return;
  if(!currentState){sec.style.display='none';return;}
  const reliability=calcReliability(b,incidentState,currentState,q);
  const items=[
    {label:'신곡수중보', value:singokTideState.swl!==null?`swl ${singokTideState.swl.toFixed(2)}m`:'조회 실패',
     score:singokTideState.status!=='unknown'?0:0, desc:singokStatusLabel(singokTideState.swl, singokTideState.owl).text},
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
        순유속 ${r.netVelMs}m/s (${(r.netVelMs*3.6).toFixed(1)}km/h)<br>
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
  
  // ID로 컨테이너 찾기
  let el = document.getElementById(chartId);
  log('[그래프]', chartId, 'el='+!!el, 'data='+(data&&data.length), 'key='+key);
  if(!el){ log('[그래프 오류]', chartId, '엘리먼트 없음'); return; }
  if(el.tagName==='CANVAS') el = el.parentElement||el;

  // 데이터 필터링
  let pts = (data||[]).filter(d=>d&&d[key]!=null&&d.time).sort((a,b)=>a.time-b.time);
  log('[그래프 pts]', chartId, 'pts='+pts.length);
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
    gridY+=`<line x1="${PL}" y1="${yp}" x2="${W-PR}" y2="${yp}" stroke="#1e3050" stroke-width="0.8"/>`;
    labY+=`<text x="${PL-6}" y="${yp+4}" text-anchor="end" font-size="17" fill="#8a9bbf">${v.toFixed(2)}</text>`;
  }

  // X 눈금
  let labX='';
  for(let i=0;i<=4;i++){
    const tx=minX+spanX*i/4;
    const xp=Math.max(PL+20,Math.min(W-PR-20,sx(tx)));
    labX+=`<text x="${xp}" y="${H-8}" text-anchor="middle" font-size="17" fill="#8a9bbf">${fmtT(tx)}</text>`;
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

  // 클릭 핀 상태 저장
  el._chartPts = pts;
  el._chartKey = key;
  el._chartRange = {minX,maxX,minY,maxY,spanX,spanY,W,H,PL,PR,PT,PB,gW,gH};
  el._chartLabel = label;

  const svgId = 'svg_' + chartId;
  const pinId = 'pin_' + chartId;
  const tipId = 'tip_' + chartId;

  el.innerHTML = `
    <div style="padding:8px 12px 0;font-size:13px;font-weight:700;color:#f0f4ff">${label}</div>
    <div id="${tipId}" style="display:none;padding:6px 12px;background:#101828;color:#fff;font-size:12px;border-radius:6px;margin:0 12px 4px;line-height:1.6"></div>
    <svg id="${svgId}" viewBox="0 0 ${W} ${H}" width="100%" style="display:block;cursor:crosshair">
      ${gridY}${labY}${labX}${mkSvg}
      <path d="${pathD}" fill="none" stroke="#0f62fe" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${sx(last.time.getTime()).toFixed(1)}" cy="${sy(last[key]).toFixed(1)}" r="6" fill="#0f62fe"/>
      <g id="${pinId}"></g>
    </svg>`;
  el.style.cssText = 'width:100%;background:#1a2235;border:1px solid #1e2d45;border-radius:10px;overflow:hidden;box-sizing:border-box';

  // 클릭/터치 핀 이벤트
  const svgEl = document.getElementById(svgId);
  const pinEl = document.getElementById(pinId);
  const tipEl = document.getElementById(tipId);
  let pinActive = false;

  function handleChartClick(e){
    e.preventDefault();
    const rect = svgEl.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const ratioX = (clientX - rect.left) / rect.width;
    const svgX = ratioX * W;
    const tClick = minX + (svgX - PL) / gW * spanX;

    // 가장 가까운 포인트
    let best = null, bestDiff = Infinity;
    pts.forEach(p => {
      const d = Math.abs(p.time.getTime() - tClick);
      if(d < bestDiff){ bestDiff = d; best = p; }
    });
    if(!best) return;

    // 같은 포인트 다시 클릭 → 핀 해제
    if(pinActive && Math.abs(best.time.getTime() - pinActive) < 30000){
      pinEl.innerHTML = '';
      tipEl.style.display = 'none';
      pinActive = false;
      return;
    }
    pinActive = best.time.getTime();

    const px = (PL + (best.time.getTime()-minX)/spanX*gW).toFixed(1);
    const py = (PT + (1-(best[key]-minY)/spanY)*gH).toFixed(1);

    // 날짜+시간 포맷
    const d = best.time;
    const spanDays2 = spanX/86400000;
    const timeTxt = spanDays2 >= 1
      ? `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')} ${_hhmm(d)}`
      : _hhmm(d);

    // 단위 판별
    const unitLabel = label.includes('수위') ? 'm'
      : label.includes('방류') ? '㎥/s'
      : label.includes('조위') ? 'cm' : '';
    const valTxt = Number(best[key]).toFixed(2) + unitLabel;

    // SVG 핀
    pinEl.innerHTML = `
      <line x1="${px}" y1="${PT}" x2="${px}" y2="${PT+gH}" stroke="#f59e0b" stroke-width="2" stroke-dasharray="4,3"/>
      <circle cx="${px}" cy="${py}" r="7" fill="#f59e0b"/>
      <circle cx="${px}" cy="${py}" r="3" fill="#fff"/>
    `;

    // 말풍선 (SVG 위 div)
    tipEl.innerHTML = `⏱ ${timeTxt} &nbsp;|&nbsp; 📊 ${valTxt}`;
    tipEl.style.display = 'block';
  }

  if(svgEl){
    svgEl.addEventListener('click', handleChartClick);
    svgEl.addEventListener('touchstart', handleChartClick, {passive:false});
  }
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
  bindToggle('tideLagToggle','tideLagSection','▶ 조석 시차 로그 보기','▼ 조석 시차 로그 숨기기');
  const purged=purgeInvalidTideLagLog();
  if(purged) log('[조석시차로그]',`비물리적 기록 ${purged}건 정리 (시차 ${TIDE_LAG_MIN_WINDOW_MIN}분 미만)`);
  renderTideLagPanel();
  if($('exportTideLagBtn')) $('exportTideLagBtn').onclick=exportTideLagLog;
  if($('clearTideLagBtn')) $('clearTideLagBtn').onclick=clearTideLagLog;
  bindToggle('releaseLagToggle','releaseLagSection','▶ 방류 시차 로그 보기','▼ 방류 시차 로그 숨기기');
  renderReleaseLagPanel();
  if($('exportReleaseLagBtn')) $('exportReleaseLagBtn').onclick=exportReleaseLagLog;
  if($('clearReleaseLagBtn')) $('clearReleaseLagBtn').onclick=clearReleaseLagLog;
  log('[초기화]',`교량 ${BRIDGES.length}개`,`Phase 3.6.4 · 해도 수심 기준 정정 + 연속방정식 유속`);
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
      `판단기준: owl-swl > 0 → 역류(강), > -0.5 → 역류가능(약), 이하 → 정상흐름`);
  }catch(e){ singokTideState={status:'unknown',swl:null,time:null,checkedAt:new Date()}; q.singok='조회 실패'; log('[신곡수중보 실패]',e.message); }
  renderSingokStatus();

  // ② 수위 조회
  try{ waterRows=await getWaterSeries(key,b.code,start,end); }catch(e){ q.water='실패';log('[수위 실패]',e.message); }
  // ③ 방류량 조회
  try{ damRows=await getDamSeries(key,start,end); }catch(e){ q.dam='실패';log('[방류 실패]',e.message); }
  // ④ fallback
  try{ const p=await applyHrfcoFallbacks(key,b,waterRows,damRows);waterRows=p.waterRows;damRows=p.damRows; }catch(e){ log('[fallback 오류]',e.message); }
  // ④-2 ★ 연속방정식용 타 관측소 수위 (조석 구간만)
  //    구간별 실측 변화율을 써야 조석 진폭 감쇠가 반영됨
  let contStationRows={};
  if(b.tide){
    for(const st of CONT_STATIONS){
      if(st.code===b.code){ contStationRows[st.code]=waterRows; continue; }
      try{ contStationRows[st.code]=await getWaterSeries(key,st.code,start,end); }
      catch(e){ log('[연속방정식 관측소 실패]',st.name,e.message); }
    }
    const got=Object.values(contStationRows).filter(r=>r?.length).length;
    log('[연속방정식]',`관측소 ${got}/${CONT_STATIONS.length}곳 수위 확보`);
  }
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

  // ★ 운항기준도 수심 DB를 상태 계산 전에 로드 — 유속 단면적에 해도 실측 수심을 쓰기 위함
  try{ await loadNavChartDB(); }catch(e){ log('[운항기준도 로드 실패]', e.message); }

  // 포인트 상태 계산
  const incidentState=makePointState('투신시점',b,incident,waterRows,damRows,tideRows,waterMetric,damMetric,singokSwlAtIncident,singokOwlAtIncident,contStationRows);
  const currentState =makePointState('조회시점',b,search,  waterRows,damRows,tideRows,waterMetric,damMetric,singokSwlAtSearch,  singokOwlAtSearch,contStationRows);
  const decision=flowDecisionFromState(currentState);

  // 렌더링
  try{ renderDepthCard(b, incidentState, currentState, NAV_CHART_DB); }catch(e){ log('[오류] renderDepthCard',e.message); }

  try{ renderSummary(b,incidentState,currentState,decision,tideRows); }catch(e){ log('[오류] renderSummary',e.message,e.stack?.split('\n')[1]); }
  try{ renderPointCompare(b,incidentState,currentState); }catch(e){ log('[오류] renderPointCompare',e.message,e.stack?.split('\n')[1]); }
  try{ renderDataFirstPanel(b,incidentState,currentState,q); }catch(e){ log('[오류] renderDataFirstPanel',e.message); }
  // renderDriftEstimate 제거 (신뢰도 40%)
  // 3초 판단 카드 업데이트
  try{
    renderDecisionCard(b,currentState,incidentState,null,tideRows,search);
  }catch(e){ log('[오류] renderDecisionCard',e.message); }
  try{ renderDeltaPanel(incidentState,currentState); }catch(e){ log('[오류] renderDeltaPanel',e.message); }
  try{ renderReasonPanel(b,incidentState,currentState,q); }catch(e){ log('[오류] renderReasonPanel',e.message); }
  try{ renderDataWarnings(b,incidentState,currentState,q,dataCapped,singokRows,tideRows); }catch(e){ log('[오류] renderDataWarnings',e.message); }
  try{ renderModelInfo(b); }catch(e){ log('[오류] renderModelInfo',e.message); }
  try{
    const _wKeys=waterMetric?.key?[waterMetric.key]:WATER_KEYS;
    const _wPts=rowsToPoints(waterRows,_wKeys);
    const r=accumulateTideLag(b,tideRows,damRows,singokRows,search,_wPts);
    if(r.added) log('[조석시차로그]',`${r.added}건 신규 누적 (기준:${b.tide?b.bridge:'신곡보'}, 누적 ${loadTideLagLog().length}건)`);
    renderTideLagPanel();
  }catch(e){ log('[오류] accumulateTideLag',e.message); }
  try{
    const _wKeys2=waterMetric?.key?[waterMetric.key]:WATER_KEYS;
    const _wPts2=rowsToPoints(waterRows,_wKeys2);
    const rr=accumulateReleaseLag(b,damRows,_wPts2);
    if(rr.added) log('[방류시차로그]',`${rr.added}건 신규 누적 (교량:${b.bridge}, 누적 ${loadReleaseLagLog().length}건)`);
    else log('[방류시차로그]',`0건 — ${rr.reason||'알 수 없음'}`);
    renderReleaseLagPanel();
  }catch(e){ log('[오류] accumulateReleaseLag',e.message); }

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
    const t=currentState.tide,offset=(t && t.offsetUsed==='간조보정') ? offsetForTideType(b,'간조') : (b.offset||0);
    let html=`<div class="tide-turn-item"><b>현재 조석</b><span>${t.phase}</span><div class="tide-ref-note">인천(${TIDE_STATION}) 실측값 + ${offset}분 도달지연 보정${t.offsetUsed==='간조보정'?' (간조 보정)':''} · 신곡수중보 swl ${singokSwlAtSearch?.toFixed(2)??'?'}m</div></div>`;
    if(t.nextTurn){
      const turnOffset=offsetForTideType(b,t.nextTurn.type);
      const bt=new Date(t.nextTurn.time.getTime()+turnOffset*60000);
      const lowNote = t.nextTurn.type==='간조' ? (STATION_LOWTIDE_DELTA[b.code]?` · 간조 보정 적용(${STATION_LOWTIDE_DELTA[b.code].note}, 표본 적어 참고용)`:' · 간조 보정 자료 없음, 만조용 offset 그대로 사용') : '';
      html+=`<div class="tide-turn-item"><b>다음 ${t.nextTurn.type} · 교량 도달추정</b><span>${hhmm(bt)}</span><div class="tide-ref-note">⚠ 이 시각은 실측이 아니라 예측입니다 — 인천에서 실제 ${t.nextTurn.type}가 일어난 시각(${hhmm(t.nextTurn.time)})에 교량별 도달지연(+${turnOffset}분)을 더한 값${lowNote}</div></div>`;
    }
    if(t.rateCmHr!==null)html+=`<div class="tide-turn-item"><b>변화율</b><span>${t.rateCmHr>0?'+':''}${t.rateCmHr}cm/h</span><div class="tide-ref-note">인천 실측 기준(교량 도달지연 미반영)</div></div>`;
    el.innerHTML=html;
  })();

  const tideRangeStart=new Date(incident.getTime()-30*60000);
  const tideRangeEnd=new Date(effectiveSearch.getTime()+30*60000);
  if(tideRows.length){
    drawLine('tideChart',tidePts,'value',`인천 조위(cm) · ${TIDE_STATION} · 인천 원시 시각(교량 미보정) · ${hhmm(tideRangeStart)} ~ ${hhmm(tideRangeEnd)}`,markers,{start:tideRangeStart,end:tideRangeEnd});
    $('tideChartNote').textContent=(currentState.tide?`이 그래프는 인천 원시 관측 시각입니다(교량 보정 미적용). 이 교량 도달추정 시각은 위 "다음 만조/간조" 카드를 참고하세요(+${b.offset||0}분).`:'조석 매칭 실패')+(dataCapped?` ⚠ 데이터 ${Math.round((search-end)/60000)}분 지연`:' (그래프 범위: 투신 30분전 ~ 조회 30분후)');
  } else {
    drawLine('tideChart',[],'value','조석',[]);
    $('tideChartNote').textContent=b.tide?'조석 API 미조회':'조석 적용 제외 구간';
  }

  $('tideSummary').innerHTML=currentState.tide?`<div class="summary-big">${currentState.tide.phase}</div><div>${fmtTidePoint(b,currentState.tide,currentState.tideActive)}</div>`:`<div class="summary-big">${!b.tide?'조석 적용 제외':currentState.tideActive===false?'⛔ 조석 차단 (신곡수중보 낮음)':singokTideState.status==='unknown'?'신곡수중보 수위 조회 실패':'조석 미조회'}</div>`;

  renderBoard([{bridge:b.bridge,direction:`${currentState.direction} · ${currentState.speed}`}],b,currentState);
  $('inputStatus').textContent=`조회 완료${dataCapped?` · ⚠ HRFCO 데이터 ${Math.round((search-end)/60000)}분 지연`:''} · 신곡수중보 swl=${singokTideState.swl?.toFixed(2)??'조회실패'}m`;
  // ★ 화면 회전 시 재렌더를 위해 마지막 조회 파라미터 저장
  window._lastRunQuery = runQuery;
  LAST_QUERY_CTX = {b, currentState, key, tideKey, search};
}

document.addEventListener('DOMContentLoaded', init);

// ★ 모바일 대응: 화면 회전·크기 변경 시 그래프 재렌더
window.addEventListener('resize', () => {
  if(window._lastRunQuery) {
    clearTimeout(window._resizeTimer);
    window._resizeTimer = setTimeout(()=>{ window._lastRunQuery(); }, 300);
  }
});
