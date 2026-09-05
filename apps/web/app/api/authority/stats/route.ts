import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest, requireAuthorityRole } from "@/lib/api-auth";
import { query } from '@/lib/db/local';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const authUser = await authenticateApiRequest(request);
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!requireAuthorityRole(authUser)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const result = await query<{
      id: string;
      disaster_type: string;
      asset_type: string | null;
      description: string | null;
      final_severity: string | null;
      ai_severity: string | null;
      ai_confidence: number | null;
      priority_score: number | null;
      verification_status: string;
      operational_status: string;
      location_lat: number | null;
      location_lng: number | null;
      submitted_at: Date;
    }>(
      `SELECT id, disaster_type, asset_type, description, final_severity, ai_severity, ai_confidence, 
              priority_score, verification_status, operational_status,
              location_lat, location_lng, submitted_at
       FROM reports 
       ORDER BY submitted_at DESC`
    );

    const rows = result.rows;

    const total = rows.length;
    const critical = rows.filter((r) => r.final_severity === "critical").length;
    const needsReview = rows.filter((r) => r.verification_status === "needs_review").length;
    const verified = rows.filter((r) => r.verification_status === "verified").length;
    const escalated = rows.filter((r) => r.verification_status === "escalated").length;
    const inProgress = rows.filter((r) => r.operational_status === "in_progress").length;

    const priorityQueue = rows
      .slice()
      .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0))
      .slice(0, 10);

    const mapReports = rows
      .filter((r) => r.location_lat != null && r.location_lng != null)
      .map((r) => ({
        id: r.id,
        lat: r.location_lat!,
        lng: r.location_lng!,
        severity: r.final_severity,
        disaster_type: r.disaster_type,
      }));

    // Calculate velocity (incidents per hour in last 24h)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentReports = rows.filter(r => new Date(r.submitted_at) > oneDayAgo);
    const velocity = Math.round(recentReports.length);

    // Average response time (mock for now - would come from actual response tracking)
    const avgResponseTime = Math.round(Math.random() * 5 + 2); // 2-7 seconds

    // Verification rate
    const verifiedCount = rows.filter(r => r.verification_status === 'verified').length;
    const verificationRate = total > 0 ? Math.round((verifiedCount / total) * 100) : 0;

    // System health (mock - would come from actual monitoring)
    const systemHealth = 99;

    return Response.json({
      total,
      critical,
      needsReview,
      verified,
      escalated,
      inProgress,
      priorityQueue: priorityQueue.map(r => ({
        ...r,
        submitted_at: r.submitted_at.toISOString(),
      })),
      mapReports,
      velocity,
      avgResponseTime,
      verificationRate,
      systemHealth,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Authority stats fetch error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 });
  }
}