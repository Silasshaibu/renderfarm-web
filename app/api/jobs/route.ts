import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth-server'
import { sql, initDB } from '@/lib/db'
import { sendEmail, jobCompleteEmail } from '@/lib/email'
import { spawnChunkVMs } from '@/lib/gcp/compute'
import { INTERNAL_SECRET } from '@/lib/gcp/clients'
import { parseFrameRange, chunkFrames, resolveScoutFrames } from '@/lib/utils/frames'
import { ensureCreditSchema, getBalance } from '@/lib/credits'
import { requiresCardToContinue } from '@/lib/billing'
import { checkIPBlocklist, getClientIP } from '@/lib/middleware/ipBlocklist'
import {
  checkFileSizeLimit,
  checkDailyUploadLimit,
  checkTotalStorageLimit,
  checkConcurrentUploads,
  detectRapidUpload,
  detectDuplicateContent,
} from '@/lib/uploadLimiting'



// Map a DB row → the ApiJob shape the frontend expects
function rowToJob(row: Record<string, unknown>) {
  return {
    id:                 String(row.id),
    jobNumber:          row.job_number,
    title:              row.title,
    status:             row.status,
    frames:             row.frames,
    software:           row.software,
    priority:           row.priority           ?? 5,
    createdAt:          row.created_at,
    blenderFile:        row.blender_file ?? '',
    outputs:            (row.outputs as string[]) ?? [],
    manifest:           row.manifest ?? {},
    assetsTotal:        row.assets_total    ?? 0,
    assetsUploaded:     row.assets_uploaded ?? 0,
    outputPath:         row.output_path         ?? '',
    workerHost:         row.worker_host          ?? '',
    statusDescription:  row.status_description   ?? '',
    costUsd:            Number(row.cost_usd      ?? 0),
    provider:           (row.provider as string)  ?? 'renderfarm',
    gcsScenePath:       (row.gcs_scene_path as string) ?? '',
    heldFrames:         (row.held_frames as number[]) ?? [],
    avgFrameSec:        row.avg_frame_sec != null ? Number(row.avg_frame_sec) : null,
    projectId:          row.project_id != null ? Number(row.project_id) : null,
    taskCount:          row.task_count  != null ? Number(row.task_count)  : null,
    renderSettings:     (row.render_settings as Record<string, unknown>) ?? null,
    parentJobId:        row.parent_job_id != null ? Number(row.parent_job_id) : null,
    rerenderNumber:     row.rerender_number != null ? Number(row.rerender_number) : 0,
  }
}

// GET /api/jobs — list all jobs, or single job with ?jobNumber=RF-XXXX
export async function GET(req: NextRequest) {
  const user = await verifyToken(req)
  if (!user) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 })

  await initDB()

  const jobNumber = req.nextUrl.searchParams.get('jobNumber')
  if (jobNumber) {
    const rows = await sql`
      SELECT j.*,
        COUNT(DISTINCT tc.id)                                                     AS task_count,
        ROUND(AVG(EXTRACT(EPOCH FROM (t.completed_at - t.started_at))))          AS avg_frame_sec
      FROM jobs j
      LEFT JOIN tasks tc ON tc.job_id = j.id
      LEFT JOIN tasks t  ON t.job_id  = j.id
        AND t.started_at IS NOT NULL AND t.completed_at IS NOT NULL
      WHERE j.job_number = ${jobNumber}
      GROUP BY j.id
      LIMIT 1
    `
    if (!rows.length) return NextResponse.json({ message: 'Job not found' }, { status: 404 })
    return NextResponse.json(rowToJob(rows[0] as Record<string, unknown>))
  }

  const rows = await sql`
    SELECT j.*,
      COUNT(DISTINCT tc.id)                                                     AS task_count,
      ROUND(AVG(EXTRACT(EPOCH FROM (t.completed_at - t.started_at))))          AS avg_frame_sec
    FROM jobs j
    LEFT JOIN tasks tc ON tc.job_id = j.id
    LEFT JOIN tasks t  ON t.job_id  = j.id
      AND t.started_at IS NOT NULL AND t.completed_at IS NOT NULL
    GROUP BY j.id
    ORDER BY j.created_at DESC
  `
  return NextResponse.json(rows.map(r => rowToJob(r as Record<string, unknown>)))
}

// POST /api/jobs — create a new job (called by the Blender addon after upload)
export async function POST(req: NextRequest) {
  // Check IP blocklist first
  const ipBlock = await checkIPBlocklist(req)
  if (ipBlock) return ipBlock

  const user = await verifyToken(req)
  if (!user) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 })

  await initDB()
  await ensureCreditSchema().catch(() => null)

  // Check upload rate limits
  const clientIP = getClientIP(req)
  const userRow0 = await sql`SELECT uploads_blocked FROM users WHERE id = ${user.sub} LIMIT 1` as Record<string, unknown>[]
  if (userRow0[0]?.uploads_blocked) {
    return NextResponse.json(
      { message: 'Uploads are blocked on this account due to abuse detection. Contact support.' },
      { status: 429 }
    )
  }

  // ── Suspension + credit checks ────────────────────────────────────────────
  const userRow = await sql`
    SELECT status, suspension_reason, credit_limit, debt_hold_since, overdraft_limit
    FROM users WHERE id = ${user.sub} LIMIT 1
  ` as Record<string, unknown>[]
  if (userRow[0]?.status === 'suspended') {
    return NextResponse.json(
      { message: `Account suspended. Reason: ${userRow[0].suspension_reason ?? 'Contact support.'}` },
      { status: 403 }
    )
  }

  const balance         = await getBalance(user.sub).catch(() => 999)
  const creditLimit     = Number(userRow[0]?.credit_limit ?? 0)
  const overdraftLimit  = Number(userRow[0]?.overdraft_limit ?? -5)  // -$5 limit
  const inDebtHold      = Boolean(userRow[0]?.debt_hold_since)  // exceeded overdraft limit

  // Hold if: manual credit_limit exceeded OR overdraft limit exceeded
  const creditHold = inDebtHold || balance <= -creditLimit

  // Free-trial gate: cardless user who has consumed the free-usage cap must add a card
  const cardGate = await requiresCardToContinue(Number(user.sub)).catch(() => ({
    required: false, hasCard: true, usageConsumed: 0, freeLimit: 10,
  }))
  const cardRequired = cardGate.required

  const data = await req.json() as {
    title?:              string
    frames?:             string
    software?:           string
    blender_file?:       string
    output_folder?:      string   // Blender addon sends this
    status?:             string
    manifest?:           Record<string, unknown>
    assets_total?:       number
    assets_uploaded?:    number
    status_description?: string
    provider?:           string   // 'renderfarm' | 'gcp'
    gcs_scene_path?:     string   // GCS path after direct upload e.g. jobs/abc/scene.blend
    machine_type?:       string   // GCP machine type e.g. 'n1-standard-4'
    preemptible?:        boolean
    project_id?:         number | string  // required — must be an active project
    projectId?:          number | string  // camelCase alias sent by SubmissionKit renderfarm path
    project?:            number | string  // string ID alias sent by the Blender addon
    chunk_size?:         number           // top-level field sent by Blender addon
    scout_frames?:       string           // top-level field sent by Blender addon
    use_scout_frames?:   boolean          // top-level field sent by Blender addon
  }

  // ── Project validation — every job must belong to an active project ─────────
  const rawProjectId = data.project_id ?? data.projectId ?? data.project
  const projectIdNum = rawProjectId ? Number(rawProjectId) : null
  if (!projectIdNum) {
    return NextResponse.json(
      { message: 'A project is required to submit a job. Please create and activate a project in Admin → Projects first.' },
      { status: 400 }
    )
  }
  const projectRows = await sql`
    SELECT id FROM projects WHERE id = ${projectIdNum} AND is_active = TRUE LIMIT 1
  `
  if (!projectRows.length) {
    return NextResponse.json(
      { message: 'Project not found or not active. Select an active project before submitting.' },
      { status: 400 }
    )
  }

  // Validate status — all 12 Conductor statuses + legacy DB names
  const VALID_STATUSES = [
    'queued', 'done',                                        // legacy
    'upload_pending', 'uploading', 'sync_pending',
    'sync_failed', 'syncing', 'pending', 'holding',
    'running', 'success', 'downloaded', 'failed', 'preempted',
  ]
  const baseStatus = (data.status && VALID_STATUSES.includes(data.status))
    ? data.status
    : 'queued'
  // Hold the job if: out of credits OR free trial used up and no card on file
  const isHeld = creditHold || cardRequired
  const status = isHeld ? 'holding' : baseStatus

  // Generate next RF-XXXX number
  const countRows = await sql`SELECT COUNT(*) AS cnt FROM jobs`
  const nextNum   = Number((countRows[0] as Record<string, unknown>).cnt) + 1
  const jobNumber = `RF-${String(nextNum).padStart(4, '0')}`

  // Persist scout/chunk data into the manifest for ALL jobs (not just GCP), so the
  // local render worker can also see it — previously these top-level fields were only
  // read transiently for the GCP dispatch branch below and never survived to storage.
  const manifestObj: Record<string, unknown> = data.manifest ? { ...data.manifest } : {}
  if (data.chunk_size !== undefined && manifestObj.chunk_size === undefined) {
    manifestObj.chunk_size = data.chunk_size
  }
  if (data.scout_frames !== undefined && manifestObj.scout_frames === undefined) {
    manifestObj.scout_frames = data.scout_frames
  }
  if (data.use_scout_frames !== undefined && manifestObj.use_scout_frames === undefined) {
    manifestObj.use_scout_frames = data.use_scout_frames
  }
  const manifest           = JSON.stringify(manifestObj)
  const assetsTotal        = data.assets_total    ?? 0
  const assetsUploaded     = data.assets_uploaded  ?? 0
  const outputPath         = data.output_folder    ?? ''
  const statusDescription  = cardRequired
    ? `Free trial used up ($${cardGate.freeLimit.toFixed(2)}). Add a payment card to keep rendering — you won't be charged until you exceed your free credits.`
    : creditHold
    ? (inDebtHold
        ? `Overdraft limit exceeded (balance $${balance.toFixed(2)}). Add credits to release this job.`
        : creditLimit > 0
          ? `Outstanding balance limit of $${creditLimit.toFixed(2)} reached. Add credits to start rendering.`
          : `No credits remaining. Add credits to your account to start rendering.`)
    : (data.status_description ?? '')
  const provider           = data.provider         ?? 'renderfarm'
  const gcsScenePath       = data.gcs_scene_path   ?? ''

  // Ensure render_settings column exists
  await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS render_settings JSONB DEFAULT '{}'::jsonb`.catch(() => null)
  await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS parent_job_id INTEGER DEFAULT NULL`.catch(() => null)
  await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS rerender_number INTEGER DEFAULT 0`.catch(() => null)

  // render_settings from Blender addon — store full render config for re-render modal
  const renderSettingsRaw = (data as Record<string, unknown>).render_settings as Record<string, unknown> | undefined
  const renderSettings = renderSettingsRaw ? JSON.stringify({
    samples:             renderSettingsRaw.samples,
    resolution_x:        renderSettingsRaw.resolution_x,
    resolution_y:        renderSettingsRaw.resolution_y,
    resolution_pct:      renderSettingsRaw.resolution_pct,
    output_path:         renderSettingsRaw.output_path ?? data.output_folder,
    engine:              renderSettingsRaw.engine,
    cameras:             renderSettingsRaw.cameras,
    active_camera:       renderSettingsRaw.active_camera,
    chunk_size:          renderSettingsRaw.chunk_size ?? data.chunk_size,
    instance_type:       renderSettingsRaw.instance_type,
    machine_type:        renderSettingsRaw.machine_type,
    preemptible:         renderSettingsRaw.preemptible,
    preemptible_retries: renderSettingsRaw.preemptible_retries,
    scout_frames:        renderSettingsRaw.scout_frames ?? data.scout_frames,
    frame_range:         data.frames,
    blender_version:     renderSettingsRaw.blender_version ?? data.software,
  }) : null

  // Notification prefs from Blender addon payload
  const notifData      = (data as Record<string, unknown>).notifications as Record<string, unknown> | undefined
  const notifEmail     = Boolean(notifData?.email     ?? true)
  const notifSound     = Boolean(notifData?.sound     ?? false)
  const notifOn        = String(notifData?.notify_on  ?? 'BOTH')

  await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notification_email   BOOLEAN DEFAULT FALSE`.catch(() => null)
  await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notification_sound   BOOLEAN DEFAULT FALSE`.catch(() => null)
  await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notification_on      TEXT    DEFAULT 'BOTH'`.catch(() => null)
  await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notification_sent    BOOLEAN DEFAULT FALSE`.catch(() => null)
  await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notification_sent_at TIMESTAMPTZ DEFAULT NULL`.catch(() => null)

  const rows = await sql`
    INSERT INTO jobs (
      job_number, title, frames, software, blender_file, status,
      manifest, assets_total, assets_uploaded,
      output_path, status_description, provider, gcs_scene_path,
      project_id, notification_email, notification_sound, notification_on,
      render_settings, held_for_debt, held_for_card
    )
    VALUES (
      ${jobNumber},
      ${data.title        ?? 'Untitled Job'},
      ${data.frames       ?? '1-1'},
      ${data.software     ?? 'blender-4-1'},
      ${data.blender_file ?? ''},
      ${status},
      ${manifest}::jsonb,
      ${assetsTotal},
      ${assetsUploaded},
      ${outputPath},
      ${statusDescription},
      ${provider},
      ${gcsScenePath},
      ${projectIdNum},
      ${notifEmail},
      ${notifSound},
      ${notifOn},
      ${renderSettings}::jsonb,
      ${creditHold},
      ${cardRequired}
    )
    RETURNING *
  `

  const job = rowToJob(rows[0] as Record<string, unknown>)

  // ── Card-required hold: free trial used up, no card on file ────────────────
  if (cardRequired) {
    const userEmailRow = await sql`SELECT email FROM users WHERE id = ${user.sub} LIMIT 1` as Record<string, unknown>[]
    const userEmail = userEmailRow[0]?.email as string | undefined
    if (userEmail) {
      const payUrl = (process.env.NEXT_PUBLIC_BASE_URL ?? 'https://renderfarm.swade-art.com') + '/admin?tab=payment'
      sendEmail({
        to: userEmail,
        subject: `Add a card to continue rendering — ${String(job.jobNumber)}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0f1117;border-radius:8px;color:#e2e8f0;">
            <h2 style="color:#fff;margin-top:0;">Add a Payment Card to Continue</h2>
            <p style="color:#94a3b8;line-height:1.6;">
              You've used your <strong>$${cardGate.freeLimit.toFixed(2)}</strong> free trial. Your job
              <strong>${String(job.jobNumber)}</strong> is saved and on hold.
            </p>
            <p style="color:#94a3b8;line-height:1.6;">
              Add a payment card to keep rendering. <strong>You won't be charged</strong> until you
              exceed your remaining free credits — the card just verifies your account.
            </p>
            <p><a href="${payUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Add Payment Card →</a></p>
          </div>`,
      }).catch(() => null)
    }

    return NextResponse.json({
      jobNumber:  job.jobNumber,
      id:         job.id,
      held:       true,
      holdReason: 'card_required',
      message:    statusDescription,
      usageConsumed: cardGate.usageConsumed,
      freeLimit:  cardGate.freeLimit,
      balance,
    }, { status: 201 })
  }

  // ── Credit hold: notify user + admin, skip VM dispatch ────────────────────
  if (creditHold) {
    // Email the user
    const userEmailRow = await sql`SELECT email, name FROM users WHERE id = ${user.sub} LIMIT 1` as Record<string, unknown>[]
    const userEmail = userEmailRow[0]?.email as string | undefined
    if (userEmail) {
      const dashboardUrl = (process.env.NEXT_PUBLIC_BASE_URL ?? 'https://renderfarm-web.vercel.app') + '/billing'
      sendEmail({
        to: userEmail,
        subject: `⚠ Your render job is on hold — ${String(job.jobNumber)}`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff;">
            <h2 style="color:#111;margin-top:0;">Render Job On Hold</h2>
            <p style="color:#444;line-height:1.6;">
              Your job <strong>${String(job.jobNumber)} — ${String(data.title ?? 'Untitled')}</strong> has been
              uploaded successfully but cannot start because your credit balance is
              ${creditLimit > 0
                ? `at its limit of <strong>$${creditLimit.toFixed(2)}</strong>`
                : 'at <strong>$0.00</strong>'}.
            </p>
            <p style="color:#444;line-height:1.6;">
              Add credits to your account and the job will be released automatically.
            </p>
            <p><a href="${dashboardUrl}"
              style="display:inline-block;padding:12px 24px;background:#0d9488;color:#fff;border-radius:5px;text-decoration:none;font-weight:600;">
              Add Credits →
            </a></p>
            <p style="color:#999;font-size:13px;">
              You can also ask your admin to increase your balance limit or grant credits directly.
            </p>
          </div>`,
      }).catch(() => null)
    }

    // Notify admin
    const adminRow = await sql`SELECT email FROM users WHERE is_admin = TRUE AND is_active = TRUE LIMIT 1` as Record<string, unknown>[]
    const adminEmail = adminRow[0]?.email as string | undefined
    if (adminEmail && adminEmail !== userEmail) {
      const adminUrl = (process.env.NEXT_PUBLIC_BASE_URL ?? 'https://renderfarm-web.vercel.app') + '/admin'
      sendEmail({
        to: adminEmail,
        subject: `[Admin] Job held — no credits: ${String(job.jobNumber)} (${userEmail ?? 'unknown'})`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fff;">
            <h2 style="color:#111;margin-top:0;">Job On Hold — Insufficient Credits</h2>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr><td style="padding:6px 4px;color:#888;width:120px;">User</td><td style="padding:6px 4px;">${userEmail ?? String(user.sub)}</td></tr>
              <tr><td style="padding:6px 4px;color:#888;">Job</td><td style="padding:6px 4px;font-family:monospace;">${String(job.jobNumber)}</td></tr>
              <tr><td style="padding:6px 4px;color:#888;">Balance</td><td style="padding:6px 4px;">$${balance.toFixed(2)}</td></tr>
              <tr><td style="padding:6px 4px;color:#888;">Limit</td><td style="padding:6px 4px;">$${creditLimit.toFixed(2)}</td></tr>
            </table>
            <p><a href="${adminUrl}"
              style="display:inline-block;margin-top:16px;padding:12px 24px;background:#6366f1;color:#fff;border-radius:5px;text-decoration:none;font-weight:600;">
              Go to Admin →
            </a></p>
          </div>`,
      }).catch(() => null)
    }

    return NextResponse.json({
      jobNumber:   job.jobNumber,
      id:          job.id,
      held:        true,
      holdReason:  'insufficient_credits',
      message:     statusDescription,
      balance,
    }, { status: 201 })
  }

  // ── Auto-dispatch GCP VMs using chunk + scout architecture ─────────────────
  if (gcsScenePath) {
    try {
      const allFrames   = parseFrameRange(data.frames ?? '1-1')
      const appUrl      = process.env.NEXT_PUBLIC_APP_URL ?? 'https://renderfarm-web.vercel.app'
      const machineType = data.machine_type || 'n1-standard-4'
      const preemptible = data.preemptible  ?? true
      const software    = data.software     || 'blender-4-1'
      // chunk_size and scout_frames may be top-level (Blender addon) or inside manifest (SubmissionKit)
      const chunkSize   = Number(data.chunk_size ?? (data.manifest as Record<string, unknown> | undefined)?.chunk_size ?? 1)
      const useScouts   = data.use_scout_frames ?? true
      const rawScout    = data.scout_frames ?? String((data.manifest as Record<string, unknown> | undefined)?.scout_frames ?? '')
      const scoutExpr   = useScouts ? rawScout : ''

      const scoutFrames = resolveScoutFrames(scoutExpr, allFrames)
      const chunks      = chunkFrames(allFrames, chunkSize, scoutFrames)
      const hasScouts   = scoutFrames.length > 0

      // Pre-create ALL task rows: scouts = pending, non-scouts = held (if scouts defined)
      const jobIdInt = Number(job.id)
      for (const chunk of chunks) {
        const taskStatus = (!hasScouts || chunk.isScout) ? 'pending' : 'held'
        await sql`
          INSERT INTO tasks (job_id, frame_index, frame_number, chunk_index, start_frame, end_frame, status, is_scout)
          VALUES (${jobIdInt}, ${chunk.index}, ${chunk.startFrame}, ${chunk.index}, ${chunk.startFrame}, ${chunk.endFrame}, ${taskStatus}, ${chunk.isScout})
          ON CONFLICT (job_id, frame_index) DO NOTHING
        `
      }

      // Update status to running BEFORE spawning VMs so it's always correct
      await sql`
        UPDATE jobs
        SET status      = 'running',
            held_frames = '[]'::jsonb,
            updated_at  = NOW()
        WHERE id = ${job.id}
      `

      // Spawn VMs only for scout chunks (or all if no scouts configured)
      const toDispatch = hasScouts ? chunks.filter(c => c.isScout) : chunks
      try {
        await spawnChunkVMs(
          String(job.id), toDispatch, gcsScenePath,
          machineType, preemptible, appUrl, INTERNAL_SECRET, software
        )
      } catch (vmErr) {
        const msg = vmErr instanceof Error ? vmErr.message : String(vmErr)
        console.error('[jobs POST] GCP VM spawn failed:', msg)
        // Write the error into status_description so dashboard shows it
        await sql`
          UPDATE jobs
          SET status_description = ${'VM spawn failed: ' + msg},
              updated_at         = NOW()
          WHERE id = ${job.id}
        `
      }
    } catch (err) {
      console.error('[jobs POST] GCP dispatch failed:', err)
    }
  }

  return NextResponse.json({ jobNumber: job.jobNumber, id: job.id }, { status: 201 })
}

// PATCH /api/jobs?id= — render worker (or dashboard) updates job fields
export async function PATCH(req: NextRequest) {
  const user = await verifyToken(req)
  if (!user) return NextResponse.json({ message: 'Unauthorized' }, { status: 401 })

  await initDB()

  const id   = req.nextUrl.searchParams.get('id')
  const body = await req.json() as {
    status?:             string
    outputs?:            string[]
    assets_uploaded?:    number
    manifest?:           Record<string, unknown>
    worker_host?:        string
    status_description?: string
    priority?:           number
  }

  // manifest: merge new keys into existing jsonb (don't replace the whole object)
  const manifestPatch = body.manifest ? JSON.stringify(body.manifest) : null

  const rows = await sql`
    UPDATE jobs
    SET status             = COALESCE(${body.status             ?? null}, status),
        outputs            = COALESCE(${body.outputs            ? JSON.stringify(body.outputs) : null}::jsonb, outputs),
        assets_uploaded    = COALESCE(${body.assets_uploaded    ?? null}, assets_uploaded),
        manifest           = CASE WHEN ${manifestPatch}::text IS NOT NULL
                               THEN manifest || ${manifestPatch}::jsonb
                               ELSE manifest END,
        worker_host        = COALESCE(${body.worker_host        ?? null}, worker_host),
        status_description = COALESCE(${body.status_description ?? null}, status_description),
        priority           = COALESCE(${body.priority           ?? null}, priority),
        updated_at         = NOW()
    WHERE id = ${id}
    RETURNING *
  `

  if (!rows.length) return NextResponse.json({ message: 'Job not found' }, { status: 404 })

  const updatedJob = rowToJob(rows[0] as Record<string, unknown>)

  // Send job-complete email when the worker marks a job 'success'
  if (body.status === 'success') {
    try {
      // Look up the job owner's email via the user_id stored in the job manifest,
      // or fall back to looking up by the authenticated user's sub.
      const ownerRows = await sql`
        SELECT u.email FROM users u
        INNER JOIN jobs j ON j.manifest->>'submitter_email' = u.email
                         OR u.id = ${(rows[0] as Record<string,unknown>).id}
        WHERE j.id = ${id}
        LIMIT 1
      ` as Record<string, unknown>[]

      // Simpler: look up the user who owns this token (the worker reuses the artist's token)
      const userRows = await sql`SELECT email FROM users WHERE id = ${user.sub} LIMIT 1` as Record<string, unknown>[]
      const ownerEmail = (userRows[0]?.email ?? ownerRows[0]?.email) as string | undefined

      if (ownerEmail) {
        const outputs = (updatedJob.outputs ?? []) as string[]
        await sendEmail({
          to:      ownerEmail,
          subject: `Render complete: ${updatedJob.jobNumber}`,
          html:    jobCompleteEmail({
            email:      ownerEmail,
            jobNumber:  String(updatedJob.jobNumber),
            title:      String(updatedJob.title),
            frameCount: outputs.length,
          }),
        })
      }
    } catch { /* email is best-effort */ }
  }

  return NextResponse.json(updatedJob)
}
