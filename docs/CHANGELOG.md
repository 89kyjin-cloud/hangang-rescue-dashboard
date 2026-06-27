# CHANGELOG

## v1.0 Phase 2.7 RestoreBaseWeather

- 사용자가 처음 올린 정상 파일 `v1.0 Phase 2.3 FieldFix`를 베이스로 재작업
- 수위/방류량 파싱·필드검증 로직은 기존 정상 로직 보존
- 잠실철교를 잠실수중보 상류 조석 제외로 수정
- 잠실대교를 잠실수중보 영향권 조석 제외로 수정
- 기상청 초단기실황 API 보조조회 추가
- 풍향·풍속은 실측 유속이 아닌 참고판정 보조요소로만 반영
- 데이터 신뢰도 표시 추가

## v1.0 Phase 2.3 FieldFix

- 수위/방류량 필드 자동탐지 강화
- 후보 필드 검증 실패 시 원자료 첫 행 전체 키와 샘플 표시
- 수위/방류량 0 임의 표시 방지 유지
- 조석 API `GetTideFcstTimeApiService` 유지
- `index.html`의 `app.js` 캐시 버전 `fieldfix`로 변경
