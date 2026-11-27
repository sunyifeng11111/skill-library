import * as React from "react";
import { toastManager } from "@/components/ui/toast";
import type { Preferences, SettingsOutcome } from "@/features/settings/gateway";
import type { DiscoveredSkill } from "@/shared/discovery";
import type {
  CategoryTarget,
  DesktopGateway,
  LibrarySnapshot,
  Skill,
} from "@/shared/library";
import { errorText } from "@/shared/ui";
import {
  readStoredViewMode,
  writeStoredViewMode,
  type SkillViewMode,
} from "@/shared/view-mode";
import {
  type ActiveDialog,
  type AppNotice,
  type AppPage,
  type LocalImportMode,
  type SettingsSection,
  defaultPreferences,
} from "./types";
import {
  useAppUpdates,
  type AppUpdatePhase,
  type AppUpdateProgress,
  type AppUpdatesState,
} from "./useAppUpdates";
import { SnapshotReorderer } from "./snapshotReorder";
import { useAgentInventory } from "./useAgentInventory";
import { packageKey, useSkillUpdates, type UpdateJob, type UpdatesState } from "./useSkillUpdates";

export type { AppUpdatePhase, AppUpdateProgress, AppUpdatesState, UpdateJob, UpdatesState };
export { packageKey };

export interface AppContextValue {
  desktop: DesktopGateway;
  snapshot: LibrarySnapshot | null;
  setSnapshot: (next: LibrarySnapshot) => void;
  reloadSnapshot: () => Promise<void>;
  reorderCategories: (ids: string[]) => Promise<void>;
  reorderAgents: (ids: string[]) => Promise<void>;
  skillViewMode: SkillViewMode;
  setSkillViewMode: (next: SkillViewMode) => void;
  loading: boolean;
  loadError: string | null;
  retryLoad: () => void;

  preferences: Preferences;
  applyPreferences: (next: Preferences) => void;
  replaceLibraryOutcome: (outcome: SettingsOutcome) => void;

  page: AppPage;
  setPage: (next: AppPage) => void;

  unmanagedByAgent: Map<string, number>;
  agentInventoryById: Map<string, DiscoveredSkill[]>;
  scanningAllAgents: boolean;
  scanningAgentIds: Set<string>;
  ensureAgentInventoryLoaded: (agentId: string) => void;
  refreshAgentInventory: (
    agentId: string,
    options?: { clearBeforeScan?: boolean; notifyOnError?: boolean },
  ) => Promise<void>;
  refreshAgentInventories: (options?: {
    force?: boolean;
    snapshotOverride?: LibrarySnapshot;
  }) => Promise<void>;
  syncAgentInventoriesFromScan: (
    rows: DiscoveredSkill[],
    snap?: LibrarySnapshot | null,
  ) => void;

  activeDialog: ActiveDialog;
  setActiveDialog: React.Dispatch<React.SetStateAction<ActiveDialog>>;
  closeDialog: () => void;
  dialogBusy: boolean;
  setDialogBusy: (busy: boolean) => void;

  settingsOpen: boolean;
  settingsSection: SettingsSection;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSettingsMutationBusy: (busy: boolean) => void;

  openCreateCategory: () => void;
  openRenameCategory: (id: string, name: string) => void;
  openDeleteCategory: (id: string, name: string) => void;
  openSkillDetail: (skillId: string) => void;
  openMoveSkills: (skillIds: string[], defaultTarget: CategoryTarget, onMoved?: () => void) => void;
  openUnloadSkills: (skillIds: string[], onUnloaded?: () => void) => void;
  openAddAgent: () => void;
  openRemoveAgent: (agentId: string) => void;
  openLocalImport: (target: CategoryTarget, entry: LocalImportMode) => void;
  openLocalFoldersPicker: (target: CategoryTarget) => Promise<void>;
  openOnlineImport: (target?: CategoryTarget) => void;
  openAttachSource: (skill: Skill) => void;

  updates: UpdatesState;
  appUpdates: AppUpdatesState;
  notify: (notice: AppNotice) => void;
  clearNotices: () => void;
  searchTrigger: number;
  triggerSearchFocus: () => void;
}

const AppContext = React.createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = React.useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}

export function AppProvider({
  desktop,
  onReady,
  children,
}: {
  desktop: DesktopGateway;
  onReady?: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const [snapshot, setSnapshotState] = React.useState<LibrarySnapshot | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [preferences, setPreferences] = React.useState<Preferences>(defaultPreferences);
  const [page, setPageState] = React.useState<AppPage>({ kind: "all" });
  const [activeDialog, setActiveDialog] = React.useState<ActiveDialog>(null);
  const [dialogBusy, setDialogBusyState] = React.useState(false);
  const dialogBusyRef = React.useRef(false);
  const setDialogBusy = React.useCallback((busy: boolean) => {
    dialogBusyRef.current = busy;
    setDialogBusyState(busy);
  }, []);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsSection, setSettingsSection] = React.useState<SettingsSection>("appearance");
  const [settingsMutationBusy, setSettingsMutationBusy] = React.useState(false);
  const [searchTrigger, setSearchTrigger] = React.useState(0);
  const [skillViewMode, setSkillViewModeState] =
    React.useState<SkillViewMode>(readStoredViewMode);

  const setSkillViewMode = React.useCallback((next: SkillViewMode) => {
    setSkillViewModeState(next);
    writeStoredViewMode(next);
  }, []);

  const mountedRef = React.useRef(true);
  const snapshotRef = React.useRef<LibrarySnapshot | null>(null);
  snapshotRef.current = snapshot;
  const [reorderer] = React.useState(() => new SnapshotReorderer());
  const readyCalledRef = React.useRef(false);
  const lastToastIdRef = React.useRef<string | null>(null);
  const pickingFoldersRef = React.useRef(false);
  const startupAppCheckStartedRef = React.useRef(false);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearNotices = React.useCallback(() => {
    if (lastToastIdRef.current) {
      toastManager.close(lastToastIdRef.current);
      lastToastIdRef.current = null;
    }
  }, []);

  const notify = React.useCallback(
    (notice: AppNotice) => {
      clearNotices();
      const timeout = notice.error || notice.action ? 6000 : 3000;
      const id = toastManager.add({
        title: notice.text,
        type: notice.error ? "error" : "success",
        timeout,
        actionProps: notice.action
          ? {
              children: notice.action.label,
              onClick: () => {
                const run = notice.action?.run;
                if (lastToastIdRef.current === id) {
                  toastManager.close(id);
                  lastToastIdRef.current = null;
                }
                void Promise.resolve(run?.()).catch(() => {});
              },
            }
          : undefined,
      });
      lastToastIdRef.current = id;
    },
    [clearNotices],
  );

  const syncDomAppearance = React.useCallback((prefs: Preferences) => {
    const docEl = document.documentElement;
    const prevLang = docEl.lang;
    docEl.lang = prefs.language;
    const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    const resolved = prefs.theme === "system" ? (systemDark ? "dark" : "light") : prefs.theme;
    docEl.dataset.theme = prefs.theme;
    docEl.dataset.colorScheme = resolved;
    docEl.classList.toggle("dark", resolved === "dark");
    if (prevLang !== prefs.language) {
      clearNotices();
    }
  }, [clearNotices]);

  const applyPreferences = React.useCallback(
    (next: Preferences) => {
      if (document.documentElement.dataset.theme !== next.theme) {
        void desktop
          .setWindowTheme?.(next.theme === "system" ? null : next.theme)
          .catch((error) => console.warn("Could not apply native window theme", error));
      }
      syncDomAppearance(next);
      setPreferences(next);
    },
    [desktop, syncDomAppearance],
  );

  // Sync OS color-scheme changes when theme === "system"
  React.useEffect(() => {
    syncDomAppearance(preferences);
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const handler = () => syncDomAppearance(preferences);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [preferences, syncDomAppearance]);

  const {
    agentInventoryById,
    unmanagedByAgent,
    scanningAllAgents,
    scanningAgentIds,
    ensureAgentInventoryLoaded,
    refreshAgentInventory,
    refreshAgentInventories,
    syncAgentInventoriesFromScan,
    pruneToAgents,
  } = useAgentInventory({ desktop, mountedRef, snapshotRef, notify });

  const setSnapshot = React.useCallback((next: LibrarySnapshot) => {
    reorderer.confirm(next);
    snapshotRef.current = next;
    pruneToAgents(next);
    setSnapshotState(next);
    setPageState((current) => {
      if (
        current.kind === "category" &&
        !next.categories.some((category) => category.id === current.id)
      ) {
        return { kind: "uncategorized" };
      }
      if (
        current.kind === "agent" &&
        !next.agents?.some((agent) => agent.id === current.id)
      ) {
        return { kind: "all" };
      }
      return current;
    });
  }, [pruneToAgents, reorderer]);

  const reloadSnapshot = React.useCallback(async () => {
    const next = await desktop.library.snapshot();
    if (mountedRef.current) setSnapshot(next);
  }, [desktop, setSnapshot]);

  const reorderDeps = React.useMemo(
    () => ({
      getSnapshot: () => snapshotRef.current,
      updateSnapshot: setSnapshotState,
      commitSnapshot: setSnapshot,
      isMounted: () => mountedRef.current,
      onError: (error: unknown) => notify({ text: errorText(error), error: true }),
    }),
    [notify, setSnapshot],
  );

  const reorderCategories = React.useCallback(
    (ids: string[]) =>
      reorderer.reorder(
        "categories",
        ids,
        (next) => desktop.library.reorderCategories(next),
        reorderDeps,
      ),
    [desktop, reorderer, reorderDeps],
  );

  const reorderAgents = React.useCallback(
    async (ids: string[]) => {
      const gateway = desktop.agents;
      if (!gateway) return;
      await reorderer.reorder("agents", ids, (next) => gateway.reorder(next), reorderDeps);
    },
    [desktop, reorderer, reorderDeps],
  );

  const updates = useSkillUpdates({ desktop, mountedRef, setSnapshot });
  const {
    check: checkUpdates,
    activity: updatesActivity,
    resetAfterReplacement: resetUpdatesAfterReplacement,
  } = updates;

  const openSettings = React.useCallback((section?: SettingsSection) => {
    if (section) setSettingsSection(section);
    setSettingsOpen(true);
  }, []);

  const closeSettings = React.useCallback(() => {
    setSettingsOpen(false);
  }, []);

  const { appUpdates, applyAppInfo } = useAppUpdates({
    desktop,
    mountedRef,
    notify,
    openSettings,
    preferences,
    updatesActivity,
    settingsMutationBusy,
    dialogBusy,
  });
  const checkAppUpdate = appUpdates.check;

  const loadInitial = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [snap, saved, appInfo] = await Promise.all([
        desktop.library.snapshot(),
        desktop.settings?.preferences(),
        desktop.appUpdates?.info().catch(() => null),
      ]);
      if (!mountedRef.current) return;
      if (saved) applyPreferences(saved);
      if (appInfo) applyAppInfo(appInfo);
      setSnapshot(snap);
      setPageState({ kind: "all" });
      if (snap.storageNotice) notify({ text: snap.storageNotice, error: true });
      void checkUpdates();
      if (
        desktop.appUpdates &&
        (saved?.autoCheckAppUpdates ?? true) &&
        !startupAppCheckStartedRef.current
      ) {
        startupAppCheckStartedRef.current = true;
        void checkAppUpdate({ silent: true });
      }
      void refreshAgentInventories({ force: true, snapshotOverride: snap });
    } catch (error) {
      if (mountedRef.current) setLoadError(errorText(error));
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [
    desktop,
    applyPreferences,
    setSnapshot,
    notify,
    checkUpdates,
    checkAppUpdate,
    refreshAgentInventories,
  ]);

  React.useEffect(() => {
    if (!loading && !readyCalledRef.current) {
      readyCalledRef.current = true;
      onReady?.();
    }
  }, [loading, onReady]);

  React.useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  const replaceLibraryOutcome = React.useCallback(
    (outcome: SettingsOutcome) => {
      clearNotices();
      applyPreferences(outcome.preferences);
      setSnapshot(outcome.library);
      resetUpdatesAfterReplacement();
      void refreshAgentInventories({ force: true, snapshotOverride: outcome.library });
    },
    [
      clearNotices,
      applyPreferences,
      setSnapshot,
      resetUpdatesAfterReplacement,
      refreshAgentInventories,
    ],
  );

  const closeDialog = React.useCallback(() => {
    if (!dialogBusyRef.current) setActiveDialog(null);
  }, []);

  const openLocalFoldersPicker = React.useCallback(
    async (target: CategoryTarget) => {
      if (pickingFoldersRef.current) return;
      pickingFoldersRef.current = true;
      try {
        const paths = await desktop.chooseFolders();
        if (paths.length && mountedRef.current) {
          setActiveDialog({ type: "localImport", target, entry: { mode: "folders", paths } });
        }
      } catch (error) {
        if (mountedRef.current) notify({ text: errorText(error), error: true });
      } finally {
        pickingFoldersRef.current = false;
      }
    },
    [desktop, notify],
  );

  const value = React.useMemo<AppContextValue>(
    () => ({
      desktop,
      snapshot,
      setSnapshot,
      reloadSnapshot,
      reorderCategories,
      reorderAgents,
      skillViewMode,
      setSkillViewMode,
      loading,
      loadError,
      retryLoad: () => void loadInitial(),
      preferences,
      applyPreferences,
      replaceLibraryOutcome,
      page,
      setPage: setPageState,
      unmanagedByAgent,
      agentInventoryById,
      scanningAllAgents,
      scanningAgentIds,
      ensureAgentInventoryLoaded,
      refreshAgentInventory,
      refreshAgentInventories,
      syncAgentInventoriesFromScan,
      activeDialog,
      setActiveDialog,
      closeDialog,
      dialogBusy,
      setDialogBusy,
      settingsOpen,
      settingsSection,
      openSettings,
      closeSettings,
      setSettingsMutationBusy,
      openCreateCategory: () => setActiveDialog({ type: "createCategory" }),
      openRenameCategory: (id, name) => setActiveDialog({ type: "renameCategory", id, name }),
      openDeleteCategory: (id, name) => setActiveDialog({ type: "deleteCategory", id, name }),
      openSkillDetail: (skillId) => setActiveDialog({ type: "skillDetail", skillId }),
      openMoveSkills: (skillIds, defaultTarget, onMoved) =>
        setActiveDialog({ type: "moveSkills", skillIds, defaultTarget, onMoved }),
      openUnloadSkills: (skillIds, onUnloaded) =>
        setActiveDialog({ type: "unloadSkills", skillIds, onUnloaded }),
      openAddAgent: () => setActiveDialog({ type: "addAgent" }),
      openRemoveAgent: (agentId) => setActiveDialog({ type: "removeAgent", agentId }),
      openLocalImport: (target, entry) => setActiveDialog({ type: "localImport", target, entry }),
      openLocalFoldersPicker,
      openOnlineImport: (target) => setActiveDialog({ type: "onlineImport", target }),
      openAttachSource: (skill) => setActiveDialog({ type: "attachSource", skill }),
      updates,
      appUpdates,
      notify,
      clearNotices,
      searchTrigger,
      triggerSearchFocus: () => setSearchTrigger((n) => n + 1),
    }),
    [
      desktop,
      snapshot,
      setSnapshot,
      reloadSnapshot,
      reorderCategories,
      reorderAgents,
      skillViewMode,
      setSkillViewMode,
      loading,
      loadError,
      loadInitial,
      preferences,
      applyPreferences,
      replaceLibraryOutcome,
      page,
      unmanagedByAgent,
      agentInventoryById,
      scanningAllAgents,
      scanningAgentIds,
      ensureAgentInventoryLoaded,
      refreshAgentInventory,
      refreshAgentInventories,
      syncAgentInventoriesFromScan,
      activeDialog,
      closeDialog,
      dialogBusy,
      setDialogBusy,
      settingsOpen,
      settingsSection,
      openSettings,
      closeSettings,
      openLocalFoldersPicker,
      updates,
      appUpdates,
      notify,
      clearNotices,
      searchTrigger,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
