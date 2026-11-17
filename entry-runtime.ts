import { createApp as createForgeServer } from './app.ts';

type LifecycleState =
  | 'booting'
  | 'listening'
  | 'registering'
  | 'waiting'
  | 'stopping';

type RetrySettings = Readonly<{
  requestTimeoutMs: number;
  firstDelayMs: number;
  maximumDelayMs: number;
  maximumExponent: number;
}>;

type RegisteredAddress = Readonly<{
  port: number;
  host: string;
}>;

const retry: RetrySettings = {
  requestTimeoutMs: 30_000,
  firstDelayMs: 250,
  maximumDelayMs: 2_000,
  maximumExponent: 8,
};

const entryLog = (message: string): void => {
  process.stdout.write(`[entry] ${message}\n`);
};

const entryError = (message: string): void => {
  process.stderr.write(`[entry] ${message}\n`);
};

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfter(failures: number): number {
  const exponent = Math.min(failures, retry.maximumExponent);
  const delay = retry.firstDelayMs * 2 ** exponent;
  return Math.min(delay, retry.maximumDelayMs);
}

type RetryOperation = 'register' | 'done';

type RetrySnapshot = Readonly<{
  attempts: number;
  failures: number;
  lastFailure: string | null;
}>;

/**
 * Record retry activity without retaining response bodies or credentials. The resulting summary makes
 * a lifecycle failure diagnosable while preserving the same retry behavior for the harness.
 */
class RetryLedger {
  readonly #records = new Map<RetryOperation, RetrySnapshot>();

  begin(operation: RetryOperation): void {
    const prior = this.#records.get(operation) ?? {
      attempts: 0,
      failures: 0,
      lastFailure: null,
    };
    this.#records.set(operation, {
      ...prior,
      attempts: prior.attempts + 1,
    });
  }

  failed(operation: RetryOperation, reason: unknown): void {
    const prior = this.#records.get(operation) ?? {
      attempts: 0,
      failures: 0,
      lastFailure: null,
    };
    const text = reason instanceof Error ? reason.message : String(reason);
    this.#records.set(operation, {
      ...prior,
      failures: prior.failures + 1,
      lastFailure: text.slice(0, 240),
    });
  }

  successful(operation: RetryOperation): RetrySnapshot {
    return this.#records.get(operation) ?? {
      attempts: 0,
      failures: 0,
      lastFailure: null,
    };
  }

  describe(operation: RetryOperation): string {
    const record = this.successful(operation);
    const failure = record.lastFailure === null ? '' : `; last failure: ${record.lastFailure}`;
    return `${operation}: ${record.attempts} attempt(s), ${record.failures} retried${failure}`;
  }
}

function environmentOrigin(): URL {
  const value = process.env.MAKEFUN_ENV_URL?.trim() ?? '';
  if (value.length === 0) {
    throw new Error('MAKEFUN_ENV_URL is not set: there is no env to register with');
  }

  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('MAKEFUN_ENV_URL is not a valid absolute URL');
  }

  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new Error('MAKEFUN_ENV_URL must use http or https');
  }

  origin.pathname = origin.pathname.replace(/\/+$/, '');
  origin.search = '';
  origin.hash = '';
  return origin;
}

function endpoint(origin: URL, path: string): URL {
  const base = origin.toString().replace(/\/$/, '');
  return new URL(`${base}${path}`);
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(retry.requestTimeoutMs);
}

async function responseExcerpt(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 400);
  } catch {
    return '';
  }
}

function shouldStopRegistering(status: number): boolean {
  return status === 400 || status === 405;
}

function describeRegisterFailure(status: number, body: string): Error {
  const suffix = body.length > 0 ? `: ${body}` : '';
  return new Error(`register answered HTTP ${status}${suffix}`);
}

async function sendRegistration(origin: URL, port: number): Promise<'accepted' | 'already-registered'> {
  const response = await fetch(endpoint(origin, '/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
    signal: timeoutSignal(),
  });

  if (response.status === 200) return 'accepted';
  if (response.status === 409) return 'already-registered';
  if (shouldStopRegistering(response.status)) {
    throw describeRegisterFailure(response.status, await responseExcerpt(response));
  }

  throw new Error(`register retryable HTTP ${response.status}`);
}

async function registerUntilAccepted(origin: URL, port: number, ledger: RetryLedger): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    ledger.begin('register');
    try {
      const result = await sendRegistration(origin, port);
      if (result === 'accepted') {
        entryLog('registered with the env');
      } else {
        entryLog('another process registered first; continuing to wait for completion');
      }
      entryLog(ledger.describe('register'));
      return;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) {
        throw error;
      }
      ledger.failed('register', error);
    }
    await pause(retryAfter(failures));
  }
}

function isDonePayload(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  return (value as { done?: unknown }).done === true;
}

async function askWhetherDone(origin: URL): Promise<boolean> {
  const response = await fetch(endpoint(origin, '/done'), {
    signal: timeoutSignal(),
  });

  if (!response.ok) return false;

  try {
    return isDonePayload(await response.json());
  } catch {
    return false;
  }
}

async function waitUntilDone(origin: URL, ledger: RetryLedger): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    ledger.begin('done');
    try {
      if (await askWhetherDone(origin)) {
        entryLog(ledger.describe('done'));
        return;
      }
    } catch (error) {
      // The environment can be unavailable while it starts or while it executes a test.
      ledger.failed('done', error);
    }
    await pause(retryAfter(failures));
  }
}

function listenOnKernelPort(server: ReturnType<typeof createForgeServer>): Promise<RegisteredAddress> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => {
      server.off('error', fail);
      reject(error);
    };

    server.once('error', fail);
    server.listen(0, () => {
      server.off('error', fail);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve({ port: address.port, host: address.address });
    });
  });
}

function closeServer(server: ReturnType<typeof createForgeServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function transition(from: LifecycleState, to: LifecycleState): LifecycleState {
  const allowed: Record<LifecycleState, LifecycleState[]> = {
    booting: ['listening', 'stopping'],
    listening: ['registering', 'stopping'],
    registering: ['waiting', 'stopping'],
    waiting: ['stopping'],
    stopping: [],
  };

  if (!allowed[from].includes(to)) {
    throw new Error(`invalid lifecycle transition from ${from} to ${to}`);
  }
  return to;
}

type LifecycleEvent = Readonly<{
  state: LifecycleState;
  at: number;
  note: string;
}>;

/**
 * Keep a small in-process account of the entry lifecycle. It is deliberately local: the harness owns
 * persistence, while this journal turns a failure into a phase-specific error that is useful in logs.
 */
class LifecycleJournal {
  readonly #startedAt = performance.now();
  #events: LifecycleEvent[] = [];

  enter(state: LifecycleState, note: string): void {
    this.#events.push({ state, note, at: performance.now() });
  }

  latestState(): LifecycleState {
    const latest = this.#events.at(-1);
    return latest?.state ?? 'booting';
  }

  elapsedMilliseconds(): number {
    return Math.max(0, Math.round(performance.now() - this.#startedAt));
  }

  summary(): string {
    if (this.#events.length === 0) return 'no lifecycle event was recorded';
    return this.#events
      .map((event) => `${event.state}:${event.note}`)
      .join(' -> ');
  }

  contextualize(error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error);
    const phase = this.latestState();
    const elapsed = this.elapsedMilliseconds();
    return new Error(`lifecycle failed during ${phase} after ${elapsed}ms: ${detail}`);
  }
}

function describeListeningAddress(address: RegisteredAddress): string {
  const visibleHost = address.host === '::' ? '[::]' : address.host;
  return `${visibleHost}:${address.port}`;
}

function explainOrigin(origin: URL): string {
  const displayPath = origin.pathname === '/' ? '' : origin.pathname;
  return `${origin.protocol}//${origin.host}${displayPath}`;
}

/**
 * Run the make.fun container lifecycle. The forge stays live until the environment declares that its
 * test work is complete; this avoids exiting during a slow fetch, push, or protocol conformance check.
 */
export async function runForgeEntry(): Promise<void> {
  let state: LifecycleState = 'booting';
  const origin = environmentOrigin();
  const server = createForgeServer();
  const journal = new LifecycleJournal();
  const retries = new RetryLedger();
  let serverStarted = false;

  journal.enter(state, `configured env ${explainOrigin(origin)}`);

  try {
    const address = await listenOnKernelPort(server);
    serverStarted = true;
    state = transition(state, 'listening');
    journal.enter(state, `bound ${describeListeningAddress(address)}`);
    entryLog(`listening on port ${address.port}`);

    state = transition(state, 'registering');
    journal.enter(state, 'posting the selected port to the env');
    await registerUntilAccepted(origin, address.port, retries);

    state = transition(state, 'waiting');
    journal.enter(state, 'polling the env completion marker');
    entryLog('waiting for the env to say done');
    await waitUntilDone(origin, retries);
  } catch (error) {
    throw journal.contextualize(error);
  } finally {
    if (state !== 'stopping') state = transition(state, 'stopping');
    journal.enter(state, 'closing the forge server');
    if (serverStarted) await closeServer(server);
  }

  entryLog('done');
}

export function reportEntryFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  entryError(message);
}
