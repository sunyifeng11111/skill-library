import * as React from "react";
import type { AppNotice, SettingsSection } from "@/app/types";
import {
  classifyAppUpdateError,
  readSkippedAppVersion,
  writeSkippedAppVersion,
  type AppUpdateErrorKind,
  type AppUpdateInfo,
  type AppUpdateRelease,
} from "@/shared/app-updates";
import { tr } from "@/shared/language";
import type { DesktopGateway } from "@/shared/library";
import { errorText } from "@/shared/ui";

export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "unconfigured"
  | "upToDate"
  | "available"
  | "downloading"
  | "readyToInstall"
  | "installing"
  | "error";

export interface AppUpdateProgress {
  downloadedBytes: number;
  contentLength: number | null;
}

export interface AppUpdatesState {
  currentVersion: string | null;
  configured: boolean;
  releasesUrl: string | null;
  phase: AppUpdatePhase;
  availableRelease: AppUpdateRelease | null;
  downloadedVersion: string | null;
  downloadProgress: AppUpdateProgress | null;
  lastCheckedAt: Date | null;
  error: string | null;
  errorKind: AppUpdateErrorKind | null;
  skippedVersion: string | null;
  isSkippedAvailable: boolean;
  hasBadge: boolean;
  installBlockedReason: string | null;
  check: (options?: { silent?: boolean }) => Promise<void>;
  download: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  installAndRelaunch: () => Promise<void>;
  skipAvailable: () => void;
  clearSkipped: () => void;
  openReleasePage: () => Promise<void>;
}

export function useAppUpdates({
  desktop,
  mountedRef,
  notify,
  openSettings,
  preferences,
  updatesActivity,
  settingsMutationBusy,
  dialogBusy,
}: {
  desktop: DesktopGateway;
  mountedRef: React.RefObject<boolean>;
  notify: (notice: AppNotice) => void;
  openSettings: (section?: SettingsSection) => void;
  preferences: { language: string };
  updatesActivity: "check" | "batch" | "package" | undefined;
  settingsMutationBusy: boolean;
  dialogBusy: boolean;
}): { appUpdates: AppUpdatesState; applyAppInfo: (info: AppUpdateInfo) => void } {
  const [appCurrentVersion, setAppCurrentVersion] = React.useState<string | null>(null);
  const [appUpdateConfigured, setAppUpdateConfigured] = React.useState(false);
  const [appReleasesUrl, setAppReleasesUrl] = React.useState<string | null>(null);
  const [appUpdatePhase, setAppUpdatePhase] = React.useState<AppUpdatePhase>("idle");
  const [appAvailableRelease, setAppAvailableRelease] =
    React.useState<AppUpdateRelease | null>(null);
  const [appDownloadedVersion, setAppDownloadedVersion] = React.useState<string | null>(null);
  const [appDownloadProgress, setAppDownloadProgress] =
    React.useState<AppUpdateProgress | null>(null);
  const [appLastCheckedAt, setAppLastCheckedAt] = React.useState<Date | null>(null);
  const [appUpdateError, setAppUpdateError] = React.useState<string | null>(null);
  const [appUpdateErrorKind, setAppUpdateErrorKind] =
    React.useState<AppUpdateErrorKind | null>(null);
  const [skippedAppVersion, setSkippedAppVersion] = React.useState<string | null>(
    readSkippedAppVersion,
  );

  const appUpdateBusyRef = React.useRef(false);
  const appUpdateCancelledRef = React.useRef(false);
  const appUpdatePhaseRef = React.useRef<AppUpdatePhase>("idle");
  appUpdatePhaseRef.current = appUpdatePhase;
  const appDownloadedVersionRef = React.useRef<string | null>(null);
  appDownloadedVersionRef.current = appDownloadedVersion;
  const skippedAppVersionRef = React.useRef<string | null>(null);
  skippedAppVersionRef.current = skippedAppVersion;
  const notifiedAppVersionRef = React.useRef<string | null>(null);

  const checkAppUpdate = React.useCallback(
    async (options?: { silent?: boolean }) => {
      const gateway = desktop.appUpdates;
      if (!gateway || appUpdateBusyRef.current) return;
      if (
        appUpdatePhaseRef.current === "downloading" ||
        appUpdatePhaseRef.current === "installing"
      ) {
        return;
      }

      const silent = Boolean(options?.silent);
      appUpdateBusyRef.current = true;
      if (!silent) {
        setAppUpdatePhase("checking");
        setAppUpdateError(null);
        setAppUpdateErrorKind(null);
      }

      try {
        const result = await gateway.check();
        if (!mountedRef.current) return;
        setAppCurrentVersion(result.currentVersion);
        setAppLastCheckedAt(new Date());

        if (result.status === "unconfigured") {
          setAppUpdateConfigured(false);
          setAppReleasesUrl(result.releasesUrl);
          setAppAvailableRelease(null);
          setAppDownloadedVersion(null);
          setAppDownloadProgress(null);
          setAppUpdatePhase(silent ? "idle" : "unconfigured");
          return;
        }

        if (result.status === "upToDate") {
          setAppUpdateConfigured(true);
          setAppReleasesUrl(result.releasesUrl);
          setAppAvailableRelease(null);
          setAppDownloadedVersion(null);
          setAppDownloadProgress(null);
          setAppUpdatePhase(silent ? "idle" : "upToDate");
          return;
        }

        setAppUpdateConfigured(true);
        if (result.release.releasesUrl) {
          setAppReleasesUrl(result.release.releasesUrl);
        }
        setAppAvailableRelease(result.release);
        const alreadyDownloaded = appDownloadedVersionRef.current === result.release.version;
        if (!alreadyDownloaded) {
          setAppDownloadedVersion(null);
          setAppDownloadProgress(null);
        }
        setAppUpdatePhase(alreadyDownloaded ? "readyToInstall" : "available");

        if (
          silent &&
          result.release.version !== skippedAppVersionRef.current &&
          notifiedAppVersionRef.current !== result.release.version
        ) {
          notifiedAppVersionRef.current = result.release.version;
          notify({
            text: tr(
              `发现 Skill Library v${result.release.version}`,
              `Skill Library v${result.release.version} is available`,
            ),
            action: {
              label: tr("查看更新", "View update"),
              run: () => openSettings("about"),
            },
          });
        }
      } catch (error) {
        if (!mountedRef.current) return;
        if (!silent) {
          const classified = classifyAppUpdateError(error);
          setAppUpdateError(classified.message);
          setAppUpdateErrorKind(classified.kind);
          setAppUpdatePhase("error");
        }
      } finally {
        appUpdateBusyRef.current = false;
      }
    },
    [desktop, notify, openSettings],
  );

  const downloadAppUpdate = React.useCallback(async () => {
    const gateway = desktop.appUpdates;
    const release = appAvailableRelease;
    if (!gateway || !release || appUpdateBusyRef.current) return;

    appUpdateBusyRef.current = true;
    appUpdateCancelledRef.current = false;
    setAppUpdateError(null);
    setAppUpdateErrorKind(null);
    setAppDownloadProgress({ downloadedBytes: 0, contentLength: null });
    setAppUpdatePhase("downloading");

    if (skippedAppVersionRef.current === release.version) {
      writeSkippedAppVersion(null);
      setSkippedAppVersion(null);
    }

    try {
      await gateway.download(release.version, (event) => {
        if (!mountedRef.current || appUpdateCancelledRef.current) return;
        if (event.event === "started") {
          setAppDownloadProgress({
            downloadedBytes: 0,
            contentLength: event.contentLength,
          });
        } else if (event.event === "progress" || event.event === "finished") {
          setAppDownloadProgress({
            downloadedBytes: event.downloadedBytes,
            contentLength: event.contentLength,
          });
        }
      });
      if (!mountedRef.current || appUpdateCancelledRef.current) return;
      setAppDownloadedVersion(release.version);
      setAppUpdatePhase("readyToInstall");
    } catch (error) {
      if (!mountedRef.current) return;
      const classified = classifyAppUpdateError(error);
      if (appUpdateCancelledRef.current || classified.kind === "cancelled") {
        setAppDownloadProgress(null);
        setAppUpdateError(null);
        setAppUpdateErrorKind(null);
        setAppUpdatePhase("available");
      } else {
        setAppUpdateError(classified.message);
        setAppUpdateErrorKind(classified.kind);
        setAppUpdatePhase("error");
      }
    } finally {
      appUpdateBusyRef.current = false;
    }
  }, [desktop, appAvailableRelease]);

  const cancelAppUpdateDownload = React.useCallback(async () => {
    const gateway = desktop.appUpdates;
    if (!gateway || appUpdatePhaseRef.current !== "downloading") return;
    appUpdateCancelledRef.current = true;
    setAppDownloadProgress(null);
    setAppUpdateError(null);
    setAppUpdateErrorKind(null);
    setAppUpdatePhase("available");
    try {
      await gateway.cancelDownload();
    } catch {
      // Cancellation already restored UI state.
    }
  }, [desktop]);

  const installBlockedReason = React.useMemo(() => {
    void preferences.language;
    if (updatesActivity === "batch" || updatesActivity === "package") {
      return tr(
        "正在更新 Skill，请等待当前更新完成后再重启安装应用。",
        "A Skill update is in progress. Finish it before restarting to install the app update.",
      );
    }
    if (settingsMutationBusy || dialogBusy) {
      return tr(
        "当前有数据操作正在进行，请等待完成后再重启安装应用。",
        "A library operation is in progress. Finish it before restarting to install the app update.",
      );
    }
    return null;
  }, [preferences.language, updatesActivity, settingsMutationBusy, dialogBusy]);

  const installAppUpdateAndRelaunch = React.useCallback(async () => {
    const gateway = desktop.appUpdates;
    const release = appAvailableRelease;
    if (
      !gateway ||
      !release ||
      appDownloadedVersion !== release.version ||
      installBlockedReason ||
      appUpdateBusyRef.current
    ) {
      return;
    }

    appUpdateBusyRef.current = true;
    setAppUpdateError(null);
    setAppUpdateErrorKind(null);
    setAppUpdatePhase("installing");

    try {
      await gateway.installAndRelaunch(release.version);
    } catch (error) {
      if (!mountedRef.current) return;
      const classified = classifyAppUpdateError(error);
      setAppUpdateError(classified.message);
      setAppUpdateErrorKind(classified.kind);
      setAppUpdatePhase("error");
    } finally {
      appUpdateBusyRef.current = false;
    }
  }, [desktop, appAvailableRelease, appDownloadedVersion, installBlockedReason]);

  const skipAvailableAppUpdate = React.useCallback(() => {
    if (!appAvailableRelease) return;
    writeSkippedAppVersion(appAvailableRelease.version);
    setSkippedAppVersion(appAvailableRelease.version);
  }, [appAvailableRelease]);

  const clearSkippedAppUpdate = React.useCallback(() => {
    writeSkippedAppVersion(null);
    setSkippedAppVersion(null);
  }, []);

  const openAppReleasePage = React.useCallback(async () => {
    const gateway = desktop.appUpdates;
    const url = appAvailableRelease?.releasesUrl ?? appReleasesUrl;
    if (!gateway || !url) return;
    try {
      await gateway.openReleasePage(url);
    } catch (error) {
      if (mountedRef.current) {
        notify({ text: errorText(error), error: true });
      }
    }
  }, [desktop, appAvailableRelease, appReleasesUrl, notify]);

  const isSkippedAvailable = Boolean(
    appAvailableRelease && skippedAppVersion === appAvailableRelease.version,
  );

  const hasAppUpdateBadge = Boolean(
    appAvailableRelease &&
      (appUpdatePhase === "available" ||
        appUpdatePhase === "downloading" ||
        appUpdatePhase === "readyToInstall" ||
        appUpdatePhase === "installing" ||
        appUpdatePhase === "error") &&
      appAvailableRelease.version !== skippedAppVersion,
  );

  const appUpdates = React.useMemo<AppUpdatesState>(
    () => ({
      currentVersion: appCurrentVersion,
      configured: appUpdateConfigured,
      releasesUrl: appReleasesUrl,
      phase: appUpdatePhase,
      availableRelease: appAvailableRelease,
      downloadedVersion: appDownloadedVersion,
      downloadProgress: appDownloadProgress,
      lastCheckedAt: appLastCheckedAt,
      error: appUpdateError,
      errorKind: appUpdateErrorKind,
      skippedVersion: skippedAppVersion,
      isSkippedAvailable,
      hasBadge: hasAppUpdateBadge,
      installBlockedReason,
      check: checkAppUpdate,
      download: downloadAppUpdate,
      cancelDownload: cancelAppUpdateDownload,
      installAndRelaunch: installAppUpdateAndRelaunch,
      skipAvailable: skipAvailableAppUpdate,
      clearSkipped: clearSkippedAppUpdate,
      openReleasePage: openAppReleasePage,
    }),
    [
      appCurrentVersion,
      appUpdateConfigured,
      appReleasesUrl,
      appUpdatePhase,
      appAvailableRelease,
      appDownloadedVersion,
      appDownloadProgress,
      appLastCheckedAt,
      appUpdateError,
      appUpdateErrorKind,
      skippedAppVersion,
      isSkippedAvailable,
      hasAppUpdateBadge,
      installBlockedReason,
      checkAppUpdate,
      downloadAppUpdate,
      cancelAppUpdateDownload,
      installAppUpdateAndRelaunch,
      skipAvailableAppUpdate,
      clearSkippedAppUpdate,
      openAppReleasePage,
    ],
  );

  const applyAppInfo = React.useCallback((info: AppUpdateInfo) => {
    setAppCurrentVersion(info.currentVersion);
    setAppUpdateConfigured(info.configured);
    setAppReleasesUrl(info.releasesUrl);
  }, []);

  return { appUpdates, applyAppInfo };
}
