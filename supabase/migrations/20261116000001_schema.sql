-- 동해 무장애지도: 기본 구조 (TECH_SPEC 4절)
-- 좌표: WGS84(EPSG:4326). 거리 계산은 geography로 한다.
-- 구간망 원천: 국토지리정보원 수치지도 1:5,000 도로 중심선(2025) — OSM 대신 사용 (TECH_SPEC 3절 변경 사항)

create extension if not exists postgis with schema extensions;
create extension if not exists pgrouting with schema extensions;

-- ─────────────── 값 정의 ───────────────
create type public.segment_grade as enum ('unsurveyed', 'passable', 'caution', 'difficult');
create type public.grade_source as enum ('dem', 'survey');
create type public.dem_estimate as enum ('gentle', 'moderate', 'steep', 'unknown');
create type public.obstacle_type as enum ('kerb', 'stairs', 'steep', 'narrow', 'damaged');
create type public.obstacle_status as enum ('reported', 'confirmed', 'verified', 'resolved', 'hidden');
create type public.report_status as enum ('pending', 'confirmed', 'not_found', 'hidden');
create type public.measure_key as enum ('incline', 'cross_slope', 'kerb:height', 'width');
create type public.measure_source as enum ('dem', 'phone_sensor', 'field_verified', 'digital_level');
create type public.target_type as enum ('segment', 'obstacle');
create type public.kerb_kind as enum ('lowered', 'raised', 'flush');

-- ─────────────── 구간망 ───────────────
create table public.nodes (
  id                 bigint primary key,
  geom               extensions.geometry(Point, 4326) not null,
  degree             integer not null default 0,
  crossing           boolean not null default false,
  crossing_count     integer not null default 0,
  crossing_kerb      public.kerb_kind,            -- 횡단보도 턱: lowered(낮춤) / raised(낮춤 없음) / flush(고원식)
  crossing_ambiguous boolean not null default false, -- 같은 좌표에 여러 횡단보도 → 어느 쪽인지 불명
  crossing_source    text
);

create table public.segments (
  id                  bigint primary key,
  source              bigint not null references public.nodes(id),
  target              bigint not null references public.nodes(id),
  geom                extensions.geometry(LineString, 4326) not null,
  length_m            double precision not null check (length_m > 0),
  kind                text not null default 'road',    -- road / ped_bike
  road_class          text,
  road_name           text,
  road_width_m        real,
  lanes               integer,
  paved               boolean,
  has_sidewalk        boolean not null default false,
  sidewalk_width_m    real,
  sidewalk_surface    text,
  on_bridge           boolean not null default false,
  near_stairs         boolean not null default false,
  near_wall           boolean not null default false,
  near_cut            boolean not null default false,
  in_tunnel           boolean not null default false,
  underpass_no_sidewalk boolean not null default false,  -- 수치지도 입체교차부: 지하차도, 보도 '무'
  overpass_nearby     text check (overpass_nearby in ('accessible', 'inaccessible')),  -- 겹치는 육교의 장애인 이용 여부
  z_start             real,
  z_end               real,
  dem_incline_pct     real,              -- source→target 방향 평균 경사 (부호 있음)
  dem_incline_max_pct real,              -- 30m 창 최대 |경사|
  dem_estimate        public.dem_estimate not null default 'unknown',
  check_items         text[] not null default '{}',
  grade               public.segment_grade not null default 'unsurveyed',
  grade_source        public.grade_source,
  surveyed_at         timestamptz,
  source_data         text not null default 'ngii_5000_2025',
  updated_at          timestamptz not null default now()
);
create index segments_geom_idx on public.segments using gist (geom);
create index segments_source_idx on public.segments (source);
create index segments_target_idx on public.segments (target);
create index segments_grade_idx on public.segments (grade);
create index nodes_geom_idx on public.nodes using gist (geom);

create table public.crosswalks (
  id            bigserial primary key,
  geom          extensions.geometry(Point, 4326) not null,
  node_id       bigint references public.nodes(id),
  node_dist_m   real,
  manage_no     text,
  kind          text,
  road_name     text,
  lanes         integer,
  width_m       real,
  length_m      real,
  kerb          public.kerb_kind,
  raised_table  boolean,
  tactile       boolean,
  ped_signal    boolean,
  island        boolean,
  data_date     date
);
create index crosswalks_geom_idx on public.crosswalks using gist (geom);

create table public.places (
  id           serial primary key,
  name         text not null unique,
  category     text not null,
  geom         extensions.geometry(Point, 4326) not null,
  nearest_node bigint references public.nodes(id)
);

-- ─────────────── 조사·장애물·측정 ───────────────
create table public.segment_surveys (
  id               bigserial primary key,
  segment_id       bigint not null references public.segments(id) on delete cascade,
  grade            public.segment_grade not null check (grade <> 'unsurveyed'),
  suggested_grade  public.segment_grade not null,
  reasons          jsonb not null default '[]',
  override_reason  text,
  surveyor_id      uuid not null,
  surveyed_at      timestamptz not null default now(),
  constraint override_needs_reason check (grade = suggested_grade or nullif(btrim(override_reason), '') is not null)
);
create index segment_surveys_segment_idx on public.segment_surveys (segment_id, surveyed_at desc);

create table public.obstacles (
  id          bigserial primary key,
  geom        extensions.geometry(Point, 4326) not null,
  type        public.obstacle_type not null,
  tags        jsonb not null default '{}',     -- 범주형 OSM 태그 (예: {"kerb":"raised"})
  segment_id  bigint references public.segments(id),
  status      public.obstacle_status not null default 'reported',
  photo_path  text,                            -- 비공개
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index obstacles_geom_idx on public.obstacles using gist (geom);
create index obstacles_segment_idx on public.obstacles (segment_id);

create table public.measurements (
  id           bigserial primary key,
  target_type  public.target_type not null,
  target_id    bigint not null,
  key          public.measure_key not null,
  value        double precision not null,
  unit         text not null,                  -- incline·cross_slope: '%', kerb:height·width: 'm'
  source       public.measure_source not null,
  heading_deg  real check (heading_deg is null or (heading_deg >= 0 and heading_deg < 360)),
  geom         extensions.geometry(Point, 4326),
  note         text,
  measured_by  uuid,
  measured_at  timestamptz not null default now(),
  constraint unit_matches_key check ((key in ('incline', 'cross_slope') and unit = '%') or (key in ('kerb:height', 'width') and unit = 'm'))
);
create index measurements_target_idx on public.measurements (target_type, target_id);

-- ─────────────── 시민 제보 ───────────────
create table public.reports (
  id              bigserial primary key,
  user_id         uuid not null default auth.uid(),
  geom            extensions.geometry(Point, 4326) not null,
  type            public.obstacle_type not null,
  loc_source      text check (loc_source in ('gps', 'photo_exif', 'manual')),
  accuracy_m      real,
  pin_adjusted    boolean not null default false,
  user_type       text,
  text            text check (char_length(text) <= 500),
  photo_path      text,
  license_agreed  boolean not null check (license_agreed),
  status          public.report_status not null default 'pending',
  cluster_id      bigint,
  created_at      timestamptz not null default now()
);
create index reports_geom_idx on public.reports using gist (geom);
create index reports_status_idx on public.reports (status, created_at desc);
create index reports_user_day_idx on public.reports (user_id, created_at);

create table public.extractions (
  id              bigserial primary key,
  report_id       bigint not null references public.reports(id) on delete cascade,
  model           text not null,
  prompt_version  text not null,
  output          jsonb,
  confidence      real,
  error           text,
  created_at      timestamptz not null default now()
);

create table public.obstacle_reports (
  obstacle_id bigint not null references public.obstacles(id) on delete cascade,
  report_id   bigint not null references public.reports(id) on delete cascade,
  primary key (obstacle_id, report_id)
);

create table public.status_events (
  id           bigserial primary key,
  entity_type  text not null,     -- segment / obstacle / report
  entity_id    bigint not null,
  from_status  text,
  to_status    text not null,
  actor_id     uuid,
  at           timestamptz not null default now(),
  note         text
);
create index status_events_entity_idx on public.status_events (entity_type, entity_id, at desc);

-- 등급 기준값 (PRD 6절 초기값, 현장 실측 T4로 보정)
create table public.grading_params (
  key   text primary key,
  value double precision not null,
  note  text
);
insert into public.grading_params (key, value, note) values
  ('incline_passable_max_pct', 5.6, '진행 방향 경사 1/18'),
  ('incline_caution_max_pct', 8.3, '진행 방향 경사 1/12'),
  ('kerb_passable_max_m', 0.02, '턱 2cm'),
  ('kerb_caution_max_m', 0.05, '임시값: 주의 턱 상한 (PRD 6절 미정, T4로 확정)'),
  ('width_caution_min_m', 1.2, '서울동행맵 기준 참고'),
  ('width_difficult_min_m', 0.9, '임시값'),
  ('dem_moderate_min_pct', 4.0, 'DEM 경사 이 이상은 현장 측정 없이 통행 가능 제안 안 함'),
  ('report_cluster_radius_m', 10, '같은 위치 제보 묶기 반경 (R-207)'),
  ('report_daily_limit', 30, '기기당 하루 제보 한도 (R-208)');
