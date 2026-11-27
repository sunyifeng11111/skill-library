import {
  ArrowUpDownIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DatabaseIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  InfoIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  RotateCcwIcon,
  SearchIcon,
  SunIcon,
  Trash2Icon,
} from "lucide-react";
import * as React from "react";
import { useApp } from "@/app/AppContext";
import type { SettingsSection } from "@/app/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Frame, FramePanel } from "@/components/ui/frame";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { formatByteCount } from "@/shared/app-updates";
import { tr } from "@/shared/language";
import { errorText } from "@/shared/ui";
import type {
  BackupRetention,
  LibraryCounts,
  OriginalBackupSummary,
  Preferences,
  ReplacementPreview,
  ResetBackupPolicy,
  Theme,
} from "./gateway";

const LANGUAGES = [
  ["zh-CN", "简体中文"],
  ["en", "English"],
] as const;

const themeLabel = (theme: Theme) =>
  ({
    light: tr("浅色", "Light"),
    dark: tr("深色", "Dark"),
    system: tr("跟随系统", "System"),
  })[theme];

const retentionOptions = () =>
  [
    ["30d", tr("30 天后自动清理（推荐）", "Auto-clean after 30 days (Recommended)")],
    ["7d", tr("7 天后自动清理", "Auto-clean after 7 days")],
    ["manual", tr("仅手动清理", "Manual only")],
  ] as const;

const shortRetentionLabel = (retention: BackupRetention) =>
  ({
    "30d": tr("30 天自动清理", "30d auto-clean"),
    "7d": tr("7 天自动清理", "7d auto-clean"),
    manual: tr("仅手动清理", "Manual only"),
  })[retention];

function formatBytes(bytes: number): string {
  if (bytes <= 0) return tr("仅软链记录", "Link record only");
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatBackupTime(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(document.documentElement.lang || undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCounts(counts: LibraryCounts) {
  return tr(
    `${counts.skills} 个 Skill · ${counts.categories} 个分类 · ${counts.agents} 个 Agent`,
    `${counts.skills} skills · ${counts.categories} categories · ${counts.agents} agents`,
  );
}

type SubModal =
  | null
  | { type: "changeDir"; path: string }
  | { type: "restoreOriginal"; batch: OriginalBackupSummary }
  | {
      type: "replacement";
      action: "import" | "reset";
      loading: boolean;
      path: string | null;
      preview: ReplacementPreview | null;
      error: string | null;
      restoreOriginals: boolean;
      deleteOriginals: boolean;
    };

export function SettingsDialog(): React.ReactElement | null {
  const {
    desktop,
    snapshot,
    setSnapshot,
    preferences,
    applyPreferences,
    replaceLibraryOutcome,
    refreshAgentInventories,
    settingsOpen,
    settingsSection,
    closeSettings,
    setSettingsMutationBusy,
    updates,
    appUpdates,
  } = useApp();

  const gateway = desktop.settings;
  const [section, setSection] = React.useState<SettingsSection>(settingsSection);
  const [dataView, setDataView] = React.useState<"overview" | "backups">("overview");
  const [savingPref, setSavingPref] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [selectingDir, setSelectingDir] = React.useState(false);
  const [loadingBackups, setLoadingBackups] = React.useState(false);
  const [backupsLoaded, setBackupsLoaded] = React.useState(false);
  const [backupsBusy, setBackupsBusy] = React.useState(false);
  const [originalBackups, setOriginalBackups] = React.useState<OriginalBackupSummary[]>([]);
  const [backupQuery, setBackupQuery] = React.useState("");
  const [backupSort, setBackupSort] = React.useState<"newest" | "oldest">("newest");
  const [status, setStatus] = React.useState<{ message: string; error?: boolean } | null>(null);
  const [subModal, setSubModal] = React.useState<SubModal>(null);
  const [subBusy, setSubBusy] = React.useState(false);
  const [subError, setSubError] = React.useState<string | null>(null);

  const loadBackups = React.useCallback(async () => {
    if (!gateway?.listOriginalBackups) {
      setOriginalBackups([]);
      setBackupsLoaded(true);
      return;
    }
    setLoadingBackups(true);
    try {
      setOriginalBackups(await gateway.listOriginalBackups());
      setBackupsLoaded(true);
    } catch (error) {
      setStatus({ message: errorText(error), error: true });
    } finally {
      setLoadingBackups(false);
    }
  }, [gateway]);

  React.useEffect(() => {
    setSettingsMutationBusy(subBusy);
    return () => setSettingsMutationBusy(false);
  }, [subBusy, setSettingsMutationBusy]);

  React.useEffect(() => {
    if (settingsOpen) {
      setSection(
        settingsSection === "about" && !desktop.appUpdates ? "appearance" : settingsSection,
      );
      setDataView("overview");
      setBackupsLoaded(false);
      setBackupQuery("");
      setBackupSort("newest");
      setStatus(null);
      setSubModal(null);
      setSubError(null);
      if (settingsSection === "data") void loadBackups();
    }
  }, [settingsOpen, settingsSection, desktop.appUpdates, loadBackups]);

  const trimmedBackupQuery = backupQuery.trim().toLocaleLowerCase();
  const filteredBackups = React.useMemo(() => {
    const matched = trimmedBackupQuery
      ? originalBackups.filter(
          (batch) =>
            batch.summary.toLocaleLowerCase().includes(trimmedBackupQuery) ||
            batch.itemNames.some((name) => name.toLocaleLowerCase().includes(trimmedBackupQuery)),
        )
      : originalBackups;
    return [...matched].sort((a, b) =>
      backupSort === "newest" ? b.createdAt - a.createdAt : a.createdAt - b.createdAt,
    );
  }, [originalBackups, trimmedBackupQuery, backupSort]);

  if (!gateway || !settingsOpen) return null;

  async function savePreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    if (!gateway || savingPref || preferences[key] === value) return;
    setSavingPref(true);
    setStatus(null);
    try {
      const saved = await gateway.setPreferences({ ...preferences, [key]: value });
      applyPreferences(saved);
      if (key === "backupRetention" && section === "data") await loadBackups();
    } catch (error) {
      setStatus({ message: errorText(error), error: true });
    } finally {
      setSavingPref(false);
    }
  }

  async function handleChooseDirectory(current: string) {
    if (!gateway || selectingDir) return;
    setSelectingDir(true);
    setStatus(null);
    try {
      const path = await gateway.chooseManagedDirectory(current);
      if (path && path !== current) {
        setSubError(null);
        setSubModal({ type: "changeDir", path });
      }
    } catch (reason) {
      setStatus({ message: errorText(reason), error: true });
    } finally {
      setSelectingDir(false);
    }
  }

  async function confirmChangeDir(path: string) {
    if (!gateway || subBusy) return;
    if (updates.applying) {
      setSubError(tr("请等待当前更新完成。", "Wait for the current update to finish."));
      return;
    }
    setSubBusy(true);
    setSubError(null);
    try {
      const next = await gateway.changeManagedDirectory(path);
      setSnapshot(next);
      void refreshAgentInventories({ force: true, snapshotOverride: next });
      setStatus({ message: tr("已更新 Skill 库目录。", "Managed skills folder updated.") });
      setSubModal(null);
    } catch (reason) {
      setSubError(errorText(reason));
    } finally {
      setSubBusy(false);
    }
  }

  async function handleExportBackup() {
    if (!gateway || exporting) return;
    setExporting(true);
    setStatus(null);
    try {
      const path = await gateway.chooseExport();
      if (path) {
        await gateway.exportBackup(path);
        setStatus({ message: tr("已导出 Skill 库备份。", "Library backup exported.") });
      }
    } catch (error) {
      setStatus({ message: errorText(error), error: true });
    } finally {
      setExporting(false);
    }
  }

  async function startReplacement(action: "import" | "reset") {
    if (!gateway || savingPref || exporting) return;
    const importing = action === "import";
    setSubError(null);
    setSubModal({
      type: "replacement",
      action,
      loading: true,
      path: null,
      preview: null,
      error: null,
      restoreOriginals: false,
      deleteOriginals: false,
    });
    try {
      const path = importing ? await gateway.chooseBackup() : null;
      if (importing && !path) {
        setSubModal(null);
        return;
      }
      const preview = path ? await gateway.previewBackup(path) : await gateway.previewDefaults();
      const hasBackups = (preview.originalBackupBatches ?? 0) > 0;
      setSubModal({
        type: "replacement",
        action,
        loading: false,
        path,
        preview,
        error: null,
        restoreOriginals: !importing && hasBackups,
        deleteOriginals: false,
      });
    } catch (error) {
      setSubModal({
        type: "replacement",
        action,
        loading: false,
        path: null,
        preview: null,
        error: `${importing ? tr("无法读取此备份。", "Could not read this backup.") : tr("无法预览重置范围。", "Could not preview what will be removed.")} ${errorText(error)}`,
        restoreOriginals: false,
        deleteOriginals: false,
      });
    }
  }

  async function applyReplacement() {
    if (!gateway || subModal?.type !== "replacement" || !subModal.preview || subBusy) return;
    if (updates.applying) {
      setSubError(tr("请等待当前更新完成。", "Wait for the current update to finish."));
      return;
    }
    setSubBusy(true);
    setSubError(null);
    const isReset = subModal.action === "reset";
    const hasOriginalBackups = (subModal.preview.originalBackupBatches ?? 0) > 0;
    const resetPolicy: ResetBackupPolicy =
      !isReset || !hasOriginalBackups
        ? "keep"
        : subModal.restoreOriginals
          ? "restoreOriginals"
          : subModal.deleteOriginals
            ? "deleteBackups"
            : "keep";
    try {
      const outcome = subModal.path
        ? await gateway.restoreBackup(subModal.path, subModal.preview)
        : await gateway.restoreDefaults(subModal.preview, resetPolicy);
      replaceLibraryOutcome(outcome);
      if (section === "data") void loadBackups();
      setStatus({
        message: subModal.path
          ? tr("已导入 Skill 库备份。", "Library backup imported.")
          : resetPolicy === "restoreOriginals" && hasOriginalBackups
            ? tr("已还原原文件并重置 Skill 库。", "Original files restored and library reset.")
            : resetPolicy === "deleteBackups" && hasOriginalBackups
              ? tr("已重置 Skill 库并删除原文件备份。", "Library reset and original backups deleted.")
              : hasOriginalBackups
                ? tr("已重置 Skill 库，原文件备份已保留。", "Library reset. Original backups were kept.")
                : tr("已重置 Skill 库。", "Library reset."),
      });
      setSubModal(null);
    } catch (reason) {
      setSubError(`${tr("Skill 库替换失败。", "Could not replace the library.")} ${errorText(reason)}`);
    } finally {
      setSubBusy(false);
    }
  }

  async function confirmRestoreOriginal(batch: OriginalBackupSummary) {
    if (!gateway?.restoreOriginalBackup || subBusy) return;
    setSubBusy(true);
    setSubError(null);
    try {
      const next = await gateway.restoreOriginalBackup(batch.id);
      setSnapshot(next);
      void refreshAgentInventories({ force: true, snapshotOverride: next });
      setOriginalBackups((prev) => prev.filter((item) => item.id !== batch.id));
      setStatus({
        message: tr(
          "已恢复原文件，Skill 库中的 Skill 副本已保留。",
          "Original files restored. Library copies were kept.",
        ),
      });
      setSubModal(null);
    } catch (reason) {
      setSubError(errorText(reason));
    } finally {
      setSubBusy(false);
    }
  }

  async function handleDeleteBackup(batch: OriginalBackupSummary) {
    if (!gateway?.deleteOriginalBackup || backupsBusy) return;
    setBackupsBusy(true);
    setStatus(null);
    try {
      const remaining = await gateway.deleteOriginalBackup(batch.id);
      setOriginalBackups(remaining);
      if (snapshot) setSnapshot({ ...snapshot, originalBackupCount: remaining.length });
      setStatus({ message: tr("已删除该原文件备份。", "Original backup deleted.") });
    } catch (error) {
      setStatus({ message: errorText(error), error: true });
    } finally {
      setBackupsBusy(false);
    }
  }

  const navItems: {
    key: SettingsSection;
    label: string;
    icon: React.ReactNode;
    badgeDot?: boolean;
  }[] = [
    { key: "appearance", label: tr("外观与语言", "Appearance & language"), icon: <PaletteIcon className="size-4" /> },
    { key: "data", label: tr("数据管理", "Library data"), icon: <DatabaseIcon className="size-4" /> },
    ...(desktop.appUpdates
      ? [
          {
            key: "about" as const,
            label: tr("关于与更新", "About & updates"),
            icon: <InfoIcon className="size-4" />,
            badgeDot: appUpdates.hasBadge,
          },
        ]
      : []),
  ];

  const retOptions = retentionOptions();
  const currentRetention = preferences.backupRetention ?? "30d";
  const currentRetentionLabel =
    retOptions.find(([v]) => v === currentRetention)?.[1] ?? retOptions[0][1];
  const currentLangLabel =
    LANGUAGES.find(([v]) => v === preferences.language)?.[1] ?? LANGUAGES[0][1];
  const backupCount = backupsLoaded
    ? originalBackups.length
    : (snapshot?.originalBackupCount ?? originalBackups.length);
  const showingBackupsSubView = section === "data" && dataView === "backups";

  const isCheckingAppUpdate = appUpdates.phase === "checking";
  const isDownloadingAppUpdate = appUpdates.phase === "downloading";
  const isInstallingAppUpdate = appUpdates.phase === "installing";
  const releasePageUrl = appUpdates.availableRelease?.releasesUrl ?? appUpdates.releasesUrl;
  const downloadPercent =
    appUpdates.downloadProgress?.contentLength && appUpdates.downloadProgress.contentLength > 0
      ? Math.min(
          100,
          Math.round(
            (appUpdates.downloadProgress.downloadedBytes /
              appUpdates.downloadProgress.contentLength) *
              100,
          ),
        )
      : null;

  return (
    <>
      <Dialog
        open={settingsOpen}
        onOpenChange={(next) => {
          if (!next && !subModal && !isInstallingAppUpdate) closeSettings();
        }}
      >
        <DialogPopup className="max-w-3xl overflow-hidden p-0" showCloseButton={!isInstallingAppUpdate}>
          <div className="flex h-[min(600px,calc(100vh-2rem))] min-h-0 flex-col sm:flex-row">
            {/* Left Nav */}
            <aside className="flex shrink-0 flex-col border-b bg-sidebar p-4 pr-12 sm:w-60 sm:border-r sm:border-b-0 sm:pr-4">
              <DialogTitle className="px-2 pb-3 text-base font-semibold">
                {tr("设置", "Settings")}
              </DialogTitle>
              <nav
                aria-label={tr("设置分区", "Settings sections")}
                className="flex flex-row gap-1 overflow-x-auto sm:flex-col"
              >
                {navItems.map((item) => {
                  const active = section === item.key;
                  return (
                    <button
                      key={item.key}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                          : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                      )}
                      type="button"
                      onClick={() => {
                        setSection(item.key);
                        setDataView("overview");
                        setBackupQuery("");
                        setBackupSort("newest");
                        if (item.key === "data") {
                          void loadBackups();
                        }
                      }}
                    >
                      {item.icon}
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.badgeDot && (
                        <span
                          aria-hidden="true"
                          className="size-2 shrink-0 rounded-full bg-info"
                          data-app-update-dot=""
                        />
                      )}
                    </button>
                  );
                })}
              </nav>
            </aside>

            {/* Right Panel */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {!showingBackupsSubView ? (
                <div className="relative min-h-0 flex-1">
                  <ScrollArea className="absolute inset-0" overscrollContain scrollFade scrollbarGutter>
                    <div className="p-6 sm:pr-12">
                      {section === "appearance" && (
                        <div className="flex flex-col gap-7">
                          <div className="flex flex-wrap items-center justify-between gap-4">
                            <div>
                              <strong className="font-medium text-sm">{tr("界面语言", "Language")}</strong>
                              <p className="text-muted-foreground text-xs">
                                {tr("立即切换所有界面文案与提示语言。", "Switch the interface language immediately.")}
                              </p>
                            </div>
                            <div className="w-44">
                              <Select
                                disabled={savingPref}
                                value={preferences.language}
                                onValueChange={(val) => {
                                  if (val === "zh-CN" || val === "en") void savePreference("language", val);
                                }}
                              >
                                <SelectTrigger aria-label={tr("界面语言", "Language")} size="sm">
                                  <SelectValue>{currentLangLabel}</SelectValue>
                                </SelectTrigger>
                                <SelectPopup>
                                  {LANGUAGES.map(([value, name]) => (
                                    <SelectItem key={value} value={value}>
                                      {name}
                                    </SelectItem>
                                  ))}
                                </SelectPopup>
                              </Select>
                            </div>
                          </div>

                          <div className="flex flex-col gap-3">
                            <div>
                              <strong className="font-medium text-sm">{tr("外观", "Appearance")}</strong>
                              <p className="text-muted-foreground text-xs">
                                {tr("选择浅色、深色或跟随系统外观。", "Choose light, dark, or match your system.")}
                              </p>
                            </div>
                            <div className="grid grid-cols-3 gap-2.5">
                              {(
                                [
                                  ["light", SunIcon],
                                  ["dark", MoonIcon],
                                  ["system", MonitorIcon],
                                ] as const
                              ).map(([value, Icon]) => {
                                const active = preferences.theme === value;
                                return (
                                  <button
                                    key={value}
                                    aria-pressed={active}
                                    className={cn(
                                      "flex cursor-pointer flex-col items-center gap-2 rounded-xl border p-4 text-sm transition-[border-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                      active
                                        ? "border-primary bg-accent font-medium text-foreground shadow-xs/5"
                                        : "border-border bg-background text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                                    )}
                                    disabled={savingPref}
                                    type="button"
                                    onClick={() => void savePreference("theme", value)}
                                  >
                                    <Icon className="size-5" />
                                    <span>{themeLabel(value)}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      )}

                      {section === "data" && (
                        <div className="divide-y divide-border">
                          {snapshot?.managedDirectory && (
                            <div className="flex flex-wrap items-start justify-between gap-4 pb-5">
                              <div className="min-w-0 flex-1">
                                <strong className="font-medium text-sm">
                                  {tr("Skill 库目录", "Managed skills folder")}
                                </strong>
                                <p className="mt-1 break-all font-mono text-muted-foreground text-xs">
                                  {snapshot.managedDirectory}
                                </p>
                              </div>
                              <Button
                                disabled={selectingDir}
                                size="sm"
                                variant="outline"
                                onClick={() => void handleChooseDirectory(snapshot.managedDirectory!)}
                              >
                                <FolderOpenIcon />
                                {tr("更改目录…", "Change folder…")}
                              </Button>
                            </div>
                          )}

                          <div
                            className={cn(
                              "flex flex-wrap items-center justify-between gap-4 pb-5",
                              snapshot?.managedDirectory && "pt-5",
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <strong className="font-medium text-sm">
                                {tr("Skill 库整库备份", "Library backup")}
                              </strong>
                              <p className="mt-0.5 text-muted-foreground text-xs">
                                {tr(
                                  "导出或导入全部 Skill、分类、Agent 配置与偏好。",
                                  "Export or import all skills, categories, Agent settings, and preferences.",
                                )}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void startReplacement("import")}
                              >
                                {tr("导入", "Import")}
                              </Button>
                              <Button
                                disabled={exporting}
                                loading={exporting}
                                size="sm"
                                variant="outline"
                                onClick={() => void handleExportBackup()}
                              >
                                {tr("导出", "Export")}
                              </Button>
                            </div>
                          </div>

                          <div className="py-2">
                            <button
                              className="flex w-[calc(100%+1.5rem)] -mx-3 cursor-pointer items-center justify-between gap-4 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              type="button"
                              onClick={() => {
                                setDataView("backups");
                                void loadBackups();
                              }}
                            >
                              <div className="min-w-0 flex-1">
                                <strong className="font-medium text-sm">
                                  {tr("接管前原文件备份", "Original tool backups")}
                                </strong>
                                <p className="mt-0.5 text-muted-foreground text-xs">
                                  {tr(
                                    "查看或还原纳入托管前的工具原文件夹。",
                                    "Review or restore original tool folders backed up during adoption.",
                                  )}
                                </p>
                              </div>
                              <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs tabular-nums">
                                <span>
                                  {backupCount > 0
                                    ? tr(`共 ${backupCount} 条`, `${backupCount} items`)
                                    : tr("暂无备份", "None")}
                                  {" · "}
                                  {shortRetentionLabel(currentRetention)}
                                </span>
                                <ChevronRightIcon className="size-4 text-muted-foreground/70" />
                              </div>
                            </button>
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-4 pt-5">
                            <div className="min-w-0 flex-1">
                              <strong className="font-medium text-sm">
                                {tr("重置 Skill 库", "Reset library")}
                              </strong>
                              <p className="mt-0.5 text-muted-foreground text-xs">
                                {tr(
                                  "清空托管库与受管链接；重置前可选择先还原原文件。",
                                  "Clear the managed library and links; optionally restore originals first.",
                                )}
                              </p>
                            </div>
                            <Button
                              size="sm"
                              variant="destructive-outline"
                              onClick={() => void startReplacement("reset")}
                            >
                              {tr("重置 Skill 库…", "Reset library…")}
                            </Button>
                          </div>
                        </div>
                      )}

                      {section === "about" && desktop.appUpdates && (
                        <div className="divide-y divide-border">
                          <div className="flex flex-wrap items-center justify-between gap-4 pb-5">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <strong className="font-semibold text-sm">Skill Library</strong>
                                <Badge size="sm" variant="secondary">
                                  {appUpdates.currentVersion ? `v${appUpdates.currentVersion}` : "…"}
                                </Badge>
                              </div>
                              <p className="mt-1 text-muted-foreground text-xs">
                                {appUpdates.lastCheckedAt
                                  ? tr(
                                      `上次检查：${appUpdates.lastCheckedAt.toLocaleTimeString(
                                        document.documentElement.lang || undefined,
                                        { hour: "2-digit", minute: "2-digit" },
                                      )}`,
                                      `Last checked: ${appUpdates.lastCheckedAt.toLocaleTimeString(
                                        document.documentElement.lang || undefined,
                                        { hour: "2-digit", minute: "2-digit" },
                                      )}`,
                                    )
                                  : tr(
                                      "通过 GitHub Releases 获取正式版更新。",
                                      "Receives stable desktop updates from GitHub Releases.",
                                    )}
                              </p>
                            </div>
                            <Button
                              disabled={
                                isCheckingAppUpdate || isDownloadingAppUpdate || isInstallingAppUpdate
                              }
                              loading={isCheckingAppUpdate}
                              size="sm"
                              variant="outline"
                              onClick={() => void appUpdates.check()}
                            >
                              {tr("检查更新", "Check for updates")}
                            </Button>
                          </div>

                          {(appUpdates.phase !== "idle" || appUpdates.availableRelease) && (
                            <div className="py-5">
                              {appUpdates.phase === "checking" && !appUpdates.availableRelease && (
                                <div
                                  className="flex items-center gap-2.5 text-muted-foreground text-sm"
                                  role="status"
                                >
                                  <Spinner />
                                  <span>{tr("正在检查应用更新…", "Checking for app updates…")}</span>
                                </div>
                              )}

                              {appUpdates.phase === "unconfigured" && (
                                <Alert variant="info">
                                  <InfoIcon />
                                  <AlertTitle>
                                    {tr("尚未配置发布源", "Update source not configured")}
                                  </AlertTitle>
                                  <AlertDescription>
                                    {tr(
                                      "当前构建仍使用开源前的占位更新配置。发布到 GitHub 并替换仓库地址与更新签名公钥后，即可在这里自动检查并安装新版本。",
                                      "This build still uses the pre-release placeholder config. Replace the repository endpoint and signing public key in tauri.conf.json once published on GitHub.",
                                    )}
                                  </AlertDescription>
                                </Alert>
                              )}

                              {appUpdates.phase === "upToDate" && (
                                <div
                                  className="flex items-center gap-2.5 text-sm text-foreground"
                                  role="status"
                                >
                                  <CheckCircle2Icon className="size-4 shrink-0 text-success" />
                                  <span>{tr("当前已是最新版本。", "You’re up to date.")}</span>
                                </div>
                              )}

                              {appUpdates.phase === "error" && (
                                <Alert variant="error">
                                  <AlertTitle>
                                    {appUpdates.errorKind === "readonlyVolume"
                                      ? tr(
                                          "无法覆盖当前应用目录",
                                          "Cannot write to current app location",
                                        )
                                      : tr("应用更新失败", "App update failed")}
                                  </AlertTitle>
                                  <AlertDescription>
                                    <p>{appUpdates.error}</p>
                                    <div className="flex flex-wrap items-center gap-2 pt-1">
                                      <Button
                                        size="xs"
                                        variant="outline"
                                        onClick={() => {
                                          if (
                                            appUpdates.availableRelease &&
                                            appUpdates.downloadedVersion ===
                                              appUpdates.availableRelease.version
                                          ) {
                                            void appUpdates.installAndRelaunch();
                                          } else if (appUpdates.availableRelease) {
                                            void appUpdates.download();
                                          } else {
                                            void appUpdates.check();
                                          }
                                        }}
                                      >
                                        {tr("重试", "Retry")}
                                      </Button>
                                      {releasePageUrl && (
                                        <Button
                                          size="xs"
                                          variant="outline"
                                          onClick={() => void appUpdates.openReleasePage()}
                                        >
                                          <ExternalLinkIcon />
                                          {tr(
                                            "前往 GitHub Releases 手动下载",
                                            "Download manually on GitHub Releases",
                                          )}
                                        </Button>
                                      )}
                                    </div>
                                  </AlertDescription>
                                </Alert>
                              )}

                              {appUpdates.availableRelease &&
                                (appUpdates.phase === "available" ||
                                  appUpdates.phase === "downloading" ||
                                  appUpdates.phase === "readyToInstall" ||
                                  appUpdates.phase === "installing") && (
                                  <Frame>
                                    <FramePanel className="space-y-4 p-4">
                                      <div className="flex flex-wrap items-start justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                          <div className="flex flex-wrap items-center gap-2">
                                            <strong className="font-semibold text-sm">
                                              {tr(
                                                `发现新版本 v${appUpdates.availableRelease.version}`,
                                                `Skill Library v${appUpdates.availableRelease.version} available`,
                                              )}
                                            </strong>
                                            {appUpdates.availableRelease.publishedAt && (
                                              <span className="text-muted-foreground text-xs">
                                                {appUpdates.availableRelease.publishedAt}
                                              </span>
                                            )}
                                            {appUpdates.isSkippedAvailable && (
                                              <Badge size="sm" variant="outline">
                                                {tr("已跳过自动提醒", "Reminders skipped")}
                                              </Badge>
                                            )}
                                          </div>
                                        </div>
                                        {releasePageUrl && (
                                          <Button
                                            size="xs"
                                            variant="ghost"
                                            onClick={() => void appUpdates.openReleasePage()}
                                          >
                                            <ExternalLinkIcon />
                                            {tr("在 GitHub 查看", "View on GitHub")}
                                          </Button>
                                        )}
                                      </div>

                                      {appUpdates.availableRelease.notes?.trim() && (
                                        <div className="max-h-36 overflow-y-auto rounded-lg border bg-muted/35 px-3 py-2.5 text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap">
                                          {appUpdates.availableRelease.notes.trim()}
                                        </div>
                                      )}

                                      <p className="text-muted-foreground text-xs">
                                        {tr(
                                          "应用更新仅升级客户端本身，不会影响已保存的 Skill 库与 Agent 配置。",
                                          "Updating only upgrades Skill Library itself; your library and Agent settings stay intact.",
                                        )}
                                      </p>

                                      {isDownloadingAppUpdate && (
                                        <div className="space-y-2">
                                          <div className="flex items-center justify-between gap-2 text-xs">
                                            <span className="text-muted-foreground">
                                              {tr("正在下载更新…", "Downloading update…")}
                                            </span>
                                            <span className="font-mono text-muted-foreground tabular-nums">
                                              {downloadPercent !== null &&
                                              appUpdates.downloadProgress?.contentLength
                                                ? `${downloadPercent}% · ${formatByteCount(
                                                    appUpdates.downloadProgress.downloadedBytes,
                                                  )} / ${formatByteCount(
                                                    appUpdates.downloadProgress.contentLength,
                                                  )}`
                                                : formatByteCount(
                                                    appUpdates.downloadProgress?.downloadedBytes ?? 0,
                                                  )}
                                            </span>
                                          </div>
                                          <div
                                            aria-label={tr("更新下载进度", "Update download progress")}
                                            aria-valuemax={100}
                                            aria-valuemin={0}
                                            aria-valuenow={downloadPercent ?? undefined}
                                            className="h-2 w-full overflow-hidden rounded-full bg-muted"
                                            role="progressbar"
                                          >
                                            <div
                                              className={cn(
                                                "h-full rounded-full bg-primary transition-[width] duration-150",
                                                downloadPercent === null && "w-2/5 animate-pulse",
                                              )}
                                              style={
                                                downloadPercent !== null
                                                  ? { width: `${downloadPercent}%` }
                                                  : undefined
                                              }
                                            />
                                          </div>
                                        </div>
                                      )}

                                      {(appUpdates.phase === "readyToInstall" ||
                                        isInstallingAppUpdate) &&
                                        appUpdates.installBlockedReason && (
                                          <Alert variant="warning">
                                            <AlertDescription>
                                              {appUpdates.installBlockedReason}
                                            </AlertDescription>
                                          </Alert>
                                        )}

                                      <div className="flex flex-wrap items-center gap-2">
                                        {appUpdates.phase === "available" && (
                                          <>
                                            <Button
                                              size="sm"
                                              onClick={() => void appUpdates.download()}
                                            >
                                              <DownloadIcon />
                                              {tr("下载更新", "Download update")}
                                            </Button>
                                            {!appUpdates.isSkippedAvailable && (
                                              <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => appUpdates.skipAvailable()}
                                              >
                                                {tr("跳过此版本", "Skip this version")}
                                              </Button>
                                            )}
                                          </>
                                        )}

                                        {isDownloadingAppUpdate && (
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => void appUpdates.cancelDownload()}
                                          >
                                            {tr("取消下载", "Cancel download")}
                                          </Button>
                                        )}

                                        {(appUpdates.phase === "readyToInstall" ||
                                          isInstallingAppUpdate) && (
                                          <Button
                                            disabled={
                                              Boolean(appUpdates.installBlockedReason) ||
                                              isInstallingAppUpdate
                                            }
                                            loading={isInstallingAppUpdate}
                                            size="sm"
                                            onClick={() => void appUpdates.installAndRelaunch()}
                                          >
                                            <RotateCcwIcon />
                                            {tr("立即重启并安装", "Restart & install")}
                                          </Button>
                                        )}
                                      </div>
                                    </FramePanel>
                                  </Frame>
                                )}
                            </div>
                          )}

                          <div
                            className={cn(
                              "flex items-center justify-between gap-4",
                              appUpdates.phase !== "idle" || appUpdates.availableRelease
                                ? "py-5"
                                : "pt-5 pb-5",
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <label
                                className="cursor-pointer font-medium text-sm"
                                htmlFor="auto-check-app-updates"
                              >
                                {tr("启动时自动检查更新", "Check for updates on launch")}
                              </label>
                              <p className="mt-0.5 text-muted-foreground text-xs">
                                {tr(
                                  "启动后静默检查 GitHub Releases 稳定版本；无新版本或离线时不打扰。",
                                  "Quietly checks stable GitHub Releases on startup without interrupting when offline.",
                                )}
                              </p>
                            </div>
                            <Switch
                              checked={preferences.autoCheckAppUpdates ?? true}
                              disabled={savingPref}
                              id="auto-check-app-updates"
                              onCheckedChange={(checked) =>
                                void savePreference("autoCheckAppUpdates", Boolean(checked))
                              }
                            />
                          </div>

                          {appUpdates.releasesUrl && (
                            <div className="flex flex-wrap items-center justify-between gap-4 pt-5">
                              <div className="min-w-0 flex-1">
                                <strong className="font-medium text-sm">
                                  {tr("发布页面", "Release page")}
                                </strong>
                                <p className="mt-0.5 truncate font-mono text-muted-foreground text-xs">
                                  {appUpdates.releasesUrl}
                                </p>
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void appUpdates.openReleasePage()}
                              >
                                <ExternalLinkIcon />
                                {tr("前往 GitHub Releases", "Open GitHub Releases")}
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              ) : (
                <>
                  <div className="shrink-0 border-b px-6 pt-5 pb-4 sm:pr-12">
                    <div className="flex items-center gap-1.5">
                      <Button
                        aria-label={tr("返回数据管理", "Back to library data")}
                        className="-ml-2 text-muted-foreground hover:text-foreground"
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setDataView("overview");
                          setBackupQuery("");
                          setBackupSort("newest");
                        }}
                      >
                        <ChevronLeftIcon />
                        <span>{tr("数据管理", "Library data")}</span>
                      </Button>
                      <span aria-hidden="true" className="text-muted-foreground/60 text-xs">
                        /
                      </span>
                      <h3 className="font-semibold text-sm">
                        {tr("接管前原文件备份", "Original tool backups")}
                      </h3>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                      <strong className="font-medium text-sm">
                        {tr("自动清理旧备份", "Auto-clean old backups")}
                      </strong>
                      <div className="w-56 shrink-0">
                        <Select
                          disabled={savingPref}
                          value={currentRetention}
                          onValueChange={(val) => {
                            if (val === "30d" || val === "7d" || val === "manual") {
                              void savePreference("backupRetention", val as BackupRetention);
                            }
                          }}
                        >
                          <SelectTrigger aria-label={tr("自动清理旧备份", "Auto-clean old backups")} size="sm">
                            <SelectValue>{currentRetentionLabel}</SelectValue>
                          </SelectTrigger>
                          <SelectPopup>
                            {retOptions.map(([value, label]) => (
                              <SelectItem key={value} value={value}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </div>
                    </div>

                    <p className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
                      {tr(
                        "恢复原文件会还原对应工具目录并解除托管关联，Skill 库中的副本仍会保留。",
                        "Restoring returns the original folder to its tool and detaches the link while keeping your library copy.",
                      )}
                    </p>

                    {!loadingBackups && originalBackups.length > 0 && (
                      <div className="mt-3.5 flex flex-wrap items-center gap-2">
                        <InputGroup className="min-w-0 flex-1">
                          <InputGroupAddon>
                            <SearchIcon />
                          </InputGroupAddon>
                          <InputGroupInput
                            aria-label={tr("搜索原文件备份", "Search original backups")}
                            placeholder={tr("搜索备份或 Skill", "Search backups or skills")}
                            size="sm"
                            type="search"
                            value={backupQuery}
                            onChange={(e) => setBackupQuery(e.target.value)}
                          />
                        </InputGroup>
                        <Button
                          aria-label={tr("切换备份排序", "Toggle backup sort order")}
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setBackupSort((prev) => (prev === "newest" ? "oldest" : "newest"))
                          }
                        >
                          <ArrowUpDownIcon />
                          {backupSort === "newest"
                            ? tr("最新优先", "Newest first")
                            : tr("最早优先", "Oldest first")}
                        </Button>
                        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                          {trimmedBackupQuery
                            ? tr(
                                `匹配 ${filteredBackups.length} / ${originalBackups.length} 条`,
                                `${filteredBackups.length} of ${originalBackups.length}`,
                              )
                            : tr(
                                `共 ${originalBackups.length} 条备份`,
                                `${originalBackups.length} backups`,
                              )}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="relative min-h-0 flex-1">
                    <ScrollArea className="absolute inset-0" overscrollContain scrollFade scrollbarGutter>
                      <div className="px-6 py-2 sm:pr-12">
                        {loadingBackups ? (
                          <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
                            <Spinner />
                            <span>{tr("正在读取原文件备份…", "Loading original backups…")}</span>
                          </div>
                        ) : !originalBackups.length ? (
                          <p className="py-10 text-center text-muted-foreground text-sm">
                            {tr("当前没有原文件备份。", "No original file backups yet.")}
                          </p>
                        ) : !filteredBackups.length ? (
                          <div className="flex flex-col items-center gap-2 py-10 text-center">
                            <p className="text-muted-foreground text-sm">
                              {tr("没有匹配的原文件备份。", "No matching original backups.")}
                            </p>
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => setBackupQuery("")}
                            >
                              {tr("清空搜索", "Clear search")}
                            </Button>
                          </div>
                        ) : (
                          <div
                            aria-label={tr("原文件备份列表", "Original backups list")}
                            className="divide-y divide-border"
                          >
                            {filteredBackups.map((batch) => {
                              const names =
                                batch.itemNames.slice(0, 4).join("、") +
                                (batch.itemNames.length > 4
                                  ? tr(` 等 ${batch.itemNames.length} 个`, ` +${batch.itemNames.length - 4}`)
                                  : "");
                              const fullNames = batch.itemNames.join("、");
                              const timeText = formatBackupTime(batch.createdAt);
                              const sizeText = formatBytes(batch.sizeBytes);
                              const meta = [timeText, names, sizeText]
                                .filter(Boolean)
                                .join(" · ");
                              const metaTitle = [timeText, fullNames, sizeText]
                                .filter(Boolean)
                                .join(" · ");

                              return (
                                <div
                                  key={batch.id}
                                  className="flex items-center justify-between gap-3 py-3"
                                >
                                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <strong className="truncate font-medium text-sm">
                                      {batch.summary}
                                    </strong>
                                    <span
                                      className="truncate text-muted-foreground text-xs"
                                      title={metaTitle}
                                    >
                                      {meta}
                                    </span>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1.5">
                                    <Button
                                      disabled={backupsBusy}
                                      size="xs"
                                      variant="outline"
                                      onClick={() => {
                                        setSubError(null);
                                        setSubModal({ type: "restoreOriginal", batch });
                                      }}
                                    >
                                      {tr("恢复原文件", "Restore")}
                                    </Button>
                                    <Button
                                      aria-label={tr(
                                        `删除备份：${batch.summary}`,
                                        `Delete backup: ${batch.summary}`,
                                      )}
                                      className="text-muted-foreground hover:text-destructive-foreground"
                                      disabled={backupsBusy}
                                      size="icon-xs"
                                      title={tr("删除备份", "Delete backup")}
                                      variant="ghost"
                                      onClick={() => void handleDeleteBackup(batch)}
                                    >
                                      <Trash2Icon className="size-3.5" />
                                    </Button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </ScrollArea>
                  </div>
                </>
              )}

              {status && (
                <div className="shrink-0 border-t px-6 py-2.5 sm:pr-12">
                  <p
                    className={cn(
                      "text-xs",
                      status.error ? "text-destructive-foreground" : "text-muted-foreground",
                    )}
                    role={status.error ? "alert" : "status"}
                  >
                    {status.message}
                  </p>
                </div>
              )}
            </div>
          </div>
        </DialogPopup>
      </Dialog>

      {/* Nested confirmation dialogs */}
      <Dialog
        open={Boolean(subModal)}
        onOpenChange={(next) => {
          if (!next && !subBusy) setSubModal(null);
        }}
      >
        <DialogPopup showCloseButton={!subBusy}>
          {subModal?.type === "changeDir" && (
            <>
              <DialogHeader>
                <DialogTitle>{tr("更改 Skill 库目录", "Change managed skills folder")}</DialogTitle>
              </DialogHeader>
              <DialogPanel>
                <div className="flex flex-col gap-3 text-sm">
                  <p>
                    {tr(
                      "已有 Skill 将移至下方目录，已启用的 Agent 链接也会更新。",
                      "Existing skills will move to this folder and enabled Agent links will be updated.",
                    )}
                  </p>
                  <code className="break-all rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs">
                    {subModal.path}
                  </code>
                  {subError && (
                    <p className="text-destructive-foreground text-xs" role="alert">
                      {subError}
                    </p>
                  )}
                </div>
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button disabled={subBusy} variant="outline" onClick={() => setSubModal(null)}>
                  {tr("取消", "Cancel")}
                </Button>
                <Button
                  disabled={subBusy}
                  loading={subBusy}
                  onClick={() => void confirmChangeDir(subModal.path)}
                >
                  {tr("确认迁移", "Move skills")}
                </Button>
              </DialogFooter>
            </>
          )}

          {subModal?.type === "restoreOriginal" && (
            <>
              <DialogHeader>
                <DialogTitle>{tr("恢复原文件？", "Restore original files?")}</DialogTitle>
              </DialogHeader>
              <DialogPanel>
                <div className="flex flex-col gap-3 text-sm">
                  <p>
                    {tr(
                      `将还原「${subModal.batch.summary}」对应的原工具目录并解除这些项目的托管关联。`,
                      `Restore original tool folders for “${subModal.batch.summary}” and detach their managed links.`,
                    )}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {tr(
                      "Skill 库中已保存的 Skill 副本会继续保留，不会删除。",
                      "Your managed Skill copies in the library will be kept.",
                    )}
                  </p>
                  {subError && (
                    <p className="text-destructive-foreground text-xs" role="alert">
                      {subError}
                    </p>
                  )}
                </div>
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button disabled={subBusy} variant="outline" onClick={() => setSubModal(null)}>
                  {tr("取消", "Cancel")}
                </Button>
                <Button
                  disabled={subBusy}
                  loading={subBusy}
                  onClick={() => void confirmRestoreOriginal(subModal.batch)}
                >
                  {tr("确认恢复", "Restore originals")}
                </Button>
              </DialogFooter>
            </>
          )}

          {subModal?.type === "replacement" && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {subModal.preview
                    ? subModal.action === "import"
                      ? tr("导入预览", "Import preview")
                      : tr("重置 Skill 库", "Reset library")
                    : subModal.action === "import"
                      ? tr("导入 Skill 库备份", "Import library backup")
                      : tr("重置 Skill 库", "Reset library")}
                </DialogTitle>
              </DialogHeader>
              <DialogPanel>
                {subModal.loading ? (
                  <div className="flex items-center gap-2.5 py-4 text-muted-foreground text-sm" role="status">
                    <Spinner />
                    <span>
                      {subModal.action === "import"
                        ? tr("正在校验备份…", "Validating backup…")
                        : tr("正在核对将受影响的内容…", "Checking what will be removed…")}
                    </span>
                  </div>
                ) : subModal.error ? (
                  <p className="text-destructive-foreground text-sm" role="alert">
                    {subModal.error}
                  </p>
                ) : subModal.preview ? (
                  <div className="flex flex-col gap-3 text-sm">
                    {subModal.path && (
                      <p className="break-all font-mono text-muted-foreground text-xs">
                        {subModal.path}
                      </p>
                    )}
                    <p>
                      {subModal.action === "import"
                        ? tr(
                            "确认后将替换当前托管文件、分类、Agent 设置和偏好。",
                            "This replaces the current managed files, categories, Agent settings, and preferences.",
                          )
                        : tr(
                            "确认后将清空 Skill 库、移除仍匹配的受管链接，并恢复简体中文和跟随系统主题。",
                            "This clears the managed library, removes matching managed links, and resets the language to Simplified Chinese and the theme to System.",
                          )}
                    </p>
                    <p className="text-xs">
                      {tr("当前 Skill 库", "Current library")} · {formatCounts(subModal.preview.current)}
                    </p>
                    {subModal.action === "reset" && (subModal.preview.originalBackupBatches ?? 0) > 0 && (
                      <div className="flex flex-col gap-2.5 rounded-lg border bg-muted/40 p-3 text-xs">
                        <p className="font-medium text-foreground">
                          {tr(
                            `检测到 ${subModal.preview.originalBackupBatches} 批原文件备份（共 ${subModal.preview.originalBackupItems ?? 0} 项）`,
                            `Found ${subModal.preview.originalBackupBatches} original backup batches (${subModal.preview.originalBackupItems ?? 0} items)`,
                          )}
                        </p>
                        <div className="flex items-start gap-2.5">
                          <Checkbox
                            checked={subModal.restoreOriginals}
                            className="mt-0.5"
                            disabled={subBusy}
                            id="reset-restore-originals"
                            onCheckedChange={(checked) => {
                              const next = Boolean(checked);
                              setSubModal((prev) =>
                                prev?.type === "replacement"
                                  ? {
                                      ...prev,
                                      restoreOriginals: next,
                                      deleteOriginals: next ? false : prev.deleteOriginals,
                                    }
                                  : prev,
                              );
                            }}
                          />
                          <label
                            className="cursor-pointer leading-relaxed text-foreground"
                            htmlFor="reset-restore-originals"
                          >
                            {tr(
                              "重置前先还原已备份的工具原文件（推荐）",
                              "Restore backed-up original tool folders before resetting (Recommended)",
                            )}
                          </label>
                        </div>
                        {!subModal.restoreOriginals && (
                          <div className="flex items-start gap-2.5">
                            <Checkbox
                              checked={subModal.deleteOriginals}
                              className="mt-0.5"
                              disabled={subBusy}
                              id="reset-delete-originals"
                              onCheckedChange={(checked) => {
                                const next = Boolean(checked);
                                setSubModal((prev) =>
                                  prev?.type === "replacement" ? { ...prev, deleteOriginals: next } : prev,
                                );
                              }}
                            />
                            <div className="flex flex-col gap-0.5">
                              <label
                                className="cursor-pointer leading-relaxed text-foreground"
                                htmlFor="reset-delete-originals"
                              >
                                {tr("同时永久删除这些原文件备份", "Also permanently delete these original backups")}
                              </label>
                              <span className="text-muted-foreground">
                                {tr(
                                  "不勾选则会保留备份记录，重置后仍可在「数据管理」中还原或删除。",
                                  "Leave unchecked to keep them so you can still restore or delete them later in Library data.",
                                )}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {subModal.action === "import" && (
                      <>
                        <p className="text-xs">
                          {tr("备份内容", "Backup contents")} ·{" "}
                          {formatCounts(subModal.preview.incoming)}
                        </p>
                        <p className="text-xs">
                          {tr("备份偏好", "Backup preferences")} ·{" "}
                          {LANGUAGES.find(([l]) => l === subModal.preview!.preferences.language)?.[1]}{" "}
                          · {themeLabel(subModal.preview.preferences.theme)}
                        </p>
                      </>
                    )}
                    {subModal.preview.linksRemoved.length > 0 && (
                      <div className="rounded-lg border bg-muted/40 p-2.5 text-xs">
                        <strong className="font-medium">
                          {tr("移除的受管链接", "Managed links to remove")} ·{" "}
                          {subModal.preview.linksRemoved.length}
                        </strong>
                        <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto font-mono text-[11px] text-muted-foreground">
                          {subModal.preview.linksRemoved.map((p) => (
                            <li key={p} className="break-all">
                              {p}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {subModal.preview.linksCreated.length > 0 && (
                      <div className="rounded-lg border bg-muted/40 p-2.5 text-xs">
                        <strong className="font-medium">
                          {tr("新建的受管链接", "Managed links to create")} ·{" "}
                          {subModal.preview.linksCreated.length}
                        </strong>
                        <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto font-mono text-[11px] text-muted-foreground">
                          {subModal.preview.linksCreated.map((p) => (
                            <li key={p} className="break-all">
                              {p}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {subError && (
                      <p className="text-destructive-foreground text-xs" role="alert">
                        {subError}
                      </p>
                    )}
                  </div>
                ) : null}
              </DialogPanel>
              <DialogFooter>
                <Button disabled={subBusy} variant="outline" onClick={() => setSubModal(null)}>
                  {tr("取消", "Cancel")}
                </Button>
                {subModal.error && (
                  <Button variant="outline" onClick={() => void startReplacement(subModal.action)}>
                    {subModal.action === "import"
                      ? tr("重新选择", "Choose another file")
                      : tr("重试", "Retry")}
                  </Button>
                )}
                {subModal.preview && (
                  <Button
                    disabled={subBusy}
                    loading={subBusy}
                    variant={subModal.action === "import" ? "default" : "destructive"}
                    onClick={() => void applyReplacement()}
                  >
                    {subModal.action === "import"
                      ? tr("替换并导入", "Replace and import")
                      : subModal.restoreOriginals && (subModal.preview.originalBackupBatches ?? 0) > 0
                        ? tr("还原原文件并重置", "Restore originals & reset")
                        : tr("确认重置", "Reset library")}
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}
