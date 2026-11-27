export type SkillViewMode = "list" | "grid";

export const VIEW_MODE_STORAGE_KEY = "skill-library:view-mode";

export function readStoredViewMode(): SkillViewMode {
  try {
    return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function writeStoredViewMode(mode: SkillViewMode): void {
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore restricted storage environments.
  }
}

export function skillMonogram(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "SK";
  const words = trimmed.split(/[\s_-]+/u).filter(Boolean);
  const raw =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => [...word][0] ?? "")
          .join("")
      : [...trimmed].slice(0, 2).join("");
  return raw.toLocaleUpperCase();
}
