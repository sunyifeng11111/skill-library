import type { CategoryTarget, Skill } from "@/shared/library";
import type { Preferences } from "@/features/settings/gateway";

export type LibraryPageKind =
  | { kind: "all" }
  | { kind: "uncategorized" }
  | { kind: "category"; id: string };

export type AppPage =
  | LibraryPageKind
  | { kind: "help" }
  | { kind: "agent"; id: string }
  | { kind: "updates" }
  | { kind: "scan"; initialFolders?: string[] };

export type SettingsSection = "appearance" | "data" | "about";

export type LocalImportMode =
  | { mode: "sources" }
  | { mode: "scan" }
  | { mode: "folders"; paths: string[] };

export interface AppNotice {
  text: string;
  error?: boolean;
  action?: { label: string; run: () => void | Promise<void> };
}

export const defaultPreferences: Preferences = {
  language: "zh-CN",
  theme: "system",
  backupRetention: "30d",
  autoCheckAppUpdates: true,
};

export function destinationFromLibraryPage(page: LibraryPageKind): CategoryTarget {
  return page.kind === "category"
    ? { kind: "existing", id: page.id }
    : { kind: "uncategorized" };
}

export type ActiveDialog =
  | null
  | { type: "createCategory" }
  | { type: "renameCategory"; id: string; name: string }
  | { type: "deleteCategory"; id: string; name: string }
  | { type: "skillDetail"; skillId: string }
  | { type: "moveSkills"; skillIds: string[]; defaultTarget: CategoryTarget; onMoved?: () => void }
  | { type: "unloadSkills"; skillIds: string[]; onUnloaded?: () => void }
  | { type: "addAgent" }
  | { type: "removeAgent"; agentId: string }
  | { type: "localImport"; target: CategoryTarget; entry: LocalImportMode }
  | { type: "onlineImport"; target?: CategoryTarget }
  | { type: "attachSource"; skill: Skill };
