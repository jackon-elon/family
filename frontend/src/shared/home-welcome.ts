/** Shared by entry surfaces for this document only. A full reload gets a fresh gate. */
export function createWelcomeGate() {
  const seen = new Set<string>();
  return (familyId: string) => {
    if (!familyId || seen.has(familyId)) return false;
    seen.add(familyId);
    return true;
  };
}
