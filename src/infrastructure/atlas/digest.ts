import { createHash, randomBytes } from 'node:crypto';

/**
 * HTTP Digest auth (RFC 2617), because that is what Atlas API keys use.
 *
 * `curl --digest` in every Atlas doc example is doing exactly this: fire the
 * request, get a 401 with a challenge, hash the credentials against the nonce,
 * fire it again. Implemented here rather than pulled in as a dependency — it is
 * sixty lines and it is the one place the private key is touched.
 */

export interface DigestCredentials {
  readonly publicKey: string;
  readonly privateKey: string;
}

interface Challenge {
  readonly realm: string;
  readonly nonce: string;
  readonly qop: string | undefined;
  readonly opaque: string | undefined;
  readonly algorithm: string;
}

/** Parses a `WWW-Authenticate: Digest ...` header. Returns undefined if it is not one. */
export function parseChallenge(header: string | null): Challenge | undefined {
  if (!header) return undefined;
  const digest = header.split(/,\s*(?=[A-Za-z]+=)/).join(',');
  if (!/^digest\s/i.test(digest)) return undefined;

  const params = new Map<string, string>();
  const pattern = /([a-z]+)=(?:"([^"]*)"|([^,\s]*))/gi;
  for (const match of digest.slice(digest.indexOf(' ')).matchAll(pattern)) {
    params.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? '');
  }

  const realm = params.get('realm');
  const nonce = params.get('nonce');
  if (realm === undefined || nonce === undefined) return undefined;

  return {
    realm,
    nonce,
    qop: params.get('qop'),
    opaque: params.get('opaque'),
    algorithm: params.get('algorithm') ?? 'MD5',
  };
}

/**
 * Builds the `Authorization` header for one request against one challenge.
 *
 * @param uri request path including query string, exactly as sent on the wire —
 *   the hash covers it, so a mismatch here fails authentication rather than
 *   producing a useful error.
 */
export function buildAuthorization(
  challenge: Challenge,
  credentials: DigestCredentials,
  method: string,
  uri: string,
  nonceCount: number,
): string {
  const cnonce = randomBytes(8).toString('hex');
  const nc = nonceCount.toString(16).padStart(8, '0');
  const qop = selectQop(challenge.qop);

  let ha1 = md5(`${credentials.publicKey}:${challenge.realm}:${credentials.privateKey}`);
  if (challenge.algorithm.toLowerCase() === 'md5-sess') {
    ha1 = md5(`${ha1}:${challenge.nonce}:${cnonce}`);
  }
  const ha2 = md5(`${method.toUpperCase()}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${credentials.publicKey}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${challenge.algorithm}`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (challenge.opaque !== undefined) parts.push(`opaque="${challenge.opaque}"`);

  return `Digest ${parts.join(', ')}`;
}

/** A server may offer several; we implement `auth` only, which is what Atlas sends. */
function selectQop(offered: string | undefined): string | undefined {
  if (!offered) return undefined;
  const options = offered.split(',').map((value) => value.trim());
  if (options.includes('auth')) return 'auth';
  throw new Error(`unsupported digest qop from Atlas: "${offered}"`);
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}
