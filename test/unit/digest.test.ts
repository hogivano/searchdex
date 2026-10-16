import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { buildAuthorization, parseChallenge } from '../../src/infrastructure/atlas/digest.ts';

const CREDENTIALS = { publicKey: 'abcdefgh', privateKey: 'e5b2a5c4-0000-0000-0000-000000000000' };
const CHALLENGE_HEADER =
  'Digest realm="MMS Public API", domain="", nonce="Kx4bLQAAAAB2+Ug", algorithm=MD5, qop="auth", stale=false';

test('parses an Atlas digest challenge', () => {
  const challenge = parseChallenge(CHALLENGE_HEADER);
  assert.deepEqual(challenge, {
    realm: 'MMS Public API',
    nonce: 'Kx4bLQAAAAB2+Ug',
    qop: 'auth',
    opaque: undefined,
    algorithm: 'MD5',
  });
});

test('ignores a non-digest challenge', () => {
  assert.equal(parseChallenge('Bearer realm="atlas"'), undefined);
  assert.equal(parseChallenge(null), undefined);
});

test('produces an RFC 2617 qop=auth response', () => {
  const challenge = parseChallenge(CHALLENGE_HEADER)!;
  const uri = '/api/atlas/v2/groups/abc/clusters/acme-prod/search/indexes';
  const header = buildAuthorization(challenge, CREDENTIALS, 'GET', uri, 1);

  const params = Object.fromEntries(
    [...header.slice('Digest '.length).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [
      m[1],
      m[2] ?? m[3],
    ]),
  );

  assert.equal(params['username'], CREDENTIALS.publicKey);
  assert.equal(params['uri'], uri);
  assert.equal(params['qop'], 'auth');
  assert.equal(params['nc'], '00000001');

  const md5 = (value: string) => createHash('md5').update(value).digest('hex');
  const ha1 = md5(`${CREDENTIALS.publicKey}:MMS Public API:${CREDENTIALS.privateKey}`);
  const ha2 = md5(`GET:${uri}`);
  const expected = md5(
    `${ha1}:Kx4bLQAAAAB2+Ug:00000001:${params['cnonce']}:auth:${ha2}`,
  );
  assert.equal(params['response'], expected);
});

test('never puts the private key in the header', () => {
  const challenge = parseChallenge(CHALLENGE_HEADER)!;
  const header = buildAuthorization(challenge, CREDENTIALS, 'GET', '/api/atlas/v2/groups/abc', 1);
  assert.equal(header.includes(CREDENTIALS.privateKey), false);
});

test('rejects a qop it cannot honour rather than sending a wrong hash', () => {
  const challenge = parseChallenge(CHALLENGE_HEADER.replace('qop="auth"', 'qop="auth-int"'))!;
  assert.throws(
    () => buildAuthorization(challenge, CREDENTIALS, 'GET', '/x', 1),
    /unsupported digest qop/,
  );
});
