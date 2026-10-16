/**
 * Errors the CLI knows how to print without a stack trace. Anything else is a
 * bug and gets the stack, because hiding an unexpected failure is worse than
 * showing one.
 *
 * Fields are declared and assigned explicitly rather than as constructor
 * parameter properties: the test runner executes this source directly under
 * Node's type stripping, which does not support that syntax.
 */
export class SearchdexError extends Error {
  /** Extra lines printed under the message, already human-readable. */
  readonly details: readonly string[];

  constructor(message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'SearchdexError';
    this.details = details;
  }
}

/** A local definition file is malformed or fails schema validation. */
export class DefinitionError extends SearchdexError {
  readonly file: string;

  constructor(file: string, message: string, details: readonly string[] = []) {
    super(`${file}: ${message}`, details);
    this.name = 'DefinitionError';
    this.file = file;
  }
}

/** Atlas answered with a 4xx/5xx. `apiMessage` is the API's own words, unedited. */
export class AtlasApiError extends SearchdexError {
  readonly httpStatus: number;
  readonly errorCode: string | undefined;
  readonly apiMessage: string;
  readonly method: string;
  readonly path: string;

  constructor(
    httpStatus: number,
    errorCode: string | undefined,
    apiMessage: string,
    method: string,
    path: string,
  ) {
    super(`Atlas API ${httpStatus} on ${method} ${path}`, [apiMessage]);
    this.name = 'AtlasApiError';
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;
    this.apiMessage = apiMessage;
    this.method = method;
    this.path = path;
  }
}

/** The index did not become queryable in time. Not the same as a failed apply. */
export class ReadinessTimeoutError extends SearchdexError {
  readonly index: string;
  readonly waitedMs: number;
  readonly lastStatus: string;

  constructor(index: string, waitedMs: number, lastStatus: string) {
    super(`timed out waiting for ${index} after ${Math.round(waitedMs / 1000)}s`, [
      `The index is still ${lastStatus}. The apply itself succeeded — Atlas accepted the`,
      'definition and is still building it. Do not roll back on this alone; re-run',
      '`searchdex apply` (it is idempotent) or check the index in the Atlas UI.',
    ]);
    this.name = 'ReadinessTimeoutError';
    this.index = index;
    this.waitedMs = waitedMs;
    this.lastStatus = lastStatus;
  }
}

/** The index build failed on Atlas' side — usually an invalid definition. */
export class IndexBuildFailedError extends SearchdexError {
  readonly index: string;

  constructor(index: string, details: readonly string[] = []) {
    super(`index ${index} entered FAILED state`, details);
    this.name = 'IndexBuildFailedError';
    this.index = index;
  }
}
