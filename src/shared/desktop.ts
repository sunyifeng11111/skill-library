import { getCurrentWindow } from "@tauri-apps/api/window";
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { AppUpdateDownloadProgress } from "./app-updates";
import type { DiscoveryGateway } from "./discovery";
import { tr } from "./language";
import type { DesktopGateway } from "./library";
import type { SourceProgress } from "./online";

const discovery: DiscoveryGateway = {
  scan: (collections, agentId, includeAgents, registeredOnly = false) =>
    invoke("scan_existing_skills", {
      collections,
      agentId,
      includeAgents,
      ...(registeredOnly ? { registeredOnly: true } : {}),
    }),
  commitBatch: (request) => invoke("commit_local_batch", { request }),
  undoBatch: (id) => invoke("undo_adoption_batch", { id }),
  compareManifests: (left, right) => invoke("compare_skill_manifests", { left, right }),
  trashBrokenLink: (path) => invoke("trash_broken_link", { path }),
  openInSystem: (path) => invoke("open_in_system", { path }),
};

export const desktop: DesktopGateway = {
  discovery,
  setWindowTheme: theme => getCurrentWindow().setTheme(theme),
  settings: {
    preferences: () => invoke("settings_preferences"),
    setPreferences: (preferences) => invoke("set_settings_preferences", { preferences }),
    chooseManagedDirectory: current => open({
      directory: true, multiple: false, defaultPath: current,
      title: tr("选择用于托管 Skill 的空文件夹", "Choose an empty folder for managed skills"),
    }),
    changeManagedDirectory: path => invoke("change_managed_directory", { path }),
    chooseBackup: () => open({
      multiple: false, title: tr("选择 Skill 库备份", "Choose a library backup"),
      filters: [{ name: "JSON", extensions: ["json"] }],
    }),
    chooseExport: () => save({
      title: tr("导出 Skill 库备份", "Export library backup"),
      defaultPath: "skill-library-backup.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    }),
    exportBackup: (path) => invoke("export_library_backup", { path }),
    previewBackup: (path) => invoke("preview_library_backup", { path }),
    restoreBackup: (path, preview) => invoke("restore_library_backup", { path, preview }),
    previewDefaults: () => invoke("preview_library_defaults"),
    restoreDefaults: (preview, backupPolicy) => invoke("restore_library_defaults", { preview, backupPolicy }),
    listOriginalBackups: () => invoke("list_original_backups"),
    restoreOriginalBackup: (id) => invoke("restore_original_backup", { id }),
    deleteOriginalBackup: (id) => invoke("delete_original_backup", { id }),
  },
  online: {
    reserve: () => invoke("reserve_package_preview"),
    read(id, input, onProgress) {
      const progress = new Channel<SourceProgress>(onProgress);
      return invoke("read_package_preview", { id, input, progress });
    },
    discard: (id) => invoke("discard_package_preview", { id }),
  },
  updates: {
    check: () => invoke("check_package_updates"),
    checkOne: (pkg) => invoke("check_package_update", { package: pkg }),
    preview: (pkg, revision) => invoke("preview_package_update", { package: pkg, revision }),
    apply: (pkg, selection) => invoke("apply_package_update", { package: pkg, selection }),
    attach: (id, previewId, memberPath) => invoke("attach_package_source", { id, previewId, memberPath }),
    openSourceUrl: (url) => invoke("open_source_url", { url }),
  },
  appUpdates: {
    info: () => invoke("app_update_info"),
    check: () => invoke("check_app_update"),
    download(version, onProgress) {
      const progress = new Channel<AppUpdateDownloadProgress>(onProgress);
      return invoke("download_app_update", { version, progress });
    },
    cancelDownload: () => invoke("cancel_app_update_download"),
    installAndRelaunch: (version) => invoke("install_app_update_and_relaunch", { version }),
    openReleasePage: (url) => invoke("open_app_release_page", { url }),
  },
  library: {
    snapshot: () => invoke("library_snapshot"),
    previewFolders: (paths, includeAgents) => discovery.scan(paths, null, includeAgents),
    commitImport: (selected, target, local, origins) => invoke("commit_import", { selected, target, local, origins }),
    managedPath: (id) => invoke("managed_path", { id }),
    createCategory: (name) => invoke("create_category", { name }),
    renameCategory: (id, name) => invoke("rename_category", { id, name }),
    deleteCategory: (id) => invoke("delete_category", { id }),
    reorderCategories: (ids) => invoke("reorder_categories", { ids }),
    moveSkills: (ids, target) => invoke("move_skills", { ids, target }),
    undoMove: (id) => invoke("undo_move", { id }),
  },
  agents: {
    presets: () => invoke("agent_presets"),
    chooseDirectory: () => open({ directory: true, multiple: false, title: tr("选择 Agent 的 Skill 目录", "Choose the Agent's skills folder") }),
    previewDirectory: (directory, agentId) => invoke("preview_agent_directory", { directory, agentId }),
    add: (draft, createDirectory) => invoke("add_agent", { draft, createDirectory }),
    remove: (id, shownSkills) => invoke("remove_agent", { id, shownSkills }),
    changeDirectory: (id, directory, createDirectory) => invoke("change_agent_directory", { id, directory, createDirectory }),
    reorder: (ids) => invoke("reorder_agents", { ids }),
    setSkill: (agentId, skillId, enabled) => invoke("set_agent_skill", { agentId, skillId, enabled }),
    setCategorySync: (agentId, categoryId, enabled) => invoke("set_category_sync", { agentId, categoryId, enabled }),
    undoCategorySync: (id) => invoke("undo_category_sync", { id }),
    previewInstall: (filenames, target, agents) => invoke("preview_install_assignments", { filenames, target, agents }),
    commitImport: (selected, target, agents, local) => invoke("commit_import_with_agents", { selected, target, agents, local }),
    previewUnload: (ids) => invoke("preview_unload", { ids }),
    unload: (preview) => invoke("unload_skills", { preview }),
  },
  scanUnmanagedIndicators: () => discovery.scan([], null, true, true),
  async chooseFolders() {
    const selection = await open({ directory: true, multiple: true, title: tr("选择 Skill 文件夹", "Choose skill folders") });
    return !selection ? [] : typeof selection === "string" ? [selection] : selection;
  },
  onFolderDrag(listener) {
    return getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "leave") listener({ type: payload.type });
      if (payload.type === "drop") listener({ type: "drop", paths: payload.paths });
    });
  },
};
