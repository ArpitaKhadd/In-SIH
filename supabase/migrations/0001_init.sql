-- ============================================================================
-- 0001_init.sql — Crowdsourced Disaster Damage Assessment System (DRM04)
-- Schema: Postgres + PostGIS, RLS, Storage, helper functions
-- Run via Supabase SQL editor or `supabase db push`.
-- ============================================================================

create extension if not exists postgis;
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

-- ----------------------------------------------------------------------------
-- Enums (as check constraints via text + domains where helpful)
-- ----------------------------------------------------------------------------

-- Roles are stored on the profile row; keep a canonical list here for reference.
-- citizen | volunteer | authority | analyst | admin

-- ----------------------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  email         text,
  phone         text,
  display_name  text,
  organization  text,
  jurisdiction_id uuid,
  role          text not null default 'citizen'
                  check (role in ('citizen','volunteer','authority','analyst','admin')),
  status        text not null default 'active'
                  check (status in ('active','suspended','invited')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles (role);
create index if not exists profiles_jurisdiction_idx on public.profiles (jurisdiction_id);

-- ----------------------------------------------------------------------------
-- jurisdictions (for jurisdiction-aware access)
-- ----------------------------------------------------------------------------
create table if not exists public.jurisdictions (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,
  type      text,
  geometry  geography(multipolygon, 4326),
  parent_id uuid references public.jurisdictions (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists jurisdictions_geom_idx on public.jurisdictions using gist (geometry);

-- ----------------------------------------------------------------------------
-- reports
-- ----------------------------------------------------------------------------
create table if not exists public.reports (
  id                 uuid primary key default gen_random_uuid(),
  reporter_id        uuid not null references auth.users (id) on delete cascade,
  disaster_type      text not null,
  asset_type         text,
  description        text,
  observed_severity  text check (observed_severity in ('minor','moderate','severe','critical')),
  ai_severity        text check (ai_severity in ('unclear','minor','moderate','severe','critical')),
  ai_confidence      numeric(3,2) check (ai_confidence >= 0 and ai_confidence <= 1),
  final_severity     text check (final_severity in ('unclear','minor','moderate','severe','critical')),
  priority_score     integer check (priority_score >= 0 and priority_score <= 100),
  verification_status text not null default 'unverified'
                        check (verification_status in ('unverified','verified','rejected','needs_review','escalated')),
  operational_status text not null default 'new'
                        check (operational_status in ('new','in_progress','resolved','archived')),
  affected_people    integer check (affected_people >= 0),
  infrastructure_impact boolean default false,
  accessibility_blocked boolean default false,
  location           geography(point, 4326),
  location_accuracy_m numeric,
  location_source    text,
  occurred_at        timestamptz,
  submitted_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists reports_reporter_idx on public.reports (reporter_id);
create index if not exists reports_submitted_idx on public.reports (submitted_at);
create index if not exists reports_disaster_idx on public.reports (disaster_type);
create index if not exists reports_final_severity_idx on public.reports (final_severity);
create index if not exists reports_verification_idx on public.reports (verification_status);
create index if not exists reports_operational_idx on public.reports (operational_status);
create index if not exists reports_priority_idx on public.reports (priority_score);
create index if not exists reports_location_idx on public.reports using gist (location);

-- Partial indexes for commonly filtered subsets (5-20x smaller, faster queries)
create index if not exists reports_needs_review_idx on public.reports (submitted_at)
  where verification_status = 'needs_review';
create index if not exists reports_critical_idx on public.reports (submitted_at)
  where final_severity = 'critical';
create index if not exists reports_active_idx on public.reports (priority_score desc)
  where operational_status in ('new', 'in_progress');

-- ----------------------------------------------------------------------------
-- report_media
-- ----------------------------------------------------------------------------
create table if not exists public.report_media (
  id                uuid primary key default gen_random_uuid(),
  report_id         uuid not null references public.reports (id) on delete cascade,
  storage_path      text not null,
  media_type        text,
  file_size         integer,
  sha256            text,
  perceptual_hash   text,
  privacy_processed boolean default false,
  privacy_status    text default 'pending'
                      check (privacy_status in ('pending','processing','done','failed')),
  is_original       boolean not null default true,
  created_at        timestamptz not null default now()
);

create index if not exists report_media_report_idx on public.report_media (report_id);

-- ----------------------------------------------------------------------------
-- ai_assessments
-- ----------------------------------------------------------------------------
create table if not exists public.ai_assessments (
  id               uuid primary key default gen_random_uuid(),
  report_id        uuid not null references public.reports (id) on delete cascade,
  provider         text,
  model_name       text,
  model_version    text,
  predicted_category text,
  predicted_severity text check (predicted_severity in ('unclear','minor','moderate','severe','critical')),
  confidence       numeric(3,2) check (confidence >= 0 and confidence <= 1),
  indicators       jsonb not null default '[]'::jsonb,
  explanation      text,
  status           text default 'assessed'
                     check (status in ('assessed','needs_human_review','processing_failed')),
  processing_time_ms integer,
  created_at       timestamptz not null default now()
);

create index if not exists ai_assessments_report_idx on public.ai_assessments (report_id);

-- ----------------------------------------------------------------------------
-- verification_events (audit of human verification)
-- ----------------------------------------------------------------------------
create table if not exists public.verification_events (
  id               uuid primary key default gen_random_uuid(),
  report_id        uuid not null references public.reports (id) on delete cascade,
  reviewer_id      uuid not null references auth.users (id),
  previous_severity text,
  new_severity      text,
  previous_status   text,
  new_status        text,
  reason           text,
  notes            text,
  created_at       timestamptz not null default now()
);

create index if not exists verification_events_report_idx on public.verification_events (report_id);
create index if not exists verification_events_reviewer_idx on public.verification_events (reviewer_id);

-- ----------------------------------------------------------------------------
-- report_tags (loose tagging / duplicate clustering)
-- ----------------------------------------------------------------------------
create table if not exists public.report_tags (
  id        uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports (id) on delete cascade,
  tag       text not null
);

create index if not exists report_tags_report_idx on public.report_tags (report_id);

-- ----------------------------------------------------------------------------
-- audit_logs
-- ----------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid references auth.users (id),
  action        text not null,
  resource_type text,
  resource_id   uuid,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists audit_logs_actor_idx on public.audit_logs (actor_id);
create index if not exists audit_logs_created_idx on public.audit_logs (created_at);
create index if not exists audit_logs_action_idx on public.audit_logs (action);
create index if not exists audit_logs_resource_idx on public.audit_logs (resource_type, resource_id);

-- ----------------------------------------------------------------------------
-- Helper functions for RLS
-- ----------------------------------------------------------------------------
create or replace function public.current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where user_id = auth.uid();
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_role(), '') in ('authority','analyst','admin');
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_role(), '') = 'admin';
$$;

-- Owns the report (for citizen access)
create or replace function public.owns_report(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.reports r where r.id = p_report_id and r.reporter_id = auth.uid()
  );
$$;

-- Updated-at trigger
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger reports_touch before update on public.reports
  for each row execute function public.touch_updated_at();

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.jurisdictions  enable row level security;
alter table public.reports         enable row level security;
alter table public.report_media    enable row level security;
alter table public.ai_assessments  enable row level security;
alter table public.verification_events enable row level security;
alter table public.report_tags     enable row level security;
alter table public.audit_logs      enable row level security;

-- profiles -------------------------------------------------------------------
create policy profiles_self_read on public.profiles
  for select using (user_id = auth.uid() or public.is_staff());

create policy profiles_self_update on public.profiles
  for update using (user_id = auth.uid());

create policy profiles_admin_all on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- jurisdictions --------------------------------------------------------------
create policy jurisdictions_read on public.jurisdictions
  for select using (true); -- needed for map boundaries; data is non-sensitive

create policy jurisdictions_admin_write on public.jurisdictions
  for all using (public.is_admin()) with check (public.is_admin());

-- reports --------------------------------------------------------------------
create policy reports_citizen_insert on public.reports
  for insert with check (reporter_id = auth.uid());

create policy reports_citizen_read_own on public.reports
  for select using (reporter_id = auth.uid());

create policy reports_staff_read on public.reports
  for select using (public.is_staff());

create policy reports_staff_update on public.reports
  for update using (public.is_staff()) with check (public.is_staff());

-- report_media ---------------------------------------------------------------
create policy media_citizen_insert on public.report_media
  for insert with check (public.owns_report(report_id));

create policy media_citizen_read_own on public.report_media
  for select using (public.owns_report(report_id));

create policy media_staff_read on public.report_media
  for select using (public.is_staff());

-- ai_assessments -------------------------------------------------------------
create policy ai_citizen_read_own on public.ai_assessments
  for select using (public.owns_report(report_id));

create policy ai_staff_read on public.ai_assessments
  for select using (public.is_staff());

create policy ai_service_write on public.ai_assessments
  for insert with check (true); -- restricted in practice to service-role key

-- verification_events --------------------------------------------------------
create policy verification_staff_write on public.verification_events
  for insert with check (public.is_staff());

create policy verification_staff_read on public.verification_events
  for select using (public.is_staff() or public.owns_report(report_id));

-- report_tags ----------------------------------------------------------------
create policy tags_citizen_insert on public.report_tags
  for insert with check (public.owns_report(report_id));

create policy tags_read on public.report_tags
  for select using (public.owns_report(report_id) or public.is_staff());

-- audit_logs -----------------------------------------------------------------
create policy audit_admin_read on public.audit_logs
  for select using (public.is_admin());

create policy audit_service_write on public.audit_logs
  for insert with check (true);

-- ----------------------------------------------------------------------------
-- Storage buckets + policies
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('report-originals', 'report-originals', false),
       ('report-redacted', 'report-redacted', false)
on conflict (id) do nothing;

-- originals: citizens upload, only admin/service may read
create policy originals_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'report-originals');

create policy originals_admin_read on storage.objects
  for select to authenticated using (
    bucket_id = 'report-originals' and public.is_admin()
  );

-- redacted: staff can read (normal operational viewing), service can write
create policy redacted_insert on storage.objects
  for insert to service_role with check (bucket_id = 'report-redacted');

create policy redacted_staff_read on storage.objects
  for select to authenticated using (
    bucket_id = 'report-redacted' and public.is_staff()
  );
