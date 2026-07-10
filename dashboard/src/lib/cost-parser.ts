// cortextOS Dashboard - Cost parser
// Parses ~/.claude/projects/*.jsonl AND <ctxRoot>/logs/<agent>/codex-tokens.jsonl
// for token usage and calculates cost.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash, randomUUID } from 'crypto';
import { db } from '@/lib/db';
import { CTX_ROOT, getAgentsForOrg, getAllAgents, getOrgs } from '@/lib/config';
import type { CostEntry } from '@/lib/types';

// -- Pricing per million tokens --

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion: number;
  cacheReadPerMillion: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  opus: { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 3.75, cacheReadPerMillion: 1.50 },
  sonnet: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30 },
  haiku: { inputPerMillion: 0.8, outputPerMillion: 4, cacheWritePerMillion: 1.00, cacheReadPerMillion: 0.08 },
  // gpt-5-codex: OpenAI list pricing as of 2026-01. cache write n/a (no separate
  // write cost on cached input). Update when codex pricing changes upstream.
  'gpt-5-codex': { inputPerMillion: 1.25, outputPerMillion: 10, cacheWritePerMillion: 0, cacheReadPerMillion: 0.125 },
};

/**
 * Resolve model name to pricing key. Matches substrings: claude variants map to
 * opus/sonnet/haiku; gpt-5-codex (and bare "codex" / "gpt-5" variants) map to
 * gpt-5-codex pricing rather than silently defaulting to sonnet.
 */
function resolvePricingKey(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('codex') || lower.includes('gpt-5')) return 'gpt-5-codex';
  // Default to sonnet for all other claude models
  return 'sonnet';
}

/**
 * Calculate USD cost for a single entry, including cache token pricing.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number = 0,
  cacheReadTokens: number = 0,
): number {
  const key = resolvePricingKey(model);
  const pricing = MODEL_PRICING[key] ?? MODEL_PRICING.sonnet;
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillion;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion;
  return Math.round((inputCost + outputCost + cacheWriteCost + cacheReadCost) * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

interface RawTokenEntry {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  timestamp?: string;
  costUSD?: number;
}

/**
 * Parse a single JSONL file and return cost entries.
 */
function parseJsonlFile(filePath: string, agent: string, org: string): CostEntry[] {
  const entries: CostEntry[] = [];

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      // Claude Code JSONL nests data in .message, plain JSONL has it at top level
      const raw: RawTokenEntry = parsed.message ?? parsed;
      const model = raw.model;
      if (!model) continue;

      const inputTokens = raw.input_tokens ?? raw.usage?.input_tokens ?? 0;
      const outputTokens = raw.output_tokens ?? raw.usage?.output_tokens ?? 0;
      const cacheWriteTokens = raw.usage?.cache_creation_input_tokens ?? 0;
      const cacheReadTokens = raw.usage?.cache_read_input_tokens ?? 0;
      if (inputTokens === 0 && outputTokens === 0 && cacheWriteTokens === 0 && cacheReadTokens === 0) continue;

      const totalTokens = inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens;
      const costUsd = raw.costUSD ?? calculateCost(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens);
      const timestamp = parsed.timestamp ?? raw.timestamp ?? new Date().toISOString();

      entries.push({
        timestamp,
        agent,
        org,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cost_usd: costUsd,
        source_file: filePath,
      });
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Directory scanning
// ---------------------------------------------------------------------------

/**
 * Scan ~/.claude/projects/ for JSONL files and parse them.
 * Scoped to the current instance's orgs to prevent cross-instance data bleed.
 */
export function scanClaudeProjectsCosts(): CostEntry[] {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeDir)) return [];

  const allowedOrgs = new Set(getOrgs());

  // Also allow the instance ID itself as a fallback org label
  const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
  allowedOrgs.add(instanceId);

  const allEntries: CostEntry[] = [];

  try {
    const projectDirs = fs.readdirSync(claudeDir, { withFileTypes: true });

    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      // Only scan directories that contain 'agents' in the path (skip unrelated projects)
      if (!dir.name.includes('agents')) continue;

      const parts = dir.name.split('-');
      const orgsIdx = parts.indexOf('orgs');
      const orgName = orgsIdx >= 0 && orgsIdx < parts.length - 1
        ? parts[orgsIdx + 1]
        : 'default';

      // Scope to current instance's orgs — prevent cross-instance bleed
      if (!allowedOrgs.has(orgName)) continue;

      const projectPath = path.join(claudeDir, dir.name);
      const files = fs.readdirSync(projectPath).filter((f) => f.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = path.join(projectPath, file);
        // Extract agent name from encoded dir path (e.g. "-Users-...-agents-devbot" -> "devbot")
        const agentsIdx = parts.lastIndexOf('agents');
        const agentName = agentsIdx >= 0 && agentsIdx < parts.length - 1
          ? parts.slice(agentsIdx + 1).join('-')
          : dir.name;
        const entries = parseJsonlFile(filePath, agentName, orgName);
        allEntries.push(...entries);
      }
    }
  } catch {
    // Directory scan failed
  }

  return allEntries;
}

// ---------------------------------------------------------------------------
// Codex JSONL scanning
// ---------------------------------------------------------------------------

interface CodexTokenEntry {
  timestamp?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  session_id?: string;
  turn_id?: string;
}

interface CodexCounters {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface CodexCheckpoint {
  parser_version: number;
  file_identity: string;
  byte_offset: number;
  boundary_fingerprint: string;
  file_mtime_ms: number;
  agent: string;
  org: string;
}

interface ParsedCodexLines {
  entries: CostEntry[];
  sessionState: Map<string, CodexCounters>;
}

export const CODEX_COST_PARSER_VERSION = 1;

function parseCodexLines(
  lines: string[],
  filePath: string,
  agent: string,
  org: string,
  previousBySession: Map<string, CodexCounters> = new Map(),
  loadPrevious?: (sessionId: string) => CodexCounters | undefined,
): ParsedCodexLines {
  const entries: CostEntry[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as CodexTokenEntry;
      const model = raw.model;
      if (!model) continue;

      const cumulative: CodexCounters = {
        inputTokens: raw.input_tokens ?? 0,
        outputTokens: raw.output_tokens ?? 0,
        cacheReadTokens: raw.cache_read_tokens ?? 0,
        cacheWriteTokens: raw.cache_write_tokens ?? 0,
      };
      let { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = cumulative;
      let isCumulativeDelta = false;

      if (raw.session_id) {
        let previous = previousBySession.get(raw.session_id);
        if (!previous && loadPrevious) {
          previous = loadPrevious(raw.session_id);
          if (previous) previousBySession.set(raw.session_id, previous);
        }
        if (previous &&
            cumulative.inputTokens >= previous.inputTokens &&
            cumulative.outputTokens >= previous.outputTokens &&
            cumulative.cacheReadTokens >= previous.cacheReadTokens &&
            cumulative.cacheWriteTokens >= previous.cacheWriteTokens) {
          isCumulativeDelta = true;
          inputTokens -= previous.inputTokens;
          outputTokens -= previous.outputTokens;
          cacheReadTokens -= previous.cacheReadTokens;
          cacheWriteTokens -= previous.cacheWriteTokens;
        }
        previousBySession.set(raw.session_id, cumulative);
      }

      // Keep a zero-delta cumulative snapshot so an upsert can repair a row
      // imported by an older parser at the same identity.
      if (!isCumulativeDelta &&
          inputTokens === 0 && outputTokens === 0 &&
          cacheReadTokens === 0 && cacheWriteTokens === 0) continue;

      const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
      entries.push({
        timestamp: raw.timestamp ?? new Date().toISOString(),
        agent,
        org,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cost_usd: calculateCost(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens),
        source_file: filePath,
      });
    } catch {
      // Skip malformed complete lines without blocking later records.
    }
  }

  return { entries, sessionState: previousBySession };
}

/**
 * Parse a single codex-tokens.jsonl file. Schema differs from claude JSONL:
 * one record per `thread/tokenUsage/updated` notification with the shape
 * written by CodexAppServerPTY.appendCodexTokenLog.
 */
function parseCodexJsonlFile(filePath: string, agent: string, org: string): CostEntry[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  return parseCodexLines(content.split('\n'), filePath, agent, org).entries;
}

/**
 * Scan <ctxRoot>/logs/<agent>/codex-tokens.jsonl for every enabled agent.
 * Codex token logs are written per-agent under the instance's logs dir, not
 * under ~/.claude/projects, so we walk the agent registry instead of a single
 * root directory.
 */
export function scanCodexLogsCosts(): CostEntry[] {
  const allEntries: CostEntry[] = [];

  // Build (agent, org) pairs. Prefer getAllAgents so we pick up CLI-created
  // agents; fall back to per-org enumeration if it returns nothing.
  const pairs: Array<{ name: string; org: string }> = getAllAgents();
  if (pairs.length === 0) {
    for (const org of getOrgs()) {
      for (const name of getAgentsForOrg(org)) pairs.push({ name, org });
    }
  }

  for (const { name, org } of pairs) {
    const filePath = path.join(CTX_ROOT, 'logs', name, 'codex-tokens.jsonl');
    if (!fs.existsSync(filePath)) continue;
    allEntries.push(...parseCodexJsonlFile(filePath, name, org));
  }

  return allEntries;
}

// ---------------------------------------------------------------------------
// SQLite persistence
// ---------------------------------------------------------------------------

const INSERT_COST = db.prepare(`
  INSERT INTO cost_entries (timestamp, agent, org, model, input_tokens, output_tokens, total_tokens, cost_usd, source_file)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT DO UPDATE SET
    org = excluded.org,
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    total_tokens = excluded.total_tokens,
    cost_usd = excluded.cost_usd
  WHERE cost_entries.org IS NOT excluded.org
     OR cost_entries.input_tokens IS NOT excluded.input_tokens
     OR cost_entries.output_tokens IS NOT excluded.output_tokens
     OR cost_entries.total_tokens IS NOT excluded.total_tokens
     OR cost_entries.cost_usd IS NOT excluded.cost_usd
`);

/**
 * Persist cost entries to SQLite. Identical rows are skipped; corrected rows
 * update the existing identity so parser fixes also repair historical data.
 */
export function persistCostEntries(entries: CostEntry[]): number {
  return db.transaction((items: CostEntry[]) => persistCostEntryItems(items))(entries);
}

function persistCostEntryItems(entries: CostEntry[]): number {
  let changed = 0;
  for (const e of entries) {
    const result = INSERT_COST.run(
      e.timestamp,
      e.agent,
      e.org,
      e.model,
      e.input_tokens,
      e.output_tokens,
      e.total_tokens,
      e.cost_usd,
      e.source_file ?? null,
    );
    if (result.changes > 0) changed++;
  }
  return changed;
}

const GET_CODEX_CHECKPOINT = db.prepare(`
  SELECT parser_version, file_identity, byte_offset, boundary_fingerprint, file_mtime_ms, agent, org
  FROM codex_cost_checkpoints
  WHERE file_path = ?
`);

const UPSERT_CODEX_CHECKPOINT = db.prepare(`
  INSERT INTO codex_cost_checkpoints
    (file_path, parser_version, file_identity, byte_offset, boundary_fingerprint, file_mtime_ms, agent, org, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(file_path) DO UPDATE SET
    parser_version = excluded.parser_version,
    file_identity = excluded.file_identity,
    byte_offset = excluded.byte_offset,
    boundary_fingerprint = excluded.boundary_fingerprint,
    file_mtime_ms = excluded.file_mtime_ms,
    agent = excluded.agent,
    org = excluded.org,
    updated_at = excluded.updated_at
`);

const GET_CODEX_SESSION_STATE = db.prepare(`
  SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
  FROM codex_cost_session_state
  WHERE file_path = ? AND session_id = ?
`);

const UPSERT_CODEX_SESSION_STATE = db.prepare(`
  INSERT INTO codex_cost_session_state
    (file_path, session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, revision)
  VALUES (?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(file_path, session_id) DO UPDATE SET
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    cache_read_tokens = excluded.cache_read_tokens,
    cache_write_tokens = excluded.cache_write_tokens,
    revision = codex_cost_session_state.revision + 1
`);

function loadCodexSessionState(filePath: string, sessionId: string): CodexCounters | undefined {
  const row = GET_CODEX_SESSION_STATE.get(filePath, sessionId) as {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  } | undefined;
  if (!row) return undefined;
  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
  };
}

function costIdentity(entry: Pick<CostEntry, 'timestamp' | 'model' | 'agent'>): string {
  return JSON.stringify([entry.timestamp, entry.model, entry.agent]);
}

const CHECKPOINT_BOUNDARY_BYTES = 64;

function fingerprintAtOffset(fd: number, byteOffset: number): string | null {
  if (byteOffset === 0) return '';
  const length = Math.min(byteOffset, CHECKPOINT_BOUNDARY_BYTES);
  const buffer = Buffer.allocUnsafe(length);
  const bytesRead = fs.readSync(fd, buffer, 0, length, byteOffset - length);
  if (bytesRead !== length) return null;
  return createHash('sha256').update(buffer).digest('hex');
}

function persistCodexCheckpointBatch(
  leaseHolder: string,
  filePath: string,
  agent: string,
  org: string,
  fileIdentity: string,
  byteOffset: number,
  boundaryFingerprint: string,
  fileMtimeMs: number,
  sessionState: Map<string, CodexCounters>,
  entries: CostEntry[],
  rebuild: boolean,
): number {
  const writeBatch = db.transaction(() => {
    assertCostSyncLease(leaseHolder);
    const changed = persistCostEntryItems(entries);

    if (rebuild) {
      const desired = new Set(entries.map(costIdentity));
      const existing = db.prepare(`
        SELECT id, timestamp, model, agent
        FROM cost_entries
        WHERE source_file = ?
      `).all(filePath) as Array<{ id: number; timestamp: string; model: string; agent: string }>;
      const deleteRow = db.prepare('DELETE FROM cost_entries WHERE id = ?');
      for (const row of existing) {
        if (!desired.has(costIdentity(row))) deleteRow.run(row.id);
      }
    }

    UPSERT_CODEX_CHECKPOINT.run(
      filePath,
      CODEX_COST_PARSER_VERSION,
      fileIdentity,
      byteOffset,
      boundaryFingerprint,
      fileMtimeMs,
      agent,
      org,
    );

    if (rebuild) {
      db.prepare('DELETE FROM codex_cost_session_state WHERE file_path = ?').run(filePath);
    }
    for (const [sessionId, counters] of sessionState) {
      UPSERT_CODEX_SESSION_STATE.run(
        filePath,
        sessionId,
        counters.inputTokens,
        counters.outputTokens,
        counters.cacheReadTokens,
        counters.cacheWriteTokens,
      );
    }
    return changed;
  });

  return writeBatch.immediate();
}

function syncCodexFileCosts(
  leaseHolder: string,
  filePath: string,
  agent: string,
  org: string,
): { scanned: number; changed: number } {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return { scanned: 0, changed: 0 };
  }

  try {
    const stat = fs.fstatSync(fd);
    const fileIdentity = `${stat.dev}:${stat.ino}`;
    const checkpoint = GET_CODEX_CHECKPOINT.get(filePath) as CodexCheckpoint | undefined;
    const checkpointOffsetValid = Boolean(
      checkpoint && checkpoint.byte_offset >= 0 && checkpoint.byte_offset <= stat.size,
    );
    let rebuild = !checkpoint ||
      checkpoint.parser_version !== CODEX_COST_PARSER_VERSION ||
      checkpoint.file_identity !== fileIdentity ||
      checkpoint.agent !== agent ||
      checkpoint.org !== org ||
      !checkpointOffsetValid;

    // An unchanged, fully consumed file is a zero-I/O steady-state no-op.
    if (!rebuild && checkpoint!.byte_offset === stat.size) {
      if (checkpoint!.file_mtime_ms === stat.mtimeMs) return { scanned: 0, changed: 0 };
      // Same size with a new mtime cannot be an append; rebuild even when the
      // writer preserved the old boundary bytes.
      rebuild = true;
    }

    if (!rebuild) {
      // The managed writer only uses appendFileSync. For bounded steady-state
      // work, validate the immutable checkpoint boundary instead of rereading
      // the historical prefix. An out-of-contract same-inode rewrite that
      // preserves this boundary and then grows beyond the old offset cannot be
      // distinguished from an append on filesystems without a generation id;
      // managed rotations must replace the inode rather than truncate in place.
      const currentBoundary = fingerprintAtOffset(fd, checkpoint!.byte_offset);
      if (currentBoundary === null || checkpoint!.boundary_fingerprint !== currentBoundary) {
        rebuild = true;
      }
    }

    const byteOffset = rebuild ? 0 : checkpoint!.byte_offset;
    const bytesToRead = stat.size - byteOffset;

    if (bytesToRead === 0 && !rebuild) return { scanned: 0, changed: 0 };

    const buffer = Buffer.allocUnsafe(bytesToRead);
    let bytesRead = 0;
    while (bytesRead < bytesToRead) {
      const count = fs.readSync(fd, buffer, bytesRead, bytesToRead - bytesRead, byteOffset + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }

    // An in-place truncation raced the read. Do not advance the checkpoint;
    // the next refresh will reopen the file and rebuild from its stable size.
    if (bytesRead !== bytesToRead || fs.fstatSync(fd).size < stat.size) {
      return { scanned: 0, changed: 0 };
    }

    const completeLineEnd = buffer.lastIndexOf(0x0a);
    if (completeLineEnd < 0 && !rebuild) return { scanned: 0, changed: 0 };

    const completeBytes = completeLineEnd < 0 ? 0 : completeLineEnd + 1;
    const content = buffer.subarray(0, completeBytes).toString('utf-8');
    const parsed = parseCodexLines(
      content.split('\n'),
      filePath,
      agent,
      org,
      new Map(),
      rebuild ? undefined : (sessionId) => loadCodexSessionState(filePath, sessionId),
    );
    const nextByteOffset = byteOffset + completeBytes;
    const nextBoundaryFingerprint = fingerprintAtOffset(fd, nextByteOffset);
    if (nextBoundaryFingerprint === null) return { scanned: 0, changed: 0 };
    const changed = persistCodexCheckpointBatch(
      leaseHolder,
      filePath,
      agent,
      org,
      fileIdentity,
      nextByteOffset,
      nextBoundaryFingerprint,
      stat.mtimeMs,
      parsed.sessionState,
      parsed.entries,
      rebuild,
    );
    return { scanned: parsed.entries.length, changed };
  } finally {
    fs.closeSync(fd);
  }
}

function syncCodexLogsCostsIncremental(leaseHolder: string): { scanned: number; changed: number } {
  const pairs: Array<{ name: string; org: string }> = getAllAgents();
  if (pairs.length === 0) {
    for (const org of getOrgs()) {
      for (const name of getAgentsForOrg(org)) pairs.push({ name, org });
    }
  }

  let scanned = 0;
  let changed = 0;
  const visited = new Set<string>();
  for (const { name, org } of pairs) {
    const filePath = path.join(CTX_ROOT, 'logs', name, 'codex-tokens.jsonl');
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    const result = syncCodexFileCosts(leaseHolder, filePath, name, org);
    scanned += result.scanned;
    changed += result.changed;
  }
  return { scanned, changed };
}

const COST_SYNC_LEASE_NAME = 'cost-sync';
const COST_SYNC_LEASE_MS = 10 * 60 * 1000;

class CostSyncLeaseLostError extends Error {
  constructor() {
    super('Cost sync writer lease was lost or expired before persistence');
    this.name = 'CostSyncLeaseLostError';
  }
}

function assertCostSyncLease(holder: string): void {
  const lease = db.prepare(`
    SELECT 1
    FROM cost_sync_leases
    WHERE name = ? AND holder = ? AND expires_at > ?
  `).get(COST_SYNC_LEASE_NAME, holder, Date.now());
  if (!lease) throw new CostSyncLeaseLostError();
}

function acquireCostSyncLease(holder: string): boolean {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO cost_sync_leases (name, holder, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      holder = excluded.holder,
      expires_at = excluded.expires_at
    WHERE cost_sync_leases.expires_at <= ?
  `).run(COST_SYNC_LEASE_NAME, holder, now + COST_SYNC_LEASE_MS, now);
  return result.changes === 1;
}

function releaseCostSyncLease(holder: string): void {
  db.prepare('DELETE FROM cost_sync_leases WHERE name = ? AND holder = ?')
    .run(COST_SYNC_LEASE_NAME, holder);
}

function persistCostEntriesWithLease(entries: CostEntry[], holder: string): number {
  const write = db.transaction(() => {
    assertCostSyncLease(holder);
    return persistCostEntryItems(entries);
  });
  return write.immediate();
}

/**
 * Scan cost sources and persist changes. Claude sources retain their existing
 * full-scan behavior; Codex sources resume from durable byte checkpoints.
 *
 * Dedup contract: an (agent, model, source_file, timestamp) tuple from claude
 * scan and codex scan should never collide in practice, because codex turns are
 * only ever written to <ctxRoot>/logs/<agent>/codex-tokens.jsonl while claude
 * turns are only ever written under ~/.claude/projects/. We still build the
 * union explicitly so any future overlap (e.g., a codex agent that also gets
 * scanned through claude's projects dir) does not double-count.
 */
export interface CostSyncResult {
  scanned: number;
  changed: number;
  completed: boolean;
}

export function syncCosts(): CostSyncResult {
  const holder = `${process.pid}:${randomUUID()}`;
  if (!acquireCostSyncLease(holder)) return { scanned: 0, changed: 0, completed: false };

  try {
    const claudeEntries = scanClaudeProjectsCosts();
    const seen = new Set<string>();
    const uniqueClaudeEntries: CostEntry[] = [];
    for (const entry of claudeEntries) {
      const key = `${entry.source_file ?? ''}|${entry.timestamp}|${entry.model}|${entry.agent}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueClaudeEntries.push(entry);
    }

    const claudeChanged = uniqueClaudeEntries.length > 0
      ? persistCostEntriesWithLease(uniqueClaudeEntries, holder)
      : 0;
    const codexResult = syncCodexLogsCostsIncremental(holder);
    return {
      scanned: uniqueClaudeEntries.length + codexResult.scanned,
      changed: claudeChanged + codexResult.changed,
      completed: true,
    };
  } finally {
    releaseCostSyncLease(holder);
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Get cost entries from the DB, newest first.
 */
export function getCostEntries(
  limit: number = 100,
  org?: string,
): CostEntry[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    return db
      .prepare(
        `SELECT id, timestamp, agent, org, model, input_tokens, output_tokens, total_tokens, cost_usd, source_file
         FROM cost_entries ${where}
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(...params, limit) as CostEntry[];
  } catch {
    return [];
  }
}

/**
 * Get daily cost totals for the last N days.
 */
export function getDailyCosts(days: number = 30): Array<{ date: string; cost: number }> {
  try {
    const rows = db
      .prepare(
        `SELECT DATE(timestamp) as date, SUM(cost_usd) as cost
         FROM cost_entries
         WHERE timestamp >= DATE('now', ?)
         GROUP BY DATE(timestamp)
         ORDER BY date ASC`,
      )
      .all(`-${days} days`) as Array<{ date: string; cost: number }>;
    return rows;
  } catch {
    return [];
  }
}

/**
 * Get cost totals grouped by model.
 */
export function getCostByModel(): Array<{ model: string; cost: number; tokens: number }> {
  try {
    return db
      .prepare(
        `SELECT model, SUM(cost_usd) as cost, SUM(total_tokens) as tokens
         FROM cost_entries
         GROUP BY model
         ORDER BY cost DESC`,
      )
      .all() as Array<{ model: string; cost: number; tokens: number }>;
  } catch {
    return [];
  }
}

/**
 * Get daily cost breakdown by model for stacked bar chart.
 */
export function getDailyCostByModel(
  days: number = 30,
): Array<Record<string, unknown>> {
  try {
    const rows = db
      .prepare(
        `SELECT DATE(timestamp) as date, model, SUM(cost_usd) as cost
         FROM cost_entries
         WHERE timestamp >= DATE('now', ?)
         GROUP BY DATE(timestamp), model
         ORDER BY date ASC`,
      )
      .all(`-${days} days`) as Array<{ date: string; model: string; cost: number }>;

    // Pivot: group by date, model names as keys
    const dateMap = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      if (!dateMap.has(row.date)) {
        dateMap.set(row.date, { date: row.date });
      }
      const entry = dateMap.get(row.date)!;
      const key = resolvePricingKey(row.model);
      entry[key] = ((entry[key] as number) ?? 0) + row.cost;
    }

    return Array.from(dateMap.values());
  } catch {
    return [];
  }
}

/**
 * Get total cost for the current month, useful for projections.
 */
export function getCurrentMonthCost(): number {
  try {
    const row = db
      .prepare(
        `SELECT SUM(cost_usd) as total
         FROM cost_entries
         WHERE timestamp >= DATE('now', 'start of month')`,
      )
      .get() as { total: number | null } | undefined;
    return row?.total ?? 0;
  } catch {
    return 0;
  }
}
