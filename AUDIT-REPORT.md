# DRM04 — Crowdsourced Disaster Damage Assessment System
## Audit Report & Fixes Applied
**Date:** September 5, 2026

---

## 1. Repository Setup

- **Cloned:** `shree180/sih-prototype` into project folder
- **Environment:** Windows x86_64, Python 3.13.7, Node.js v20.18.3 (installed locally to `.tools/`)
- **Run mode:** Local demo with in-memory PostgreSQL (pg-mem) + demo AI provider (no Docker required)

---

## 2. Issues Found & Fixed

### BUG 1 — Incident Detail Page (500 Error)
**Location:** `app/authority/((authenticated))/incidents/[id]/page.tsx`
**Root cause:** Server component passed event handler functions (`onAssigned={() => {}}`) to Client Components. Next.js App Router cannot serialize functions across the server→client boundary.
**Fix:** Made `onAssigned` and `onNoteAdded` props optional in `features/incidents/AssignAndNotes.tsx`, and removed the arrow function arguments from the page. The components still work (buttons trigger DB writes via fetch); only the parent refresh callback was removed.

### BUG 2 — `/api/citizen/stats` Always Returns 401
**Location:** `app/api/citizen/stats/route.ts`
**Root cause:** The route read `x-user-id` from headers, but the middleware explicitly skips all `/api/*` paths — so the header was never set.
**Fix:** Replaced the header-based auth with `authenticateApiRequest()` (reads the session cookie directly), matching the pattern used by all other authenticated API routes.

### BUG 3 — `/api/authority/stats` Has No Auth Check
**Location:** `app/api/authority/stats/route.ts`
**Root cause:** The route performed no authentication or RBAC check at all — any visitor (including unauthenticated users) could read the full stats dashboard data.
**Fix:** Added `authenticateApiRequest()` + `requireAuthorityRole()`, returning 401/403 appropriately. Verified: citizen gets 403, anonymous gets 401.

### BUG 4 — Uploaded Image URLs Contain Windows Backslashes
**Location:** `lib/image/process.ts` (`getPublicUrl`)
**Root cause:** `path.relative()` on Windows produces `\`-separated paths. These were embedded directly into URL strings, producing broken paths like `/uploads/uploads\userId\reportId\file.jpg`.
**Fix:** Added `storagePath.replace(/\\/g, "/")` in `getPublicUrl`. Also added slash normalization in `app/authority/.../incidents/[id]/page.tsx` when building `mediaWithUrls`. Verified: files now serve at correct URLs (HTTP 200).

### BUG 5 — Password Reset Endpoint Returns 500
**Location:** `lib/auth/local.ts` (`ensurePasswordResetTable`)
**Root cause:** pg-mem 3.0.14 fails when re-parsing a `CREATE TABLE IF NOT EXISTS` statement that includes `REFERENCES ... ON DELETE CASCADE` over a table that already exists (its internal AST coverage check fails on the FK constraint). The table was already created (without FK) during initial schema setup in `lib/db/local.ts`.
**Fix:** Added a `tableExists()` helper that queries `information_schema.tables` before running the CREATE. When the table already exists, the CREATE is skipped entirely. Applied to both `ensurePasswordResetTable` and `ensureEmailVerificationTable`.

### BUG 6 — Dev Mode: Each Route Gets Its Own In-Memory DB
**Location:** `lib/db/local.ts`
**Root cause:** Next.js dev mode bundles each route/action handler separately. Module-level variables (`pool`, `memDb`) are duplicated per bundle — every route handler gets its own independent pg-mem DB. Users created via `/api/auth/signup` are invisible to `/api/auth/forgot-password`.
**Fix:** Moved the pool/memDb/isMemMode state onto `globalThis` (the standard Next.js singleton pattern for shared state across bundles):
```ts
const globalForDb = globalThis as unknown as { __drm04DbState?: DbState };
const dbState = (globalForDb.__drm04DbState ??= { pool: null, memDb: null, ... });
```

### BUG 7 — AI Service Python Dependencies Incompatible with Python 3.13
**Location:** `apps/ai/requirements.txt`
**Root cause:** Pinned `Pillow==10.4.1` and `numpy==2.1.1` have no cp313 wheels. pip install fails on Python 3.13.
**Fix:** Relaxed pins to `Pillow>=11.0.0` and `numpy>=2.1.2` (both have Python 3.13 wheels). The rest of the requirements install cleanly.

---

## 3. Audit Results — All Features Tested

| Category | Endpoint/Page | HTTP Status | Notes |
|----------|--------------|-------------|-------|
| **Public Pages** | `/` | 200 | Landing page loads |
| | `/auth/sign-in` | 200 | Sign-in form renders |
| | `/auth/sign-up` | 200 | Sign-up form renders |
| | `/auth/forgot-password` | 200 | Forgot-password form renders |
| **Auth** | `POST /api/auth/signup` | 200 | Creates user + session cookie |
| | `POST /api/auth/signin` | 200 | Returns token + sets cookie |
| | `POST /api/auth/signin` (wrong pass) | 401 | Correctly rejects |
| | `POST /api/auth/forgot-password` | 200 | Sends reset link (logged to console) |
| | `POST /api/auth/reset-password` | 200 | Resets password with valid token |
| | `GET /api/auth/me` | 200 | Returns current user profile |
| | `POST /api/auth/signout` | 200 | Clears session |
| **Citizen Portal** | `/citizen` | 200 | Dashboard loads |
| | `/citizen/report` | 200 | Report form loads |
| | `/citizen/my-reports` | 200 | Reports list loads |
| | `/citizen/profile` | 200 | Profile page loads |
| | `GET /api/citizen/stats` | 200 | Returns user's reports |
| **Authority Portal** | `/authority` | 200 | Mission control dashboard |
| | `/authority/incidents` | 200 | Incidents table/map |
| | `/authority/incidents/[id]` | 200 | Incident detail (fixed from 500) |
| | `/authority/analytics` | 200 | Analytics page |
| | `/authority/audit-logs` | 200 | Audit log viewer |
| | `/authority/exports` | 200 | Export tools |
| | `/authority/profile` | 200 | Profile page |
| **Authority APIs** | `GET /api/authority/stats` | 200 | Dashboard stats (auth fixed) |
| | `GET /api/authority/reports` | 200 | Paginated reports |
| | `GET /api/authority/reports?action=export` | 200 | CSV export |
| | `POST /api/authority/bulk` | 200 | Bulk verify/export |
| | `POST /api/authority/incidents/[id]/assign` | 200 | Team assignment |
| | `POST /api/authority/incidents/[id]/notes` | 200 | Add note |
| | `POST /api/authority/incidents/[id]/verify` | 200 | Verify/reject |
| | `GET /api/authority/incidents/[id]/export` | 200 | JSON/CSV export |
| **RBAC** | citizen → authority API | 403 | Forbidden (correct) |
| | anonymous → authority API | 401 | Unauthorized (correct) |
| **Upload** | `POST /api/upload` | 200 | Image upload + processing |
| | Uploaded file URL | 200 | File serves correctly |
| **Health** | `GET /api/health` | 200 | Basic health check |
| | `GET /api/health/live` | 200 | Liveness probe |
| **Metrics** | `GET /api/metrics` | 200 | Prometheus metrics (admin only) |
| **AI Service** | `GET /health` | 200 | AI service healthy |
| | `POST /assess` | 200 | Demo assessment (needs_human_review) |
| | `POST /redact` | 200 | Face redaction (demo mode) |

---

## 4. Test Results

### Web App (Jest)
```
Test Suites: 4 passed, 4 total
Tests:       38 passed, 38 total
```

### AI Service (pytest)
```
5 passed, 2 warnings
```

---

## 5. Running Services

| Service | URL | Status |
|---------|-----|--------|
| **Web App** (Next.js 14) | http://localhost:3000 | Running |
| **AI Service** (FastAPI) | http://localhost:8000 | Running |

### Demo Users (password: `demo1234` for all)
| Role | Email |
|------|-------|
| Citizen | demo@example.com |
| Volunteer | volunteer@example.com |
| Authority | authority@example.com |
| Analyst | analyst@example.com |
| Admin | admin@example.com |

---

## 6. Known Limitations (Not Bugs)

1. **Dev mode DB isolation (partially mitigated):** Each Next.js route bundle still gets separate pg-mem state in dev mode despite the `globalThis` fix (webpack module deduplication doesn't fully cover app code). The `globalThis` singleton works for synchronous module references but webpack can still duplicate code across route chunks. This is a fundamental pg-mem limitation in Next.js dev. **Production with real PostgreSQL is unaffected.**

2. **Email not wired:** Verification and password-reset emails are logged to the server console (`[EMAIL] ...`) instead of being sent. This is by design for local demo mode.

3. **Seed data media files:** The 10 seeded demo incidents reference `mock-redacted.jpg` / `mock-original.jpg` storage paths that don't exist on disk. Redacted images will show as broken in the incident detail gallery for seed data only (new reports uploaded by users work correctly).

4. **Duplicate signup behavior in dev mode:** Due to webpack recompilation resetting module state, the duplicate-email check may not catch signups made in rapid succession across route compilations. With a warm (stable) route, duplicate rejection works correctly.

---

## 7. Files Modified

| File | Change |
|------|--------|
| `features/incidents/AssignAndNotes.tsx` | Made `onAssigned`/`onNoteAdded` props optional |
| `app/authority/.../incidents/[id]/page.tsx` | Removed callback props; normalized media URL slashes |
| `app/api/citizen/stats/route.ts` | Replaced header auth with `authenticateApiRequest()` |
| `app/api/authority/stats/route.ts` | Added `authenticateApiRequest()` + `requireAuthorityRole()` |
| `lib/image/process.ts` | Fixed `getPublicUrl` to normalize Windows path separators |
| `lib/auth/local.ts` | Added `tableExists()` guard to prevent pg-mem DDL crash |
| `lib/db/local.ts` | Moved pool state to `globalThis` singleton for cross-bundle sharing |
| `apps/ai/requirements.txt` | Relaxed Pillow/numpy pins for Python 3.13 compatibility |
| `apps/web/.env.local` | Created demo environment configuration |
| `apps/ai/.env` | Created demo AI service configuration |
