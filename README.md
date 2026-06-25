# HanRiver Environment Dashboard v1.0 Phase 1

한강 교량별 수위·방류량·조석·조류 방향 분석을 위한 데이터 엔진 검증판입니다.

## 핵심 원칙
- API 실패 시 임의값으로 대체하지 않습니다.
- 수위는 수심이 아니라 관측소 기준값입니다.
- 조류 방향은 수위 변화 + 방류량 + 보정 조석 기반의 계산값입니다.
- 잠실수중보 상류 구간은 조석 적용 제외로 처리합니다.

## 파일 구조
- `index.html` 화면
- `css/style.css` 디자인
- `js/app.js` API 호출·계산·그래프
- `docs/CHANGELOG.md` 변경 이력
