// Tracks the logged-in username for the duration of one request, so db.js's
// mutating functions can attribute activity-log entries without every single
// function needing an extra `actorUsername` parameter threaded through it.
import { AsyncLocalStorage } from 'async_hooks';

export const requestContext = new AsyncLocalStorage();

export function currentUsername() {
  return requestContext.getStore()?.username || null;
}
