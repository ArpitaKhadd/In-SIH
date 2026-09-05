import { query } from "./local";
import { Assignment, TeamMember, Note } from "@/lib/types";

export interface ReportFilters {
  disaster_type?: string;
  final_severity?: string;
  verification_status?: string;
  operational_status?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
  has_location?: boolean;
}

export interface PaginationParams {
  page: number;
  pageSize: number;
}

export interface SortParams {
  field: string;
  direction: "asc" | "desc";
}

export interface ReportsResponse {
  reports: any[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function getReports(
  filters: ReportFilters = {},
  pagination: PaginationParams = { page: 1, pageSize: 20 },
  sort: SortParams = { field: "submitted_at", direction: "desc" }
): Promise<ReportsResponse> {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (filters.disaster_type) {
    conditions.push(`disaster_type = $${paramIndex++}`);
    params.push(filters.disaster_type);
  }
  if (filters.final_severity) {
    conditions.push(`final_severity = $${paramIndex++}`);
    params.push(filters.final_severity);
  }
  if (filters.verification_status) {
    conditions.push(`verification_status = $${paramIndex++}`);
    params.push(filters.verification_status);
  }
  if (filters.operational_status) {
    conditions.push(`operational_status = $${paramIndex++}`);
    params.push(filters.operational_status);
  }
  if (filters.date_from) {
    conditions.push(`submitted_at >= $${paramIndex++}`);
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    conditions.push(`submitted_at <= $${paramIndex++}`);
    params.push(filters.date_to);
  }
  if (filters.search) {
    conditions.push(`(description ILIKE $${paramIndex} OR disaster_type ILIKE $${paramIndex} OR asset_type ILIKE $${paramIndex})`);
    params.push(`%${filters.search}%`);
    paramIndex++;
  }
  if (filters.has_location) {
    conditions.push(`location_lat IS NOT NULL AND location_lng IS NOT NULL`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const allowedSortFields = ["submitted_at", "updated_at", "priority_score", "final_severity", "disaster_type", "verification_status"];
  const sortField = allowedSortFields.includes(sort.field) ? sort.field : "submitted_at";
  const sortDirection = sort.direction === "asc" ? "ASC" : "DESC";

  const offset = (pagination.page - 1) * pagination.pageSize;

  const countQuery = `SELECT COUNT(*) FROM reports ${whereClause}`;
  const countResult = await query(countQuery, params);
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  const dataQuery = `
    SELECT *, location_lat as lat, location_lng as lng FROM reports 
    ${whereClause}
    ORDER BY ${sortField} ${sortDirection}
    LIMIT $${paramIndex++} OFFSET $${paramIndex++}
  `;
  params.push(pagination.pageSize, offset);

  const dataResult = await query(dataQuery, params);

  return {
    reports: dataResult.rows,
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
    totalPages: Math.ceil(total / pagination.pageSize),
  };
}

export async function getReportById(id: string) {
  const result = await query(
    `SELECT * FROM reports WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function getReportMedia(reportId: string) {
  const result = await query(
    `SELECT * FROM report_media WHERE report_id = $1 ORDER BY is_original DESC, created_at ASC`,
    [reportId]
  );
  return result.rows;
}

export async function getAiAssessments(reportId: string) {
  const result = await query(
    `SELECT * FROM ai_assessments WHERE report_id = $1 ORDER BY created_at DESC`,
    [reportId]
  );
  return result.rows;
}

export async function getVerificationEvents(reportId: string) {
  const result = await query(
    `SELECT ve.*, p.display_name as reviewer_name 
     FROM verification_events ve
     LEFT JOIN profiles p ON p.user_id = ve.reviewer_id
     WHERE ve.report_id = $1 
     ORDER BY ve.created_at DESC`,
    [reportId]
  );
  return result.rows;
}

export async function getTeamMembers(): Promise<TeamMember[]> {
  const result = await query(
    `SELECT user_id, display_name, email, role 
     FROM profiles 
     WHERE role IN ('authority', 'analyst', 'admin') AND status = 'active'
     ORDER BY display_name ASC`
  );
  return result.rows as TeamMember[];
}

export async function assignReport(reportId: string, assigneeId: string, assignedBy: string) {
  const result = await query(
    `INSERT INTO report_assignments (report_id, assignee_id, assigned_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (report_id) DO UPDATE SET assignee_id = $2, assigned_by = $3, assigned_at = NOW()
     RETURNING *`,
    [reportId, assigneeId, assignedBy]
  );
  return result.rows[0];
}

export async function getReportAssignment(reportId: string): Promise<Assignment | null> {
  const result = await query(
    `SELECT ra.*, p.display_name as assignee_name, p.email as assignee_email
     FROM report_assignments ra
     LEFT JOIN profiles p ON p.user_id = ra.assignee_id
     WHERE ra.report_id = $1`,
    [reportId]
  );
  return result.rows[0] as Assignment | null;
}


export async function addReportNote(reportId: string, authorId: string, content: string) {
  const result = await query(
    `INSERT INTO report_notes (report_id, author_id, content)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [reportId, authorId, content]
  );
  return result.rows[0];
}

export async function getReportNotes(reportId: string): Promise<Note[]> {
  const result = await query(
    `SELECT rn.*, p.display_name as author_name
     FROM report_notes rn
     LEFT JOIN profiles p ON p.user_id = rn.author_id
     WHERE rn.report_id = $1
     ORDER BY rn.created_at DESC`,
    [reportId]
  );
  return result.rows as Note[];
}

export async function updateReportVerification(
  reportId: string,
  updates: {
    final_severity?: string;
    verification_status?: string;
    operational_status?: string;
    reason?: string;
    notes?: string;
  },
  reviewerId: string
) {
  return await query(
    `UPDATE reports 
     SET final_severity = COALESCE($2, final_severity),
         verification_status = COALESCE($3, verification_status),
         operational_status = COALESCE($4, operational_status),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [reportId, updates.final_severity, updates.verification_status, updates.operational_status]
  );
}

export async function createVerificationEvent(
  reportId: string,
  reviewerId: string,
  data: {
    previous_severity?: string;
    new_severity?: string;
    previous_status?: string;
    new_status?: string;
    reason?: string;
    notes?: string;
  }
) {
  const result = await query(
    `INSERT INTO verification_events (report_id, reviewer_id, previous_severity, new_severity, previous_status, new_status, reason, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [reportId, reviewerId, data.previous_severity, data.new_severity, data.previous_status, data.new_status, data.reason, data.notes]
  );
  return result.rows[0];
}

export async function getDashboardStats() {
  const [
    statsResult,
    byDisasterResult,
    bySeverityResult,
    byVerificationResult,
    recentCriticalResult,
  ] = await Promise.all([
    // Optimized: Single query with conditional aggregation instead of 8 separate queries
    query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE final_severity = 'critical') as critical,
        COUNT(*) FILTER (WHERE verification_status = 'needs_review') as needs_review,
        COUNT(*) FILTER (WHERE verification_status = 'verified') as verified,
        COUNT(*) FILTER (WHERE operational_status = 'in_progress') as in_progress,
        COUNT(*) FILTER (WHERE operational_status = 'resolved') as resolved
      FROM reports
    `),
    query(`SELECT disaster_type, COUNT(*) as count FROM reports GROUP BY disaster_type ORDER BY count DESC`),
    query(`SELECT final_severity, COUNT(*) as count FROM reports GROUP BY final_severity ORDER BY count DESC`),
    query(`SELECT verification_status, COUNT(*) as count FROM reports GROUP BY verification_status ORDER BY count DESC`),
    query(`SELECT * FROM reports WHERE final_severity = 'critical' AND verification_status != 'rejected' ORDER BY submitted_at DESC LIMIT 10`),
  ]);

  const statsRow = statsResult.rows[0];

  return {
    total: parseInt(statsRow?.total ?? "0", 10),
    critical: parseInt(statsRow?.critical ?? "0", 10),
    needsReview: parseInt(statsRow?.needs_review ?? "0", 10),
    verified: parseInt(statsRow?.verified ?? "0", 10),
    inProgress: parseInt(statsRow?.in_progress ?? "0", 10),
    resolved: parseInt(statsRow?.resolved ?? "0", 10),
    byDisaster: byDisasterResult.rows,
    bySeverity: bySeverityResult.rows,
    byVerification: byVerificationResult.rows,
    recentCritical: recentCriticalResult.rows,
  };
}

export async function getAnalyticsData(days: number = 30) {
  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
  const cutoffDate = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);

  const [reportsOverTime, severityOverTime, disasterOverTime, verificationFunnel, priorityHeatmap] = await Promise.all([
    query(`
      SELECT 
        DATE_TRUNC('day', submitted_at) as date,
        COUNT(*) as count
      FROM reports
      WHERE submitted_at >= $1
      GROUP BY DATE_TRUNC('day', submitted_at)
      ORDER BY date ASC
    `, [cutoffDate]),
    query(`
      SELECT 
        DATE_TRUNC('day', submitted_at) as date,
        final_severity,
        COUNT(*) as count
      FROM reports
      WHERE submitted_at >= $1 AND final_severity IS NOT NULL
      GROUP BY DATE_TRUNC('day', submitted_at), final_severity
      ORDER BY date ASC
    `, [cutoffDate]),
    query(`
      SELECT 
        disaster_type,
        COUNT(*) as count
      FROM reports
      WHERE submitted_at >= $1
      GROUP BY disaster_type
      ORDER BY count DESC
    `, [cutoffDate]),
    query(`
      SELECT 
        verification_status,
        COUNT(*) as count
      FROM reports
      WHERE submitted_at >= $1
      GROUP BY verification_status
      ORDER BY 
        CASE verification_status 
          WHEN 'unverified' THEN 1
          WHEN 'needs_review' THEN 2
          WHEN 'verified' THEN 3
          WHEN 'rejected' THEN 4
          WHEN 'escalated' THEN 5
          ELSE 6
        END
    `, [cutoffDate]),
    query(`
      SELECT 
        disaster_type,
        final_severity,
        COUNT(*) as count,
        AVG(priority_score) as avg_priority
      FROM reports
      WHERE submitted_at >= $1 AND final_severity IS NOT NULL
      GROUP BY disaster_type, final_severity
      ORDER BY disaster_type, 
        CASE final_severity 
          WHEN 'unclear' THEN 1
          WHEN 'minor' THEN 2
          WHEN 'moderate' THEN 3
          WHEN 'severe' THEN 4
          WHEN 'critical' THEN 5
          ELSE 6
        END
    `, [cutoffDate]),
  ]);

  return {
    reportsOverTime: reportsOverTime.rows,
    severityOverTime: severityOverTime.rows,
    disasterOverTime: disasterOverTime.rows,
    verificationFunnel: verificationFunnel.rows,
    priorityHeatmap: priorityHeatmap.rows,
  };
}

export async function bulkVerifyReports(reportIds: string[], verificationStatus: string, reviewerId: string, reason?: string) {
  const results = [];
  for (const id of reportIds) {
    const reportResult = await query(
      `SELECT verification_status, final_severity FROM reports WHERE id = $1`,
      [id]
    );
    const report = reportResult.rows[0];
    if (!report) continue;

    await query(
      `UPDATE reports 
       SET verification_status = $1, updated_at = NOW()
       WHERE id = $2`,
      [verificationStatus, id]
    );

    await query(
      `INSERT INTO verification_events (report_id, reviewer_id, previous_status, new_status, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, reviewerId, report.verification_status, verificationStatus, reason ?? null]
    );

    results.push({ id, success: true });
  }
  return results;
}

export async function getReportsForExport(filters: ReportFilters = {}) {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (filters.disaster_type) {
    conditions.push(`disaster_type = $${paramIndex++}`);
    params.push(filters.disaster_type);
  }
  if (filters.final_severity) {
    conditions.push(`final_severity = $${paramIndex++}`);
    params.push(filters.final_severity);
  }
  if (filters.verification_status) {
    conditions.push(`verification_status = $${paramIndex++}`);
    params.push(filters.verification_status);
  }
  if (filters.operational_status) {
    conditions.push(`operational_status = $${paramIndex++}`);
    params.push(filters.operational_status);
  }
  if (filters.date_from) {
    conditions.push(`submitted_at >= $${paramIndex++}`);
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    conditions.push(`submitted_at <= $${paramIndex++}`);
    params.push(filters.date_to);
  }
  if (filters.search) {
    conditions.push(`(description ILIKE $${paramIndex} OR disaster_type ILIKE $${paramIndex} OR asset_type ILIKE $${paramIndex})`);
    params.push(`%${filters.search}%`);
    paramIndex++;
  }
  if (filters.has_location) {
    conditions.push(`location_lat IS NOT NULL AND location_lng IS NOT NULL`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await query(
    `SELECT *, location_lat as lat, location_lng as lng FROM reports ${whereClause} ORDER BY submitted_at DESC`,
    params
  );

  return result.rows;
}

export async function getReportsByReporter(reporterId: string) {
  // Keep aggregation in application code: pg-mem cannot implement PostgreSQL's
  // json_build_object aggregate reliably, while this stays three bounded queries
  // rather than an N+1 query and produces the same report shape in both runtimes.
  const [reportsResult, mediaResult, assessmentsResult] = await Promise.all([
    query(`SELECT r.*, r.location_lat AS lat, r.location_lng AS lng
           FROM reports r
           WHERE r.reporter_id = $1
           ORDER BY r.submitted_at DESC`, [reporterId]),
    query(`SELECT rm.report_id, rm.id, rm.storage_path, rm.is_original, rm.privacy_processed
           FROM report_media rm
           INNER JOIN reports r ON r.id = rm.report_id
           WHERE r.reporter_id = $1
           ORDER BY rm.created_at ASC`, [reporterId]),
    query(`SELECT aa.report_id, aa.predicted_severity, aa.confidence, aa.indicators, aa.explanation, aa.status
           FROM ai_assessments aa
           INNER JOIN reports r ON r.id = aa.report_id
           WHERE r.reporter_id = $1
           ORDER BY aa.created_at DESC`, [reporterId]),
  ]);

  const mediaByReport = new Map<string, unknown[]>();
  for (const media of mediaResult.rows) {
    const items = mediaByReport.get(media.report_id) ?? [];
    items.push({
      id: media.id,
      storage_path: media.storage_path,
      is_original: media.is_original,
      privacy_processed: media.privacy_processed,
    });
    mediaByReport.set(media.report_id, items);
  }

  const assessmentsByReport = new Map<string, unknown[]>();
  for (const assessment of assessmentsResult.rows) {
    const items = assessmentsByReport.get(assessment.report_id) ?? [];
    items.push({
      predicted_severity: assessment.predicted_severity,
      confidence: assessment.confidence,
      indicators: assessment.indicators,
      explanation: assessment.explanation,
      status: assessment.status,
    });
    assessmentsByReport.set(assessment.report_id, items);
  }

  return reportsResult.rows.map((report) => ({
    ...report,
    media: mediaByReport.get(report.id) ?? [],
    assessments: assessmentsByReport.get(report.id) ?? [],
  }));
}

export async function createAuditLog(
  actorId: string | null,
  action: string,
  resourceType: string,
  resourceId?: string | null,
  metadata: Record<string, any> = {}
) {
  const result = await query(
    `INSERT INTO audit_logs (actor_id, action, resource_type, resource_id, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING *`,
    [actorId, action, resourceType, resourceId ?? null, JSON.stringify(metadata)]
  );
  return result.rows[0];
}

export async function getAuditLogs(limit: number = 50) {
  const result = await query(
    `SELECT al.*, p.display_name as actor_name, p.email as actor_email, p.role as actor_role
     FROM audit_logs al
     LEFT JOIN profiles p ON p.user_id = al.actor_id
     ORDER BY al.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}
