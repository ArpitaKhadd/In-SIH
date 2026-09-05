-- ============================================================================
-- 00_init.sql — Combined schema for local development (Postgres + PostGIS)
-- Runs automatically on container startup via docker-entrypoint-initdb.d
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ----------------------------------------------------------------------------
-- Enums as check constraints
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- users (for local auth)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_email_idx ON public.users (email);

-- ----------------------------------------------------------------------------
-- profiles (1:1 with users)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id       UUID PRIMARY KEY,
  email         TEXT,
  phone         TEXT,
  display_name  TEXT,
  organization  TEXT,
  jurisdiction_id UUID,
  role          TEXT NOT NULL DEFAULT 'citizen'
                  CHECK (role IN ('citizen','volunteer','authority','analyst','admin')),
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','invited')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS profiles_role_idx ON public.profiles (role);
CREATE INDEX IF NOT EXISTS profiles_jurisdiction_idx ON public.profiles (jurisdiction_id);

-- ----------------------------------------------------------------------------
-- jurisdictions
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.jurisdictions (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name      TEXT NOT NULL,
  type      TEXT,
  geometry  GEOGRAPHY(MULTIPOLYGON, 4326),
  parent_id UUID REFERENCES public.jurisdictions (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jurisdictions_geom_idx ON public.jurisdictions USING GIST (geometry);

-- ----------------------------------------------------------------------------
-- reports
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reports (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id        UUID NOT NULL,
  disaster_type      TEXT NOT NULL,
  asset_type         TEXT,
  description        TEXT,
  observed_severity  TEXT CHECK (observed_severity IN ('minor','moderate','severe','critical')),
  ai_severity        TEXT CHECK (ai_severity IN ('unclear','minor','moderate','severe','critical')),
  ai_confidence      NUMERIC(3,2) CHECK (ai_confidence >= 0 AND ai_confidence <= 1),
  final_severity     TEXT CHECK (final_severity IN ('unclear','minor','moderate','severe','critical')),
  priority_score     INTEGER CHECK (priority_score >= 0 AND priority_score <= 100),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
                        CHECK (verification_status IN ('unverified','verified','rejected','needs_review','escalated')),
  operational_status TEXT NOT NULL DEFAULT 'new'
                        CHECK (operational_status IN ('new','in_progress','resolved','archived')),
  affected_people    INTEGER CHECK (affected_people >= 0),
  infrastructure_impact BOOLEAN DEFAULT FALSE,
  accessibility_blocked BOOLEAN DEFAULT FALSE,
  location           GEOGRAPHY(POINT, 4326),
  location_lat       DOUBLE PRECISION,
  location_lng       DOUBLE PRECISION,
  location_accuracy_m NUMERIC,
  location_source    TEXT,
  occurred_at        TIMESTAMPTZ,
  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reports_reporter_idx ON public.reports (reporter_id);
CREATE INDEX IF NOT EXISTS reports_submitted_idx ON public.reports (submitted_at);
CREATE INDEX IF NOT EXISTS reports_disaster_idx ON public.reports (disaster_type);
CREATE INDEX IF NOT EXISTS reports_final_severity_idx ON public.reports (final_severity);
CREATE INDEX IF NOT EXISTS reports_verification_idx ON public.reports (verification_status);
CREATE INDEX IF NOT EXISTS reports_operational_idx ON public.reports (operational_status);
CREATE INDEX IF NOT EXISTS reports_priority_idx ON public.reports (priority_score);
CREATE INDEX IF NOT EXISTS reports_location_idx ON public.reports USING GIST (location);

-- Partial indexes for commonly filtered subsets (5-20x smaller, faster queries)
CREATE INDEX IF NOT EXISTS reports_needs_review_idx ON public.reports (submitted_at)
  WHERE verification_status = 'needs_review';
CREATE INDEX IF NOT EXISTS reports_critical_idx ON public.reports (submitted_at)
  WHERE final_severity = 'critical';
CREATE INDEX IF NOT EXISTS reports_active_idx ON public.reports (priority_score DESC)
  WHERE operational_status IN ('new', 'in_progress');

-- ----------------------------------------------------------------------------
-- report_media
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.report_media (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id         UUID NOT NULL REFERENCES public.reports (id) ON DELETE CASCADE,
  storage_path      TEXT NOT NULL,
  media_type        TEXT,
  file_size         INTEGER,
  sha256            TEXT,
  perceptual_hash   TEXT,
  privacy_processed BOOLEAN DEFAULT FALSE,
  privacy_status    TEXT DEFAULT 'pending'
                      CHECK (privacy_status IN ('pending','processing','done','failed')),
  is_original       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS report_media_report_idx ON public.report_media (report_id);

-- ----------------------------------------------------------------------------
-- ai_assessments
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_assessments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id        UUID NOT NULL REFERENCES public.reports (id) ON DELETE CASCADE,
  provider         TEXT,
  model_name       TEXT,
  model_version    TEXT,
  predicted_category TEXT,
  predicted_severity TEXT CHECK (predicted_severity IN ('unclear','minor','moderate','severe','critical')),
  confidence       NUMERIC(3,2) CHECK (confidence >= 0 AND confidence <= 1),
  indicators       JSONB NOT NULL DEFAULT '[]'::jsonb,
  explanation      TEXT,
  status           TEXT DEFAULT 'assessed'
                     CHECK (status IN ('assessed','needs_human_review','processing_failed')),
  processing_time_ms INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_assessments_report_idx ON public.ai_assessments (report_id);

-- ----------------------------------------------------------------------------
-- verification_events
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.verification_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id        UUID NOT NULL REFERENCES public.reports (id) ON DELETE CASCADE,
  reviewer_id      UUID NOT NULL,
  previous_severity TEXT,
  new_severity      TEXT,
  previous_status   TEXT,
  new_status        TEXT,
  reason           TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS verification_events_report_idx ON public.verification_events (report_id);
CREATE INDEX IF NOT EXISTS verification_events_reviewer_idx ON public.verification_events (reviewer_id);

-- ----------------------------------------------------------------------------
-- report_tags
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.report_tags (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL REFERENCES public.reports (id) ON DELETE CASCADE,
  tag       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS report_tags_report_idx ON public.report_tags (report_id);

-- ----------------------------------------------------------------------------
-- audit_logs
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id      UUID,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   UUID,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON public.audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON public.audit_logs (created_at);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON public.audit_logs (action);
CREATE INDEX IF NOT EXISTS audit_logs_resource_idx ON public.audit_logs (resource_type, resource_id);

-- ----------------------------------------------------------------------------
-- Helper functions
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_role()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET SEARCH_PATH = public
AS $$
  SELECT role FROM public.profiles WHERE user_id = current_setting('app.current_user_id', true)::uuid;
$$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET SEARCH_PATH = public
AS $$
  SELECT COALESCE(public.current_role(), '') IN ('authority','analyst','admin');
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET SEARCH_PATH = public
AS $$
  SELECT COALESCE(public.current_role(), '') = 'admin';
$$;

CREATE OR REPLACE FUNCTION public.owns_report(p_report_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET SEARCH_PATH = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.reports r WHERE r.id = p_report_id AND r.reporter_id = current_setting('app.current_user_id', true)::uuid
  );
$$;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE PLPGSQL
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER reports_touch BEFORE UPDATE ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER profiles_touch BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jurisdictions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_media    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_assessments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_tags     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs      ENABLE ROW LEVEL SECURITY;

-- profiles
CREATE POLICY profiles_self_read ON public.profiles
  FOR SELECT USING (user_id = current_setting('app.current_user_id', true)::uuid OR public.is_staff());

CREATE POLICY profiles_self_update ON public.profiles
  FOR UPDATE USING (user_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY profiles_admin_all ON public.profiles
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- jurisdictions
CREATE POLICY jurisdictions_read ON public.jurisdictions FOR SELECT USING (TRUE);
CREATE POLICY jurisdictions_admin_write ON public.jurisdictions
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- reports
CREATE POLICY reports_citizen_insert ON public.reports
  FOR INSERT WITH CHECK (reporter_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY reports_citizen_read_own ON public.reports
  FOR SELECT USING (reporter_id = current_setting('app.current_user_id', true)::uuid);

CREATE POLICY reports_staff_read ON public.reports FOR SELECT USING (public.is_staff());
CREATE POLICY reports_staff_update ON public.reports
  FOR UPDATE USING (public.is_staff()) WITH CHECK (public.is_staff());

-- report_media
CREATE POLICY media_citizen_insert ON public.report_media
  FOR INSERT WITH CHECK (public.owns_report(report_id));
CREATE POLICY media_citizen_read_own ON public.report_media
  FOR SELECT USING (public.owns_report(report_id));
CREATE POLICY media_staff_read ON public.report_media FOR SELECT USING (public.is_staff());

-- ai_assessments
CREATE POLICY ai_citizen_read_own ON public.ai_assessments
  FOR SELECT USING (public.owns_report(report_id));
CREATE POLICY ai_staff_read ON public.ai_assessments FOR SELECT USING (public.is_staff());
CREATE POLICY ai_service_write ON public.ai_assessments FOR INSERT WITH CHECK (TRUE);

-- verification_events
CREATE POLICY verification_staff_write ON public.verification_events
  FOR INSERT WITH CHECK (public.is_staff());
CREATE POLICY verification_staff_read ON public.verification_events
  FOR SELECT USING (public.is_staff() OR public.owns_report(report_id));

-- report_tags
CREATE POLICY tags_citizen_insert ON public.report_tags
  FOR INSERT WITH CHECK (public.owns_report(report_id));
CREATE POLICY tags_read ON public.report_tags
  FOR SELECT USING (public.owns_report(report_id) OR public.is_staff());

-- audit_logs
CREATE POLICY audit_admin_read ON public.audit_logs FOR SELECT USING (public.is_admin());
CREATE POLICY audit_service_write ON public.audit_logs FOR INSERT WITH CHECK (TRUE);

-- ----------------------------------------------------------------------------
-- Helper functions (priority, geo, duplicates)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_priority(
  p_severity TEXT,
  p_confidence NUMERIC,
  p_affected_people INTEGER,
  p_infrastructure BOOLEAN,
  p_accessibility BOOLEAN,
  p_submitted_at TIMESTAMPTZ DEFAULT NOW()
)
RETURNS INTEGER
LANGUAGE PLPGSQL
IMMUTABLE
AS $$
DECLARE
  v_score INTEGER := 0;
  v_sev INTEGER := 0;
  v_conf INTEGER := 0;
  v_people INTEGER := 0;
  v_infra INTEGER := 0;
  v_access INTEGER := 0;
  v_recency INTEGER := 0;
BEGIN
  v_sev := CASE p_severity
    WHEN 'critical' THEN 40
    WHEN 'severe'   THEN 32
    WHEN 'moderate' THEN 22
    WHEN 'minor'    THEN 12
    ELSE 0 END;

  v_conf := COALESCE(ROUND(COALESCE(p_confidence, 0) * 15), 0)::INTEGER;
  v_people := LEAST(COALESCE(p_affected_people, 0), 100) / 7;
  v_people := LEAST(v_people, 15);
  v_infra := CASE WHEN p_infrastructure THEN 10 ELSE 0 END;
  v_access := CASE WHEN p_accessibility THEN 10 ELSE 0 END;
  v_recency := GREATEST(0, LEAST(10, 10 - (EXTRACT(EPOCH FROM (NOW() - p_submitted_at)) / 3600.0 - 6) / 6.6));

  v_score := v_sev + v_conf + v_people + v_infra + v_access + v_recency;
  RETURN LEAST(100, GREATEST(0, v_score));
END;
$$;

CREATE OR REPLACE FUNCTION public.nearby_reports(
  p_lon DOUBLE PRECISION,
  p_lat DOUBLE PRECISION,
  p_radius_m DOUBLE PRECISION DEFAULT 5000,
  p_limit INTEGER DEFAULT 50
)
RETURNS SETOF public.reports
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET SEARCH_PATH = public
AS $$
  SELECT r.*
  FROM public.reports r
  WHERE r.location IS NOT NULL
    AND ST_DWITHIN(r.location, ST_MAKEPOINT(p_lon, p_lat)::GEOGRAPHY, p_radius_m)
  ORDER BY ST_DISTANCE(r.location, ST_MAKEPOINT(p_lon, p_lat)::GEOGRAPHY) ASC
  LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION public.reports_in_bbox(
  p_min_lon DOUBLE PRECISION,
  p_min_lat DOUBLE PRECISION,
  p_max_lon DOUBLE PRECISION,
  p_max_lat DOUBLE PRECISION,
  p_limit INTEGER DEFAULT 500
)
RETURNS SETOF public.reports
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET SEARCH_PATH = public
AS $$
  SELECT r.*
  FROM public.reports r
  WHERE r.location IS NOT NULL
    AND r.location && ST_MAKEENVELOPE(p_min_lon, p_min_lat, p_max_lon, p_max_lat, 4326)
  LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION public.reports_list()
RETURNS TABLE (
  id UUID,
  reporter_id UUID,
  disaster_type TEXT,
  asset_type TEXT,
  description TEXT,
  ai_severity TEXT,
  ai_confidence NUMERIC,
  final_severity TEXT,
  priority_score INTEGER,
  verification_status TEXT,
  operational_status TEXT,
  affected_people INTEGER,
  infrastructure_impact BOOLEAN,
  accessibility_blocked BOOLEAN,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  submitted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET SEARCH_PATH = public
AS $$
  SELECT
    r.id, r.reporter_id, r.disaster_type, r.asset_type, r.description,
    r.ai_severity, r.ai_confidence, r.final_severity, r.priority_score,
    r.verification_status, r.operational_status, r.affected_people,
    r.infrastructure_impact, r.accessibility_blocked,
    CASE WHEN r.location IS NOT NULL THEN ST_Y(r.location::GEOMETRY) ELSE NULL END AS lat,
    CASE WHEN r.location IS NOT NULL THEN ST_X(r.location::GEOMETRY) ELSE NULL END AS lng,
    r.submitted_at, r.updated_at
  FROM public.reports r;
$$;

-- ----------------------------------------------------------------------------
-- Seed data
-- ----------------------------------------------------------------------------
INSERT INTO public.jurisdictions (id, name, type, geometry)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'Demo City',
  'city',
  ST_SETSRID(ST_GEOMFROMTEXT(
    'MULTIPOLYGON(((72.80 18.90, 72.95 18.90, 72.95 19.05, 72.80 19.05, 72.80 18.90)))'
  ), 4326)::GEOGRAPHY
)
ON CONFLICT (id) DO NOTHING;

-- Default users will be created via the web app's auth flow
-- This script only sets up the schema and reference data
