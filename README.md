# 경사났네 · 동해 무장애지도

휠체어·유모차로 갈 수 있는 길을 경사 기준으로 안내하는 동해시 무장애지도입니다. G-Lab@동해 해커톤(2026-11-20~21) 출품작입니다.

- 서비스: https://donghae-barrier-free-map.vercel.app
- 동해시 전체 길 34,000여 구간의 경사를 국토지리정보원 수치지도(1:5,000)로 추정하고, 시민 제보와 현장 측정으로 고쳐 나갑니다.

## 주요 기능

| 기능 | 내용 |
| --- | --- |
| 휠체어 길 안내 | 경사 8.3% 이하, 인도 폭 1.2m 이상, 턱 2cm 이하(장애인등편의법 접근로 기준)인 길로만 경로를 찾습니다. 가장 짧은 길과 함께 보여 주고, 경사가 있는 구간과 돌아가는 이유를 지도에 표시합니다 |
| 말로 길 찾기 | "A에서 B로 가는 길 알려줘"라고 말하거나 쓰면 출발지와 도착지를 알아듣고 바로 경로를 찾습니다 |
| 앱 안 로드뷰 | 경로를 막는 곳을 카카오 로드뷰로 바로 확인합니다 |
| 시민 제보 | 단차(턱), 계단, 기타 장애물을 위치와 함께 제보합니다 |
| 관리자 화면 (`/#admin`) | 제보 확인, 장애물 등록, 길 경사 수정, 데이터에 없는 길 그려 넣기 (자석·직교 모드). 고친 값은 곧바로 길 안내에 쓰입니다 |
| 공개 데이터 | 구간·장애물 레이어를 GeoJSON·CSV와 공개 API(`/api/features`)로 제공합니다 |

## 한계

경사는 수치지도 등고선으로 계산한 **추정값**입니다. 등고선 간격과 높이 오차 때문에 일부 길은 실제보다 가파르게 잡혀, 휠체어 경로가 크게 돌아가거나 길이 없다고 나올 수 있습니다. 시민 제보와 현장 측정이 쌓이면 추정값이 실측값으로 바뀌어 정확해집니다.

## 폴더

```
app/                  React 앱 (Vite, PWA) + Vercel 함수 (app/api: AI·음성 인식·공개 API)
app/public/data/      앱이 쓰는 동해시 길 데이터 (아래 '데이터'의 가공 결과)
supabase/migrations/  DB 구조·함수 (PostgreSQL + PostGIS)
scripts/prep/         수치지도 → 구간망·경사 추정 파이프라인, DB 적재 (Python)
scripts/survey/       앱 데이터 묶음, 인도 보행망
docs/                 기획·기술 문서
```

## 실행

```bash
cd app
cp .env.example .env.local   # 아래 '키'를 채운다
npm install
npm run dev                  # http://localhost:5173
npm test                     # Vitest
npm run build
```

### 키 (`app/.env.local`)

| 이름 | 용도 | 받는 곳 |
| --- | --- | --- |
| `VITE_KAKAO_JS_KEY` | 지도 (필수) | [카카오 개발자](https://developers.kakao.com) 앱 → JavaScript 키, 사이트 도메인에 `http://localhost:5173` 등록 |
| `KAKAO_REST_KEY` | 장소 검색 | 같은 앱의 REST API 키 |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | 제보·관리자·현장 측정 | [Supabase](https://supabase.com) 프로젝트. DB 구조는 `supabase/migrations/`를 차례로 적용 |
| `BAZE_API_KEY`, `BAZE_BASE_URL`, `BAZE_MODEL` | 말로 길 찾기, 음성 인식 (선택) | OpenAI 호환 AI 게이트웨이 |

`VITE_`로 시작하는 값만 브라우저로 갑니다. 나머지는 서버(개발 서버의 `/api/*`, 배포 시 Vercel 환경 변수)에서만 씁니다. 지도 키만 있어도 길 안내는 동작합니다.

## 데이터

이 저장소에는 **원본 공공데이터를 넣지 않았습니다.** 앱이 쓰는 가공 결과(`app/public/data/`)만 들어 있습니다.

| 데이터 | 출처 | 이용 조건 |
| --- | --- | --- |
| 도로 중심선·인도·등고선·표고점 등 | 국토지리정보원 수치지도 1:5,000 (2025), [국토정보플랫폼](https://map.ngii.go.kr) | 공공누리 제1유형 (출처 표시) |
| 횡단보도 위치·턱낮춤 | 행정안전부 전국횡단보도표준데이터, [공공데이터포털](https://www.data.go.kr) | 공공데이터 이용 조건 |
| 보완 길 (단지 안 길·보행로 등) | © OpenStreetMap contributors | ODbL. OSM 형상이 들어간 `app/public/data/` 구간 데이터는 ODbL 동일조건이 붙습니다 |
| 바탕 지도·로드뷰·장소 검색 | 카카오 | 카카오 API 이용약관 |

### 데이터 다시 만들기

1. 국토정보플랫폼에서 동해시 수치지도(1:5,000) 도엽 zip을 받아 한 폴더에 둡니다.
2. 공공데이터포털에서 전국횡단보도표준데이터 CSV를 받습니다.
3. `scripts/prep/requirements.txt`로 가상환경을 만든 뒤 아래를 차례로 실행합니다.

```bash
python -I scripts/prep/extract_sheets.py <zip 폴더> scripts/prep/raw/donghae_5000
python -I scripts/prep/fetch_osm.py
python -I scripts/prep/donghae_pipeline.py scripts/prep/raw/donghae_5000 <횡단보도 CSV> scripts/prep/out/road_city --osm scripts/prep/raw/osm_donghae.json
python -I scripts/survey/slope_bundle.py scripts/prep/out/road_city scripts/prep/raw/donghae_5000 --out app/public/data --all --no-basemap --center 동해시청 --view 1500 --radius 13000 --file donghae_city.json --walk donghae_walk.json
```

## 문서

| 문서 | 내용 |
| --- | --- |
| [HANDOFF.md](HANDOFF.md) | 설계 결정 모음 (코드 주석의 'HANDOFF N절'이 가리키는 문서) |
| [무장애 경로 추천 기준.md](무장애%20경로%20추천%20기준.md) | 휠체어 경로 규칙과 법적 근거 |
| [docs/PRD.md](docs/PRD.md) | 무엇을 왜 만드는지, 요구사항 |
| [docs/TECH_SPEC.md](docs/TECH_SPEC.md) | 기술 구성, 데이터 구조, API |
| [docs/BACKEND.md](docs/BACKEND.md) | 데이터 파이프라인과 DB |
| [docs/FIELD_APP.md](docs/FIELD_APP.md) | 현장 조사 방법 |
| [docs/openapi.yaml](docs/openapi.yaml) | 공개 API 명세 |
| [docs/PLANNING.md](docs/PLANNING.md) | 배경과 근거 |

## 라이선스

- 코드: [MIT](LICENSE)
- 데이터(`app/public/data/`): 위 '데이터' 표의 출처별 이용 조건을 따릅니다 (수치지도 공공누리 제1유형, OSM 형상 ODbL)
