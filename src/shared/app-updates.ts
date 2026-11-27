import { errorText } from "./ui";

export interface AppUpdateInfo {
  currentVersion: string;
  configured: boolean;
  releasesUrl: string | null;
}

export interface AppUpdateRelease {
  version: string;
  publishedAt: string | null;
  notes: string | null;
  releasesUrl: string | null;
}

export type AppUpdateCheckResult =
  | { status: "unconfigured"; currentVersion: string; releasesUrl: string | null }
  | { status: "upToDate"; currentVersion: string; releasesUrl: string | null }
  | { status: "available"; currentVersion: string; release: AppUpdateRelease };

export type AppUpdateDownloadProgress =
  | { event: "started"; contentLength: number | null }
  | { event: "progress"; downloadedBytes: number; contentLength: number | null }
  | { event: "finished"; downloadedBytes: number; contentLength: number | null };

export interface AppUpdateGateway {
  info(): Promise<AppUpdateInfo>;
  check(): Promise<AppUpdateCheckResult>;
  download(
    version: string,
    onProgress: (event: AppUpdateDownloadProgress) => void,
  ): Promise<void>;
  cancelDownload(): Promise<void>;
  installAndRelaunch(version: string): Promise<void>;
  openReleasePage(url: string): Promise<void>;
}

export const SKIPPED_APP_VERSION_STORAGE_KEY = "skill-library:skipped-app-version";

export function readSkippedAppVersion(): string | null {
  try {
    const raw = window.localStorage.getItem(SKIPPED_APP_VERSION_STORAGE_KEY)?.trim();
    return raw ? raw : null;
  } catch {
    return null;
  }
}

export function writeSkippedAppVersion(version: string | null): void {
  try {
    if (version?.trim()) {
      window.localStorage.setItem(SKIPPED_APP_VERSION_STORAGE_KEY, version.trim());
    } else {
      window.localStorage.removeItem(SKIPPED_APP_VERSION_STORAGE_KEY);
    }
  } catch {
    // Ignore restricted storage environments.
  }
}

export type AppUpdateErrorKind =
  | "readonlyVolume"
  | "network"
  | "signature"
  | "cancelled"
  | "unknown";

export function classifyAppUpdateError(error: unknown): {
  kind: AppUpdateErrorKind;
  message: string;
} {
  const raw = errorText(error).trim();
  const normalized = raw.toLowerCase();

  if (raw.startsWith("DOWNLOAD_CANCELLED") || normalized === "download cancelled") {
    return { kind: "cancelled", message: raw };
  }

  if (raw.startsWith("READONLY_VOLUME:")) {
    return {
      kind: "readonlyVolume",
      message: raw.slice("READONLY_VOLUME:".length).trim() || raw,
    };
  }

  if (
    normalized.includes("read-only file system") ||
    normalized.includes("readonly") ||
    normalized.includes("erofs") ||
    normalized.includes("/volumes/") ||
    normalized.includes("permission denied") ||
    normalized.includes("operation not permitted")
  ) {
    return { kind: "readonlyVolume", message: raw };
  }

  if (
    normalized.includes("signature") ||
    normalized.includes("minisign") ||
    normalized.includes("pubkey")
  ) {
    return { kind: "signature", message: raw };
  }

  if (
    normalized.includes("network") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("dns") ||
    normalized.includes("connection") ||
    normalized.includes("status:") ||
    normalized.includes("fetch")
  ) {
    return { kind: "network", message: raw };
  }

  return { kind: "unknown", message: raw };
}

export function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
