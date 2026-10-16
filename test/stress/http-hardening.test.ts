import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { after, test } from 'node:test';
import { AtlasApiError } from '../../src/domain/index.ts';
import { AtlasClient } from '../../src/infrastructure/atlas/http.ts';

/**
 * What the client does when Atlas misbehaves: hangs, half-answers, returns an
 * HTML error page from a proxy, rate-limits forever, or answers a digest
 * challenge it never issued.
 */

const CREDENTIALS = { publicKey: 'pk', privateKey: 'sk' };
const MEDIA = 'application/vnd.atlas.2024-05-30+json';

const servers: Server[] = [];
after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

/** Serves a scripted sequence of responses, one per request. */
async function serve(
  handler: (request: { method: string; url: string; auth: boolean }, respond: Respond) => void,
): Promise<string> {
  const server = createServer((req, res) => {
    const auth = typeof req.headers['authorization'] === 'string';
    handler(
      { method: req.method ?? 'GET', url: req.url ?? '/', auth },
      Object.assign(
        (status: number, body: string, headers: Record<string, string> = {}) => {
          res.writeHead(status, { 'content-type': MEDIA, ...headers });
          res.end(body);
        },
        {
          challenge: () => {
            res.writeHead(401, {
              'content-type': MEDIA,
              'www-authenticate': 'Digest realm="MMS Public API", nonce="n", algorithm=MD5, qop="auth"',
            });
            res.end('{}');
          },
          hang: () => {
            // Never responds; the client's own timeout has to fire.
          },
        },
      ),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

interface Respond {
  (status: number, body: string, headers?: Record<string, string>): void;
  challenge(): void;
  hang(): void;
}

function client(baseUrl: string, overrides: Partial<{ timeoutMs: number; maxRetries: number }> = {}) {
  return new AtlasClient({
    baseUrl,
    credentials: CREDENTIALS,
    sleep: async () => {},
    timeoutMs: overrides.timeoutMs ?? 30_000,
    maxRetries: overrides.maxRetries ?? 3,
  });
}

test('a request that never gets a response fails with a timeout, not a hang', async () => {
  const url = await serve((_, respond) => respond.hang());
  await assert.rejects(() => client(url, { timeoutMs: 150, maxRetries: 0 }).get('/x'));
});

test('a hang is retried and then given up on, rather than retried forever', async () => {
  let requests = 0;
  const url = await serve((_, respond) => {
    requests += 1;
    respond.hang();
  });

  await assert.rejects(() => client(url, { timeoutMs: 100, maxRetries: 2 }).get('/x'));
  assert.equal(requests, 3, `made ${requests} attempts for maxRetries=2`);
});

test('persistent 429s give up with the API error, not with a generic failure', async () => {
  const url = await serve((request, respond) => {
    if (!request.auth) return respond.challenge();
    respond(429, JSON.stringify({ errorCode: 'RATE_LIMITED', detail: 'too many requests' }));
  });

  await assert.rejects(() => client(url, { maxRetries: 2 }).get('/x'), (error: unknown) => {
    assert.ok(error instanceof AtlasApiError, `threw ${(error as Error).name}`);
    assert.equal(error.httpStatus, 429);
    assert.match(error.apiMessage, /too many requests/);
    return true;
  });
});

test('a 5xx is retried and a later success is returned', async () => {
  let attempt = 0;
  const url = await serve((request, respond) => {
    if (!request.auth) return respond.challenge();
    attempt += 1;
    if (attempt <= 2) return respond(503, '{"errorCode":"SERVICE_UNAVAILABLE"}');
    respond(200, '[]');
  });

  assert.deepEqual((await client(url).get('/x')).body, []);
});

test('an HTML error page from a proxy is surfaced as text, not swallowed', async () => {
  const url = await serve((request, respond) => {
    if (!request.auth) return respond.challenge();
    respond(502, '<html><body>Bad Gateway</body></html>', { 'content-type': 'text/html' });
  });

  await assert.rejects(() => client(url, { maxRetries: 0 }).get('/x'), (error: unknown) => {
    assert.ok(error instanceof AtlasApiError);
    assert.match(error.apiMessage, /Bad Gateway/);
    return true;
  });
});

test('a 200 with a truncated JSON body fails loudly rather than parsing as empty', async () => {
  const url = await serve((request, respond) => {
    if (!request.auth) return respond.challenge();
    respond(200, '[{"name":"jo');
  });

  await assert.rejects(() => client(url).get('/x'), /JSON/);
});

test('a 204 with no body is not a parse error', async () => {
  const url = await serve((request, respond) => {
    if (!request.auth) return respond.challenge();
    respond(204, '');
  });

  const response = await client(url).delete('/x');
  assert.equal(response.status, 204);
  assert.equal(response.body, undefined);
});

test('a 200 with an empty body is treated as no content, not as invalid JSON', async () => {
  const url = await serve((request, respond) => {
    if (!request.auth) return respond.challenge();
    respond(200, '   ');
  });

  assert.equal((await client(url).get('/x')).body, undefined);
});

test('a 401 with no digest challenge is reported, not retried into a loop', async () => {
  let requests = 0;
  const url = await serve((_, respond) => {
    requests += 1;
    respond(401, '{"errorCode":"UNAUTHORIZED","detail":"invalid API key"}');
  });

  await assert.rejects(() => client(url).get('/x'), (error: unknown) => {
    assert.ok(error instanceof AtlasApiError);
    assert.equal(error.httpStatus, 401);
    assert.match(error.apiMessage, /invalid API key/);
    return true;
  });
  assert.equal(requests, 1, '4xx must not be retried');
});

test('a 401 that repeats after a correct digest answer does not loop forever', async () => {
  let requests = 0;
  const url = await serve((_, respond) => {
    requests += 1;
    respond.challenge();
  });

  await assert.rejects(() => client(url).get('/x'));
  // One unauthenticated probe plus one authenticated retry; the second 401 is
  // final, because answering a challenge we already answered would never end.
  assert.equal(requests, 2);
});

test('the private key never appears in a request or an error message', async () => {
  const seen: string[] = [];
  const url = await serve((request, respond) => {
    if (!request.auth) return respond.challenge();
    respond(400, JSON.stringify({ errorCode: 'BAD', detail: 'nope' }));
  });

  const server = servers[servers.length - 1]!;
  server.on('request', (req) => {
    seen.push(JSON.stringify(req.headers));
  });

  await client(url, { maxRetries: 0 })
    .post('/x', { secret: 'value' })
    .catch((error: Error) => {
      assert.equal(error.message.includes(CREDENTIALS.privateKey), false);
      assert.equal(JSON.stringify(error).includes(CREDENTIALS.privateKey), false);
    });

  assert.equal(
    seen.some((headers) => headers.includes(CREDENTIALS.privateKey)),
    false,
    'the private key was sent in a header',
  );
});

test('a POST body survives the digest retry', async () => {
  const bodies: string[] = [];
  const url = await serve((request, respond) => {
    if (!request.auth) return respond.challenge();
    respond(201, '{"database":"d","collectionName":"c","name":"n"}');
  });

  // Read the body off the authenticated attempt: a digest client that forgets to
  // resend it creates the index with an empty definition.
  servers[servers.length - 1]!.on('request', async (req) => {
    if (req.headers['authorization'] === undefined) return;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    bodies.push(Buffer.concat(chunks).toString('utf8'));
  });

  await client(url).post('/x', { definition: { mappings: { dynamic: true } } });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(
    bodies.some((body) => body.includes('dynamic')),
    'the authenticated retry was sent without the request body',
  );
});
