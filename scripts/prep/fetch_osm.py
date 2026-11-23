"""동해시 범위 OSM 길(highway)을 Overpass API에서 받아 raw/osm_donghae.json에 저장한다 (raw/는 git 제외).

사용법: python -I fetch_osm.py
OSM 데이터는 ODbL이다: '© OpenStreetMap contributors' 표기, 파생 레이어는 우리 길 데이터와 따로 배포 (HANDOFF 3절).
"""
import json
import os
import subprocess

BBOX = (37.42, 128.98, 37.61, 129.17)   # 남, 서, 북, 동
MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
           "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw", "osm_donghae.json")
Q = f"""[out:json][timeout:180];
way["highway"~"^(footway|path|pedestrian|steps|service|living_street|residential|unclassified|cycleway|corridor|track)$"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
out tags geom;"""


def main():
    # 시스템 Python의 오래된 TLS로는 Overpass에 붙지 않아 curl을 쓴다. 서버가 붐비면 다른 미러로
    d = body = None
    for url in MIRRORS:
        body = subprocess.run(["curl", "-s", "-m", "240", "-A", "donghae-barrier-free-map/0.1 (hackathon)", "-H", "Accept: application/json",
                               url, "--data-urlencode", f"data={Q}"], capture_output=True).stdout
        try:
            d = json.loads(body)
            print(f"받음: {url}")
            break
        except ValueError:
            print(f"실패: {url} ({body[:80]!r})")
    if d is None:
        raise SystemExit("모든 Overpass 서버가 응답하지 않습니다. 잠시 뒤 다시 실행하세요")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as f:
        f.write(body)
    print(f"OSM 길 {len(d.get('elements', []))}개 → {OUT} ({len(body) / 1e6:.1f}MB), 기준 시각 {d.get('osm3s', {}).get('timestamp_osm_base')}")


if __name__ == "__main__":
    main()
