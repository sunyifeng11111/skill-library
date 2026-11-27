import type { LibrarySnapshot } from "../../shared/library";

export type Language = "zh-CN" | "en";
export type Theme = "light" | "dark" | "system";
export type BackupRetention = "30d" | "7d" | "manual";
export type ResetBackupPolicy = "keep" | "restoreOriginals" | "deleteBackups";

export interface Preferences {
  language: Language;
  theme: Theme;
  backupRetention?: BackupRetention;
  autoCheckAppUpdates?: boolean;
}

export interface OriginalBackupSummary {
  id: string;
  createdAt: number;
  summary: string;
  sizeBytes: number;
  itemNames: string[];
  itemCount: number;
}

export interface LibraryCounts {
  skills: number;
  categories: number;
  agents: number;
}

export interface ReplacementPreview {
  token: string;
  current: LibraryCounts;
  incoming: LibraryCounts;
  linksRemoved: string[];
  linksCreated: string[];
  preferences: Preferences;
  originalBackupBatches?: number;
  originalBackupItems?: number;
}

export interface SettingsOutcome {
  library: LibrarySnapshot;
  preferences: Preferences;
}

export interface SettingsGateway {
  preferences(): Promise<Preferences>;
  setPreferences(preferences: Preferences): Promise<Preferences>;
  chooseManagedDirectory(current: string): Promise<string | null>;
  changeManagedDirectory(path: string): Promise<LibrarySnapshot>;
  chooseBackup(): Promise<string | null>;
  chooseExport(): Promise<string | null>;
  exportBackup(path: string): Promise<void>;
  previewBackup(path: string): Promise<ReplacementPreview>;
  restoreBackup(path: string, preview: ReplacementPreview): Promise<SettingsOutcome>;
  previewDefaults(): Promise<ReplacementPreview>;
  restoreDefaults(preview: ReplacementPreview, backupPolicy?: ResetBackupPolicy): Promise<SettingsOutcome>;
  listOriginalBackups?(): Promise<OriginalBackupSummary[]>;
  restoreOriginalBackup?(id: string): Promise<LibrarySnapshot>;
  deleteOriginalBackup?(id: string): Promise<OriginalBackupSummary[]>;
}

