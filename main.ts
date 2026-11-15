// main.ts — boot the forge and keep it alive until the trial env says done.
//
// The env drives the whole trial: it waits for this process to announce the
// port it listens on, runs the suite against it, and then flips /done to
// true. This file only does that handshake; all of the forge lives in app.ts.
//
// Steps:
//   1. Read MAKEFUN_ENV_URL. Without it there is no env to talk to.
//   2. Start the HTTP server on a kernel-chosen port (never 8080).
//   3. POST {"port": n} to <env>/register until the env accepts it.
//   4. Poll <env>/done until it answers {"done": true}.
//   5. Shut the server down and exit 0.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envUrl === '') {
  process.stderr.write('MAKEFUN_ENV_URL is not set\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 2_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

function backoffMs(attempt: number): number {
  const step = Math.min(attempt, 8);
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** step);
}

async function postPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      await sleep(backoffMs(attempt));
      continue;
    }
    if (response.status === 200 || response.status === 409) return;
    if (response.status === 400 || response.status === 405) {
      throw new Error(`register rejected with HTTP ${response.status}`);
    }
    await sleep(backoffMs(attempt));
  }
}

async function pollDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // env not up yet, or the request timed out — keep polling
    }
    await sleep(backoffMs(attempt));
  }
}

async function boot(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('server did not bind a TCP port');
  }
  process.stdout.write(`listening on ${bound.port}\n`);
  await postPort(bound.port);
  process.stdout.write('registered with the env\n');
  await pollDone();
  server.close();
  process.stdout.write('env says done; exiting\n');
}

try {
  await boot();
  process.exit(0);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
