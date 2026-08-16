import { appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { EventCategory, EventSeverity, BusPaths, Heartbeat } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomString } from '../utils/random.js';
import { validateEventCategory, validateEventSeverity, isValidJson } from '../utils/validate.js';

/**
 * Log a structured event. Appends JSONL line to daily event file.
 * Identical to bash log-event.sh format.
 *
 * Events are stored at: {analyticsDir}/events/{agent}/{YYYY-MM-DD}.jsonl
 *
 * Optional side-effect: when the caller opts in via `opts.refreshHeartbeat`
 * and this agent has an existing heartbeat.json, refresh its
 * `last_heartbeat` timestamp. "Activity is liveness" holds ONLY for an
 * agent logging its OWN in-session activity, so opt-in is reserved for
 * those call sites. Daemon-on-behalf writes (e.g. delivering an inbound
 * message to another agent) must never opt in — otherwise a wedged
 * agent's heartbeat would be spoofed fresh by traffic it did not act on.
 * The default is off (fail-safe): a caller that says nothing never
 * touches the heartbeat. Other fields (status, mode, etc.) are preserved
 * from the last explicit update-heartbeat call. Best-effort: a failing
 * heartbeat refresh never blocks the event write itself. If no heartbeat
 * file exists yet we do nothing — the first update-heartbeat call creates
 * it with full field values.
 */
export function logEvent(
  paths: BusPaths,
  agentName: string,
  org: string,
  category: EventCategory,
  eventName: string,
  severity: EventSeverity,
  metadata?: Record<string, unknown> | string,
  opts?: { refreshHeartbeat?: boolean },
): void {
  validateEventCategory(category);
  validateEventSeverity(severity);

  // Parse metadata if it's a string
  let meta: Record<string, unknown> = {};
  if (typeof metadata === 'string') {
    if (isValidJson(metadata)) {
      meta = JSON.parse(metadata);
    }
  } else if (metadata) {
    meta = metadata;
  }

  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const eventId = `${epoch}-${agentName}-${rand}`;
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const eventsDir = join(paths.analyticsDir, 'events', agentName);
  ensureDir(eventsDir);

  const eventLine = JSON.stringify({
    id: eventId,
    agent: agentName,
    org,
    timestamp,
    category,
    event: eventName,
    severity,
    metadata: meta,
  });

  appendFileSync(join(eventsDir, `${today}.jsonl`), eventLine + '\n', 'utf-8');

  // Refresh heartbeat timestamp only when the caller opts in (in-session
  // self-logging). Default off is fail-safe. See doc comment above.
  if (opts?.refreshHeartbeat) {
    refreshHeartbeatTimestamp(paths, timestamp);
  }
}

/**
 * Bump the `last_heartbeat` timestamp on the existing heartbeat.json,
 * preserving every other field. No-op when the file does not exist yet
 * or when any step fails — event writes are the authoritative record
 * and must never be blocked by heartbeat housekeeping.
 */
function refreshHeartbeatTimestamp(paths: BusPaths, timestamp: string): void {
  try {
    const hbPath = join(paths.stateDir, 'heartbeat.json');
    if (!existsSync(hbPath)) return;
    const hb = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
    hb.last_heartbeat = timestamp;
    atomicWriteSync(hbPath, JSON.stringify(hb));
  } catch {
    // Best-effort — event already persisted, heartbeat refresh is secondary.
  }
}
