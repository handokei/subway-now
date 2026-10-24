# data/raw/used/ — 사용된 원본 데이터

## 박제 룰

- **인코딩**: 모든 CSV는 UTF-8 (cp949 원본은 iconv로 변환 후 박제). xls/xlsx는 binary 그대로.
- **BOM**: 추가 없음.
- **slim**: 원본 컬럼을 그대로 보존(역명/호선/형식/비고 등 미사용 컬럼 포함). ingest script가 필요 컬럼만 선택. PR #1492의 slim 룰은 ingest 단계에서 적용되며 archive에는 raw 원본을 둔다.
- **파일명**: Downloads/ 원본 그대로 (공백/대소문자/괄호 포함). 중복 `(1)` suffix만 제거.

## ingest script 매핑

`tasks/` 또는 fixtures/에 보존된 ingest 입력은 영향받지 않는다 (이 폴더는 archive 백업).

| 데이터 | 활용 PR | ingest target |
|---|---|---|
| 역사건축정보 | #1444 | stations.json `platformInfo` 일부 |
| 역사심도정보 | #1467 | stations.json `depth` 보완 |
| 환승정보 | #1464 | stations.json `transfers[].walkSeconds/walkMeters` |
| 승강장정보 (1~9호선 + 광역) | #1462/#1463/#1468/#1470 | platform 형식/길이/지상구분 |
| 우이신설 역구조 | #1470 | 우이신설 노선 |
| 역간거리 시리즈 | #1473/#1492+ | 인접역 거리 SSOT |
| tnSubwayWifi | #1475 | WiFi SSID/위치 |

## 갱신 절차

1. 공공데이터포털에서 신규 버전 다운로드 (파일명 suffix YYYYMMDD 갱신)
2. cp949 인코딩이면 `iconv -f CP949 -t UTF-8 in.csv > out.csv`로 변환
3. 이 폴더에 덮어쓰기 + 상위 `data/raw/README.md` 카탈로그의 "활용 PR" 컬럼에 갱신 PR # 추가
4. ingest script (fixtures/ + tasks/) 재실행
