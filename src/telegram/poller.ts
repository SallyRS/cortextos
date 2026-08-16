import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { TelegramUpdate, TelegramMessage, TelegramCallbackQuery, TelegramMessageReaction } from '../types/index.js';
import { TelegramAPI } from './api.js';
import { ensureDir } from '../utils/atomic.js';

export type MessageHandler = (msg: TelegramMessage) => void;
export type CallbackHandler = (query: TelegramCallbackQuery) => void;
export type ReactionHandler = (reaction: TelegramMessageReaction) => void;

/**
 * Ceiling (ms) on an honored Telegram 429 `retry after N` hint.
 *
 * The retry_after hint is honored directly and is deliberately NOT subject to the
 * 30s exponential `capMs` — a real Telegram flood-control wait can legitimately
 * exceed 30s, and truncating it to 30s would ignore the server's instruction and
 * risk a tighter flood ban. But the hint must still be bounded: an uncapped
 * honor path lets a hostile or buggy `retry after 3600` sleep the poller ~1h and
 * freeze the agent's Telegram lifeline.
 *
 * 5 minutes is a generous ceiling. Real Telegram flood-control waits run from
 * seconds to at most low minutes, so a legitimate hint is honored unchanged,
 * while an absurd value is clamped so the poller resumes within minutes rather
 * than being frozen for an hour.
 */
export const RETRY_AFTER_CEILING_MS = 300_000;

/**
 * Compute the base backoff delay (in ms) after a transient poll failure.
 *
 * Pure and jitter-free — the caller adds any jitter and owns 409 handling.
 *
 * @param message The error message from the failed getUpdates call.
 * @param attempt Consecutive-transient-error count (>=1).
 * @param baseMs Base delay for the exponential curve (the normal poll interval).
 * @param capMs Maximum backoff delay.
 * @returns Honors a `retry after N` hint from a Telegram 429 (short-circuits the
 *   curve), clamped to {@link RETRY_AFTER_CEILING_MS}; otherwise an
 *   exponential-with-cap delay: min(capMs, baseMs * 2^(attempt-1)).
 */
export function computePollBackoffMs(message: string, attempt: number, baseMs: number, capMs: number): number {
  const retryMatch = message.match(/retry after (\d+)/i);
  if (retryMatch) {
    const honored = Math.max(1, parseInt(retryMatch[1], 10)) * 1000;
    return Math.min(RETRY_AFTER_CEILING_MS, honored);
  }
  return Math.min(capMs, baseMs * 2 ** (attempt - 1));
}

/**
 * Telegram polling loop. Replaces the Telegram portion of fast-checker.sh.
 * Polls getUpdates every 1 second and routes messages/callbacks to handlers.
 */
export class TelegramPoller {
  private api: TelegramAPI;
  private offset: number = 0;
  private running: boolean = false;
  private stateDir: string;
  private offsetFileName: string;
  private messageHandlers: MessageHandler[] = [];
  private callbackHandlers: CallbackHandler[] = [];
  private reactionHandlers: ReactionHandler[] = [];
  private pollInterval: number;
  private consecutiveErrors = 0;
  private readonly backoffCapMs = 30_000;
  /**
   * Why the poll loop last exited. Read by AgentManager's poller-supervisor
   * (#459 supervision-gap fix) to decide whether to restart:
   *   - 'stopped-externally': intentional stop() (stopAgent) — do NOT restart.
   *   - 'conflict-self-die': a Telegram 409 Conflict (another getUpdates
   *     holder owns the lock, e.g. a not-yet-released connection after a
   *     daemon crash) — the loop exits so the supervisor can sleep 30s and
   *     retake the lock instead of hot-looping on Conflict.
   *   - '' : loop still running / never exited.
   */
  lastExitReason: string = '';

  /**
   * @param api Telegram API client scoped to a single bot token.
   * @param stateDir Directory for persisted poller state (offset, dedup).
   * @param pollInterval Milliseconds between getUpdates calls.
   * @param offsetFileSuffix Optional distinct suffix for the offset file.
   *   When omitted (default), offset persists to `.telegram-offset`. When
   *   provided, offset persists to `.telegram-offset-<suffix>`. Use this
   *   when running a second poller in the same stateDir against a
   *   different bot token (e.g. an activity-channel bot alongside the
   *   agent's own bot), so the two pollers do not clobber each other's
   *   offsets. Without this, two pollers sharing a stateDir would both
   *   write to `.telegram-offset` and lose track of which bot each
   *   offset belonged to.
   */
  constructor(api: TelegramAPI, stateDir: string, pollInterval: number = 1000, offsetFileSuffix?: string) {
    this.api = api;
    this.stateDir = stateDir;
    this.pollInterval = pollInterval;
    this.offsetFileName = offsetFileSuffix
      ? `.telegram-offset-${offsetFileSuffix}`
      : '.telegram-offset';
    this.loadOffset();
  }

  /**
   * Register a handler for incoming messages.
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Register a handler for callback queries.
   */
  onCallback(handler: CallbackHandler): void {
    this.callbackHandlers.push(handler);
  }

  /**
   * Register a handler for message_reaction updates. These fire when a
   * user adds or removes an emoji reaction on a chat message the bot can
   * see. Requires the bot's getUpdates call to include `message_reaction`
   * in allowed_updates (handled by TelegramAPI.getUpdates).
   */
  onReaction(handler: ReactionHandler): void {
    this.reactionHandlers.push(handler);
  }

  /**
   * Start the polling loop.
   */
  async start(): Promise<void> {
    this.running = true;
    this.lastExitReason = '';
    this.consecutiveErrors = 0;
    while (this.running) {
      try {
        await this.pollOnce();
        // Success — clear the backoff counter and poll again at the normal interval.
        this.consecutiveErrors = 0;
        await sleep(this.pollInterval);
      } catch (err) {
        if (!this.running) {
          this.lastExitReason = 'stopped-externally';
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        // A 409 Conflict means another getUpdates connection holds the lock
        // (e.g. a not-yet-released connection lingering ~60s after a daemon
        // crash). Exit the loop with a distinct reason so the supervisor can
        // sleep and retake the lock, rather than hot-looping on Conflict.
        if (/Conflict/i.test(msg)) {
          this.lastExitReason = 'conflict-self-die';
          this.running = false;
          return;
        }
        // Other errors are transient — back off exponentially (honoring a 429
        // retry_after hint) so a persistent failure does not hot-loop the API.
        this.consecutiveErrors++;
        const base = computePollBackoffMs(msg, this.consecutiveErrors, this.pollInterval, this.backoffCapMs);
        const delay = base + Math.random() * this.pollInterval;
        console.error(`[telegram-poller] Poll error (retry in ${Math.round(delay)}ms, attempt ${this.consecutiveErrors}):`, err);
        await sleep(delay);
      }
    }
  }

  /**
   * Stop the polling loop. Marks the exit as intentional so the supervisor
   * does not restart it.
   */
  stop(): void {
    this.running = false;
    this.lastExitReason = 'stopped-externally';
  }

  /**
   * Perform a single poll cycle.
   *
   * Offset-after-handler semantics: the offset only advances after every
   * registered handler for an update returns successfully. If any handler
   * throws, the update is left un-acknowledged (Telegram will re-deliver it
   * on the next `getUpdates` call) and the remainder of the batch is deferred
   * to preserve ordering. The offset is persisted after each successful
   * update so a crash mid-batch does not drop confirmed state.
   */
  async pollOnce(): Promise<void> {
    const result = await this.api.getUpdates(this.offset, 1);
    if (!result?.result?.length) return;

    for (const update of result.result as TelegramUpdate[]) {
      const nextOffset = update.update_id + 1;
      let handlerFailed = false;

      if (update.message) {
        for (const handler of this.messageHandlers) {
          try {
            handler(update.message);
          } catch (err) {
            console.error('[telegram-poller] Message handler error:', err);
            handlerFailed = true;
            break;
          }
        }
      }

      if (!handlerFailed && update.callback_query) {
        for (const handler of this.callbackHandlers) {
          try {
            handler(update.callback_query);
          } catch (err) {
            console.error('[telegram-poller] Callback handler error:', err);
            handlerFailed = true;
            break;
          }
        }
      }

      if (!handlerFailed && update.message_reaction) {
        for (const handler of this.reactionHandlers) {
          try {
            handler(update.message_reaction);
          } catch (err) {
            console.error('[telegram-poller] Reaction handler error:', err);
            handlerFailed = true;
            break;
          }
        }
      }

      if (handlerFailed) {
        // Do not advance offset — the update will be redelivered.
        // Stop processing the rest of this batch to preserve ordering.
        return;
      }

      this.offset = nextOffset;
      this.saveOffset();
    }
  }

  /**
   * Load persisted offset from state file.
   */
  private loadOffset(): void {
    const offsetFile = join(this.stateDir, this.offsetFileName);
    try {
      if (existsSync(offsetFile)) {
        const content = readFileSync(offsetFile, 'utf-8').trim();
        const parsed = parseInt(content, 10);
        if (!isNaN(parsed)) {
          this.offset = parsed;
        }
      }
    } catch {
      // Start from 0 if can't read
    }
  }

  /**
   * Save current offset to state file.
   */
  private saveOffset(): void {
    ensureDir(this.stateDir);
    const offsetFile = join(this.stateDir, this.offsetFileName);
    try {
      writeFileSync(offsetFile, String(this.offset), 'utf-8');
    } catch {
      // Ignore write errors
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
