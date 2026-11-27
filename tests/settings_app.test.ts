// @vitest-environment happy-dom

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp } from "../src/app";
import type {
  OriginalBackupSummary,
  Preferences,
  ReplacementPreview,
  SettingsGateway,
} from "../src/features/settings/gateway";
import type { DesktopGateway, LibrarySnapshot } from "../src/shared/library";

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
  document.documentElement.lang = "zh-CN";
  delete document.documentElement.dataset.colorScheme;
  document.documentElement.classList.remove("dark");
});

describe("settings dialog (React + coss ui)", () => {
  it("switches appearance theme and updates managed directory after confirmation", async () => {
    let savedPrefs: Preferences = { language: "zh-CN", theme: "light", backupRetention: "30d" };
    const initial: LibrarySnapshot = {
      managedDirectory: "/Users/dev/.skills-library",
      categories: [],
      skills: [],
    };

    const setPreferences = vi.fn().mockImplementation(async (next: Preferences) => {
      savedPrefs = next;
      return savedPrefs;
    });
    const changeManagedDirectory = vi.fn().mockResolvedValue({
      ...initial,
      managedDirectory: "/Users/dev/Documents/Skills",
    });

    const settings: SettingsGateway = {
      preferences: vi.fn().mockImplementation(async () => savedPrefs),
      setPreferences,
      chooseManagedDirectory: vi.fn().mockResolvedValue("/Users/dev/Documents/Skills"),
      changeManagedDirectory,
      chooseBackup: vi.fn().mockResolvedValue(null),
      chooseExport: vi.fn().mockResolvedValue("/tmp/backup.json"),
      exportBackup: vi.fn().mockResolvedValue(undefined),
      previewBackup: vi.fn(),
      restoreBackup: vi.fn(),
      previewDefaults: vi.fn(),
      restoreDefaults: vi.fn(),
      listOriginalBackups: vi.fn().mockResolvedValue([]),
      restoreOriginalBackup: vi.fn(),
      deleteOriginalBackup: vi.fn(),
    };

    const setWindowTheme = vi.fn().mockResolvedValue(undefined);
    const desktop: DesktopGateway = {
      chooseFolders: vi.fn().mockResolvedValue([]),
      onFolderDrag: vi.fn().mockResolvedValue(() => {}),
      setWindowTheme,
      settings,
      library: {
        snapshot: vi.fn().mockResolvedValue(initial),
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

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, desktop);

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const dialog = await screen.findByRole("dialog");

    // Switch theme to dark
    fireEvent.click(within(dialog).getByRole("button", { name: "深色" }));
    await waitFor(() => expect(setPreferences).toHaveBeenCalledWith({ ...savedPrefs, theme: "dark" }));
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    // Switch to Library data and change managed directory
    fireEvent.click(within(dialog).getByRole("button", { name: "数据管理" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "更改目录…" }));

    const confirmBtn = await screen.findByRole("button", { name: "确认迁移" });
    fireEvent.click(confirmBtn);
    await waitFor(() =>
      expect(changeManagedDirectory).toHaveBeenCalledWith("/Users/dev/Documents/Skills"),
    );
    expect(await screen.findByText("已更新 Skill 库目录。")).toBeTruthy();
  });

  it("renders many original backups inside a scrollable list with search and sort to reach old items", async () => {
    const savedPrefs: Preferences = { language: "zh-CN", theme: "system", backupRetention: "30d" };
    const backups: OriginalBackupSummary[] = Array.from({ length: 25 }, (_, idx) => {
      const n = idx + 1;
      return {
        id: `bak-${n}`,
        createdAt: 1700000000 + n * 3600,
        summary: `Claude Code 收进 Skill 库 #${n}`,
        sizeBytes: 1024 * n,
        itemNames: [n === 1 ? "oldest-helper" : `skill-${n}`],
        itemCount: 1,
      };
    });
    const restoreOriginalBackup = vi.fn().mockResolvedValue({
      categories: [],
      skills: [],
      originalBackupCount: 24,
    });
    const deleteOriginalBackup = vi.fn().mockResolvedValue(backups.slice(1));
    const settings: SettingsGateway = {
      preferences: vi.fn().mockResolvedValue(savedPrefs),
      setPreferences: vi.fn().mockResolvedValue(savedPrefs),
      chooseManagedDirectory: vi.fn().mockResolvedValue(null),
      changeManagedDirectory: vi.fn(),
      chooseBackup: vi.fn().mockResolvedValue(null),
      chooseExport: vi.fn().mockResolvedValue(null),
      exportBackup: vi.fn(),
      previewBackup: vi.fn(),
      restoreBackup: vi.fn(),
      previewDefaults: vi.fn(),
      restoreDefaults: vi.fn(),
      listOriginalBackups: vi.fn().mockResolvedValue(backups),
      restoreOriginalBackup,
      deleteOriginalBackup,
    };
    const desktop: DesktopGateway = {
      chooseFolders: vi.fn().mockResolvedValue([]),
      onFolderDrag: vi.fn().mockResolvedValue(() => {}),
      settings,
      library: {
        snapshot: vi.fn().mockResolvedValue({ categories: [], skills: [] }),
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

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, desktop);

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).queryByRole("button", { name: "原文件备份" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "数据管理" }));

    // Overview shows summary and drills into backups subview
    expect(await within(dialog).findByText("共 25 条 · 30 天自动清理")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /接管前原文件备份/ }));
    expect(await within(dialog).findByText("共 25 条备份")).toBeTruthy();

    // Backup list renders inside a ScrollArea viewport in the definite-height flex layout
    const viewport = dialog.querySelector('[data-slot="scroll-area-viewport"]');
    expect(viewport).toBeTruthy();
    const listContainer = within(viewport as HTMLElement).getByLabelText("原文件备份列表");
    expect(within(listContainer).getByText("Claude Code 收进 Skill 库 #1")).toBeTruthy();

    // Default sort is newest first (#25 first)
    const firstSummaryText = () => listContainer.querySelector("strong")?.textContent;
    expect(firstSummaryText()).toBe("Claude Code 收进 Skill 库 #25");

    // Toggle sort to oldest first (#1 first)
    fireEvent.click(within(dialog).getByRole("button", { name: "切换备份排序" }));
    expect(firstSummaryText()).toBe("Claude Code 收进 Skill 库 #1");
    expect(within(dialog).getByText("最早优先")).toBeTruthy();

    // Search filters by skill name or summary, handles empty results, and clears back
    const searchInput = within(dialog).getByRole("searchbox", { name: "搜索原文件备份" });
    fireEvent.change(searchInput, { target: { value: "不存在的备份" } });
    expect(within(dialog).getByText("匹配 0 / 25 条")).toBeTruthy();
    expect(within(dialog).getByText("没有匹配的原文件备份。")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "清空搜索" }));
    expect(within(dialog).getByText("共 25 条备份")).toBeTruthy();

    fireEvent.change(searchInput, { target: { value: "oldest-helper" } });
    expect(within(dialog).getByText("匹配 1 / 25 条")).toBeTruthy();
    expect(within(dialog).queryByText("Claude Code 收进 Skill 库 #25")).toBeNull();
    expect(within(dialog).getByText("Claude Code 收进 Skill 库 #1")).toBeTruthy();

    // Delete icon button uses accessible aria-label
    fireEvent.click(
      within(dialog).getByRole("button", { name: "删除备份：Claude Code 收进 Skill 库 #1" }),
    );
    await waitFor(() => expect(deleteOriginalBackup).toHaveBeenCalledWith("bak-1"));

    // Restore a backup item
    fireEvent.click(within(dialog).getByRole("button", { name: "清空搜索" }));
    fireEvent.click(within(dialog).getAllByRole("button", { name: "恢复原文件" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "确认恢复" }));
    await waitFor(() => expect(restoreOriginalBackup).toHaveBeenCalled());

    // Breadcrumb returns to Library data overview
    fireEvent.click(within(dialog).getByRole("button", { name: "返回数据管理" }));
    expect(await within(dialog).findByRole("button", { name: "重置 Skill 库…" })).toBeTruthy();
    expect(within(dialog).queryByRole("searchbox", { name: "搜索原文件备份" })).toBeNull();
  });

  it("supports restoreOriginals, keep, and deleteBackups policies when resetting library", async () => {
    const savedPrefs: Preferences = { language: "zh-CN", theme: "system", backupRetention: "30d" };
    const defaultPreview: ReplacementPreview = {
      token: "tok-1",
      current: { skills: 2, categories: 1, agents: 1 },
      incoming: { skills: 0, categories: 0, agents: 0 },
      linksRemoved: ["/Users/dev/.claude/skills/alpha"],
      linksCreated: [],
      preferences: savedPrefs,
      originalBackupBatches: 1,
      originalBackupItems: 2,
    };
    const emptyBackupPreview: ReplacementPreview = {
      ...defaultPreview,
      token: "tok-2",
      originalBackupBatches: 0,
      originalBackupItems: 0,
    };
    const previewDefaults = vi
      .fn()
      .mockResolvedValueOnce(defaultPreview)
      .mockResolvedValueOnce(defaultPreview)
      .mockResolvedValueOnce(defaultPreview)
      .mockResolvedValueOnce(emptyBackupPreview);
    const restoreDefaults = vi.fn().mockResolvedValue({
      library: { categories: [], skills: [], agents: [], assignments: [], originalBackupCount: 0 },
      preferences: savedPrefs,
    });
    const settings: SettingsGateway = {
      preferences: vi.fn().mockResolvedValue(savedPrefs),
      setPreferences: vi.fn().mockResolvedValue(savedPrefs),
      chooseManagedDirectory: vi.fn().mockResolvedValue(null),
      changeManagedDirectory: vi.fn(),
      chooseBackup: vi.fn().mockResolvedValue(null),
      chooseExport: vi.fn().mockResolvedValue(null),
      exportBackup: vi.fn(),
      previewBackup: vi.fn(),
      restoreBackup: vi.fn(),
      previewDefaults,
      restoreDefaults,
      listOriginalBackups: vi.fn().mockResolvedValue([]),
      restoreOriginalBackup: vi.fn(),
      deleteOriginalBackup: vi.fn(),
    };
    const desktop: DesktopGateway = {
      chooseFolders: vi.fn().mockResolvedValue([]),
      onFolderDrag: vi.fn().mockResolvedValue(() => {}),
      settings,
      library: {
        snapshot: vi.fn().mockResolvedValue({ categories: [], skills: [] }),
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

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, desktop);

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "数据管理" }));

    // 1. With original backups: defaults to restoreOriginals
    fireEvent.click(within(dialog).getByRole("button", { name: "重置 Skill 库…" }));
    expect(await screen.findByText("检测到 1 批原文件备份（共 2 项）")).toBeTruthy();
    const restoreCheck = screen.getByRole("checkbox", {
      name: "重置前先还原已备份的工具原文件（推荐）",
    });
    expect(restoreCheck.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "还原原文件并重置" }));
    await waitFor(() => expect(restoreDefaults).toHaveBeenCalledWith(defaultPreview, "restoreOriginals"));
    expect(await within(dialog).findByText("已还原原文件并重置 Skill 库。")).toBeTruthy();

    // 2. Uncheck restoreOriginals without deleteBackups -> keep
    fireEvent.click(within(dialog).getByRole("button", { name: "重置 Skill 库…" }));
    const restoreCheck2 = await screen.findByRole("checkbox", {
      name: "重置前先还原已备份的工具原文件（推荐）",
    });
    fireEvent.click(restoreCheck2);
    expect(restoreCheck2.getAttribute("aria-checked")).toBe("false");
    const deleteCheck = screen.getByRole("checkbox", { name: "同时永久删除这些原文件备份" });
    expect(deleteCheck.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    await waitFor(() => expect(restoreDefaults).toHaveBeenCalledWith(defaultPreview, "keep"));
    expect(await within(dialog).findByText("已重置 Skill 库，原文件备份已保留。")).toBeTruthy();

    // 3. Uncheck restoreOriginals and check deleteBackups -> deleteBackups
    fireEvent.click(within(dialog).getByRole("button", { name: "重置 Skill 库…" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "重置前先还原已备份的工具原文件（推荐）" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "同时永久删除这些原文件备份" }));
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    await waitFor(() => expect(restoreDefaults).toHaveBeenCalledWith(defaultPreview, "deleteBackups"));
    expect(await within(dialog).findByText("已重置 Skill 库并删除原文件备份。")).toBeTruthy();

    // 4. Without original backups: hides backup options and submits keep
    fireEvent.click(within(dialog).getByRole("button", { name: "重置 Skill 库…" }));
    await screen.findByRole("button", { name: "确认重置" });
    expect(screen.queryByRole("checkbox", { name: "重置前先还原已备份的工具原文件（推荐）" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认重置" }));
    await waitFor(() => expect(restoreDefaults).toHaveBeenCalledWith(emptyBackupPreview, "keep"));
    expect(await within(dialog).findByText("已重置 Skill 库。")).toBeTruthy();
  });
});
