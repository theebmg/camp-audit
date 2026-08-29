// Tracks the logged-in username/role for the duration of one request, so
// db.js's mutating functions can attribute activity-log entries (and scope
// per-user views) without every single function needing extra parameters
// threaded through it.
import { AsyncLocalStorage } from 'async_hooks';

export const requestContext = new AsyncLocalStorage();

export function currentUsername() {
  return requestContext.getStore()?.username || null;
}

export function currentRole() {
  return requestContext.getStore()?.role || 'standard';
}
