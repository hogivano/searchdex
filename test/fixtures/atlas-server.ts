import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

/**
 * A local HTTP server that speaks the Atlas Admin API the way the real one does:
 * it demands digest auth, requires the versioned Accept header, and answers with
 * the `SearchIndexResponse` shape from the 2024-05-30 media type.
 *
 * The point is to exercise the parts the in-memory fake cannot — auth, headers,
 * status codes, error bodies — without needing a cluster.
 */

export const REALM = 'MMS Public API';
export const NONCE = 'testnonce0000000';
export const MEDIA_TYPE = 'application/vnd.atlas.2024-05-30+json';

export interface TestServer {
  readonly url: string;
  readonly requests: { method: string; path: string; authorized: boolean }[];
  close(): Promise<void>;
}

export interface ServerOptions {
  readonly publicKey: string;
  readonly privateKey: string;
  /** Status codes returned before the request is allowed to succeed. */
  readonly failWith?: number[];
}

export async function startAtlasServer(options: ServerOptions): Promise<TestServer> {
  const requests: TestServer['requests'] = [];
  const failures = [...(options.failWith ?? [])];
  const indexes = new Map<string, Record<string, unknown>>();

  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/';
    const authorization = req.headers['authorization'];
    const authorized = typeof authorization === 'string' && authorization.startsWith('Digest ');
    requests.push({ method: req.method ?? 'GET', path, authorized });

    if (req.headers['accept'] !== MEDIA_TYPE) {
      return send(res, 406, { errorCode: 'UNSUPPORTED_MEDIA_TYPE', detail: 'wrong Accept header' });
    }

    if (!authorized) {
      res.setHeader(
        'www-authenticate',
        `Digest realm="${REALM}", nonce="${NONCE}", algorithm=MD5, qop="auth"`,
      );
      return send(res, 401, { errorCode: 'UNAUTHORIZED', detail: 'digest challenge' });
    }
    if (!verify(authorization, req.method ?? 'GET', path, options)) {
      return send(res, 401, { errorCode: 'UNAUTHORIZED', detail: 'bad digest response' });
    }

    const failure = failures.shift();
    if (failure !== undefined) {
      return send(res, failure, { errorCode: 'RATE_LIMITED', detail: 'slow down' });
    }

    // Path segments arrive percent-encoded; the stored keys come from request
    // bodies and are not. Decode before comparing, or every namespace needing
    // encoding looks like a missing index.
    const parts = path.split('?')[0]!.split('/').filter(Boolean).map(decodeSegment);
    const isCollection = parts[parts.length - 1] === 'indexes';

    if (req.method === 'GET' && isCollection) return send(res, 200, [...indexes.values()]);
    if (req.method === 'GET') {
      const found = indexes.get(parts.slice(-3).join('.'));
      return found ? send(res, 200, found) : send(res, 404, { errorCode: 'RESOURCE_NOT_FOUND', detail: 'no index' });
    }
    if (req.method === 'POST') {
      return readBody(req).then((body) => {
        const record = toResponse(body as Record<string, unknown>);
        indexes.set(`${record['database']}.${record['collectionName']}.${record['name']}`, record);
        send(res, 201, record);
      });
    }
    if (req.method === 'DELETE') {
      indexes.delete(parts.slice(-3).join('.'));
      res.writeHead(204);
      return res.end();
    }
    return send(res, 405, { errorCode: 'METHOD_NOT_ALLOWED', detail: req.method ?? '' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function toResponse(body: Record<string, unknown>): Record<string, unknown> {
  return {
    database: body['database'],
    collectionName: body['collectionName'],
    name: body['name'],
    type: body['type'] ?? 'search',
    indexID: randomBytes(12).toString('hex'),
    status: 'READY',
    queryable: true,
    latestDefinition: body['definition'] ?? {},
    latestDefinitionVersion: { version: 1, createdAt: new Date().toISOString() },
    statusDetail: [
      {
        hostname: 'atlas-test-shard-00-00',
        status: 'READY',
        queryable: true,
        mainIndex: { status: 'READY', queryable: true, definitionVersion: { version: 1 } },
      },
    ],
  };
}

function verify(header: string, method: string, uri: string, options: ServerOptions): boolean {
  const params = Object.fromEntries(
    [...header.slice('Digest '.length).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((match) => [
      match[1],
      match[2] ?? match[3] ?? '',
    ]),
  );
  const md5 = (value: string) => createHash('md5').update(value).digest('hex');
  const ha1 = md5(`${options.publicKey}:${REALM}:${options.privateKey}`);
  const ha2 = md5(`${method}:${uri}`);
  const expected = md5(`${ha1}:${NONCE}:${params['nc']}:${params['cnonce']}:auth:${ha2}`);
  return params['response'] === expected && params['uri'] === uri;
}

/** A segment that is not valid percent-encoding is passed through unchanged. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function send(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': MEDIA_TYPE, 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
