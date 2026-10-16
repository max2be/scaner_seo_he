export class HttpFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = 'HttpFailure'; }
}
export function errorCode(error: unknown): string {
  if (error instanceof HttpFailure) return error.code;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^(ERR_TLS_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(error.code)) return 'tls_error';
  return 'network_error';
}
