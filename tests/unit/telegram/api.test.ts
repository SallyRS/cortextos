import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock node:https so the unpooled transport can be driven without real sockets.
// The Agent stub must be constructable — the module does `new HttpsAgent(...)`
// at import time.
vi.mock('https', () => ({ Agent: class {}, request: vi.fn() }));

import { request as httpsRequest } from 'https';
import { TelegramAPI, formatValidateError } from '../../../src/telegram/api';

// ---------------------------------------------------------------------------
// Fetch timeout tests (from main — pre-existing)
// ---------------------------------------------------------------------------
describe('TelegramAPI fetch timeout', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws a timeout error when fetch hangs indefinitely', async () => {
    globalThis.fetch = vi.fn(
      (_input: any, init?: any) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as any;

    const api = new TelegramAPI('123:TEST');
    await expect(api.getUpdates(0, 1)).rejects.toThrow(/timed out after 15s/);
  }, 20000);

  it('succeeds on normal fetch response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as any;

    const api = new TelegramAPI('123:TEST');
    const res = await api.getUpdates(0, 1);
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateCredentials tests (from pr-58)
// Minimal fetch mock — each test queues up 1 or 2 responses (one for getMe,
// optionally one for getChat) and asserts the resulting ValidateCredentialsResult.
// ---------------------------------------------------------------------------
type MockResponse = { status: number; body: any } | { throws: Error };

let responseQueue: MockResponse[] = [];
let callLog: Array<{ url: string; body: any }> = [];

function queue(response: MockResponse): void {
  responseQueue.push(response);
}

describe('TelegramAPI.validateCredentials', () => {
  beforeEach(() => {
    responseQueue = [];
    callLog = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      callLog.push({ url, body });
      const next = responseQueue.shift();
      if (!next) {
        throw new Error('fetch called with no queued response');
      }
      if ('throws' in next) {
        throw next.throws;
      }
      return {
        ok: next.status === 200,
        status: next.status,
        json: async () => next.body,
      } as any;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('happy path: valid token + reachable user chat returns ok=true', async () => {
    queue({ status: 200, body: { ok: true, result: { id: 111, username: 'my_test_bot' } } });
    queue({
      status: 200,
      body: { ok: true, result: { id: 222, type: 'private', first_name: 'Alice', is_bot: false } },
    });

    const api = new TelegramAPI('111:AAA');
    const result = await api.validateCredentials('222');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.botId).toBe(111);
      expect(result.botUsername).toBe('my_test_bot');
      expect(result.chatType).toBe('private');
      expect(result.chatTitle).toBe('Alice');
    }
    expect(callLog[0].url).toContain('/getMe');
    expect(callLog[1].url).toContain('/getChat');
    expect(callLog[1].body.chat_id).toBe('222');
  });

  it('bad_token: getMe returns 401 -> reason=bad_token', async () => {
    queue({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } });

    const api = new TelegramAPI('999:BAD');
    const result = await api.validateCredentials('222');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('bad_token');
    }
    // Critical: error message must not leak any part of the token.
    if (!result.ok) {
      const msg = formatValidateError(result);
      expect(msg).not.toContain('999');
      expect(msg).not.toContain('BAD');
      expect(msg).toMatch(/401 Unauthorized/);
    }
    // Must NOT have attempted getChat once getMe failed.
    expect(callLog).toHaveLength(1);
    expect(callLog[0].url).toContain('/getMe');
  });

  it('self_chat: CHAT_ID equals getMe.id -> reason=self_chat (no getChat call)', async () => {
    queue({ status: 200, body: { ok: true, result: { id: 1234567890, username: 'self_chat_test_bot' } } });

    const api = new TelegramAPI('1234567890:AAF3-rr');
    const result = await api.validateCredentials('1234567890');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('self_chat');
      expect(result.detail).toBe('1234567890');
      const msg = formatValidateError(result);
      // The error message must name the trap, point at the fix, and NOT
      // leak any part of the token.
      expect(msg).toContain('1234567890');
      expect(msg).toContain('BOT_TOKEN prefix');
      expect(msg).toContain('/start');
      expect(msg).toContain('getUpdates');
      expect(msg).not.toContain('AAF3');
    }
    // self_chat is caught after getMe alone — getChat must not have been called.
    expect(callLog).toHaveLength(1);
  });

  it('chat_not_found: getChat returns 400 -> reason=chat_not_found', async () => {
    queue({ status: 200, body: { ok: true, result: { id: 111, username: 'my_test_bot' } } });
    queue({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } });

    const api = new TelegramAPI('111:AAA');
    const result = await api.validateCredentials('222');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('chat_not_found');
      expect(result.detail).toBe('222');
      const msg = formatValidateError(result);
      expect(msg).toContain('222');
      expect(msg).toContain('/start');
    }
    expect(callLog).toHaveLength(2);
  });

  it('bot_recipient: getChat returns a bot user -> reason=bot_recipient', async () => {
    queue({ status: 200, body: { ok: true, result: { id: 111, username: 'my_test_bot' } } });
    queue({
      status: 200,
      body: { ok: true, result: { id: 333, type: 'private', username: 'other_bot', is_bot: true } },
    });

    const api = new TelegramAPI('111:AAA');
    const result = await api.validateCredentials('333');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('bot_recipient');
      const msg = formatValidateError(result);
      expect(msg).toContain('333');
      expect(msg).toContain('bot');
    }
    expect(callLog).toHaveLength(2);
  });

  it('bot_recipient: getChat throws 403 "bots cant send messages to bots" -> reason=bot_recipient', async () => {
    queue({ status: 200, body: { ok: true, result: { id: 111, username: 'my_test_bot' } } });
    queue({
      status: 403,
      body: { ok: false, error_code: 403, description: "Forbidden: bots can't send messages to bots" },
    });

    const api = new TelegramAPI('111:AAA');
    const result = await api.validateCredentials('333');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('bot_recipient');
    }
  });

  it('network_error: fetch throws -> reason=network_error (caller treats as WARN)', async () => {
    queue({ throws: new Error('getaddrinfo ENOTFOUND api.telegram.org') });

    const api = new TelegramAPI('111:AAA');
    const result = await api.validateCredentials('222');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('network_error');
      expect(result.detail).toContain('ENOTFOUND');
      const msg = formatValidateError(result);
      expect(msg).toMatch(/Telegram API/i);
    }
  });

  it('rate_limited: getMe 429 -> reason=rate_limited', async () => {
    queue({
      status: 429,
      body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' },
    });

    const api = new TelegramAPI('111:AAA');
    const result = await api.validateCredentials('222');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('rate_limited');
    }
  });

  it('timeout: fetch never resolves -> reason=network_error with "timed out" detail', async () => {
    // Queue nothing — fetch will just hang. Then advance fake timers past 10s
    // and assert the validator bails with network_error.
    vi.useFakeTimers();
    try {
      // Override the stubbed fetch to return a never-resolving promise.
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* never resolves */ })));

      const api = new TelegramAPI('111:AAA');
      const pending = api.validateCredentials('222');

      // Advance fake timers past the 10s withTimeout cap. The internal
      // setTimeout in withTimeout rejects, validateCredentials catches,
      // returns network_error.
      await vi.advanceTimersByTimeAsync(10_500);

      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('network_error');
        expect(result.detail).toMatch(/timed out after 10s/);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('empty chat_id: reason=chat_not_found with no API calls', async () => {
    // Note: this must NOT call fetch at all, so queue nothing.
    const api = new TelegramAPI('111:AAA');
    const result = await api.validateCredentials('');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('chat_not_found');
    }
    expect(callLog).toHaveLength(0);
  });
});

describe('formatValidateError', () => {
  it('bad_token: does not leak token or detail in user-facing text', () => {
    const msg = formatValidateError({
      ok: false,
      reason: 'bad_token',
      detail: 'Telegram API error: Unauthorized TOKEN_SECRET_123',
    });
    expect(msg).not.toContain('TOKEN_SECRET_123');
    expect(msg).toMatch(/invalid or revoked/);
  });

  it('self_chat: message includes concrete fix instructions', () => {
    const msg = formatValidateError({ ok: false, reason: 'self_chat', detail: '1234567890' });
    expect(msg).toContain('1234567890');
    expect(msg).toContain('BOT_TOKEN prefix');
    expect(msg).toContain('/start');
    expect(msg).toContain('getUpdates');
  });

  it('chat_not_found: suggests /start', () => {
    const msg = formatValidateError({ ok: false, reason: 'chat_not_found', detail: '222' });
    expect(msg).toContain('222');
    expect(msg).toContain('/start');
  });

  it('bot_recipient: explains the user-vs-bot distinction', () => {
    const msg = formatValidateError({ ok: false, reason: 'bot_recipient', detail: '333' });
    expect(msg).toMatch(/bot/i);
    expect(msg).toMatch(/user/i);
    expect(msg).toContain('333');
  });

  it('network_error: includes the underlying detail', () => {
    const msg = formatValidateError({
      ok: false,
      reason: 'network_error',
      detail: 'ENOTFOUND api.telegram.org',
    });
    expect(msg).toContain('ENOTFOUND');
  });

  it('rate_limited: mentions retry', () => {
    const msg = formatValidateError({
      ok: false,
      reason: 'rate_limited',
      detail: 'Too Many Requests: retry after 5',
    });
    expect(msg).toMatch(/retry/i);
  });
});

// ---------------------------------------------------------------------------
// Unpooled HTTPS transport (CORTEXTOS_TELEGRAM_UNPOOLED_HTTPS)
// ---------------------------------------------------------------------------
describe('TelegramAPI unpooled HTTPS', () => {
  const mockedRequest = vi.mocked(httpsRequest);
  const originalUnpooledSetting = process.env.CORTEXTOS_TELEGRAM_UNPOOLED_HTTPS;

  // Build a fake req/res pair. The response is driven synchronously when the
  // source calls req.end(), by which point its data/end handlers are registered.
  function driveHttps(opts: { statusCode: number; chunks: Buffer[] }) {
    const res: any = {
      statusCode: opts.statusCode,
      _handlers: {} as Record<string, (arg?: any) => void>,
      on(event: string, h: (arg?: any) => void) { this._handlers[event] = h; return this; },
      once(event: string, h: (arg?: any) => void) { this._handlers[event] = h; return this; },
    };
    const req: any = {
      setTimeout: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      on: vi.fn().mockReturnThis(),
      destroy: vi.fn(),
      end: vi.fn(function () {
        for (const chunk of opts.chunks) res._handlers['data']?.(chunk);
        res._handlers['end']?.();
      }),
    };
    mockedRequest.mockImplementation(((_options: any, cb: any) => {
      cb(res);
      return req;
    }) as any);
    return { req, res };
  }

  beforeEach(() => {
    mockedRequest.mockReset();
  });

  afterEach(() => {
    if (originalUnpooledSetting === undefined) {
      delete process.env.CORTEXTOS_TELEGRAM_UNPOOLED_HTTPS;
    } else {
      process.env.CORTEXTOS_TELEGRAM_UNPOOLED_HTTPS = originalUnpooledSetting;
    }
    vi.restoreAllMocks();
  });

  // POSITIVE CONTROL: must fail if the unpooled branch in post() is missing.
  it('T1: routes getUpdates through node:https with family 4 when flag is 1', async () => {
    process.env.CORTEXTOS_TELEGRAM_UNPOOLED_HTTPS = '1';
    driveHttps({
      statusCode: 200,
      chunks: [Buffer.from(JSON.stringify({ ok: true, result: [] }))],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const api = new TelegramAPI('123:TEST');
    const res = await api.getUpdates(0, 1);

    expect(res.ok).toBe(true);
    expect(mockedRequest).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const options = mockedRequest.mock.calls[0][0] as any;
    expect(options.family).toBe(4);
    expect(options.method).toBe('POST');
    expect(options.hostname).toBe('api.telegram.org');
    expect(options.path).toContain('/getUpdates');
    expect(options.agent).toBeTruthy();
  });

  it('T2: uses fetch (not node:https) when flag is unset or 0', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    delete process.env.CORTEXTOS_TELEGRAM_UNPOOLED_HTTPS;
    await new TelegramAPI('123:TEST').getUpdates(0, 1);

    process.env.CORTEXTOS_TELEGRAM_UNPOOLED_HTTPS = '0';
    await new TelegramAPI('123:TEST').getUpdates(0, 1);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('T3: downloadFile returns the response bytes over a node:https GET', async () => {
    process.env.CORTEXTOS_TELEGRAM_UNPOOLED_HTTPS = '1';
    const payload = [Buffer.from([0x89, 0x50]), Buffer.from([0x4e, 0x47])];
    driveHttps({ statusCode: 200, chunks: payload });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const api = new TelegramAPI('123:TEST');
    const buf = await api.downloadFile('photos/file_1.jpg');

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.equals(Buffer.concat(payload))).toBe(true);
    expect(mockedRequest).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const options = mockedRequest.mock.calls[0][0] as any;
    expect(options.method).toBe('GET');
    expect(options.family).toBe(4);
  });

  it('T4a: post rejects with a Telegram API error when ok is false, over node:https', async () => {
    process.env.CORTEXTOS_TELEGRAM_UNPOOLED_HTTPS = '1';
    driveHttps({
      statusCode: 200,
      chunks: [Buffer.from(JSON.stringify({ ok: false, description: 'Bad Request' }))],
    });
    // Mock fetch so no real network call happens if the unpooled routing is
    // removed, and so the routing assertions below go RED in that case.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ ok: false, description: 'FETCH PATH' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const api = new TelegramAPI('123:TEST');
    await expect(api.getUpdates(0, 1)).rejects.toThrow(/^Telegram API error/);
    expect(mockedRequest).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('T4b: downloadFile rejects with the status on a non-2xx response, over node:https', async () => {
    process.env.CORTEXTOS_TELEGRAM_UNPOOLED_HTTPS = '1';
    driveHttps({ statusCode: 404, chunks: [] });
    // Mock fetch to a DIFFERENT status so no real network call happens and the
    // rejection message (404) is wrong if routing falls through to fetch.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('nope', { status: 500 }),
    );

    const api = new TelegramAPI('123:TEST');
    await expect(api.downloadFile('photos/missing.jpg')).rejects.toThrow(
      'Failed to download file: 404',
    );
    expect(mockedRequest).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('T4c: post wraps a non-timeout transport error to match the pooled shape', async () => {
    process.env.CORTEXTOS_TELEGRAM_UNPOOLED_HTTPS = '1';
    // Fire the req "error" handler with a raw transport error (e.g. ECONNRESET).
    mockedRequest.mockImplementation(((_options: any, _cb: any) => {
      const req: any = {
        setTimeout: vi.fn().mockReturnThis(),
        on: vi.fn().mockReturnThis(),
        destroy: vi.fn(),
        end: vi.fn(),
        once(event: string, h: (arg?: any) => void) {
          if (event === 'error') h(new Error('ECONNRESET'));
          return this;
        },
      };
      return req;
    }) as any);

    const api = new TelegramAPI('123:TEST');
    await expect(api.getUpdates(0, 1)).rejects.toThrow(/^Telegram API request failed:/);
  });
});
