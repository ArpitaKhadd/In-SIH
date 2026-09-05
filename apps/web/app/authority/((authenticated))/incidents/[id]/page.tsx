import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getReportById,
  getReportMedia,
  getAiAssessments,
  getVerificationEvents,
  getReportAssignment,
  getReportNotes,
  getTeamMembers,
} from "@/lib/db/queries";
import { Card, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { VerificationPanel } from "@/features/verification/VerificationPanel";
import { ImageGallery } from "@/features/incidents/ImageGallery";
import { VerificationTimeline } from "@/features/incidents/VerificationTimeline";
import type { VerificationEvent } from "@/features/incidents/VerificationTimeline";
import { AssignDropdown, NotesSection } from "@/features/incidents/AssignAndNotes";
import { SEVERITY_LABEL, SEVERITY_COLOR, VERIFICATION_LABEL, priorityBand } from "@/lib/rbac";
import type { Severity, VerificationStatus, OperationalStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function IncidentDetail({
  params,
}: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const resolvedParams = await Promise.resolve(params);
  const id = resolvedParams.id;

  const report = await getReportById(id);
  if (!report) notFound();

  const [media, assessments, rawEvents, assignment, notes, teamMembers] = await Promise.all([
    getReportMedia(id),
    getAiAssessments(id),
    getVerificationEvents(id),
    getReportAssignment(id),
    getReportNotes(id),
    getTeamMembers(),
  ]);

  const verificationEvents: VerificationEvent[] = (rawEvents as any[]).map((e) => ({
    id: e.id,
    created_at: e.created_at,
    reviewer_name: e.reviewer_name,
    previous_severity: e.previous_severity,
    new_severity: e.new_severity,
    previous_status: e.previous_status,
    new_status: e.new_status,
    reason: e.reason,
    notes: e.notes,
  }));

  const mediaWithUrls = media.map((m: any) => {
    // Normalize Windows path separators to web-safe forward slashes.
    const normalizedPath = String(m.storage_path).replace(/\\/g, "/");
    return {
      id: m.id,
      storage_path: m.storage_path,
      media_type: m.media_type,
      is_original: m.is_original,
      signed_url: !m.is_original && normalizedPath.startsWith("http")
        ? normalizedPath
        : !m.is_original
          ? `/uploads/${normalizedPath.replace(/^\/uploads\//, "")}`
          : undefined,
    };
  });

  const ai = assessments[0];
  const band = priorityBand(report.priority_score);
  const sev = (report.final_severity as Severity) ?? (ai?.predicted_severity as Severity) ?? "unclear";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <Link href="/authority/incidents" className="text-xs font-semibold text-amber-600 hover:text-amber-500 transition-colors">
          ← Back to Incidents
        </Link>
        <span className="text-[11px] font-mono text-navy-400">
          ID: <strong className="text-navy-600">{report.id}</strong>
        </span>
      </div>

      <div className="rounded-2xl border border-navy-100/60 bg-white p-5 shadow-elevated">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-black tracking-tight text-navy-900 capitalize">
                {report.disaster_type.replace("_", " ")} Incident
              </h1>
              <Badge variant="default" className="capitalize">Asset: {report.asset_type || "General"}</Badge>
            </div>
            <p className="text-[11px] text-navy-400">
              {new Date(report.submitted_at).toLocaleString()} · {report.location_source || "GPS"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={`${SEVERITY_COLOR[sev]} text-xs px-3 py-1 font-bold`}>Severity: {SEVERITY_LABEL[sev]}</Badge>
            <Badge className={`${band.color} text-xs px-3 py-1 font-bold`}>Priority: {band.label} ({report.priority_score ?? "—"}/100)</Badge>
            <Badge variant="default">{VERIFICATION_LABEL[report.verification_status as VerificationStatus] || report.verification_status}</Badge>
            <Badge variant="muted" className="uppercase font-mono">Ops: {report.operational_status}</Badge>
          </div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <Suspense fallback={<div className="animate-pulse h-96 bg-navy-100 rounded-2xl" />}>
            <ImageGallery media={mediaWithUrls} reportId={report.id} />
          </Suspense>
        </div>

        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-center justify-between border-b border-navy-100/60 pb-3 mb-3">
              <CardTitle className="text-sm font-bold text-navy-900">Vision AI Assessment</CardTitle>
              <span className="text-[10px] font-mono text-navy-400">
                {ai ? `${ai.model_name || "N/A"} (${ai.provider || "N/A"})` : "No assessment"}
              </span>
            </div>

            {ai ? (
              <div className="space-y-3 text-xs">
                <div className="flex items-center justify-between rounded-xl bg-navy-50/50 p-3 border border-navy-100/60">
                  <div>
                    <span className="text-navy-400 block text-[10px] uppercase font-semibold">Predicted Severity</span>
                    <span className="text-sm font-bold text-navy-900 capitalize">
                      {SEVERITY_LABEL[(ai.predicted_severity as Severity) ?? "unclear"]}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-navy-400 block text-[10px] uppercase font-semibold">Confidence</span>
                    <span className="text-sm font-bold text-amber-600 font-mono">
                      {ai.confidence != null ? `${Math.round(ai.confidence * 100)}%` : "—"}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-navy-400 block text-[10px] uppercase font-semibold">Triage Gate</span>
                    <span className="text-xs font-semibold text-navy-700">
                      {ai.status === "needs_human_review" ? "Human Review Req." : "High Confidence"}
                    </span>
                  </div>
                </div>

                <div>
                  <span className="font-semibold text-navy-700 block mb-1.5">Detected Indicators:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {ai.indicators && Array.isArray(ai.indicators) && ai.indicators.length > 0 ? (
                      ai.indicators.map((ind: string, i: number) => (
                        <Badge key={i} variant="info">#{ind}</Badge>
                      ))
                    ) : (
                      <span className="text-navy-400">No indicators flagged</span>
                    )}
                  </div>
                </div>

                <div>
                  <span className="font-semibold text-navy-700 block mb-1">AI Summary:</span>
                  <p className="text-navy-600 leading-relaxed bg-navy-50/50 p-3 rounded-xl border border-navy-100/60">
                    {ai.explanation || "No explanation provided."}
                  </p>
                </div>

                <p className="text-[11px] text-navy-400 italic">
                  AI assists initial triage. An authorized official must verify before dispatch.
                </p>
              </div>
            ) : (
              <p className="text-xs text-navy-400 py-4">No AI assessment available.</p>
            )}
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between border-b border-navy-100/60 pb-3 mb-3">
              <CardTitle className="text-sm font-bold text-navy-900">Priority Score Breakdown</CardTitle>
              <Badge variant="default" className="font-mono font-bold">{report.priority_score ?? 0} / 100</Badge>
            </div>
            <div className="space-y-2 text-xs">
              {[
                ["Damage Severity Weight (Max 40)", sev === "critical" ? 40 : sev === "severe" ? 32 : sev === "moderate" ? 22 : sev === "minor" ? 12 : 0],
                ["AI Confidence Weight (Max 15)", Math.round((ai?.confidence ?? 0) * 15)],
                ["Affected People Risk (Max 15)", Math.min(15, Math.ceil((report.affected_people ?? 0) / 5))],
                ["Infrastructure Impact (Max 10)", report.infrastructure_impact ? 10 : 0],
                ["Road Blockage (Max 10)", report.accessibility_blocked ? 10 : 0],
                ["Recency Boost (Max 10)", 10],
              ].map(([label, score]) => (
                <div key={label} className="flex justify-between items-center py-1 border-b border-navy-50 last:border-0">
                  <span className="text-navy-500">{label}</span>
                  <span className="font-mono font-bold text-navy-900">+{score}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Card className="p-5">
        <CardTitle className="text-sm font-bold text-navy-900 mb-3">Citizen Field Evidence</CardTitle>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          {[
            ["Observation", report.description || "No description"],
            ["Coordinates", report.location_lat && report.location_lng ? `${report.location_lat.toFixed(5)}, ${report.location_lng.toFixed(5)}` : "—"],
            ["Affected", report.affected_people ? `${report.affected_people} individuals` : "Not specified"],
            ["Impact", `${report.infrastructure_impact ? "⚡ Infra " : ""}${report.accessibility_blocked ? "🚫 Road" : "Normal"}`],
          ].map(([label, value]) => (
            <div key={label} className="p-3 rounded-xl bg-navy-50/50 border border-navy-100/60">
              <span className="text-navy-400 block font-semibold uppercase text-[10px]">{label}</span>
              <p className="text-navy-800 font-medium mt-0.5">{value}</p>
            </div>
          ))}
        </div>
      </Card>

      <VerificationPanel
        reportId={report.id}
        severity={sev}
        aiSeverity={ai?.predicted_severity as Severity}
        status={report.verification_status as VerificationStatus}
        operational={report.operational_status as OperationalStatus}
      />

      <Suspense fallback={<div className="animate-pulse h-32 bg-navy-100 rounded-2xl" />}>
        <VerificationTimeline events={verificationEvents} />
      </Suspense>

      <div className="grid gap-5 lg:grid-cols-2">
        <Suspense fallback={<div className="animate-pulse h-48 bg-navy-100 rounded-2xl" />}>
          <AssignDropdown reportId={report.id} teamMembers={teamMembers} currentAssignment={assignment} />
        </Suspense>
        <Suspense fallback={<div className="animate-pulse h-48 bg-navy-100 rounded-2xl" />}>
          <NotesSection reportId={report.id} notes={notes} />
        </Suspense>
      </div>
    </div>
  );
}
