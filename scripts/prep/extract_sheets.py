"""수치지도(1:5,000) 도엽 zip들에서 필요한 레이어만 풀어 도엽별 폴더에 둔다.

사용법:
    python -I extract_sheets.py <zip들이 있는 폴더> <출력 폴더>

출력: <출력 폴더>/<도엽번호>/<레이어>.shp ...
"""
import os
import re
import sys
import zipfile

LAYERS = {
    "N3L_F0010000",  # 등고선
    "N3P_F0020000",  # 표고점
    "N3P_H0020000",  # 삼각점
    "N3P_H0059153",  # 산 정상
    "N3A_H0010000",  # 도엽 경계
    "N3L_A0020000",  # 도로 중심선
    "N3L_A0033330",  # 자전거보행자겸용도로 (선)
    "N3A_A0033320",  # 인도 (면)
    "N3A_A0010000",  # 도로 경계 (면)
    "N3A_A0070000",  # 교량
    "N3A_A0080000",  # 교차로
    "N3A_C0390000",  # 계단·스탠드
    "N3L_F0040000",  # 옹벽
    "N3L_F0030000",  # 절토·성토
    "N3A_B0010000",  # 건물 (시설 이름 찾기용)
    "N3P_H0040000",  # 지명
    "N3A_G0010000",  # 행정경계 (동해시 경계로 자르기)
    "N3A_A0063321",  # 육교 (형태: 장애인이용여부)
    "N3A_A0090000",  # 입체교차부 (지하차도·고가차도, 보도 유무)
    "N3A_A0110020",  # 터널
    "N3P_A0131122",  # 철도역
}
EXTS = (".shp", ".shx", ".dbf", ".prj", ".cpg")


def main():
    src, out = sys.argv[1], sys.argv[2]
    zips = sorted(f for f in os.listdir(src) if f.lower().endswith(".zip"))
    n = 0
    for zf in zips:
        m = re.search(r"_(\d{8})_", zf)
        if not m:
            continue
        sheet = m.group(1)
        dst = os.path.join(out, sheet)
        os.makedirs(dst, exist_ok=True)
        with zipfile.ZipFile(os.path.join(src, zf)) as z:
            for info in z.infolist():
                base = os.path.basename(info.filename)
                stem, ext = os.path.splitext(base)
                if stem in LAYERS and ext.lower() in EXTS and ".." not in base:
                    with open(os.path.join(dst, base), "wb") as f:
                        f.write(z.read(info))
        n += 1
    print(f"{n} sheets extracted to {out}")


if __name__ == "__main__":
    main()
