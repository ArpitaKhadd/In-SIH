import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

// In-memory PostgreSQL adapter using pg-mem
// Falls back to real PostgreSQL if DATABASE_URL is set and connects successfully

// Next.js dev mode bundles each route/action into its own module graph, so a
// plain module-level variable would give every route a *separate* pg-mem DB.
// Attach the pool state to globalThis so all bundles in the process share one DB.
interface DbState {
  pool: Pool | null;
  memDb: any;
  isMemMode: boolean;
  poolInitialization: Promise<Pool> | null;
}

const globalForDb = globalThis as unknown as { __drm04DbState?: DbState };
const dbState: DbState = (globalForDb.__drm04DbState ??= {
  pool: null,
  memDb: null,
  isMemMode: false,
  poolInitialization: null,
});

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  email_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.profiles (
  user_id UUID PRIMARY KEY,
  email TEXT,
  phone TEXT,
  display_name TEXT,
  organization TEXT,
  jurisdiction_id UUID,
  role TEXT NOT NULL DEFAULT 'citizen' CHECK (role IN ('citizen','volunteer','authority','analyst','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','invited')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL,
  disaster_type TEXT NOT NULL,
  asset_type TEXT,
  description TEXT,
  observed_severity TEXT,
  ai_severity TEXT,
  ai_confidence NUMERIC,
  final_severity TEXT,
  priority_score INTEGER,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  operational_status TEXT NOT NULL DEFAULT 'new',
  affected_people INTEGER,
  infrastructure_impact BOOLEAN DEFAULT FALSE,
  accessibility_blocked BOOLEAN DEFAULT FALSE,
  location_lat DOUBLE PRECISION,
  location_lng DOUBLE PRECISION,
  location_accuracy_m NUMERIC,
  location_source TEXT,
  occurred_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.report_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL,
  storage_path TEXT NOT NULL,
  media_type TEXT,
  file_size INTEGER,
  sha256 TEXT,
  perceptual_hash TEXT,
  privacy_processed BOOLEAN DEFAULT FALSE,
  privacy_status TEXT DEFAULT 'pending',
  is_original BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.ai_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL,
  provider TEXT,
  model_name TEXT,
  model_version TEXT,
  predicted_category TEXT,
  predicted_severity TEXT,
  confidence NUMERIC,
  indicators JSONB DEFAULT '[]',
  explanation TEXT,
  status TEXT DEFAULT 'assessed',
  processing_time_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.verification_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL,
  reviewer_id UUID NOT NULL,
  previous_severity TEXT,
  new_severity TEXT,
  previous_status TEXT,
  new_status TEXT,
  reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id UUID,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.jurisdictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT,
  parent_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.report_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID UNIQUE NOT NULL,
  assignee_id UUID NOT NULL,
  assigned_by UUID,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.report_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL,
  author_id UUID NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function initMemDb() {
  const { newDb, DataType } = await import('pg-mem');
  dbState.memDb = newDb();
  
  // Register uuid generation
  dbState.memDb.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => crypto.randomUUID(),
    impure: true,
  });
  
  dbState.memDb.public.registerFunction({
    name: 'uuid_generate_v4',
    returns: DataType.uuid,
    implementation: () => crypto.randomUUID(),
    impure: true,
  });
  
  // Run schema
  dbState.memDb.public.none(SCHEMA_SQL);
  
  // Create pg adapter for pg-mem
  const { Pool: MemPool } = dbState.memDb.adapters.createPg() as any;
  dbState.pool = new MemPool();
  dbState.isMemMode = true;
  
  console.log('[db] Initialized in-memory PostgreSQL (pg-mem)');
  
  // Seed demo data
  await seedDemoData();
}

async function seedDemoData() {
  const { createHash, randomBytes } = await import('crypto');
  function makeHash(password: string) {
    const salt = randomBytes(16).toString('hex');
    const hash = createHash('sha256').update(salt + password).digest('hex');
    return `${salt}:${hash}`;
  }
  const defaultHash = makeHash('demo1234');

  // 1. Seed Demo Roles
  const users = [
    {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'demo@example.com',
      name: 'Aarav Sharma (Citizen)',
      role: 'citizen',
      org: 'Resident - Mumbai Suburbs',
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      email: 'authority@example.com',
      name: 'Rajesh Kumar (Authority)',
      role: 'authority',
      org: 'Disaster Management Authority',
    },
    {
      id: '33333333-3333-3333-3333-333333333333',
      email: 'volunteer@example.com',
      name: 'Priya Patel (Volunteer)',
      role: 'volunteer',
      org: 'Civil Defense Volunteer Corps',
    },
    {
      id: '44444444-4444-4444-4444-444444444444',
      email: 'analyst@example.com',
      name: 'Dr. Ananya Sen (Analyst)',
      role: 'analyst',
      org: 'Geospatial Damage Analytics Unit',
    },
    {
      id: '55555555-5555-5555-5555-555555555555',
      email: 'admin@example.com',
      name: 'Vikram Mehta (Admin)',
      role: 'admin',
      org: 'National Disaster Response Directorate',
    },
  ];

  for (const u of users) {
    await dbState.pool!.query(
      `INSERT INTO users (id, email, password_hash, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, true, NOW(), NOW())
       ON CONFLICT (email) DO NOTHING`,
      [u.id, u.email, defaultHash]
    );
    await dbState.pool!.query(
      `INSERT INTO profiles (user_id, email, display_name, role, organization, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [u.id, u.email, u.name, u.role, u.org]
    );
  }

  // 2. Seed Jurisdictions
  const jurisdictions = [
    { id: '10000000-0000-0000-0000-000000000001', name: 'Maharashtra Zone 1 (Mumbai MMR)', type: 'state_zone' },
    { id: '10000000-0000-0000-0000-000000000002', name: 'Kerala Zone 3 (Wayanad / Malabar)', type: 'district' },
    { id: '10000000-0000-0000-0000-000000000003', name: 'Tamil Nadu Zone 2 (Chennai Coastal)', type: 'coastal' },
    { id: '10000000-0000-0000-0000-000000000004', name: 'Delhi NCR Central Zone', type: 'urban' },
    { id: '10000000-0000-0000-0000-000000000005', name: 'Himachal Pradesh Western Range', type: 'hilly' },
  ];

  for (const j of jurisdictions) {
    await dbState.pool!.query(
      `INSERT INTO jurisdictions (id, name, type, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [j.id, j.name, j.type]
    );
  }

  // 3. Seed Realistic Disaster Incidents
  const sampleIncidents = [
    {
      id: 'a0000000-0000-0000-0000-000000000001',
      reporter_id: users[0].id,
      disaster_type: 'flood',
      asset_type: 'building',
      description: 'Severe waterlogging and structural water intrusion on ground floor. Multiple families stranded with electricity cut.',
      observed_severity: 'critical',
      ai_severity: 'critical',
      ai_confidence: 0.92,
      final_severity: 'critical',
      priority_score: 92,
      verification_status: 'needs_review',
      operational_status: 'in_progress',
      affected_people: 45,
      infrastructure_impact: true,
      accessibility_blocked: true,
      lat: 19.0728,
      lng: 72.8797,
      indicators: ['water intrusion', 'structural flooding', 'trapped residents', 'power loss'],
      explanation: 'Deep standing floodwater exceeding 4 feet entering residential ground floors. Immediate rescue and de-watering required.',
    },
    {
      id: 'a0000000-0000-0000-0000-000000000002',
      reporter_id: users[2].id,
      disaster_type: 'landslide',
      asset_type: 'road',
      description: 'Major hillside debris flow blocking state highway connecting Meppadi to Chooralmala. Road completely impassable.',
      observed_severity: 'critical',
      ai_severity: 'critical',
      ai_confidence: 0.95,
      final_severity: 'critical',
      priority_score: 96,
      verification_status: 'verified',
      operational_status: 'in_progress',
      affected_people: 120,
      infrastructure_impact: true,
      accessibility_blocked: true,
      lat: 11.5543,
      lng: 76.1264,
      indicators: ['debris flow', 'highway cutoff', 'boulder obstruction', 'erosion'],
      explanation: 'Massive landslide deposit covering roadway with mud and boulders. Heavy machinery needed for route clearance.',
    },
    {
      id: 'a0000000-0000-0000-0000-000000000003',
      reporter_id: users[0].id,
      disaster_type: 'cyclone',
      asset_type: 'power_grid',
      description: 'Gale force winds uprooted large trees and snapped multiple high-voltage power transmission lines across the street.',
      observed_severity: 'severe',
      ai_severity: 'severe',
      ai_confidence: 0.86,
      final_severity: 'severe',
      priority_score: 82,
      verification_status: 'verified',
      operational_status: 'in_progress',
      affected_people: 300,
      infrastructure_impact: true,
      accessibility_blocked: true,
      lat: 12.9815,
      lng: 80.2180,
      indicators: ['transmission line collapse', 'fallen trees', 'live wire hazard', 'road blockage'],
      explanation: 'Overhead electrical poles fractured and blocking arterial corridor. Severe electrocution hazard present.',
    },
    {
      id: 'a0000000-0000-0000-0000-000000000004',
      reporter_id: users[0].id,
      disaster_type: 'building_collapse',
      asset_type: 'building',
      description: 'Deep vertical shear cracks visible along foundation and load-bearing columns of 4-story heritage commercial building.',
      observed_severity: 'severe',
      ai_severity: 'severe',
      ai_confidence: 0.88,
      final_severity: 'severe',
      priority_score: 79,
      verification_status: 'needs_review',
      operational_status: 'new',
      affected_people: 25,
      infrastructure_impact: true,
      accessibility_blocked: false,
      lat: 28.6506,
      lng: 77.2303,
      indicators: ['structural shear cracks', 'masonry spalling', 'foundation settlement'],
      explanation: 'Substantial structural fissure observed on primary load-bearing pillar. Evacuation recommended pending structural inspection.',
    },
    {
      id: 'a0000000-0000-0000-0000-000000000005',
      reporter_id: users[0].id,
      disaster_type: 'fire',
      asset_type: 'building',
      description: 'Industrial warehouse fire spreading to adjacent storage sheds. Dense black smoke billowing with thermal radiation.',
      observed_severity: 'critical',
      ai_severity: 'critical',
      ai_confidence: 0.91,
      final_severity: 'critical',
      priority_score: 89,
      verification_status: 'escalated',
      operational_status: 'in_progress',
      affected_people: 60,
      infrastructure_impact: true,
      accessibility_blocked: true,
      lat: 21.1702,
      lng: 72.8311,
      indicators: ['active fire', 'toxic smoke plume', 'structural burnout', 'explosive risk'],
      explanation: 'High-intensity structural blaze with flammable contents. Fire brigade and hazardous material response deployed.',
    },
    {
      id: 'a0000000-0000-0000-0000-000000000006',
      reporter_id: users[2].id,
      disaster_type: 'flood',
      asset_type: 'road',
      description: 'Waterlogging under railway underpass reaching 2.5 feet, causing traffic snarls and stranded two-wheelers.',
      observed_severity: 'moderate',
      ai_severity: 'moderate',
      ai_confidence: 0.79,
      final_severity: 'moderate',
      priority_score: 54,
      verification_status: 'verified',
      operational_status: 'in_progress',
      affected_people: 15,
      infrastructure_impact: false,
      accessibility_blocked: true,
      lat: 12.9279,
      lng: 77.6830,
      indicators: ['submerged roadway', 'drainage overflow', 'traffic diversion'],
      explanation: 'Underpass drainage overwhelmed. Moderate traffic impediment without immediate structural failure.',
    },
    {
      id: 'a0000000-0000-0000-0000-000000000007',
      reporter_id: users[0].id,
      disaster_type: 'landslide',
      asset_type: 'road',
      description: 'Rockfall and minor slope slippage near km 42 hairpin turn. One lane obstructed by fallen boulders.',
      observed_severity: 'severe',
      ai_severity: 'severe',
      ai_confidence: 0.83,
      final_severity: 'severe',
      priority_score: 74,
      verification_status: 'needs_review',
      operational_status: 'new',
      affected_people: 10,
      infrastructure_impact: true,
      accessibility_blocked: false,
      lat: 31.1048,
      lng: 77.1734,
      indicators: ['rockfall deposit', 'slope instability', 'single lane open'],
      explanation: 'Rock slide debris encroaching on downhill lane. Road safety barrier damaged.',
    },
    {
      id: 'a0000000-0000-0000-0000-000000000008',
      reporter_id: users[0].id,
      disaster_type: 'cyclone',
      asset_type: 'building',
      description: 'Corrugated asbestos and tin roof sheets blown off school building and community center.',
      observed_severity: 'moderate',
      ai_severity: 'moderate',
      ai_confidence: 0.81,
      final_severity: 'moderate',
      priority_score: 61,
      verification_status: 'verified',
      operational_status: 'resolved',
      affected_people: 8,
      infrastructure_impact: true,
      accessibility_blocked: false,
      lat: 19.8135,
      lng: 85.8312,
      indicators: ['roof detachment', 'water seepage', 'scattered tin sheets'],
      explanation: 'Severe wind uplift caused partial roof failure. Building structure intact but requires tarpaulin cover.',
    },
    {
      id: 'a0000000-0000-0000-0000-000000000009',
      reporter_id: users[0].id,
      disaster_type: 'industrial',
      asset_type: 'water_sanitation',
      description: 'Chemical pipeline leak resulting in pungent vapor emission and colored runoff entering storm canal.',
      observed_severity: 'moderate',
      ai_severity: 'moderate',
      ai_confidence: 0.74,
      final_severity: 'moderate',
      priority_score: 65,
      verification_status: 'needs_review',
      operational_status: 'in_progress',
      affected_people: 35,
      infrastructure_impact: true,
      accessibility_blocked: false,
      lat: 18.6298,
      lng: 73.7997,
      indicators: ['pipeline rupture', 'chemical plume', 'storm canal discoloration'],
      explanation: 'Liquid discharge from industrial manifold. Pollution control team and municipal safety notified.',
    },
    {
      id: 'a0000000-0000-0000-0000-000000000010',
      reporter_id: users[0].id,
      disaster_type: 'other',
      asset_type: 'telecom',
      description: 'Fallen branches on telecom junction box causing landline and fiber outage in sector 4.',
      observed_severity: 'minor',
      ai_severity: 'minor',
      ai_confidence: 0.89,
      final_severity: 'minor',
      priority_score: 30,
      verification_status: 'verified',
      operational_status: 'resolved',
      affected_people: 5,
      infrastructure_impact: false,
      accessibility_blocked: false,
      lat: 22.5867,
      lng: 88.4178,
      indicators: ['fiber box dented', 'branch debris'],
      explanation: 'Minor physical damage to utility pedestal. No structural hazard.',
    },
  ];

  for (const inc of sampleIncidents) {
    await dbState.pool!.query(
      `INSERT INTO reports (
        id, reporter_id, disaster_type, asset_type, description,
        observed_severity, ai_severity, ai_confidence, final_severity,
        priority_score, verification_status, operational_status,
        affected_people, infrastructure_impact, accessibility_blocked,
        location_lat, location_lng, location_source, submitted_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'gps', NOW() - INTERVAL '2 hours', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        inc.id, inc.reporter_id, inc.disaster_type, inc.asset_type, inc.description,
        inc.observed_severity, inc.ai_severity, inc.ai_confidence, inc.final_severity,
        inc.priority_score, inc.verification_status, inc.operational_status,
        inc.affected_people, inc.infrastructure_impact, inc.accessibility_blocked,
        inc.lat, inc.lng,
      ]
    );

    // AI Assessment
    await dbState.pool!.query(
      `INSERT INTO ai_assessments (
        report_id, provider, model_name, model_version,
        predicted_category, predicted_severity, confidence, indicators, explanation, status, processing_time_ms, created_at
      ) VALUES ($1, 'gemini-vision', 'gemini-2.5-flash', '2.0', $2, $3, $4, $5, $6, $7, 850, NOW() - INTERVAL '2 hours')`,
      [
        inc.id, inc.disaster_type, inc.ai_severity, inc.ai_confidence,
        JSON.stringify(inc.indicators), inc.explanation,
        inc.ai_confidence < 0.85 ? 'needs_human_review' : 'assessed',
      ]
    );

    // Report Media (both original and privacy-redacted derivative)
    await dbState.pool!.query(
      `INSERT INTO report_media (
        report_id, storage_path, media_type, file_size, sha256, perceptual_hash, privacy_processed, privacy_status, is_original, created_at
      ) VALUES
        ($1, 'mock-original.jpg', 'image/jpeg', 2450000, 'mock-sha-orig', 'p-hash-1', true, 'done', true, NOW() - INTERVAL '2 hours'),
        ($1, 'mock-redacted.jpg', 'image/jpeg', 1150000, 'mock-sha-red', 'p-hash-1', true, 'done', false, NOW() - INTERVAL '2 hours')`,
      [inc.id]
    );

    // Sample verification event if verified
    if (inc.verification_status === 'verified' || inc.verification_status === 'escalated') {
      await dbState.pool!.query(
        `INSERT INTO verification_events (
          report_id, reviewer_id, previous_severity, new_severity, previous_status, new_status, reason, notes, created_at
        ) VALUES ($1, $2, $3, $4, 'needs_review', $5, 'Operational review confirmed damage indicators', 'NDRF rapid dispatch alerted.', NOW() - INTERVAL '1 hour')`,
        [inc.id, users[1].id, inc.ai_severity, inc.final_severity, inc.verification_status]
      );
    }

    // Add sample notes
    await dbState.pool!.query(
      `INSERT INTO report_notes (report_id, author_id, content, created_at)
       VALUES ($1, $2, 'Initial triage completed. High priority response initiated.', NOW() - INTERVAL '90 minutes')`,
      [inc.id, users[1].id]
    );

    // Add assignment
    await dbState.pool!.query(
      `INSERT INTO report_assignments (report_id, assignee_id, assigned_by, assigned_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '90 minutes')
       ON CONFLICT (report_id) DO NOTHING`,
      [inc.id, users[1].id, users[4].id]
    );

    // Audit log for report creation
    await dbState.pool!.query(
      `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, metadata, created_at)
       VALUES ($1, 'report_created', 'report', $2, $3, NOW() - INTERVAL '2 hours')`,
      [inc.reporter_id, inc.id, JSON.stringify({ disaster: inc.disaster_type, severity: inc.final_severity })]
    );
  }

  console.log('[db] 5 Demo Roles & 10 Realistic Disaster Incidents seeded successfully:');
  console.log('      Citizen:   demo@example.com / demo1234');
  console.log('      Volunteer: volunteer@example.com / demo1234');
  console.log('      Authority: authority@example.com / demo1234');
  console.log('      Analyst:   analyst@example.com / demo1234');
  console.log('      Admin:     admin@example.com / demo1234');
}

export async function getPool(): Promise<Pool> {
  if (dbState.pool) return dbState.pool;
  if (dbState.poolInitialization) return dbState.poolInitialization;

  dbState.poolInitialization = (async () => {
    const dbUrl = process.env.DATABASE_URL;

    if (dbUrl && !dbUrl.includes('pg-mem') && !dbUrl.includes('memory')) {
      try {
        const realPool = new Pool({
          connectionString: dbUrl,
          max: 20,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        });

        const client = await realPool.connect();
        await client.query('SELECT 1');
        client.release();

        dbState.pool = realPool;
        dbState.isMemMode = false;
        console.log('[db] Connected to real PostgreSQL');
        return dbState.pool;
      } catch (err) {
        if (process.env.NODE_ENV === "production" || process.env.ALLOW_IN_MEMORY_DB !== "true") {
          throw new Error("Database connection failed. Configure DATABASE_URL before running the application.");
        }
        console.warn('[db] Failed to connect to real PostgreSQL, using the explicitly enabled in-memory development database:', err);
      }
    }

    if (process.env.NODE_ENV === "production" || process.env.ALLOW_IN_MEMORY_DB !== "true") {
      throw new Error("DATABASE_URL is required. Set ALLOW_IN_MEMORY_DB=true only for local demos or tests.");
    }

    await initMemDb();
    return dbState.pool!;
  })();

  try {
    return await dbState.poolInitialization;
  } finally {
    dbState.poolInitialization = null;
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<QueryResult<T>> {
  const p = await getPool();
  const start = Date.now();
  const result = await p.query(text, params);
  if (!result) {
    throw new Error("Database driver returned no result for a query.");
  }
  const duration = Date.now() - start;
  if (process.env.NODE_ENV === 'development') {
    console.log('Executed query', { text: text.substring(0, 100), duration, rows: result.rowCount });
  }
  return result;
}

export async function getClient(): Promise<PoolClient> {
  const p = await getPool();
  return p.connect();
}

export async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function setCurrentUser(client: PoolClient, userId: string): Promise<void> {
  // pg-mem doesn't support SET LOCAL the same way, but we can use session variables
  try {
    await client.query(`SET app.current_user_id = $1`, [userId]);
  } catch {
    // Ignore if not supported
  }
}

export async function closePool(): Promise<void> {
  if (dbState.pool) {
    await dbState.pool.end();
    dbState.pool = null;
    dbState.poolInitialization = null;
  }
}

export function isInMemoryMode(): boolean {
  return dbState.isMemMode;
}

export interface DbReport {
  id: string;
  reporter_id: string;
  disaster_type: string;
  asset_type: string | null;
  description: string | null;
  observed_severity: string | null;
  ai_severity: string | null;
  ai_confidence: number | null;
  final_severity: string | null;
  priority_score: number | null;
  verification_status: string;
  operational_status: string;
  affected_people: number | null;
  infrastructure_impact: boolean | null;
  accessibility_blocked: boolean | null;
  lat: number | null;
  lng: number | null;
  submitted_at: Date;
  updated_at: Date;
}

export interface DbReportMedia {
  id: string;
  report_id: string;
  storage_path: string;
  media_type: string | null;
  file_size: number | null;
  sha256: string | null;
  privacy_processed: boolean;
  privacy_status: string;
  is_original: boolean;
  created_at: Date;
}

export interface DbAiAssessment {
  id: string;
  report_id: string;
  provider: string | null;
  model_name: string | null;
  predicted_severity: string | null;
  confidence: number | null;
  indicators: string[];
  explanation: string | null;
  status: string;
  processing_time_ms: number | null;
  created_at: Date;
}

export interface DbVerificationEvent {
  id: string;
  report_id: string;
  reviewer_id: string;
  previous_severity: string | null;
  new_severity: string | null;
  previous_status: string | null;
  new_status: string | null;
  reason: string | null;
  notes: string | null;
  created_at: Date;
}

export interface DbProfile {
  user_id: string;
  email: string | null;
  display_name: string | null;
  organization: string | null;
  jurisdiction_id: string | null;
  role: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}
