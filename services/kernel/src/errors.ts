// Typed API errors (docs/05 section 4): { "error": { "code", "message", "detail" } }. Messages are fixed strings chosen
// by this service, never echoes of request content (INV-15): `detail` carries only structured, bounded values.
export const ERROR_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  TENANT_MISMATCH: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  NOT_TEXT: 422,
  BAD_SIGNATURE: 422,
  TERMS_MISMATCH: 409,
  TOO_EARLY: 409,
  ALREADY_SIGNED: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
  UNAVAILABLE: 503,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;

export type ErrorDetail = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: ErrorDetail;
  /** Extra response headers (e.g. Retry-After). */
  readonly headers: Readonly<Record<string, string>>;

  constructor(code: ErrorCode, message: string, detail: ErrorDetail = {}, headers: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.detail = detail;
    this.headers = headers;
  }
}

export interface ErrorBody {
  readonly error: { readonly code: ErrorCode; readonly message: string; readonly detail: ErrorDetail };
}

export function errorBody(e: ApiError): ErrorBody {
  return { error: { code: e.code, message: e.message, detail: e.detail } };
}

/** The only body an unexpected exception ever produces: no message, no stack, no cause. */
export const INTERNAL_ERROR_BODY: ErrorBody = {
  error: { code: "INTERNAL", message: "internal error; the request was not processed", detail: {} },
};
