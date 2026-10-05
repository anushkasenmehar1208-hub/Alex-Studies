// Browsers can deny storage access even when window.localStorage exists.
export function readBrowserToken(key: string): string {
  try {
    const raw = window.localStorage.getItem(key) ?? "";
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : raw;
    } catch {
      return raw;
    }
  } catch {
    return "";
  }
}
