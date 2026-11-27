export function localOriginLabel(origin: string) {
  const parts = origin.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts.slice(-2).join(" / ") : origin;
}
