export function tr(chinese: string, english: string): string {
  return document.documentElement.lang === "en" ? english : chinese;
}
