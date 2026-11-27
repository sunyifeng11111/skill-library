// @vitest-environment happy-dom

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp } from "../src/app";
import type { Preferences, SettingsGateway } from "../src/features/settings/gateway";
import {
  SKIPPED_APP_VERSION_STORAGE_KEY,
  type AppUpdateDownloadProgress,
  type AppUpdateGateway,
} from "../src/shared/app-updates";
import type { DesktopGateway, LibrarySnapshot } from "../src/shared/library";
import type { UpdateGateway } from "../src/shared/updates";

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
  document.documentElement.lang = "zh-CN";
  delete document.documentElement.dataset.colorScheme;
  document.documentElement.classList.remove("dark");
  window.localStorage.clear();
});

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeGateway(overrides?: {
  preferences?: Preferences;
  appUpdates?: Partial<AppUpdateGateway>;
  updates?: Partial<UpdateGateway>;
  snapshot?: LibrarySnapshot;
}) {
  let savedPrefs: Preferences = overrides?.preferences ?? {
    language: "zh-CN",
    theme: "light",
    backupRetention: "30d",
    autoCheckAppUpdates: true,
  };
  const snapshot: LibrarySnapshot = overrides?.snapshot ?? {
    managedDirectory: "/Users/dev/.skill-library/skills",
    categories: [],
    skills: [],
  };

  const setPreferences = vi.fn().mockImplementation(async (next: Preferences) => {
    savedPrefs = next;
    return savedPrefs;
  });

  const settings: SettingsGateway = {
    preferences: vi.fn().mockImplementation(async () => savedPrefs),
    setPreferences,
    chooseManagedDirectory: vi.fn().mockResolvedValue(null),
    changeManagedDirectory: vi.fn(),
    chooseBackup: vi.fn().mockResolvedValue(null),
    chooseExport: vi.fn().mockResolvedValue(null),
    exportBackup: vi.fn(),
    previewBackup: vi.fn(),
    restoreBackup: vi.fn(),
    previewDefaults: vi.fn(),
    restoreDefaults: vi.fn(),
    listOriginalBackups: vi.fn().mockResolvedValue([]),
    restoreOriginalBackup: vi.fn(),
    deleteOriginalBackup: vi.fn(),
  };

  const appUpdates: AppUpdateGateway = {
    info: vi.fn().mockResolvedValue({
      currentVersion: "0.1.0",
      configured: true,
      releasesUrl: "https://github.com/acme/skill-library/releases",
    }),
    check: vi.fn().mockResolvedValue({
      status: "upToDate",
      currentVersion: "0.1.0",
      releasesUrl: "https://github.com/acme/skill-library/releases",
    }),
    download: vi.fn().mockResolvedValue(undefined),
    cancelDownload: vi.fn().mockResolvedValue(undefined),
    installAndRelaunch: vi.fn().mockResolvedValue(undefined),
    openReleasePage: vi.fn().mockResolvedValue(undefined),
    ...overrides?.appUpdates,
  };

  const updates: UpdateGateway | undefined = overrides?.updates
    ? {
        check: vi.fn().mockResolvedValue([]),
        checkOne: vi.fn(),
        preview: vi.fn(),
        apply: vi.fn(),
        attach: vi.fn(),
        ...overrides.updates,
      }
    : undefined;

  const desktop: DesktopGateway = {
    chooseFolders: vi.fn().mockResolvedValue([]),
    onFolderDrag: vi.fn().mockResolvedValue(() => {}),
    settings,
    appUpdates,
    updates,
    library: {
      snapshot: vi.fn().mockResolvedValue(snapshot),
      previewFolders: vi.fn().mockResolvedValue([]),
      commitImport: vi.fn(),
      managedPath: vi.fn(),
      createCategory: vi.fn(),
      renameCategory: vi.fn(),
      deleteCategory: vi.fn(),
      reorderCategories: vi.fn(),
      moveSkills: vi.fn(),
      undoMove: vi.fn(),
    },
  };

  return { desktop, appUpdates, setPreferences };
}

describe("app online updates (Tauri + GitHub Releases)", () => {
  it("silently checks on launch, shows Settings dot & toast, and jumps to About & updates", async () => {
    const { desktop, appUpdates } = makeGateway({
      appUpdates: {
        check: vi.fn().mockResolvedValue({
          status: "available",
          currentVersion: "0.1.0",
          release: {
            version: "0.2.0",
            publishedAt: "2026-11-24",
            notes: "- 支持应用内在线更新\n- 修复若干问题",
            releasesUrl: "https://github.com/acme/skill-library/releases",
          },
        }),
      },
    });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, desktop);

    await waitFor(() => expect(appUpdates.check).toHaveBeenCalledTimes(1));

    const settingsBtn = screen.getByRole("button", { name: /设置/ });
    expect(settingsBtn.querySelector("[data-app-update-dot]")).toBeTruthy();

    const toastAction = await screen.findByRole("button", { name: "查看更新" });
    expect(screen.getByText("发现 Skill Library v0.2.0")).toBeTruthy();

    fireEvent.click(toastAction);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("发现新版本 v0.2.0")).toBeTruthy();
    expect(within(dialog).getByText(/支持应用内在线更新/)).toBeTruthy();
  });

  it("respects autoCheckAppUpdates=false on launch and stays silent on unconfigured or failed startup checks", async () => {
    const disabled = makeGateway({
      preferences: {
        language: "zh-CN",
        theme: "light",
        backupRetention: "30d",
        autoCheckAppUpdates: false,
      },
    });
    const root1 = document.createElement("div");
    document.body.append(root1);
    stop = await startApp(root1, disabled.desktop);
    await waitFor(() => expect(disabled.appUpdates.info).toHaveBeenCalledTimes(1));
    expect(disabled.appUpdates.check).not.toHaveBeenCalled();
    stop();
    stop = undefined;
    document.body.innerHTML = "";

    const failing = makeGateway({
      appUpdates: {
        check: vi.fn().mockRejectedValue(new Error("network timeout")),
      },
    });
    const root2 = document.createElement("div");
    document.body.append(root2);
    stop = await startApp(root2, failing.desktop);
    await waitFor(() => expect(failing.appUpdates.check).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "查看更新" })).toBeNull();
    expect(document.querySelector("[data-app-update-dot]")).toBeNull();
  });

  it("skips a version for silent reminders while still showing it on manual check", async () => {
    const release = {
      version: "0.2.0",
      publishedAt: "2026-11-24",
      notes: "Release 0.2.0",
      releasesUrl: "https://github.com/acme/skill-library/releases",
    };
    const first = makeGateway({
      appUpdates: {
        check: vi.fn().mockResolvedValue({
          status: "available",
          currentVersion: "0.1.0",
          release,
        }),
      },
    });

    const root1 = document.createElement("div");
    document.body.append(root1);
    stop = await startApp(root1, first.desktop);

    fireEvent.click(await screen.findByRole("button", { name: "查看更新" }));
    const dialog1 = await screen.findByRole("dialog");
    fireEvent.click(within(dialog1).getByRole("button", { name: "跳过此版本" }));

    expect(window.localStorage.getItem(SKIPPED_APP_VERSION_STORAGE_KEY)).toBe("0.2.0");
    expect(await within(dialog1).findByText("已跳过自动提醒")).toBeTruthy();
    fireEvent.click(within(dialog1).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "设置" }).querySelector("[data-app-update-dot]")).toBeNull();

    stop();
    stop = undefined;
    document.body.innerHTML = "";

    // Re-launch: silent startup check must NOT toast or show badge for skipped 0.2.0
    const second = makeGateway({
      appUpdates: {
        check: vi.fn().mockResolvedValue({
          status: "available",
          currentVersion: "0.1.0",
          release,
        }),
      },
    });
    const root2 = document.createElement("div");
    document.body.append(root2);
    stop = await startApp(root2, second.desktop);
    await waitFor(() => expect(second.appUpdates.check).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "查看更新" })).toBeNull();
    expect(document.querySelector("[data-app-update-dot]")).toBeNull();

    // Manual check still honestly presents 0.2.0 and allows downloading
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const dialog2 = await screen.findByRole("dialog");
    fireEvent.click(within(dialog2).getByRole("button", { name: "关于与更新" }));
    fireEvent.click(within(dialog2).getByRole("button", { name: "检查更新" }));
    expect(await within(dialog2).findByText("发现新版本 v0.2.0")).toBeTruthy();
    expect(within(dialog2).getByText("已跳过自动提醒")).toBeTruthy();
    expect(within(dialog2).getByRole("button", { name: "下载更新" })).toBeTruthy();
  });

  it("supports two-stage download with known/unknown progress, cancellation, and restart install", async () => {
    const firstDownload = createDeferred<void>();
    const secondDownload = createDeferred<void>();
    let firstProgressCb: ((ev: AppUpdateDownloadProgress) => void) | undefined;
    let secondProgressCb: ((ev: AppUpdateDownloadProgress) => void) | undefined;
    let attempt = 0;

    const download = vi
      .fn()
      .mockImplementation((_version: string, onProgress: (ev: AppUpdateDownloadProgress) => void) => {
        attempt += 1;
        if (attempt === 1) {
          firstProgressCb = onProgress;
          return firstDownload.promise;
        }
        secondProgressCb = onProgress;
        return secondDownload.promise;
      });

    const { desktop, appUpdates } = makeGateway({
      appUpdates: {
        check: vi.fn().mockResolvedValue({
          status: "available",
          currentVersion: "0.1.0",
          release: {
            version: "0.2.0",
            publishedAt: "2026-11-24",
            notes: "Update notes",
            releasesUrl: "https://github.com/acme/skill-library/releases",
          },
        }),
        download,
      },
    });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, desktop);

    fireEvent.click(await screen.findByRole("button", { name: "查看更新" }));
    const dialog = await screen.findByRole("dialog");

    // Attempt 1: unknown contentLength + cancel
    fireEvent.click(within(dialog).getByRole("button", { name: "下载更新" }));
    await waitFor(() => expect(firstProgressCb).toBeDefined());
    firstProgressCb!({ event: "started", contentLength: null });
    firstProgressCb!({
      event: "progress",
      downloadedBytes: 2 * 1024 * 1024,
      contentLength: null,
    });
    expect(await within(dialog).findByText("2.0 MB")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "取消下载" }));
    expect(appUpdates.cancelDownload).toHaveBeenCalledTimes(1);
    firstDownload.reject(new Error("DOWNLOAD_CANCELLED"));
    expect(await within(dialog).findByRole("button", { name: "下载更新" })).toBeTruthy();

    // Attempt 2: known contentLength -> complete -> install & relaunch
    fireEvent.click(within(dialog).getByRole("button", { name: "下载更新" }));
    await waitFor(() => expect(secondProgressCb).toBeDefined());
    secondProgressCb!({ event: "started", contentLength: 10 * 1024 * 1024 });
    secondProgressCb!({
      event: "progress",
      downloadedBytes: 5 * 1024 * 1024,
      contentLength: 10 * 1024 * 1024,
    });
    expect(await within(dialog).findByText(/50% · 5\.0 MB \/ 10\.0 MB/)).toBeTruthy();
    const progressBar = within(dialog).getByRole("progressbar", { name: "更新下载进度" });
    expect(progressBar.getAttribute("aria-valuenow")).toBe("50");

    secondProgressCb!({
      event: "finished",
      downloadedBytes: 10 * 1024 * 1024,
      contentLength: 10 * 1024 * 1024,
    });
    secondDownload.resolve();

    const installBtn = await within(dialog).findByRole("button", { name: "立即重启并安装" });
    fireEvent.click(installBtn);
    await waitFor(() => expect(appUpdates.installAndRelaunch).toHaveBeenCalledWith("0.2.0"));
  });

  it("blocks restart-and-install while a Skill update is actively applying", async () => {
    const skillUpdateDeferred = createDeferred<{
      library: LibrarySnapshot;
      updated: string[];
      skipped: { id: string; name: string; skipReason: string | null }[];
      added: string[];
      backup: string | null;
    }>();
    const snapshot: LibrarySnapshot = {
      managedDirectory: "/Users/dev/.skill-library/skills",
      categories: [],
      skills: [
        {
          id: "sk-1",
          name: "alpha",
          description: "Alpha skill",
          folderName: "alpha",
          fingerprint: "f".repeat(64),
          categoryId: null,
          source: {
            repository: "https://github.com/acme/skills.git",
            memberPath: "alpha",
            revision: "1".repeat(40),
          },
        },
      ],
    };

    const { desktop } = makeGateway({
      snapshot,
      updates: {
        check: vi.fn().mockResolvedValue([
          {
            package: { repository: "https://github.com/acme/skills.git", reference: null },
            memberIds: ["sk-1"],
            status: "available",
            revision: "2".repeat(40),
            error: null,
          },
        ]),
        apply: vi.fn().mockReturnValue(skillUpdateDeferred.promise),
      },
      appUpdates: {
        check: vi.fn().mockResolvedValue({
          status: "available",
          currentVersion: "0.1.0",
          release: {
            version: "0.2.0",
            publishedAt: "2026-11-24",
            notes: "Notes",
            releasesUrl: "https://github.com/acme/skill-library/releases",
          },
        }),
      },
    });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, desktop);

    // Download the app update first
    fireEvent.click(await screen.findByRole("button", { name: "查看更新" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "下载更新" }));
    await within(dialog).findByRole("button", { name: "立即重启并安装" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    // Start a Skill package update in Updates center
    fireEvent.click(screen.getByRole("button", { name: /更新中心/ }));
    const updateAllBtn = await screen.findByRole("button", { name: "全部更新" });
    fireEvent.click(updateAllBtn);

    // Re-open Settings -> About & updates while Skill update is applying
    fireEvent.click(screen.getByRole("button", { name: /设置/ }));
    const reopened = await screen.findByRole("dialog");
    fireEvent.click(within(reopened).getByRole("button", { name: "关于与更新" }));

    const blockedBtn = within(reopened).getByRole("button", { name: "立即重启并安装" });
    expect((blockedBtn as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(reopened).getByText("正在更新 Skill，请等待当前更新完成后再重启安装应用。"),
    ).toBeTruthy();

    skillUpdateDeferred.resolve({
      library: snapshot,
      updated: ["alpha"],
      skipped: [],
      added: [],
      backup: null,
    });
    await waitFor(() =>
      expect(
        (within(reopened).getByRole("button", { name: "立即重启并安装" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  it("shows unconfigured guidance, read-only volume recovery, manual GitHub Releases fallback, and preference switch", async () => {
    const { desktop, appUpdates, setPreferences } = makeGateway({
      preferences: {
        language: "zh-CN",
        theme: "light",
        backupRetention: "30d",
        autoCheckAppUpdates: false,
      },
      appUpdates: {
        info: vi.fn().mockResolvedValue({
          currentVersion: "0.1.0",
          configured: false,
          releasesUrl: null,
        }),
        check: vi
          .fn()
          .mockResolvedValueOnce({
            status: "unconfigured",
            currentVersion: "0.1.0",
            releasesUrl: null,
          })
          .mockResolvedValueOnce({
            status: "available",
            currentVersion: "0.1.0",
            release: {
              version: "0.2.0",
              publishedAt: "2026-11-24",
              notes: "Notes",
              releasesUrl: "https://github.com/acme/skill-library/releases",
            },
          }),
        installAndRelaunch: vi
          .fn()
          .mockRejectedValue(
            new Error(
              "READONLY_VOLUME: 无法替换当前应用目录（可能正从只读磁盘映像 .dmg 中运行，或缺少写入权限）。",
            ),
          ),
      },
    });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, desktop);

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "关于与更新" }));

    // Toggle auto-check switch
    const toggle = within(dialog).getByRole("switch", { name: "启动时自动检查更新" });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(setPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ autoCheckAppUpdates: true }),
      ),
    );

    // 1. Unconfigured placeholder state
    fireEvent.click(within(dialog).getByRole("button", { name: "检查更新" }));
    expect(await within(dialog).findByText("尚未配置发布源")).toBeTruthy();

    // 2. Real endpoint available -> download -> read-only DMG install error -> manual Releases fallback
    fireEvent.click(within(dialog).getByRole("button", { name: "检查更新" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "下载更新" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "立即重启并安装" }));

    expect(await within(dialog).findByText("无法覆盖当前应用目录")).toBeTruthy();
    expect(within(dialog).getByText(/只读磁盘映像 \.dmg/)).toBeTruthy();
    const manualBtn = within(dialog).getByRole("button", {
      name: "前往 GitHub Releases 手动下载",
    });
    fireEvent.click(manualBtn);
    await waitFor(() =>
      expect(appUpdates.openReleasePage).toHaveBeenCalledWith(
        "https://github.com/acme/skill-library/releases",
      ),
    );
  });

  it("shows the update indicator dot on the collapsed toolbar Settings shortcut", async () => {
    const { desktop } = makeGateway({
      appUpdates: {
        check: vi.fn().mockResolvedValue({
          status: "available",
          currentVersion: "0.1.0",
          release: {
            version: "0.2.0",
            publishedAt: null,
            notes: null,
            releasesUrl: "https://github.com/acme/skill-library/releases",
          },
        }),
      },
    });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, desktop);

    await screen.findByRole("button", { name: "查看更新" });
    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));

    const toolbarSettingsBtn = screen.getByRole("button", {
      name: "设置（有可用的应用更新）",
    });
    expect(toolbarSettingsBtn.querySelector("[data-app-update-dot]")).toBeTruthy();
  });
});
