// @vitest-environment happy-dom

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp } from "../src/app";
import { classifyScanRows } from "../src/features/scan/classify";
import type { OriginalBackupSummary, Preferences, SettingsGateway } from "../src/features/settings/gateway";
import type { DiscoveredSkill } from "../src/shared/discovery";
import type { Agent, DesktopGateway, LibrarySnapshot } from "../src/shared/library";

import { createDiscoveryGateway } from "./support/discovery";

const mockScan = vi.fn<() => Promise<DiscoveredSkill[]>>();
const mockCommit = vi.fn();
const mockUndo = vi.fn();
const mockDiff = vi.fn();
const mockTrash = vi.fn();

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.clearAllMocks();
  document.body.innerHTML = "";
  document.documentElement.lang = "zh-CN";
});

const claudeAgent: Agent = {
  id: "claude",
  kind: "claudeCode",
  name: "Claude Code",
  directory: "/Users/dev/.claude/skills",
  syncedCategories: [],
  syncUncategorized: false,
};

function createDesktop(
  initial: LibrarySnapshot,
  settings?: SettingsGateway,
  unmanagedIndicators?: DiscoveredSkill[],
): DesktopGateway {
  return {
    chooseFolders: vi.fn().mockResolvedValue([]),
    onFolderDrag: vi.fn().mockResolvedValue(() => {}),
    discovery: createDiscoveryGateway({
      scan: mockScan,
      commitBatch: mockCommit,
      undoBatch: mockUndo,
      compareManifests: mockDiff,
      trashBrokenLink: mockTrash,
    }),
    scanUnmanagedIndicators: unmanagedIndicators
      ? vi.fn().mockResolvedValue(unmanagedIndicators)
      : undefined,
    settings,
    agents: {
      presets: vi.fn().mockResolvedValue([]),
      chooseDirectory: vi.fn().mockResolvedValue(null),
      previewDirectory: vi.fn(),
      add: vi.fn(),
      remove: vi.fn(),
      changeDirectory: vi.fn(),
      reorder: vi.fn(),
      setSkill: vi.fn(),
      setCategorySync: vi.fn(),
      undoCategorySync: vi.fn(),
      previewInstall: vi.fn().mockResolvedValue({ targets: [], conflicts: [] }),
      commitImport: vi.fn(),
      previewUnload: vi.fn(),
      unload: vi.fn(),
    },
    library: {
      snapshot: vi.fn().mockResolvedValue(initial),
      previewFolders: vi.fn().mockResolvedValue([]),
      commitImport: vi.fn(),
      managedPath: vi.fn().mockResolvedValue("/managed/skill"),
      createCategory: vi.fn(),
      renameCategory: vi.fn(),
      deleteCategory: vi.fn(),
      reorderCategories: vi.fn(),
      moveSkills: vi.fn(),
      undoMove: vi.fn(),
    },
  };
}

describe("unified local scan & original backups (React + coss ui)", () => {
  it("runs scan from onboarding, classifies ready/conflicts/invalid, compares diff, and commits with undo", async () => {
    const initial: LibrarySnapshot = {
      categories: [],
      skills: [],
      agents: [claudeAgent],
      assignments: [],
    };
    const afterCommit: LibrarySnapshot = {
      ...initial,
      skills: [
        {
          id: "s-ready",
          name: "Alpha Tool",
          description: "通用助手",
          folderName: "alpha",
          fingerprint: "fp-alpha",
          categoryId: null,
          source: null,
        },
      ],
    };

    mockScan.mockResolvedValue([
      {
        path: "/Users/dev/.claude/skills/alpha",
        name: "Alpha Tool",
        description: "通用助手",
        sourceDirectory: "/Users/dev/.claude/skills",
        sourceName: "Claude Code",
        agentId: "claude",
        agentKind: "claudeCode",
        status: "directory",
        target: null,
        fingerprint: "fp-alpha",
        identity: "alpha",
        reason: null,
      },
      {
        path: "/Users/dev/.claude/skills/conflict",
        name: "Shared Skill",
        description: "v1",
        sourceDirectory: "/Users/dev/.claude/skills",
        sourceName: "Claude Code",
        agentId: "claude",
        agentKind: "claudeCode",
        status: "directory",
        target: null,
        fingerprint: "fp-v1",
        identity: "conflict-1",
        reason: null,
        modifiedAt: 1700000000,
      },
      {
        path: "/Users/dev/.cursor/skills/conflict",
        name: "Shared Skill",
        description: "v2",
        sourceDirectory: "/Users/dev/.cursor/skills",
        sourceName: "Cursor",
        agentId: "cursor",
        agentKind: "cursor",
        status: "directory",
        target: null,
        fingerprint: "fp-v2",
        identity: "conflict-2",
        reason: null,
        modifiedAt: 1700000100,
      },
      {
        path: "/Users/dev/.claude/skills/broken",
        name: "Broken Link",
        description: null,
        sourceDirectory: "/Users/dev/.claude/skills",
        sourceName: "Claude Code",
        agentId: "claude",
        agentKind: "claudeCode",
        status: "invalid",
        target: null,
        brokenLink: true,
        fingerprint: null,
        identity: null,
        reason: "broken symlink",
      },
    ]);

    mockDiff.mockResolvedValue({
      leftPath: "/Users/dev/.cursor/skills/conflict",
      rightPath: "/Users/dev/.claude/skills/conflict",
      sameManifest: false,
      lines: [
        { kind: "removed", text: "old line" },
        { kind: "added", text: "new line" },
      ],
    });
    mockTrash.mockResolvedValue(undefined);
    mockCommit.mockResolvedValue({
      snapshot: afterCommit,
      results: [],
      managedCount: 3,
      importedCount: 2,
      backedUpCount: 3,
      skippedCount: 0,
      batchId: "batch-1",
    });
    mockUndo.mockResolvedValue(initial);

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, createDesktop(initial));

    fireEvent.click(await screen.findByRole("button", { name: "扫描本机工具中的 Skill" }));

    expect(await screen.findByText("可直接托管")).toBeTruthy();
    expect(screen.getByText("同名但内容不同")).toBeTruthy();

    // Compare diff
    fireEvent.click(screen.getByRole("button", { name: "对比差异" }));
    expect(await screen.findByText("+ new line")).toBeTruthy();

    // Commit all (1 ready + 1 conflict defaulting to keepBoth = 2 items)
    fireEvent.click(screen.getByRole("button", { name: "一键纳入管理（2 项）" }));
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Alpha Tool")).toBeTruthy();

    // Undo via toast
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await waitFor(() => expect(mockUndo).toHaveBeenCalledWith("batch-1"));
  });

  it("manages original backups in Settings (restore and delete)", async () => {
    const backup: OriginalBackupSummary = {
      id: "bak-1",
      createdAt: 1700000000,
      summary: "Claude Code 收进 Skill 库（2 项）",
      sizeBytes: 2048,
      itemNames: ["Alpha Tool", "Beta Tool"],
      itemCount: 2,
    };
    const prefs: Preferences = { language: "zh-CN", theme: "system", backupRetention: "30d" };
    const restoreOriginalBackup = vi.fn().mockResolvedValue({ categories: [], skills: [] });
    const deleteOriginalBackup = vi.fn().mockResolvedValue([]);

    const settings: SettingsGateway = {
      preferences: vi.fn().mockResolvedValue(prefs),
      setPreferences: vi.fn().mockImplementation(async (p) => p),
      chooseManagedDirectory: vi.fn(),
      changeManagedDirectory: vi.fn(),
      chooseBackup: vi.fn(),
      chooseExport: vi.fn(),
      exportBackup: vi.fn(),
      previewBackup: vi.fn(),
      restoreBackup: vi.fn(),
      previewDefaults: vi.fn(),
      restoreDefaults: vi.fn(),
      listOriginalBackups: vi.fn().mockResolvedValue([backup]),
      restoreOriginalBackup,
      deleteOriginalBackup,
    };

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, createDesktop({ categories: [], skills: [] }, settings));

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "数据管理" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: /接管前原文件备份/ }));
    expect(await within(dialog).findByText(backup.summary)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "恢复原文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认恢复" }));
    await waitFor(() => expect(restoreOriginalBackup).toHaveBeenCalledWith("bak-1"));
  });

  it("treats unmanaged rows with null fingerprint as invalid instead of false version conflicts", () => {
    const snapshot: LibrarySnapshot = {
      categories: [],
      skills: [
        {
          id: "s-1",
          name: "ask-matt",
          description: "Router skill",
          folderName: "ask-matt",
          fingerprint: "sha256-real",
          categoryId: null,
          source: null,
        },
      ],
      agents: [claudeAgent],
      assignments: [],
    };
    const rows: DiscoveredSkill[] = [
      {
        path: "/Users/dev/.claude/skills/ask-matt",
        name: "ask-matt",
        description: "Router skill",
        sourceDirectory: "/Users/dev/.claude/skills",
        sourceName: "Claude Code",
        agentId: "claude",
        agentKind: "claudeCode",
        status: "externalLink",
        target: "/Users/dev/other/ask-matt",
        fingerprint: null,
        identity: null,
        reason: "内部包含不支持的软链接",
      },
    ];
    const classified = classifyScanRows(rows, snapshot);
    expect(classified.conflicts).toHaveLength(0);
    expect(classified.ready).toHaveLength(0);
    expect(classified.invalid).toHaveLength(1);
    expect(classified.invalid[0].path).toBe("/Users/dev/.claude/skills/ask-matt");
  });
});
