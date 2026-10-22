import { HttpErrorResponse } from '@angular/common/http';
import type { Problem } from '@phub/contracts';

/** Normalizes any HTTP or runtime error to RFC 9457 problem details. */
export function toProblem(error: unknown): Problem {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as Partial<Problem> | null;
    if (body && typeof body === 'object' && typeof body.title === 'string') {
      return { type: body.type ?? 'about:blank', title: body.title, status: body.status ?? error.status, ...(body.detail ? { detail: body.detail } : {}), ...(body.errors ? { errors: body.errors } : {}) };
    }
    if (error.status === 0) {
      return { type: 'about:blank', title: 'Cannot reach the analytics API', status: 0, detail: 'Check your connection and that the API is running.' };
    }
    return { type: 'about:blank', title: error.statusText || 'Request failed', status: error.status };
  }
  return { type: 'about:blank', title: 'Something went wrong', status: 0, detail: error instanceof Error ? error.message : undefined };
}
