export function inviteTokenFromPath(pathname: string): string | null {
  const match = /^\/invite\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Reconfirm once, retaining the exact operation that the user requested. */
export async function performSensitiveAction(
  operation: () => Promise<unknown>,
  confirmIdentity: () => Promise<boolean>,
): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "REAUTH_REQUIRED"
    )
      throw error;
  }
  if (!(await confirmIdentity())) return false;
  await operation();
  return true;
}
/** Role denials from several requests share one refresh for the current account. */
export function createPermissionRefresh(
  accountId: () => string | undefined,
  refresh: () => Promise<void>,
): () => Promise<void> {
  let pending: { accountId: string; promise: Promise<void> } | null = null;
  return () => {
    const id = accountId();
    if (!id) return Promise.resolve();
    if (pending?.accountId === id) return pending.promise;
    const attempt = { accountId: id, promise: Promise.resolve() };
    pending = attempt;
    attempt.promise = Promise.resolve()
      .then(() => {
        if (accountId() === id) return refresh();
      })
      // The app's refresh owns the visible error. An event handler must not
      // leak an unhandled rejection or prevent a later retry.
      .catch(() => {})
      .finally(() => {
        if (pending === attempt) pending = null;
      });
    return attempt.promise;
  };
}
