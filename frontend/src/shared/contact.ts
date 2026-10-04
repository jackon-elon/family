/** Allow ordinary phone numbers only, never dial codes or URI parameters. */
export function phoneLink(phone?: string): string | undefined {
  if (!phone || !/^\+?[\d\s()-]+$/.test(phone.trim())) return;
  const number = phone.trim().replace(/[\s()-]/g, "");
  if (!/^\+?\d{6,15}$/.test(number)) return;
  return `tel:${number}`;
}
