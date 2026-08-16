import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelegramPoller, computePollBackoffMs, RETRY_AFTER_CEILING_MS } from '../../../src/telegram/poller';
import type { TelegramAPI } from '../../../src/telegram/api';
import type { TelegramUpdate } from '../../../src/types/index';

function makeMessageUpdate(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 1, type: 'private' },
      text,
    },
  };
}

function makeCallbackUpdate(updateId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: 1, is_bot: false, first_name: 'test' },
      data,
    } as any,
  };
}

function makeStubApi(updates: TelegramUpdate[]): { api: TelegramAPI; calls: number[] } {
  const calls: number[] = [];
  const api = {
    getUpdates: vi.fn(async (offset: number) => {
      calls.push(offset);
      const remaining = updates.filter((u) => u.update_id >= offset);
      return { result: remaining };
    }),
  } as unknown as TelegramAPI;
  return { api, calls };
}

describe('TelegramPoller — offset-after-handler', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('advances offset only after message handler succeeds', async () => {
    const { api } = makeStubApi([makeMessageUpdate(100, 'hello')]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onMessage((msg) => {
      received.push(msg.text ?? '');
    });

    await poller.pollOnce();

    expect(received).toEqual(['hello']);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('101');
  });

  it('does NOT advance offset if a message handler throws', async () => {
    const { api } = makeStubApi([makeMessageUpdate(200, 'boom')]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onMessage(() => {
      throw new Error('inject failed');
    });

    // Handler errors are caught internally — pollOnce should not throw.
    await expect(poller.pollOnce()).resolves.toBeUndefined();

    // Offset file must not exist (or must still be 0) — update should redeliver.
    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });

  it('halts the batch on failure to preserve ordering', async () => {
    const { api } = makeStubApi([
      makeMessageUpdate(10, 'first'),
      makeMessageUpdate(11, 'second-will-fail'),
      makeMessageUpdate(12, 'third'),
    ]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onMessage((msg) => {
      received.push(msg.text ?? '');
      if (msg.text === 'second-will-fail') {
        throw new Error('inject failed');
      }
    });

    await poller.pollOnce();

    // First succeeded, second threw, third MUST NOT have run.
    expect(received).toEqual(['first', 'second-will-fail']);

    // Offset should be advanced past the first (11) but not past the second.
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('11');
  });

  it('persists offset per-update so a mid-batch crash preserves confirmed state', async () => {
    const { api } = makeStubApi([
      makeMessageUpdate(50, 'a'),
      makeMessageUpdate(51, 'b'),
      makeMessageUpdate(52, 'c'),
    ]);
    const poller = new TelegramPoller(api, stateDir);

    const offsetsSeenDuringHandling: string[] = [];
    poller.onMessage(() => {
      // Read the persisted file mid-batch to prove per-update persistence.
      const f = join(stateDir, '.telegram-offset');
      offsetsSeenDuringHandling.push(existsSync(f) ? readFileSync(f, 'utf-8').trim() : 'none');
    });

    await poller.pollOnce();

    // Before processing 50, nothing persisted. Before 51, 51 persisted. Before 52, 52 persisted.
    expect(offsetsSeenDuringHandling).toEqual(['none', '51', '52']);

    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('53');
  });

  it('advances offset only after callback handler succeeds', async () => {
    const { api } = makeStubApi([makeCallbackUpdate(300, 'approve')]);
    const poller = new TelegramPoller(api, stateDir);

    const received: string[] = [];
    poller.onCallback((cb) => {
      received.push(cb.data ?? '');
    });

    await poller.pollOnce();

    expect(received).toEqual(['approve']);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('301');
  });

  it('does NOT advance offset if a callback handler throws', async () => {
    const { api } = makeStubApi([makeCallbackUpdate(400, 'deny')]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onCallback(() => {
      throw new Error('callback broke');
    });

    await poller.pollOnce();

    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });

  it('routes message_reaction updates to registered reaction handlers and advances offset', async () => {
    const reactionUpdate: TelegramUpdate = {
      update_id: 500,
      message_reaction: {
        chat: { id: 42, type: 'private' },
        user: { id: 7, first_name: 'alice' },
        message_id: 123,
        date: 1700000000,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    };
    const { api } = makeStubApi([reactionUpdate]);
    const poller = new TelegramPoller(api, stateDir);

    const received: Array<{ msgId: number; emoji: string }> = [];
    poller.onReaction((r) => {
      const emoji = r.new_reaction[0]?.type === 'emoji' ? r.new_reaction[0].emoji : '?';
      received.push({ msgId: r.message_id, emoji });
    });

    await poller.pollOnce();

    expect(received).toEqual([{ msgId: 123, emoji: '👍' }]);
    const persisted = readFileSync(join(stateDir, '.telegram-offset'), 'utf-8').trim();
    expect(persisted).toBe('501');
  });

  it('does NOT advance offset if a reaction handler throws', async () => {
    const reactionUpdate: TelegramUpdate = {
      update_id: 600,
      message_reaction: {
        chat: { id: 42, type: 'private' },
        user: { id: 7, first_name: 'alice' },
        message_id: 999,
        date: 1700000000,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '🔥' }],
      },
    };
    const { api } = makeStubApi([reactionUpdate]);
    const poller = new TelegramPoller(api, stateDir);

    poller.onReaction(() => { throw new Error('reaction broke'); });

    await poller.pollOnce();

    const offsetFile = join(stateDir, '.telegram-offset');
    if (existsSync(offsetFile)) {
      const persisted = readFileSync(offsetFile, 'utf-8').trim();
      expect(persisted).toBe('0');
    }
  });

  it('does not convert an intentional stop during an in-flight Conflict into a restartable conflict exit', async () => {
    let rejectPoll: ((err: Error) => void) | undefined;
    const api = {
      getUpdates: vi.fn(() => new Promise((_resolve, reject) => {
        rejectPoll = reject;
      })),
    } as unknown as TelegramAPI;
    const poller = new TelegramPoller(api, stateDir);

    const running = poller.start();
    await vi.waitFor(() => expect(api.getUpdates).toHaveBeenCalled());

    poller.stop();
    rejectPoll?.(new Error('Telegram API error: Conflict: terminated by other getUpdates request'));

    await expect(running).resolves.toBeUndefined();
    expect(poller.lastExitReason).toBe('stopped-externally');
  });
});

describe('TelegramPoller — start() re-entry (LINK A for the map-entry-race poller resurrection)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-reentry-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  // WHY THIS EXISTS. The agent-manager poller-supervisor fix rests on a two-step
  // claim, and only the second step is about Telegram:
  //   LINK A  start() called again on a torn-down poller -> a live poll loop again
  //   LINK B  two live loops on one bot token            -> 409 Conflict churn
  // Link B is Telegram's semantics and stays INFERRED. Link A is OUR code and is
  // therefore checkable, so it is checked here rather than asserted in prose —
  // otherwise a two-step chain reads as a one-step one and the severity of the
  // whole finding rests on a step nobody measured.
  //
  // This is a CHARACTERISATION assertion, not a regression control for that fix:
  // it pins current behaviour of a file the fix does not touch, so it was never
  // red and cannot be. It fails if someone later adds a re-entry guard here —
  // at which point the severity rating of the resurrection class must be
  // revisited, which is exactly the moment someone needs to be told.
  it('restarting a stopped poller re-arms it: start() has NO re-entry guard', async () => {
    const { api } = makeStubApi([]);
    const poller = new TelegramPoller(api, stateDir, 1);
    const calls = () => (api.getUpdates as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    const first = poller.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls()).toBeGreaterThan(0);            // it really polled

    poller.stop();
    await first;                                   // the loop has exited, not merely been asked to
    const afterStop = calls();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls()).toBe(afterStop);               // positive control: stop() really stops it

    // The resurrection. No guard rejects this, no in-flight flag absorbs it:
    // poller.ts:89 sets `this.running = true` unconditionally as its FIRST
    // statement. Contrast AgentProcess.start(), which opens with
    // `if (this.status === 'running') return;` — the absence here is specific to
    // this class, not a codebase-wide convention.
    const second = poller.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls()).toBeGreaterThan(afterStop);    // LINK A: it is polling again

    poller.stop();
    await second;
  });

  it('start() also erases the stopped-externally signal its supervisor reads', async () => {
    const { api } = makeStubApi([]);
    const poller = new TelegramPoller(api, stateDir, 1);

    const first = poller.start();
    await new Promise((r) => setTimeout(r, 20));
    poller.stop();
    await first;
    expect(poller.lastExitReason).toBe('stopped-externally');

    // poller.ts:90 blanks it. This is why the supervisor's `lastExitReason`
    // check cannot defend the case where the stop lands while the supervisor is
    // parked in its 30s retry sleep: by the time it looks, the evidence is gone.
    const second = poller.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(poller.lastExitReason).toBe('');

    poller.stop();
    await second;
  });
});

describe('TelegramPoller — poll backoff', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cortextos-poller-backoff-'));
    // Silence the diagnostic error logging the backoff path emits.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Group A — pure function, no timers.
  it('grows exponentially then caps at capMs', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      computePollBackoffMs('Telegram API request timed out after 15s: getUpdates', n, 1000, 30000),
    );
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('honors a 429 retry_after hint regardless of attempt', () => {
    const msg = 'Telegram API error: Too Many Requests: retry after 7';
    expect(computePollBackoffMs(msg, 1, 1000, 30000)).toBe(7000);
    expect(computePollBackoffMs(msg, 5, 1000, 30000)).toBe(7000);
  });

  it('floors a retry_after of 0 to 1000ms', () => {
    expect(computePollBackoffMs('retry after 0', 3, 1000, 30000)).toBe(1000);
  });

  it('falls back to the exponential curve when there is no retry_after', () => {
    expect(computePollBackoffMs('Telegram API request failed: boom', 3, 1000, 30000)).toBe(4000);
  });

  it('clamps a retry_after above the ceiling and honors one below it unchanged', () => {
    const ceilingSecs = RETRY_AFTER_CEILING_MS / 1000;
    // Above the ceiling (e.g. a hostile "retry after 3600") is clamped down to it.
    const aboveSecs = ceilingSecs + 300;
    expect(computePollBackoffMs(`retry after ${aboveSecs}`, 1, 1000, 30000)).toBe(RETRY_AFTER_CEILING_MS);
    // Below the ceiling (a realistic flood-control wait that still exceeds the 30s
    // exponential cap) is honored as-is — proving the honor path does not reuse capMs.
    const belowSecs = ceilingSecs - 60;
    expect(computePollBackoffMs(`retry after ${belowSecs}`, 1, 1000, 30000)).toBe(belowSecs * 1000);
  });

  // Group B — loop integration under fake timers.
  function backoffApi(impl: () => Promise<unknown>): TelegramAPI {
    return { getUpdates: vi.fn(impl) } as unknown as TelegramAPI;
  }

  it('backs off exponentially and caps during a sustained error storm', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const delays = () => setTimeoutSpy.mock.calls.map((c) => Number(c[1]));

    const api = backoffApi(async () => {
      throw new Error('Telegram API request timed out after 15s: getUpdates');
    });
    const poller = new TelegramPoller(api, stateDir);
    const running = poller.start();

    // Flush the first pollOnce rejection microtask so the first backoff sleep is scheduled.
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 1; i < 7; i++) {
      const d = delays();
      await vi.advanceTimersByTimeAsync(d[d.length - 1]);
    }

    expect(delays()).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);

    poller.stop();
    const d = delays();
    await vi.advanceTimersByTimeAsync(d[d.length - 1]);
    await running;
  });

  it('honors a 429 retry_after for the first backoff in the loop', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const delays = () => setTimeoutSpy.mock.calls.map((c) => Number(c[1]));

    const api = backoffApi(async () => {
      throw new Error('Telegram API error: Too Many Requests: retry after 5');
    });
    const poller = new TelegramPoller(api, stateDir);
    const running = poller.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(delays()[0]).toBe(5000);

    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await running;
  });

  it('resets the backoff counter after a successful poll', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const delays = () => setTimeoutSpy.mock.calls.map((c) => Number(c[1]));

    let call = 0;
    const api = backoffApi(async () => {
      call++;
      if (call === 3) return { result: [] }; // third poll succeeds
      throw new Error('Telegram API request timed out after 15s: getUpdates');
    });
    const poller = new TelegramPoller(api, stateDir);
    const running = poller.start();

    await vi.advanceTimersByTimeAsync(0); // call1 fail -> 1000
    await vi.advanceTimersByTimeAsync(1000); // call2 fail -> 2000
    await vi.advanceTimersByTimeAsync(2000); // call3 success -> reset -> sleep 1000
    await vi.advanceTimersByTimeAsync(1000); // call4 fail -> attempt 1 again -> 1000

    // fail(1000), fail(2000), success(1000 interval), fail(1000 — NOT 4000)
    expect(delays()).toEqual([1000, 2000, 1000, 1000]);

    poller.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await running;
  });

  it('still self-dies on a 409 Conflict without scheduling a backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const api = backoffApi(async () => {
      throw new Error('Telegram API error: Conflict: terminated by other getUpdates request');
    });
    const poller = new TelegramPoller(api, stateDir);
    const running = poller.start();

    await vi.advanceTimersByTimeAsync(0);
    await running;

    expect(poller.lastExitReason).toBe('conflict-self-die');
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
