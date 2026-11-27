// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp } from "../src/app";
import { renderEmojiSafeText } from "../src/components/EmojiSafeText";
import type { DiscoveredSkill, DiscoveryGateway } from "../src/shared/discovery";
import type { AgentGateway, DesktopGateway, LibrarySnapshot } from "../src/shared/library";

import { createDiscoveryGateway } from "./support/discovery";

let stop: (() => void) | undefined;
let discovery: DiscoveryGateway = createDiscoveryGateway();

afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
  document.documentElement.lang = "zh-CN";
  window.localStorage.removeItem("skill-library:view-mode");
  discovery = createDiscoveryGateway();
});

function baseSnapshot(): LibrarySnapshot {
  return {
    categories: [{ id: "writing", name: "写作" }],
    skills: [
      {
        id: "outline",
        name: "Writing Outline",
        description: "规划长文的结构",
        folderName: "outline",
        fingerprint: "fp-outline",
        categoryId: "writing",
        source: null,
      },
    ],
    agents: [
      {
        id: "claude",
        kind: "claudeCode",
        name: "Claude Code",
        directory: "/Users/dev/.claude/skills",
        syncedCategories: [],
        syncUncategorized: false,
      },
    ],
    assignments: [],
  };
}

function createAgentGateway(overrides: Partial<AgentGateway> = {}): AgentGateway {
  return {
    presets: vi.fn().mockResolvedValue([
      { kind: "claudeCode", name: "Claude Code", directory: "/Users/dev/.claude/skills" },
      { kind: "codex", name: "Codex", directory: "/Users/dev/.codex/skills" },
    ]),
    chooseDirectory: vi.fn().mockResolvedValue(null),
    previewDirectory: vi.fn().mockImplementation(async (dir) => ({ directory: dir, exists: true })),
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
    ...overrides,
  };
}

function createDesktop(initial: LibrarySnapshot, agents: AgentGateway): DesktopGateway {
  return {
    chooseFolders: vi.fn().mockResolvedValue([]),
    onFolderDrag: vi.fn().mockResolvedValue(() => {}),
    agents,
    discovery,
    library: {
      snapshot: vi.fn().mockResolvedValue(initial),
      previewFolders: vi.fn().mockResolvedValue([]),
      commitImport: vi.fn(),
      managedPath: vi.fn().mockResolvedValue("/managed/outline"),
      createCategory: vi.fn(),
      renameCategory: vi.fn(),
      deleteCategory: vi.fn(),
      reorderCategories: vi.fn(),
      moveSkills: vi.fn(),
      undoMove: vi.fn(),
    },
  };
}

describe("agent management (React + coss ui)", () => {
  it("adds a preset tool and navigates to its page", async () => {
    const initial = baseSnapshot();
    const afterAdd: LibrarySnapshot = {
      ...initial,
      agents: [
        ...initial.agents!,
        {
          id: "codex",
          kind: "codex",
          name: "Codex",
          directory: "/Users/dev/.codex/skills",
          syncedCategories: [],
          syncUncategorized: false,
        },
      ],
    };
    const agents = createAgentGateway({
      add: vi.fn().mockResolvedValue(afterAdd),
    });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, createDesktop(initial, agents));

    fireEvent.click(screen.getByRole("button", { name: "添加工具" }));
    const dialog = await screen.findByRole("dialog");

    // Codex should be auto-selected because Claude Code is already added
    await waitFor(() => {
      const submit = within(dialog).getByRole("button", { name: "添加工具" });
      expect((submit as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "添加工具" }));

    await waitFor(() =>
      expect(agents.add).toHaveBeenCalledWith(
        { kind: "codex", name: "Codex", directory: "/Users/dev/.codex/skills" },
        false,
      ),
    );
    expect(await screen.findByRole("heading", { name: "Codex" })).toBeTruthy();
  });

  it("toggles a skill switch and category auto-enable with undo", async () => {
    const initial = baseSnapshot();
    const afterEnable: LibrarySnapshot = {
      ...initial,
      assignments: [
        {
          agentId: "claude",
          skillId: "outline",
          direct: true,
          viaCategory: false,
          excluded: false,
          path: "/Users/dev/.claude/skills/outline",
        },
      ],
    };
    const afterSync: LibrarySnapshot = {
      ...afterEnable,
      agents: [{ ...initial.agents![0], syncedCategories: ["writing"] }],
    };

    const agents = createAgentGateway({
      setSkill: vi.fn().mockResolvedValue(afterEnable),
      setCategorySync: vi.fn().mockResolvedValue({
        library: afterSync,
        impact: { enabled: 1, disabled: 0, retainedDirect: 0 },
        undo: "sync-undo-1",
      }),
      undoCategorySync: vi.fn().mockResolvedValue({
        library: afterEnable,
        impact: { enabled: 0, disabled: 1, retainedDirect: 0 },
        undo: null,
      }),
    });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, createDesktop(initial, agents));

    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    expect(await screen.findByRole("heading", { name: "Claude Code" })).toBeTruthy();

    // Category groups are collapsed by default; expand "写作" before toggling individual skills
    expect(
      screen.queryByRole("switch", { name: "在 Claude Code 中启用 Writing Outline" }),
    ).toBeNull();
    const categorySwitch = await screen.findByRole("switch", {
      name: "整类自动开启「写作」",
    });
    fireEvent.click(screen.getByRole("button", { name: /写作.*0 \/ 1 已启用/ }));

    const skillSwitch = await screen.findByRole("switch", {
      name: "在 Claude Code 中启用 Writing Outline",
    });
    fireEvent.click(skillSwitch);
    await waitFor(() => expect(agents.setSkill).toHaveBeenCalledWith("claude", "outline", true));

    fireEvent.click(categorySwitch);
    await waitFor(() =>
      expect(agents.setCategorySync).toHaveBeenCalledWith("claude", "writing", true),
    );

    const undoBtn = await screen.findByRole("button", { name: "撤销" });
    fireEvent.click(undoBtn);
    await waitFor(() => expect(agents.undoCategorySync).toHaveBeenCalledWith("sync-undo-1"));
  });

  it("removes a tool after confirmation", async () => {
    const initial = baseSnapshot();
    const agents = createAgentGateway({
      remove: vi.fn().mockResolvedValue({ ...initial, agents: [], assignments: [] }),
    });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, createDesktop(initial, agents));

    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "从「我的工具」移除…" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("移除 Claude Code？")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "移除工具" }));

    await waitFor(() => expect(agents.remove).toHaveBeenCalledWith("claude", []));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Claude Code" })).toBeNull());
  });

  it("keeps skills stable in category groups, supports sticky Enabled-only filter, uncategorized sync, and row-click detail dialog", async () => {
    const initial: LibrarySnapshot = {
      categories: [
        { id: "writing", name: "写作" },
        { id: "design", name: "设计" },
      ],
      skills: [
        {
          id: "outline",
          name: "Writing Outline",
          description: "规划长文的结构",
          folderName: "outline",
          fingerprint: "fp-outline",
          categoryId: "writing",
          source: null,
        },
        {
          id: "apple-design",
          name: "Apple Design",
          description: "界面走查",
          folderName: "apple-design",
          fingerprint: "fp-design",
          categoryId: "design",
          source: null,
        },
        {
          id: "misc",
          name: "Misc Helper",
          description: "未分类助手",
          folderName: "misc",
          fingerprint: "fp-misc",
          categoryId: null,
          source: null,
        },
      ],
      agents: [
        {
          id: "claude",
          kind: "claudeCode",
          name: "Claude Code",
          directory: "/Users/dev/.claude/skills",
          syncedCategories: [],
          syncUncategorized: false,
        },
      ],
      assignments: [
        {
          agentId: "claude",
          skillId: "outline",
          direct: true,
          viaCategory: false,
          excluded: false,
          path: "/Users/dev/.claude/skills/outline",
        },
      ],
    };
    const afterDisableOutline: LibrarySnapshot = {
      ...initial,
      assignments: [],
    };
    const afterSyncUncategorized: LibrarySnapshot = {
      ...afterDisableOutline,
      agents: [{ ...initial.agents![0], syncUncategorized: true }],
      assignments: [
        {
          agentId: "claude",
          skillId: "misc",
          direct: false,
          viaCategory: true,
          excluded: false,
          path: "/Users/dev/.claude/skills/misc",
        },
      ],
    };
    const agents = createAgentGateway({
      setSkill: vi.fn().mockResolvedValue(afterDisableOutline),
      setCategorySync: vi.fn().mockResolvedValue({
        library: afterSyncUncategorized,
        impact: { enabled: 1, disabled: 0, retainedDirect: 0 },
        undo: "sync-undo-uncat",
      }),
    });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, createDesktop(initial, agents));

    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));

    // By default all category groups are collapsed
    expect(await screen.findByRole("heading", { name: "Claude Code" })).toBeTruthy();
    expect(screen.queryByText("Writing Outline")).toBeNull();
    expect(screen.queryByText("Apple Design")).toBeNull();
    expect(screen.queryByText("Misc Helper")).toBeNull();

    // Expand all and collapse all toggle
    fireEvent.click(screen.getByRole("button", { name: "全部展开" }));
    expect(await screen.findByText("Writing Outline")).toBeTruthy();
    expect(screen.getByText("Apple Design")).toBeTruthy();
    expect(screen.getByText("Misc Helper")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全部收起" }));
    expect(screen.queryByText("Writing Outline")).toBeNull();
    expect(screen.queryByText("Apple Design")).toBeNull();
    expect(screen.queryByText("Misc Helper")).toBeNull();

    // Expand a single category group and open detail dialog on title click without toggling switch
    fireEvent.click(screen.getByRole("button", { name: /设计.*0 \/ 1 已启用/ }));
    fireEvent.click(await screen.findByText("Apple Design"));
    const detailDialog = await screen.findByRole("dialog");
    expect(within(detailDialog).getByText("界面走查")).toBeTruthy();
    expect(agents.setSkill).not.toHaveBeenCalled();
    fireEvent.click(within(detailDialog).getByRole("button", { name: "关闭" }));

    // Turn on "仅看已启用": auto-expands matching groups, hides disabled items, keeps enabled item
    fireEvent.click(screen.getByRole("button", { name: "仅看已启用" }));
    expect(await screen.findByText("Writing Outline")).toBeTruthy();
    expect(screen.queryByText("Apple Design")).toBeNull();
    expect(screen.queryByText("Misc Helper")).toBeNull();

    // Disabling Writing Outline while "仅看已启用" is active keeps it in place (no vanishing!)
    fireEvent.click(
      screen.getByRole("switch", { name: "在 Claude Code 中停用 Writing Outline" }),
    );
    await waitFor(() =>
      expect(agents.setSkill).toHaveBeenCalledWith("claude", "outline", false),
    );
    expect(screen.getByText("Writing Outline")).toBeTruthy();
    expect(screen.getByText("已关闭")).toBeTruthy();

    // Turn off "仅看已启用" and filter by category pill "未分类" (auto-expands target group)
    fireEvent.click(screen.getByRole("button", { name: "仅看已启用" }));
    const filterGroup = screen.getByRole("group", { name: "按分类筛选" });
    fireEvent.click(within(filterGroup).getByRole("button", { name: /未分类/ }));
    expect(await screen.findByText("Misc Helper")).toBeTruthy();
    expect(screen.queryByText("Apple Design")).toBeNull();

    // Uncategorized supports auto-sync directly in its group header
    fireEvent.click(screen.getByRole("switch", { name: "整类自动开启「未分类」" }));
    await waitFor(() =>
      expect(agents.setCategorySync).toHaveBeenCalledWith("claude", null, true),
    );
  });

  it("reorders agents via pointer drag, ignores menu trigger press, and keeps click navigation", async () => {
    const claude = {
      id: "claude",
      kind: "claudeCode",
      name: "Claude Code",
      directory: "/Users/dev/.claude/skills",
      syncedCategories: [],
      syncUncategorized: false,
    };
    const codex = {
      id: "codex",
      kind: "codex",
      name: "Codex",
      directory: "/Users/dev/.codex/skills",
      syncedCategories: [],
      syncUncategorized: false,
    };
    const cursor = {
      id: "cursor",
      kind: "cursor",
      name: "Cursor",
      directory: "/Users/dev/.cursor/skills",
      syncedCategories: [],
      syncUncategorized: false,
    };
    const initial: LibrarySnapshot = {
      categories: [],
      skills: [],
      agents: [claude, codex, cursor],
      assignments: [],
    };
    const reorder = vi.fn().mockResolvedValue({
      ...initial,
      agents: [codex, cursor, claude],
    });
    const agents = createAgentGateway({ reorder });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, createDesktop(initial, agents));

    const toolsNav = screen.getByRole("navigation", { name: "我的工具" });
    const agentLabels = () =>
      [...toolsNav.querySelectorAll("button[id^='agent-nav-']")].map((el) =>
        el.getAttribute("aria-label"),
      );

    expect(agentLabels()).toEqual(["Claude Code", "Codex", "Cursor"]);

    // Pressing the row's More button must not start a drag
    const moreBtn = screen.getByRole("button", { name: "Claude Code 的更多操作" });
    fireEvent.pointerDown(moreBtn, { button: 0, clientY: 10, pointerId: 1, isPrimary: true });
    fireEvent.pointerMove(window, { clientY: 120, pointerId: 1 });
    expect(document.body.dataset.reordering).toBeUndefined();
    fireEvent.pointerUp(window, { clientY: 120, pointerId: 1 });
    expect(reorder).not.toHaveBeenCalled();

    // Drag Claude Code to the bottom
    const claudeBtn = screen.getByRole("button", { name: "Claude Code" });
    fireEvent.pointerDown(claudeBtn, { button: 0, clientY: 10, pointerId: 1, isPrimary: true });
    fireEvent.pointerMove(window, { clientY: 120, pointerId: 1 });
    expect(document.body.dataset.reordering).toBe("true");
    fireEvent.pointerUp(window, { clientY: 120, pointerId: 1 });
    fireEvent.click(claudeBtn);

    expect(document.body.dataset.reordering).toBeUndefined();
    await waitFor(() => expect(reorder).toHaveBeenCalledWith(["codex", "cursor", "claude"]));
    expect(agentLabels()).toEqual(["Codex", "Cursor", "Claude Code"]);
    expect(claudeBtn.getAttribute("aria-current")).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(await screen.findByRole("heading", { name: "Codex" })).toBeTruthy();
  });

  it("reorders agents via menu and keyboard and rolls back on failure", async () => {
    const claude = {
      id: "claude",
      kind: "claudeCode",
      name: "Claude Code",
      directory: "/Users/dev/.claude/skills",
      syncedCategories: [],
      syncUncategorized: false,
    };
    const codex = {
      id: "codex",
      kind: "codex",
      name: "Codex",
      directory: "/Users/dev/.codex/skills",
      syncedCategories: [],
      syncUncategorized: false,
    };
    const initial: LibrarySnapshot = {
      categories: [],
      skills: [],
      agents: [claude, codex],
      assignments: [],
    };
    const reorder = vi
      .fn()
      .mockResolvedValueOnce({ ...initial, agents: [codex, claude] })
      .mockRejectedValueOnce(new Error("工具排序失败"));
    const agents = createAgentGateway({ reorder });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, createDesktop(initial, agents));

    const toolsNav = screen.getByRole("navigation", { name: "我的工具" });
    const agentLabels = () =>
      [...toolsNav.querySelectorAll("button[id^='agent-nav-']")].map((el) =>
        el.getAttribute("aria-label"),
      );

    // Move Claude Code down via menu ("上移" disabled at top)
    fireEvent.click(screen.getByRole("button", { name: "Claude Code 的更多操作" }));
    const moveUpItem = await screen.findByRole("menuitem", { name: "上移" });
    expect(moveUpItem.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "下移" }));

    await waitFor(() => expect(reorder).toHaveBeenNthCalledWith(1, ["codex", "claude"]));
    expect(agentLabels()).toEqual(["Codex", "Claude Code"]);

    // Keyboard Alt+ArrowDown triggers second call which fails and rolls back
    fireEvent.keyDown(screen.getByRole("button", { name: "Codex" }), {
      key: "ArrowDown",
      altKey: true,
    });
    expect(await screen.findByText("工具排序失败")).toBeTruthy();
    expect(agentLabels()).toEqual(["Codex", "Claude Code"]);
  });

  it("supports card grid view in My tools with Switch, sticky Enabled-only, detail dialog, and syncs view mode with Library", async () => {
    const initial: LibrarySnapshot = {
      categories: [{ id: "writing", name: "写作" }],
      skills: [
        {
          id: "outline",
          name: "Writing Outline",
          description: "规划长文的结构",
          folderName: "outline",
          fingerprint: "fp-outline",
          categoryId: "writing",
          source: null,
        },
        {
          id: "polish",
          name: "Prose Polish",
          description: "检查段落表述",
          folderName: "polish",
          fingerprint: "fp-polish",
          categoryId: "writing",
          source: null,
        },
      ],
      agents: [
        {
          id: "claude",
          kind: "claudeCode",
          name: "Claude Code",
          directory: "/Users/dev/.claude/skills",
          syncedCategories: [],
          syncUncategorized: false,
        },
      ],
      assignments: [
        {
          agentId: "claude",
          skillId: "outline",
          direct: true,
          viaCategory: false,
          excluded: false,
          path: "/Users/dev/.claude/skills/outline",
        },
      ],
    };

    const afterDisableOutline: LibrarySnapshot = {
      ...initial,
      assignments: [],
    };
    const agents = createAgentGateway({
      setSkill: vi.fn().mockResolvedValue(afterDisableOutline),
    });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, createDesktop(initial, agents));

    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    expect(await screen.findByRole("heading", { name: "Claude Code" })).toBeTruthy();

    // Defaults to grid view with category groups collapsed
    const gridBtn = screen.getByRole("button", { name: "网格视图" });
    expect(gridBtn.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Writing Outline")).toBeNull();

    // Expand "写作" group to inspect skill cards
    fireEvent.click(screen.getByRole("button", { name: /写作.*1 \/ 2 已启用/ }));
    expect(await screen.findByText("Writing Outline")).toBeTruthy();
    expect(screen.getByText("已启用")).toBeTruthy();
    expect(screen.getByText("未启用")).toBeTruthy();

    // Clicking card title opens detail dialog without toggling switch
    fireEvent.click(screen.getByText("Prose Polish"));
    const detailDialog = await screen.findByRole("dialog");
    expect(within(detailDialog).getByText("检查段落表述")).toBeTruthy();
    expect(agents.setSkill).not.toHaveBeenCalled();
    fireEvent.click(within(detailDialog).getByRole("button", { name: "关闭" }));

    // Sticky Enabled-only + Switch works inside grid view
    fireEvent.click(screen.getByRole("button", { name: "仅看已启用" }));
    expect(screen.getByText("Writing Outline")).toBeTruthy();
    expect(screen.queryByText("Prose Polish")).toBeNull();

    fireEvent.click(
      screen.getByRole("switch", { name: "在 Claude Code 中停用 Writing Outline" }),
    );
    await waitFor(() =>
      expect(agents.setSkill).toHaveBeenCalledWith("claude", "outline", false),
    );
    expect(screen.getByText("Writing Outline")).toBeTruthy();
    expect(screen.getByText("已关闭")).toBeTruthy();

    // Switch to list view and confirm sync back to All skills
    const listBtn = screen.getByRole("button", { name: "列表视图" });
    fireEvent.click(listBtn);
    expect(listBtn.getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem("skill-library:view-mode")).toBe("list");

    fireEvent.click(screen.getByRole("button", { name: "全部 Skill" }));
    expect(screen.getByRole("button", { name: "列表视图" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("renders unmanaged local skills inside an integrated group without sidebar yellow dot and supports Reveal, single adopt with undo, and detail category adopt", async () => {
    const initial = baseSnapshot();
    const localFolderSkill: DiscoveredSkill = {
      path: "/Users/dev/.claude/skills/local-refactor",
      name: "local-refactor",
      description: "重构 TypeScript 模块",
      sourceDirectory: "/Users/dev/.claude/skills",
      sourceName: "Claude Code",
      agentId: "claude",
      agentKind: "claudeCode",
      status: "directory",
      target: null,
      fingerprint: "fp-local-refactor",
      identity: "/Users/dev/.claude/skills/local-refactor",
      reason: null,
    };
    const conflictSkill: DiscoveredSkill = {
      path: "/Users/dev/.claude/skills/outline-custom",
      name: "Writing Outline",
      description: "本地修改版大纲 Skill",
      sourceDirectory: "/Users/dev/.claude/skills",
      sourceName: "Claude Code",
      agentId: "claude",
      agentKind: "claudeCode",
      status: "externalLink",
      target: "/Users/dev/shared/outline-custom",
      fingerprint: "fp-different-outline",
      identity: "/Users/dev/.claude/skills/outline-custom",
      reason: null,
    };

    const afterSingleAdopt: LibrarySnapshot = {
      ...initial,
      skills: [
        ...initial.skills,
        {
          id: "adopted-1",
          name: "local-refactor",
          description: "重构 TypeScript 模块",
          folderName: "local-refactor",
          fingerprint: "fp-local-refactor",
          categoryId: null,
          source: null,
        },
      ],
      assignments: [
        {
          agentId: "claude",
          skillId: "adopted-1",
          direct: true,
          viaCategory: false,
          excluded: false,
          path: "/Users/dev/.claude/skills/local-refactor",
        },
      ],
    };
    const afterMove: LibrarySnapshot = {
      ...afterSingleAdopt,
      skills: afterSingleAdopt.skills.map((s) =>
        s.id === "adopted-1" ? { ...s, categoryId: "writing" } : s,
      ),
    };

    vi.mocked(discovery.scan)
      .mockResolvedValueOnce([conflictSkill])
      .mockResolvedValueOnce([localFolderSkill, conflictSkill])
      .mockResolvedValueOnce([conflictSkill]);

    vi.mocked(discovery.commitBatch).mockResolvedValue({
      snapshot: afterSingleAdopt,
      results: [{ path: localFolderSkill.path, skipped: false, error: null }],
      managedCount: 1,
      importedCount: 1,
      backedUpCount: 1,
      skippedCount: 0,
      batchId: "batch-single-1",
    });
    vi.mocked(discovery.undoBatch).mockResolvedValue(initial);

    const moveSkills = vi.fn().mockResolvedValue({
      library: afterMove,
      moved: 1,
      undo: "undo-move-1",
    });
    const undoMove = vi.fn().mockResolvedValue(afterSingleAdopt);

    const desktop = createDesktop(initial, createAgentGateway());
    desktop.scanUnmanagedIndicators = vi
      .fn()
      .mockResolvedValue([localFolderSkill, conflictSkill]);
    desktop.library.moveSkills = moveSkills;
    desktop.library.undoMove = undoMove;

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, desktop);

    // Sidebar does NOT render yellow dot for unmanaged skills
    await waitFor(() => expect(desktop.scanUnmanagedIndicators).toHaveBeenCalled());
    expect(screen.queryByLabelText(/未托管/)).toBeNull();

    // Navigate to Claude Code: renders immediately from startup preload without re-scanning
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));

    // Integrated local group appears without old top Alert banner and starts collapsed
    expect(await screen.findByText("仅在 Claude Code 中")).toBeTruthy();
    expect(discovery.scan).not.toHaveBeenCalled();
    expect(screen.queryByText(/发现 .* 个未收进 Skill 库的 Skill/)).toBeNull();
    expect(screen.queryByText("local-refactor")).toBeNull();

    // Local filter pill filters down to the unmanaged group and auto-expands it
    const filterGroup = screen.getByRole("group", { name: "按分类筛选" });
    fireEvent.click(within(filterGroup).getByRole("button", { name: /仅在本工具/ }));
    expect(await screen.findByText("local-refactor")).toBeTruthy();
    expect(screen.getByText("独立文件夹")).toBeTruthy();
    expect(screen.getByText("外部软链")).toBeTruthy();
    expect(screen.getByText("同名差异")).toBeTruthy();
    expect(screen.queryByText("0 / 1 已启用")).toBeNull();

    // Reveal button opens Finder via openInSystem
    fireEvent.click(screen.getByRole("button", { name: "在访达中打开 local-refactor" }));
    await waitFor(() => expect(discovery.openInSystem).toHaveBeenCalledWith(localFolderSkill.path));

    // Single-item adopt commits just that row and supports Toast Undo
    fireEvent.click(screen.getByRole("button", { name: "收进库" }));
    await waitFor(() =>
      expect(discovery.commitBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          readyRows: [localFolderSkill],
          copyOnly: false,
        }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "撤销" }));
    await waitFor(() => expect(discovery.undoBatch).toHaveBeenCalledWith("batch-single-1"));
    expect(await screen.findByText("local-refactor")).toBeTruthy();

    // Clicking the unmanaged card opens detail dialog with path and CategoryPicker
    fireEvent.click(screen.getByText("local-refactor"));
    const dialog = await screen.findByRole("dialog", { name: "local-refactor" });
    expect(within(dialog).getByText(localFolderSkill.path)).toBeTruthy();

    // Select target category "写作" and submit
    fireEvent.click(within(dialog).getByRole("combobox", { name: "目标分类" }));
    const writingOption = await screen.findByRole("option", { name: "写作" });
    fireEvent.pointerDown(writingOption);
    fireEvent.click(writingOption);
    fireEvent.click(within(dialog).getByRole("button", { name: "收进 Skill 库" }));

    await waitFor(() =>
      expect(moveSkills).toHaveBeenCalledWith(["adopted-1"], {
        kind: "existing",
        id: "writing",
      }),
    );
  });

  it("preloads unmanaged skills across multiple tools for instant switching and refreshes on manual rescan", async () => {
    const initial: LibrarySnapshot = {
      categories: [{ id: "writing", name: "写作" }],
      skills: baseSnapshot().skills,
      agents: [
        {
          id: "claude",
          kind: "claudeCode",
          name: "Claude Code",
          directory: "/Users/dev/.claude/skills",
          syncedCategories: [],
          syncUncategorized: false,
        },
        {
          id: "codex",
          kind: "codex",
          name: "Codex",
          directory: "/Users/dev/.codex/skills",
          syncedCategories: [],
          syncUncategorized: false,
        },
      ],
      assignments: [],
    };
    const claudeUnmanaged: DiscoveredSkill = {
      path: "/Users/dev/.claude/skills/claude-only-skill",
      name: "claude-only-skill",
      description: "Claude 独立本地技能",
      sourceDirectory: "/Users/dev/.claude/skills",
      sourceName: "Claude Code",
      agentId: "claude",
      agentKind: "claudeCode",
      status: "directory",
      target: null,
      fingerprint: "fp-claude-only",
      identity: "/Users/dev/.claude/skills/claude-only-skill",
      reason: null,
    };
    const codexUnmanaged: DiscoveredSkill = {
      path: "/Users/dev/.codex/skills/codex-only-skill",
      name: "codex-only-skill",
      description: "Codex 独立本地技能",
      sourceDirectory: "/Users/dev/.codex/skills",
      sourceName: "Codex",
      agentId: "codex",
      agentKind: "codex",
      status: "directory",
      target: null,
      fingerprint: "fp-codex-only",
      identity: "/Users/dev/.codex/skills/codex-only-skill",
      reason: null,
    };
    const claudeRefreshed: DiscoveredSkill = {
      ...claudeUnmanaged,
      path: "/Users/dev/.claude/skills/claude-refreshed-skill",
      name: "claude-refreshed-skill",
      description: "刷新后发现的新本地技能",
      fingerprint: "fp-claude-refreshed",
      identity: "/Users/dev/.claude/skills/claude-refreshed-skill",
    };

    vi.mocked(discovery.scan).mockResolvedValueOnce([claudeRefreshed]);

    const desktop = createDesktop(initial, createAgentGateway());
    desktop.scanUnmanagedIndicators = vi
      .fn()
      .mockResolvedValue([claudeUnmanaged, codexUnmanaged]);

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, desktop);

    await waitFor(() => expect(desktop.scanUnmanagedIndicators).toHaveBeenCalledTimes(1));

    // Open Claude Code: preloaded unmanaged skill shows immediately with zero per-page scans
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    expect(await screen.findByText("仅在 Claude Code 中")).toBeTruthy();
    expect(screen.getByText("1 个仅在本工具")).toBeTruthy();
    expect(discovery.scan).not.toHaveBeenCalled();

    let filterGroup = screen.getByRole("group", { name: "按分类筛选" });
    fireEvent.click(within(filterGroup).getByRole("button", { name: /仅在本工具/ }));
    expect(await screen.findByText("claude-only-skill")).toBeTruthy();
    expect(discovery.scan).not.toHaveBeenCalled();

    // Switch to Codex: preloaded unmanaged skill shows immediately with zero per-page scans
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(await screen.findByText("仅在 Codex 中")).toBeTruthy();
    expect(screen.getByText("1 个仅在本工具")).toBeTruthy();
    filterGroup = screen.getByRole("group", { name: "按分类筛选" });
    fireEvent.click(within(filterGroup).getByRole("button", { name: /仅在本工具/ }));
    expect(await screen.findByText("codex-only-skill")).toBeTruthy();
    expect(discovery.scan).not.toHaveBeenCalled();

    // Switch back to Claude Code: still instant from cache
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    expect(await screen.findByText("仅在 Claude Code 中")).toBeTruthy();
    expect(discovery.scan).not.toHaveBeenCalled();

    // Manual "重新检查文件夹" performs a single-agent refresh
    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重新检查文件夹" }));

    await waitFor(() =>
      expect(discovery.scan).toHaveBeenCalledWith([], "claude", true, true),
    );
    filterGroup = screen.getByRole("group", { name: "按分类筛选" });
    fireEvent.click(within(filterGroup).getByRole("button", { name: /仅在本工具/ }));
    expect(await screen.findByText("claude-refreshed-skill")).toBeTruthy();
  });

  it("keeps sidebar counts on Uncategorized and My tools visible when opening and closing dialogs", async () => {
    const initial: LibrarySnapshot = {
      categories: [{ id: "writing", name: "写作" }],
      skills: [
        ...baseSnapshot().skills,
        {
          id: "misc",
          name: "Misc Helper",
          description: "未分类助手",
          folderName: "misc",
          fingerprint: "fp-misc",
          categoryId: null,
          source: null,
        },
      ],
      agents: [
        {
          id: "claude",
          kind: "claudeCode",
          name: "Claude Code",
          directory: "/Users/dev/.claude/skills",
          syncedCategories: [],
          syncUncategorized: false,
        },
      ],
      assignments: [
        {
          agentId: "claude",
          skillId: "misc",
          direct: true,
          viaCategory: false,
          excluded: false,
          path: "/Users/dev/.claude/skills/misc",
        },
      ],
    };

    const desktop = createDesktop(initial, createAgentGateway());
    desktop.settings = {
      preferences: vi.fn().mockResolvedValue({
        language: "zh-CN",
        theme: "system",
        backupRetention: "30d",
      }),
      setPreferences: vi.fn(),
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

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, desktop);

    const assertCountsVisible = () => {
      const uncatBtn = document.getElementById("library-nav-uncategorized");
      const claudeBtn = document.getElementById("agent-nav-claude");
      expect(uncatBtn).toBeTruthy();
      expect(claudeBtn).toBeTruthy();
      const uncatCount = uncatBtn!.querySelector("[data-nav-count]") as HTMLElement | null;
      const claudeCount = claudeBtn!.querySelector("[data-nav-count]") as HTMLElement | null;
      expect(uncatCount).toBeTruthy();
      expect(claudeCount).toBeTruthy();
      expect(uncatCount!.textContent?.trim()).toBe("1");
      expect(claudeCount!.textContent?.trim()).toBe("1");
      expect(uncatCount!.className).not.toContain("group-focus-within:opacity-0");
      expect(claudeCount!.className).not.toContain("group-focus-within:opacity-0");
      expect(uncatCount!.className).toContain("group-has-[[data-nav-more]:focus-visible]:opacity-0");
      expect(claudeCount!.className).toContain("group-has-[[data-nav-more]:focus-visible]:opacity-0");
    };

    // Click sidebar items so they receive focus, then open and close dialogs
    fireEvent.click(screen.getByRole("button", { name: "未分类" }));
    assertCountsVisible();

    fireEvent.click(screen.getByRole("button", { name: "添加工具" }));
    const addDialog = await screen.findByRole("dialog");
    assertCountsVisible();
    fireEvent.click(within(addDialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    assertCountsVisible();

    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    assertCountsVisible();

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const settingsDialog = await screen.findByRole("dialog");
    assertCountsVisible();
    fireEvent.keyDown(settingsDialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    assertCountsVisible();
  });

  it("wraps VS16 emoji sequences in .emoji-run when expanding a category group without altering text", async () => {
    const emojiDesc = "认知劫持理论驱动，选题诊断（🚲🛵🚗✈️分级）、大纲设计";
    const plainDesc = "普通中文与English说明";
    const initial: LibrarySnapshot = {
      categories: [{ id: "writing", name: "写作" }],
      skills: [
        {
          id: "sun-topic",
          name: "sun-topic",
          description: emojiDesc,
          folderName: "sun-topic",
          fingerprint: "fp-sun-topic",
          categoryId: "writing",
          source: null,
        },
        {
          id: "plain-skill",
          name: "plain-skill",
          description: plainDesc,
          folderName: "plain-skill",
          fingerprint: "fp-plain",
          categoryId: "writing",
          source: null,
        },
      ],
      agents: baseSnapshot().agents,
      assignments: [],
    };

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, createDesktop(initial, createAgentGateway()));

    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    expect(await screen.findByRole("heading", { name: "Claude Code" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /写作.*0 \/ 2 已启用/ }));

    const emojiNode = await screen.findByTitle(emojiDesc);
    expect(emojiNode.textContent).toBe(emojiDesc);
    const emojiRuns = [...emojiNode.querySelectorAll(".emoji-run")].map((el) => el.textContent);
    expect(emojiRuns).toEqual(["🚲🛵🚗✈️"]);

    const plainNode = screen.getByTitle(plainDesc);
    expect(plainNode.textContent).toBe(plainDesc);
    expect(plainNode.querySelectorAll(".emoji-run")).toHaveLength(0);
  });
});

describe("renderEmojiSafeText", () => {
  it("returns plain strings unchanged without extra DOM nodes", () => {
    const plain = "普通中文 English 「引号」（括号）→ © ® ™ 123 #*";
    const result = renderEmojiSafeText(plain);
    expect(typeof result).toBe("string");
    expect(result).toBe(plain);
  });

  it("wraps VS16, skin-tone, ZWJ, keycap, regional flags, and stray VS16 in .emoji-run", () => {
    const cases: [string, string[]][] = [
      ["按爆款等级（✈️🚗🛵🚲🚶）分类", ["✈️🚗🛵🚲🚶"]],
      ["手势 👍🏻 测试", ["👍🏻"]],
      ["家庭 👨‍👩‍👧‍👦 与 🤷‍♀️ 组合", ["👨‍👩‍👧‍👦", "🤷‍♀️"]],
      ["按键 1️⃣ 和 #️⃣", ["1️⃣", "#️⃣"]],
      ["旗帜 🇨🇳 标识", ["🇨🇳"]],
      ["孤立\uFE0F符", ["\uFE0F"]],
    ];

    for (const [sample, expectedRuns] of cases) {
      const { container, unmount } = render(createElement("div", null, renderEmojiSafeText(sample)));
      expect(container.textContent).toBe(sample);
      const runs = [...container.querySelectorAll(".emoji-run")].map((el) => el.textContent);
      expect(runs).toEqual(expectedRuns);
      unmount();
    }
  });
});
