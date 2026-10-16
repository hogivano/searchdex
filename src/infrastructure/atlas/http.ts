import { AtlasApiError } from '../../domain/index.ts';
import type { Json } from '../../domain/index.ts';
import { buildAuthorization, parseChallenge } from './digest.ts';
import type { DigestCredentials } from './digest.ts';

/**
 * The only code that talks to cloud.mongodb.com.
 *
 * Two things are load-bearing here and easy to get wrong elsewhere:
 * the versioned Accept header (Atlas serves a different resource shape without
 * it), and never letting the private key reach a log line or an error message.
 */

/**
 * Atlas versions its API by media type. `2024-05-30` is the version that
 * introduced the `SearchIndexResponse` shape this tool depends on — it carries
 * `queryable`, `statusDetail` and `latestDefinitionVersion`, which the older
 * `2023-01-01` shape does not. Pinned deliberately: a floating version would
 * silently change the fields readiness is computed from.
 */
export const ATLAS_SEARCH_API_VERSION = '2024-05-30';
const MEDIA_TYPE = `application/vnd.atlas.${ATLAS_SEARCH_API_VERSION}+json`;

export const DEFAULT_BASE_URL = 'https://cloud.mongodb.com';

export interface AtlasClientOptions {
  readonly baseUrl?: string;
  readonly credentials: DigestCredentials;
  readonly timeoutMs?: number;
  /** Retries on 429 and 5xx. Atlas rate-limits per project and expects backoff. */
  readonly maxRetries?: number;
  /** Injected in tests so retry backoff does not cost real seconds. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface AtlasResponse {
  readonly status: number;
  readonly body: Json | undefined;
}

export class AtlasClient {
  readonly #baseUrl: string;
  readonly #credentials: DigestCredentials;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #sleep: (ms: number) => Promise<void>;
  #nonceCount = 0;

  constructor(options: AtlasClientOptions) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.#credentials = options.credentials;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get(path: string): Promise<AtlasResponse> {
    return this.#send('GET', path);
  }

  post(path: string, body: Json): Promise<AtlasResponse> {
    return this.#send('POST', path, body);
  }

  patch(path: string, body: Json): Promise<AtlasResponse> {
    return this.#send('PATCH', path, body);
  }

  delete(path: string): Promise<AtlasResponse> {
    return this.#send('DELETE', path);
  }

  async #send(method: string, path: string, body?: Json): Promise<AtlasResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      if (attempt > 0) await this.#sleep(backoffMs(attempt));
      try {
        const response = await this.#sendOnce(method, path, body);
        if (!isRetryable(response.status)) return this.#interpret(method, path, response);
        lastError = await this.#toError(method, path, response);
      } catch (error) {
        if (!isTransientNetworkError(error)) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Fires the request, answering a digest challenge if one comes back. */
  async #sendOnce(method: string, path: string, body?: Json): Promise<Response> {
    const url = `${this.#baseUrl}${path}`;
    const headers: Record<string, string> = { accept: MEDIA_TYPE, 'user-agent': 'searchdex' };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers['content-type'] = MEDIA_TYPE;

    const first = await fetch(url, {
      method,
      headers,
      body: payload ?? null,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (first.status !== 401) return first;

    const challenge = parseChallenge(first.headers.get('www-authenticate'));
    if (!challenge) return first;

    this.#nonceCount += 1;
    return fetch(url, {
      method,
      headers: {
        ...headers,
        authorization: buildAuthorization(challenge, this.#credentials, method, path, this.#nonceCount),
      },
      body: payload ?? null,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
  }

  async #interpret(method: string, path: string, response: Response): Promise<AtlasResponse> {
    if (response.status >= 400) throw await this.#toError(method, path, response);
    if (response.status === 204) return { status: response.status, body: undefined };
    const text = await response.text();
    if (text.trim() === '') return { status: response.status, body: undefined };
    return { status: response.status, body: JSON.parse(text) as Json };
  }

  /**
   * Atlas' error bodies are specific and actionable. Print them verbatim rather
   * than paraphrasing — a paraphrase of "index already exists in namespace" is
   * never more useful than the original.
   */
  async #toError(method: string, path: string, response: Response): Promise<AtlasApiError> {
    const text = await response.text().catch(() => '');
    let errorCode: string | undefined;
    let message = text.trim();
    try {
      const parsed = JSON.parse(text) as { errorCode?: string; detail?: string; reason?: string };
      errorCode = parsed.errorCode;
      message = [parsed.errorCode, parsed.detail ?? parsed.reason].filter(Boolean).join(': ');
    } catch {
      // Not JSON — an HTML error page from a proxy, most likely. Keep the text.
    }
    return new AtlasApiError(response.status, errorCode, message || response.statusText, method, path);
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function isTransientNetworkError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
  return base + Math.floor(Math.random() * 250);
}
