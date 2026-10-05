type WelcomeStorage = Pick<Storage, "getItem" | "setItem">;

/** A tab-local greeting marker contains no family profile or login data. */
export function createWelcomeGate(storage: () => WelcomeStorage) {
  const seen = new Set<string>();
  return (familyId: string) => {
    if (!familyId || seen.has(familyId)) return false;
    seen.add(familyId);
    try {
      const key = `family-home-welcome:${familyId}`;
      const store = storage();
      if (store.getItem(key)) return false;
      store.setItem(key, "1");
    } catch {
      // Private browsing/storage restrictions must not prevent opening the home.
      // The in-memory set still prevents repeats while navigating this page.
    }
    return true;
  };
}
