/** Stable operation-layer errors shared by registry handlers and core services. */
export type ErrorCode =
  | 'page_not_found'
  | 'proposal_not_found'
  | 'invalid_params'
  | 'invalid_state'
  | 'conflict'
  | 'ambiguous'
  | 'stale_proposal'
  | 'embedding_failed'
  | 'storage_error'
  | 'bucket_not_found'
  | 'database_error'
  | 'permission_denied'
  | 'unknown_transport'
  | 'rate_limited'
  | 'extraction_failed'
  | 'fact_not_found'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

export class OperationError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public suggestion?: string,
    public docs?: string,
  ) {
    super(message);
    this.name = 'OperationError';
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      suggestion: this.suggestion,
      docs: this.docs,
    };
  }
}
