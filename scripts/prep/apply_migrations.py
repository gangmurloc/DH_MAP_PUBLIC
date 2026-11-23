"""supabase/migrations/*.sql을 순서대로 Supabase(Postgres)에 올린다. 이미 올린 파일은 건너뛴다.

사용법:
    python -I apply_migrations.py [--dry-run]

연결: 환경 변수 DATABASE_URL, 없으면 app/.env.local의 SUPABASE_DB_PASSWORD와 VITE_SUPABASE_URL로
Supabase 연결 풀러(세션 모드) 주소를 만든다. DB 비밀번호는 화면에 출력하지 않는다 (HANDOFF 10절).
기록은 Supabase CLI와 같은 표(supabase_migrations.schema_migrations)에 남겨, 나중에 `supabase db push`와 겹치지 않게 한다.
"""
import argparse
import glob
import os
import re
import sys
from urllib.parse import quote

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
POOLERS = ["aws-0-ap-northeast-1", "aws-1-ap-northeast-1", "aws-0-ap-northeast-2", "aws-1-ap-northeast-2"]  # 이 프로젝트는 도쿄(ap-northeast-1)


def env_local():
    out = {}
    p = os.path.join(ROOT, "app", ".env.local")
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
            if m:
                out[m.group(1)] = m.group(2).strip().strip('"')
    return out


def candidates():
    if os.environ.get("DATABASE_URL"):
        yield "DATABASE_URL", os.environ["DATABASE_URL"]
        return
    e = env_local()
    pw, url = e.get("SUPABASE_DB_PASSWORD"), e.get("VITE_SUPABASE_URL", "")
    ref = re.sub(r"^https://|\.supabase\.co/?$", "", url)
    if not pw or not ref:
        sys.exit("app/.env.local에 SUPABASE_DB_PASSWORD와 VITE_SUPABASE_URL이 필요합니다")
    for host in POOLERS:
        yield f"풀러 {host}", f"postgresql://postgres.{ref}:{quote(pw, safe='')}@{host}.pooler.supabase.com:5432/postgres"
    yield "직접 연결", f"postgresql://postgres:{quote(pw, safe='')}@db.{ref}.supabase.co:5432/postgres"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    import psycopg
    conn = None
    for label, dsn in candidates():
        try:
            conn = psycopg.connect(dsn, autocommit=True, connect_timeout=8)
            print(f"연결: {label}")
            break
        except Exception as ex:   # 비밀번호가 든 주소는 출력하지 않는다
            print(f"연결 실패: {label} ({type(ex).__name__}: {str(ex).splitlines()[0][:120]})")
    if conn is None:
        sys.exit("DB에 연결하지 못했습니다")
    with conn:
        conn.execute("create schema if not exists supabase_migrations")
        conn.execute("create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)")
        done = {r[0] for r in conn.execute("select version from supabase_migrations.schema_migrations")}
        for path in sorted(glob.glob(os.path.join(ROOT, "supabase", "migrations", "*.sql"))):
            base = os.path.basename(path)
            version, name = base.split("_", 1)
            if version in done:
                print(f"건너뜀 (이미 올림): {base}")
                continue
            if a.dry_run:
                print(f"올릴 예정: {base}")
                continue
            sql = open(path, encoding="utf-8").read()
            with conn.transaction():
                conn.execute(sql)
                conn.execute("insert into supabase_migrations.schema_migrations (version, statements, name) values (%s, %s, %s)",
                             (version, [sql], name.removesuffix(".sql")))
            print(f"올림: {base}")


if __name__ == "__main__":
    main()
