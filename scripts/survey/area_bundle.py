"""slope_bundle.py가 쓰는 공용 기준값·함수 (복원판, 2026-11-21).

원래 이 파일은 예전 현장 조사판(#survey)용 데이터 묶음(area.json)을 만드는 스크립트였고, 2026-11-20 조사판을 없앨 때
함께 지웠다. 그런데 slope_bundle.py가 산길 판정 기준값과 건물 읽기 함수를 여기서 가져다 쓰고 있어, 그 부분만 다시 만들었다.
값의 근거: HANDOFF.md 3절(산길 제외 규칙), load_survey.py(ASSUMED_ID0 = 900001 = LINK_ID0),
지금 앱 데이터(app/public/data/donghae_city.json)의 산길 판정 이유. 복원한 값으로 donghae_city.json을 다시 만들어
원래 파일과 같은지 확인했다 (팀 논의 기록).
배경 지도 그림(render_basemap)은 복원하지 않았다: 동해시 전체 지도는 --no-basemap(카카오 지도)으로 만든다.
"""
import os

import shapefile
from shapely.geometry import box, shape

SRC_CRS = "EPSG:5187"          # 수치지도 좌표계 (donghae_pipeline.py CRS와 같음)
ENC = "cp949"

# 산길 추정 (경로에서 뺀다): 고도 MOUNTAIN_Z_M 초과, 또는 폭 MOUNTAIN_MAX_W_M 이하
# MOUNTAIN_CLASSES 길이 급경사 추정인데 MOUNTAIN_BUILDING_M 안에 건물이 없음 (임도·농로)
MOUNTAIN_Z_M = 120.0
MOUNTAIN_MAX_W_M = 4.0
MOUNTAIN_CLASSES = {"소로", "면리간도로", "미분류"}
MOUNTAIN_BUILDING_M = 40.0

# 연결 추정: 큰 도로망에서 떨어진 기관을 가장 가까운 노드와 직선으로 잇는다
LINK_ID0 = 900001
LINK_MAX_M = 500.0


def read_layer(raw, name, bbox=None):
    """수치지도 도엽 폴더들(raw/도엽번호/name.shp)에서 도형 목록 (EPSG:5187). bbox [minx, miny, maxx, maxy]에 걸치는 것만"""
    clip = box(*bbox) if bbox else None
    out, seen = [], set()
    for sheet in sorted(os.listdir(raw)):
        p = os.path.join(raw, sheet, name + ".shp")
        if not os.path.exists(p):
            continue
        r = shapefile.Reader(p, encoding=ENC)
        names = [f[0] for f in r.fields[1:]]
        for sr in r.iterShapeRecords():
            gi = sr.shape.__geo_interface__
            if not gi or not gi.get("coordinates"):
                continue
            rec = dict(zip(names, sr.record))
            key = rec.get("UFID")
            if key is not None and key in seen:   # 도엽 경계에 걸친 같은 도형
                continue
            g = shape(gi)
            if g.is_empty or (clip is not None and not g.intersects(clip)):
                continue
            if key is not None:
                seen.add(key)
            out.append(g)
    return out


def render_basemap(*_args, **_kwargs):
    raise SystemExit("배경 지도 그림(render_basemap)은 복원하지 않았습니다. --no-basemap으로 만드세요 (카카오 지도 사용).")
