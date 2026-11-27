import type { DiscoveredSkill, DiscoveryGateway } from "./discovery";
import type { UpdateGateway } from "./updates";
import type { AppUpdateGateway } from "./app-updates";
import type { OnlineGateway } from "./online";
import type { SettingsGateway } from "../features/settings/gateway";

export interface PackageSource {
  repository: string;
  memberPath: string;
  revision: string;
  reference?: string;
}

export interface Skill {
  localOrigins?: string[];
  id: string;
  name: string;
  description: string;
  folderName: string;
  fingerprint: string;
  categoryId: string | null;
  source: PackageSource | null;
}

export interface Category {
  id: string;
  name: string;
}

export interface LibrarySnapshot {
  managedDirectory?: string;
  storageNotice?: string;
  skills: Skill[];
  categories: Category[];
  agents?: Agent[];
  assignments?: AgentAssignment[];
  lastInstallAgents?: string[];
  originalBackupCount?: number;
}

// Preset IDs are supplied by the native catalog and persisted with the Agent.
export type AgentKind = string;

export interface AgentDraft {
  kind: AgentKind;
  name: string;
  directory: string;
}

export interface Agent extends AgentDraft {
  id: string;
  syncedCategories: string[];
  syncUncategorized: boolean;
}

export interface AgentAssignment {
  agentId: string;
  skillId: string;
  direct: boolean;
  viaCategory: boolean;
  excluded: boolean;
  path: string | null;
}

export interface SyncOutcome {
  library: LibrarySnapshot;
  impact: { enabled: number; disabled: number; retainedDirect: number };
  undo: string | null;
}

export interface InstallAssignmentsPreview {
  targets: { agentId: string; direct: boolean; viaCategory: boolean }[];
  conflicts: { path: string; message: string }[];
}

export interface UnloadPreview {
  members: { id: string; name: string }[];
  agents: { id: string; name: string; paths: string[] }[];
}

export interface AgentDirectoryPreview {
  directory: string;
  exists: boolean;
}

export interface AgentGateway {
  presets(): Promise<AgentDraft[]>;
  chooseDirectory(): Promise<string | null>;
  previewDirectory(directory: string, agentId?: string): Promise<AgentDirectoryPreview>;
  add(draft: AgentDraft, createDirectory: boolean): Promise<LibrarySnapshot>;
  remove(id: string, shownSkills: string[]): Promise<LibrarySnapshot>;
  changeDirectory(id: string, directory: string, createDirectory: boolean): Promise<LibrarySnapshot>;
  reorder(ids: string[]): Promise<LibrarySnapshot>;
  setSkill(agentId: string, skillId: string, enabled: boolean): Promise<LibrarySnapshot>;
  setCategorySync(agentId: string, categoryId: string | null, enabled: boolean): Promise<SyncOutcome>;
  undoCategorySync(id: string): Promise<SyncOutcome>;
  previewInstall(filenames: string[], target: CategoryTarget, agents: string[]): Promise<InstallAssignmentsPreview>;
  commitImport(selected: ImportSelection[], target: CategoryTarget, agents: string[], local?: boolean): Promise<ImportOutcome>;
  previewUnload(ids: string[]): Promise<UnloadPreview>;
  unload(preview: UnloadPreview): Promise<LibrarySnapshot>;
}

export type CategoryTarget =
  | { kind: "uncategorized" }
  | { kind: "existing"; id: string }
  | { kind: "new"; name: string };

export interface PreviewMember {
  path: string;
  name: string;
  description: string;
  folderName: string;
  fingerprint: string;
  status: "ready" | "duplicate";
}

export interface ImportSelection {
  path: string;
  fingerprint: string;
  source: PackageSource | null;
}

export interface ImportOutcome {
  library: LibrarySnapshot;
  added: string[];
  duplicates: number;
}

export interface MoveOutcome {
  library: LibrarySnapshot;
  moved: number;
  undo: string | null;
}

export interface LibraryGateway {
  snapshot(): Promise<LibrarySnapshot>;
  previewFolders(paths: string[], includeAgents: boolean): Promise<DiscoveredSkill[]>;
  commitImport(selected: ImportSelection[], target: CategoryTarget, local?: boolean, origins?: Record<string, string[]>): Promise<ImportOutcome>;
  managedPath(id: string): Promise<string>;
  createCategory(name: string): Promise<LibrarySnapshot>;
  renameCategory(id: string, name: string): Promise<LibrarySnapshot>;
  deleteCategory(id: string): Promise<LibrarySnapshot>;
  reorderCategories(ids: string[]): Promise<LibrarySnapshot>;
  moveSkills(ids: string[], target: CategoryTarget): Promise<MoveOutcome>;
  undoMove(id: string): Promise<LibrarySnapshot>;
}

export type FolderDrag =
  | { type: "enter" | "leave" }
  | { type: "drop"; paths: string[] };

export interface DesktopGateway {
  library: LibraryGateway;
  discovery: DiscoveryGateway;
  settings?: SettingsGateway;
  setWindowTheme?(theme: "light" | "dark" | null): Promise<void>;
  agents?: AgentGateway;
  online?: OnlineGateway;
  updates?: UpdateGateway;
  appUpdates?: AppUpdateGateway;
  scanUnmanagedIndicators?(): Promise<DiscoveredSkill[]>;
  chooseFolders(): Promise<string[]>;
  onFolderDrag(listener: (event: FolderDrag) => void): Promise<() => void>;
}
