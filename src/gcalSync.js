// Build Brief v4, step 3 — the outbound sync worker's actual orchestration:
// drains gcal_pending_syncs/gcal_pending_deletes, builds Google event
// bodies from CMMS rows, calls gcal.js, and reports into system_health.
// Split out of db.js (no SQL-shaped business logic belongs there beyond
// plain queries) and out of gcal.js (which only ever talks to Google, never
// interprets what a job line or calendar event IS). scripts/gcal-sync-
// worker.js is the cron entry point; the admin "Sync now"/"Regenerate all
// events" actions in pg-api.js call runGcalSyncDrain directly too.
import {
  getGcalSyncTarget, listDueGcalSyncs, listDueGcalDeletes,
  resolveGcalSync, markGcalSyncRetry, resolveGcalDelete, markGcalDeleteRetry,
  getJobLineForGcalSync, setJobLineGcalEventId,
  getCalendarEventForGcalSync, setCalendarEventGcalEventId,
  getWorkOrderRevisitForGcalSync, setWorkOrderGcalEventId,
  getFindingRevisitForGcalSync, setFindingGcalEventId,
  getGcalEventColors, recordSystemHealthSuccess, recordSystemHealthFailure,
} from './db.js';
import { gcalIsConfigured, getAccessTokenOrThrow, insertEvent, updateEvent, deleteEvent } from './gcal.js';

// Answered by Ben (2026-09-14): the camp itself, not the container (which
// runs in UTC — no TZ is set anywhere in this deploy, see docker-compose.yml).
// Every naive date/time this app stores means wall-clock time at the camp;
// this is the one place that fact gets attached to an outbound event so
// Google shows the same wall-clock time back to any viewer, regardless of
// their own timezone. If Sychar ever runs work at a second camp in another
// zone, this stops being a single constant — not a concern today.
const CAMP_TIMEZONE = 'America/New_York';

const MAX_BATCH = 25;
const BACKOFF_CAP_MINUTES = 60;

function backoffMinutes(attempts) {
  return Math.min(BACKOFF_CAP_MINUTES, 2 ** attempts);
}

function pad2(n) { return String(n).padStart(2, '0'); }

// DATE columns come back from pg as JS Date objects at local midnight; the
// container runs in UTC (no TZ set anywhere in this deploy — see
// update-for-claude.md), so toISOString's UTC slice is exactly the stored
// calendar date, same pattern listCalendarEventOccurrences already uses.
function dateStr(d) { return d.toISOString().slice(0, 10); }

function addDaysToDateStr(str, days) {
  if (!days) return str;
  const d = new Date(`${str}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return dateStr(d);
}

// Pure wall-clock arithmetic (minutes since midnight), never a real Date
// object — job_lines express duration in decimal hours, not an end_time, so
// this is the only way to get an end time/date without smuggling in the
// container's own UTC offset. Rolls past midnight into the next day for a
// duration that runs that long (rare, but a graveyard-shift work session on
// a scheduled_start_time of 22:00 with a long duration is real enough not
// to just get the wrong end time).
function addHoursToTime(dStr, tStr, hours) {
  const [h, m] = tStr.split(':').map(Number);
  const totalMin = h * 60 + m + Math.round(hours * 60);
  const dayOffset = Math.floor(totalMin / 1440);
  const remMin = ((totalMin % 1440) + 1440) % 1440;
  return {
    date: addDaysToDateStr(dStr, dayOffset),
    time: `${pad2(Math.floor(remMin / 60))}:${pad2(remMin % 60)}`,
  };
}

function timedPoint(dStr, tStr) {
  return { dateTime: `${dStr}T${tStr}:00`, timeZone: CAMP_TIMEZONE };
}
// Google's all-day end.date is EXCLUSIVE (the day after the last visible
// day) — a single all-day event on the 20th needs end.date = the 21st, and
// a Friday-Sunday span's end.date is Monday, not Sunday. Easy to get wrong
// silently (Google just renders one day short, no error), so it's isolated
// here rather than inlined at each call site.
function allDayPoint(lastInclusiveDateStr) {
  return { date: addDaysToDateStr(lastInclusiveDateStr, 1) };
}

function buildRRule(recurrenceType, recurrenceInterval, recurrenceEndDate, isTimed) {
  const freqMap = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };
  const freq = freqMap[recurrenceType];
  if (!freq) return undefined;
  const parts = [`FREQ=${freq}`, `INTERVAL=${Math.max(1, recurrenceInterval || 1)}`];
  if (recurrenceEndDate) {
    const endStr = dateStr(recurrenceEndDate);
    // UNTIL must match DTSTART's value type (RFC5545) — DATE for an all-day
    // event, UTC DATE-TIME for a timed one. 23:59:59Z of the end date is
    // safe for any US timezone (all behind UTC): the last local occurrence
    // that calendar day always starts before that UTC instant.
    parts.push(`UNTIL=${isTimed ? `${endStr.replace(/-/g, '')}T235959Z` : endStr.replace(/-/g, '')}`);
  }
  return [`RRULE:${parts.join(';')}`];
}

const MANAGED_FOOTER = 'Managed automatically by Sychar Operations — edits made directly in Google Calendar are overwritten on the next sync.';

// Same host gcal.js's OAuth redirect_uri is hardcoded against — no env var
// for the app's own base URL exists anywhere else in this codebase, and a
// deep link back into the app (below) needs one.
const APP_BASE_URL = 'https://audit.fracturedrv.com';

// ── Event body builders — one per synced entity_type. ───────────────────────

function buildJobLineEventBody(jl, jobLineColorId) {
  const place = jl.asset_name || jl.location_name;
  const summary = `${place ? `${place}: ` : ''}${jl.title}`;
  const description = [
    `Work Order #${jl.work_order_id} — ${jl.wo_title}`,
    `Status: ${jl.status_name}`,
    '',
    MANAGED_FOOTER,
  ].join('\n');
  const isTimed = !!jl.scheduled_start_time;
  const startDate = dateStr(jl.scheduled_date);
  let start, end;
  if (isTimed) {
    const durationHours = jl.scheduled_duration_hours != null ? Number(jl.scheduled_duration_hours) : 1;
    const endPoint = addHoursToTime(startDate, jl.scheduled_start_time.slice(0, 5), durationHours);
    start = timedPoint(startDate, jl.scheduled_start_time.slice(0, 5));
    end = timedPoint(endPoint.date, endPoint.time);
  } else {
    start = { date: startDate };
    end = allDayPoint(startDate);
  }
  return {
    summary, description, start, end,
    colorId: jobLineColorId || undefined,
    extendedProperties: { private: { sychar_entity_type: 'job_line', sychar_entity_id: String(jl.id) } },
  };
}

function buildCalendarEventEventBody(ev) {
  const summary = ev.type_name ? `${ev.type_name} — ${ev.title}` : ev.title;
  const descriptionLines = [];
  if (ev.description) descriptionLines.push(ev.description, '');
  if (ev.work_order_id) descriptionLines.push(`Work Order #${ev.work_order_id} — ${ev.wo_title}`);
  if (ev.job_line_id) descriptionLines.push(`Job line: ${ev.job_line_title}`);
  if (descriptionLines.length) descriptionLines.push('');
  descriptionLines.push(MANAGED_FOOTER);
  const isTimed = !!ev.start_time && !!ev.end_time;
  const startDateStr = dateStr(ev.event_date);
  const endDateStr = ev.end_date ? dateStr(ev.end_date) : startDateStr;
  let start, end;
  if (isTimed) {
    start = timedPoint(startDateStr, ev.start_time.slice(0, 5));
    end = timedPoint(endDateStr, ev.end_time.slice(0, 5));
  } else {
    start = { date: startDateStr };
    end = allDayPoint(endDateStr);
  }
  return {
    summary, description: descriptionLines.join('\n'), start, end,
    colorId: ev.type_gcal_color_id || undefined,
    recurrence: buildRRule(ev.recurrence_type, ev.recurrence_interval, ev.recurrence_end_date, isTimed),
    extendedProperties: { private: { sychar_entity_type: 'calendar_event', sychar_entity_id: String(ev.id) } },
  };
}

// Revisit prompts (wo_revisit/finding_revisit) — the gap flagged when this
// worker first shipped, closed 2026-09-15: a deferred work order or
// deferred finding's revisit_date is a commitment already made, not an open
// scheduling slot, so it always syncs as an all-day event, never timed —
// "a prompt, not an appointment" (Ben's framing). One builder for both
// entity types since the shape is identical; only the deep-link target and
// the record's own vocabulary ("Work Order" vs "Finding") differ. The app
// has no URL-based routing for a work order's own page, but does for an
// asset's — a finding has no dedicated detail view at all (it's read-only
// on the Asset page, see db.js's updateConditionFinding comment), so an
// asset-page deep link is the closest thing to "the record" that exists;
// an assetless finding falls back to the app's root.
function buildRevisitEventBody(row, kind, revisitColorId) {
  const place = row.asset_name ? `${row.asset_name} ` : '';
  const summary = `Revisit — ${place}${row.title} (deferred)`;
  const deepLink = kind === 'workOrder'
    ? `${APP_BASE_URL}/?openWorkOrder=${row.id}`
    : row.asset_id ? `${APP_BASE_URL}/?openAsset=${row.asset_id}` : APP_BASE_URL;
  const description = [
    `Deferred: ${row.deferred_reason || '(no reason recorded)'}`,
    `Deferred by: ${row.deferred_by || 'unknown'}`,
    '',
    `Open in Sychar Operations: ${deepLink}`,
    '',
    MANAGED_FOOTER,
  ].join('\n');
  const dateOnly = dateStr(row.revisit_date);
  return {
    summary, description,
    start: { date: dateOnly },
    end: allDayPoint(dateOnly),
    colorId: revisitColorId || undefined,
    extendedProperties: {
      private: { sychar_entity_type: kind === 'workOrder' ? 'wo_revisit' : 'finding_revisit', sychar_entity_id: String(row.id) },
    },
  };
}

// ── Per-entity-type dispatch — what to fetch, whether the Google event
//    should currently exist at all, how to build its body, and where to
//    store the resulting id back. One table instead of the job_line/
//    calendar_event if/else this replaced, now that there are four kinds. ──
const ENTITY_HANDLERS = {
  job_line: {
    fetch: getJobLineForGcalSync,
    setGcalEventId: setJobLineGcalEventId,
    shouldExist: (row) => !!row.scheduled_date,
    buildBody: (row, ctx) => buildJobLineEventBody(row, ctx.jobLineColorId),
  },
  calendar_event: {
    fetch: getCalendarEventForGcalSync,
    setGcalEventId: setCalendarEventGcalEventId,
    shouldExist: () => true,
    buildBody: (row) => buildCalendarEventEventBody(row),
  },
  wo_revisit: {
    fetch: getWorkOrderRevisitForGcalSync,
    setGcalEventId: setWorkOrderGcalEventId,
    shouldExist: (row) => row.status_name === 'Deferred' && !!row.revisit_date,
    buildBody: (row, ctx) => buildRevisitEventBody(row, 'workOrder', ctx.revisitColorId),
  },
  finding_revisit: {
    fetch: getFindingRevisitForGcalSync,
    setGcalEventId: setFindingGcalEventId,
    shouldExist: (row) => row.status === 'Deferred' && !!row.revisit_date,
    buildBody: (row, ctx) => buildRevisitEventBody(row, 'finding', ctx.revisitColorId),
  },
};

// ── One pending sync ─────────────────────────────────────────────────────

async function processSync(item, ctx) {
  const entityType = item.entity_type, entityId = item.entity_id, queuedAt = item.queued_at;
  const handler = ENTITY_HANDLERS[entityType];
  const row = await handler.fetch(entityId);

  // Row is gone (raced with a delete — deleteJobLine/deleteCalendarEvent
  // already handle the Google-side cleanup themselves), a job line no
  // longer scheduled, or a revisit whose record already left Deferred
  // (changeWorkOrderStatus/dismissFinding/autoResolveLinkedFinding queue
  // their own delete on that transition, but this is a defensive second
  // check against the same race the job_line comment above describes).
  // Either way there's nothing to sync; if it still has a Google event from
  // a previous sync, that needs deleting.
  const shouldExist = row && handler.shouldExist(row);
  if (!shouldExist) {
    if (row?.gcal_event_id) {
      await deleteEvent(ctx.accessToken, ctx.calendarId, row.gcal_event_id);
      await handler.setGcalEventId(entityId, null);
    }
    await resolveGcalSync(entityType, entityId, queuedAt);
    return { ok: true };
  }

  const body = handler.buildBody(row, ctx);
  try {
    let gcalEventId = row.gcal_event_id;
    if (gcalEventId) {
      try {
        await updateEvent(ctx.accessToken, ctx.calendarId, gcalEventId, body);
      } catch (e) {
        if (e.status !== 404) throw e;
        gcalEventId = null; // hand-deleted on Google's side; fall through to a fresh insert
      }
    }
    if (!gcalEventId) {
      const created = await insertEvent(ctx.accessToken, ctx.calendarId, body);
      gcalEventId = created.id;
      await handler.setGcalEventId(entityId, gcalEventId);
    }
    await resolveGcalSync(entityType, entityId, queuedAt);
    return { ok: true };
  } catch (e) {
    const attempts = (item.attempts || 0) + 1;
    const nextAttemptAt = new Date(Date.now() + backoffMinutes(attempts) * 60000);
    await markGcalSyncRetry(entityType, entityId, queuedAt, { attempts, nextAttemptAt, error: e.message });
    return { ok: false, error: e.message };
  }
}

async function processDelete(item, ctx) {
  try {
    await deleteEvent(ctx.accessToken, ctx.calendarId, item.gcal_event_id);
    await resolveGcalDelete(item.id);
    return { ok: true };
  } catch (e) {
    const attempts = (item.attempts || 0) + 1;
    const nextAttemptAt = new Date(Date.now() + backoffMinutes(attempts) * 60000);
    await markGcalDeleteRetry(item.id, { attempts, nextAttemptAt, error: e.message });
    return { ok: false, error: e.message };
  }
}

// ── Entry point ───────────────────────────────────────────────────────────
// One drain pass: up to MAX_BATCH deletes, then up to MAX_BATCH syncs.
// Returns a summary object rather than throwing on a partial failure — a
// handful of items failing transiently is the expected/designed-for case,
// not an exceptional one (that's the whole reason this is a queue with
// backoff instead of a direct call from the CMMS write path). Only truly
// can't-proceed conditions (not configured, not connected, dead token) are
// reported as a clean early return.
export async function runGcalSyncDrain() {
  if (!gcalIsConfigured()) return { skipped: 'not_configured' };

  const { refreshToken, calendarId } = await getGcalSyncTarget();
  if (!refreshToken) return { skipped: 'not_connected' };
  if (!calendarId) return { skipped: 'no_calendar_selected' };

  let accessToken;
  try {
    accessToken = await getAccessTokenOrThrow(refreshToken);
  } catch (e) {
    // "Do NOT retry on a dead token" (brief): nothing here counts as a
    // per-item attempt, since no per-item call was even possible — every
    // pending row stays exactly as queued and will be picked straight back
    // up once reconnected.
    if (e.deadToken) {
      await recordSystemHealthFailure('gcal_sync', 'Google Calendar refresh token is invalid — reconnect in Admin > Integrations > Google Calendar Sync.');
      return { skipped: 'dead_token' };
    }
    await recordSystemHealthFailure('gcal_sync', `Could not refresh Google access token: ${e.message}`);
    return { skipped: 'token_refresh_failed', error: e.message };
  }

  const colors = await getGcalEventColors();
  const ctx = {
    accessToken, calendarId,
    jobLineColorId: colors.find((c) => c.Kind === 'job_line')?.GcalColorId || null,
    revisitColorId: colors.find((c) => c.Kind === 'revisit')?.GcalColorId || null,
  };

  const deletes = await listDueGcalDeletes(MAX_BATCH);
  const deleteResults = [];
  for (const item of deletes) deleteResults.push(await processDelete(item, ctx));

  const syncs = await listDueGcalSyncs(MAX_BATCH);
  const syncResults = [];
  for (const item of syncs) syncResults.push(await processSync(item, ctx));

  const results = [...deleteResults, ...syncResults];
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  if (results.length === 0) {
    await recordSystemHealthSuccess('gcal_sync', 'Nothing to sync');
  } else if (succeeded > 0) {
    await recordSystemHealthSuccess('gcal_sync', `Synced ${succeeded} event(s)${failed ? `, ${failed} still retrying` : ''}`);
  } else {
    await recordSystemHealthFailure('gcal_sync', results.find((r) => !r.ok)?.error || 'Sync failed');
  }

  return { deletes: deleteResults.length, syncs: syncResults.length, succeeded, failed };
}
