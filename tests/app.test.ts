// @vitest-environment happy-dom

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp } from "../src/app";
import type { DesktopGateway, FolderDrag, LibrarySnapshot, PreviewMember } from "../src/shared/library";

const first: PreviewMember = {
  name: "Writing Outline",
  description: "规划长文的结构",
  path: "/isolated/outline",
  folderName: "outline",
  fingerprint: "outline-digest",
  status: "ready",
};

const second: PreviewMember = {
  name: "Prose Polish",
  description: "检查段落表述",
  path: "/isolated/polish",
  folderName: "polish",
  fingerprint: "polish-digest",
  status: "ready",
};

function localRow(member: PreviewMember) {
  return {
    ...member,
    status: "directory" as const,
    agentKind: null,
    agentId: null,
    reason: null,
    sourceName: "Files",
    sourceDirectory: "/isolated",
    target: null,
    identity: member.path,
  };
}

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
  document.documentElement.lang = "zh-CN";
  delete document.documentElement.dataset.colorScheme;
  document.documentElement.classList.remove("dark");
  window.localStorage.removeItem("skill-library:view-mode");
});

function createGateway(
  initial: LibrarySnapshot,
  overrides: Partial<DesktopGateway> = {},
  libraryOverrides: Partial<DesktopGateway["library"]> = {},
): DesktopGateway {
  return {
    chooseFolders: vi.fn().mockResolvedValue([]),
    onFolderDrag: vi.fn().mockResolvedValue(() => {}),
    ...overrides,
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
      ...libraryOverrides,
    },
  };
}

describe("desktop application entry (React + coss ui)", () => {
  it("renders empty onboarding and imports selected skills from local folders", async () => {
    const commitImport = vi.fn().mockResolvedValue({
      library: {
        categories: [{ id: "writing", name: "写作" }],
        skills: [{ ...first, id: "outline", categoryId: "writing", source: null }],
      },
      added: ["outline"],
      duplicates: 0,
    });
    const gateway = createGateway(
      { categories: [{ id: "writing", name: "写作" }], skills: [] },
      { chooseFolders: vi.fn().mockResolvedValue([first.path, second.path]) },
      {
        previewFolders: vi.fn().mockResolvedValue([localRow(first), localRow(second)]),
        commitImport,
      },
    );

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, gateway);

    expect(await screen.findByText("开始统一管理你的 Skill")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "从文件夹添加" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("找到 2 个可以添加的 Skill")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "选择要添加的 Skill…" }));
    const checkboxes = within(dialog).getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    // Uncheck the first item alphabetically ("Prose Polish")
    fireEvent.click(checkboxes[0]);

    fireEvent.click(within(dialog).getByRole("button", { name: "添加所选（1）" }));

    await waitFor(() => expect(commitImport).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Writing Outline")).toBeTruthy();
  });

  it("uses the current category for dropped folders and filters by search", async () => {
    let dragListener: ((event: FolderDrag) => void) | undefined;
    const commitImport = vi.fn().mockResolvedValue({
      library: {
        categories: [{ id: "writing", name: "写作" }],
        skills: [
          { ...first, id: "outline", categoryId: "writing", source: null },
          { ...second, id: "polish", categoryId: "writing", source: null },
        ],
      },
      added: ["polish"],
      duplicates: 0,
    });

    const gateway = createGateway(
      {
        categories: [{ id: "writing", name: "写作" }],
        skills: [{ ...first, id: "outline", categoryId: "writing", source: null }],
      },
      {
        onFolderDrag: vi.fn().mockImplementation(async (listener) => {
          dragListener = listener;
          return () => {};
        }),
      },
      {
        previewFolders: vi.fn().mockResolvedValue([localRow(second)]),
        commitImport,
      },
    );

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, gateway);

    fireEvent.click(screen.getByRole("button", { name: "写作" }));
    await waitFor(() => expect(dragListener).toBeDefined());

    dragListener!({ type: "drop", paths: [second.path] });

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "全部添加（1）" }));

    await waitFor(() =>
      expect(commitImport).toHaveBeenCalledWith(
        expect.any(Array),
        { kind: "existing", id: "writing" },
        true,
        expect.any(Object),
      ),
    );

    const search = screen.getByRole("searchbox", { name: "搜索名称或用途" });
    fireEvent.change(search, { target: { value: "段落" } });
    expect(screen.getByText("Prose Polish")).toBeTruthy();
    expect(screen.queryByText("Writing Outline")).toBeNull();
  });

  it("creates a category, moves selected skills, undoes move, and shows skill details", async () => {
    const createCategory = vi.fn().mockResolvedValue({
      categories: [{ id: "coding", name: "编程" }],
      skills: [{ ...first, id: "outline", categoryId: null, source: null }],
    });
    const moveSkills = vi.fn().mockResolvedValue({
      library: {
        categories: [{ id: "coding", name: "编程" }],
        skills: [{ ...first, id: "outline", categoryId: "coding", source: null }],
      },
      moved: 1,
      undo: "undo-1",
    });
    const undoMove = vi.fn().mockResolvedValue({
      categories: [{ id: "coding", name: "编程" }],
      skills: [{ ...first, id: "outline", categoryId: null, source: null }],
    });

    const gateway = createGateway(
      {
        categories: [],
        skills: [{ ...first, id: "outline", categoryId: null, source: null }],
      },
      {},
      { createCategory, moveSkills, undoMove },
    );

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, gateway);

    // Create category
    fireEvent.click(screen.getByRole("button", { name: "新建分类" }));
    const createDialog = await screen.findByRole("dialog");
    fireEvent.change(within(createDialog).getByLabelText("分类名称"), {
      target: { value: "编程" },
    });
    fireEvent.click(within(createDialog).getByRole("button", { name: "创建分类" }));
    await waitFor(() => expect(createCategory).toHaveBeenCalledWith("编程"));

    // Back to all skills and open detail
    fireEvent.click(screen.getByRole("button", { name: "全部 Skill" }));
    fireEvent.click(await screen.findByText("Writing Outline"));
    const detailDialog = await screen.findByRole("dialog");
    expect(await within(detailDialog).findByText("/managed/outline")).toBeTruthy();
    fireEvent.click(within(detailDialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Select and move
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Writing Outline" }));
    fireEvent.click(screen.getByRole("button", { name: "移至分类" }));
    const moveDialog = await screen.findByRole("dialog");
    fireEvent.click(within(moveDialog).getByRole("button", { name: "移至分类" }));
    await waitFor(() => expect(moveSkills).toHaveBeenCalledTimes(1));

    // Undo via toast action
    const undoBtn = await screen.findByRole("button", { name: "撤销移动" });
    fireEvent.click(undoBtn);
    await waitFor(() => expect(undoMove).toHaveBeenCalledWith("undo-1"));
  });

  it("toggles desktop sidebar compact rail cleanly without duplicating nav buttons and caps >5 agent icons", async () => {
    const agents = [
      { id: "a1", kind: "claudeCode", name: "Claude Code", directory: "/a/1", syncedCategories: [], syncUncategorized: false },
      { id: "a2", kind: "codex", name: "Codex", directory: "/a/2", syncedCategories: [], syncUncategorized: false },
      { id: "a3", kind: "cursor", name: "Cursor", directory: "/a/3", syncedCategories: [], syncUncategorized: false },
      { id: "a4", kind: "githubCopilot", name: "GitHub Copilot", directory: "/a/4", syncedCategories: [], syncUncategorized: false },
      { id: "a5", kind: "antigravity", name: "Antigravity", directory: "/a/5", syncedCategories: [], syncUncategorized: false },
      { id: "a6", kind: "opencode", name: "OpenCode", directory: "/a/6", syncedCategories: [], syncUncategorized: false },
    ];
    const assignments = agents.map((agent) => ({
      agentId: agent.id,
      skillId: "outline",
      direct: true,
      viaCategory: false,
      excluded: false,
      path: `${agent.directory}/outline`,
    }));

    const gateway = createGateway({
      categories: [],
      skills: [{ ...first, id: "outline", categoryId: null, source: null }],
      agents,
      assignments,
    });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, gateway);

    // Caps 6 enabled agents at 4 icon chips + "+2" overflow indicator
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByLabelText("还有 2 个已启用工具").getAttribute("title")).toBe("Antigravity、OpenCode");

    // Sidebar expanded: compact rail does not duplicate "全部 Skill" button
    expect(screen.getAllByRole("button", { name: "全部 Skill" })).toHaveLength(1);

    // Collapse desktop sidebar -> inline compact rail mounts quick buttons
    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(screen.getAllByRole("button", { name: "全部 Skill" })).toHaveLength(2);

    // Expand desktop sidebar -> compact rail quick buttons unmount
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(screen.getAllByRole("button", { name: "全部 Skill" })).toHaveLength(1);
  });

  it("prevents double-click selection/focus leak on titlebar drag region without blocking search input", async () => {
    const gateway = createGateway({
      categories: [],
      skills: [{ ...first, id: "outline", categoryId: null, source: null }],
    });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, gateway);

    const breadcrumb = screen.getByTitle("Skill 库 ／ 全部 Skill");
    const dragDblDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 2,
    });
    breadcrumb.dispatchEvent(dragDblDown);
    expect(dragDblDown.defaultPrevented).toBe(true);

    const search = screen.getByLabelText("搜索名称或用途");
    const searchDblDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      detail: 2,
    });
    search.dispatchEvent(searchDblDown);
    expect(searchDblDown.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(search);
  });

  it("renders enabled tools as compact chips in skill detail dialog with on-demand paths and collapsible technical details", async () => {
    const agents = [
      { id: "a1", kind: "codex", name: "Codex", directory: "/Users/dev/.codex/skills", syncedCategories: [], syncUncategorized: false },
      { id: "a2", kind: "droid", name: "Droid", directory: "/Users/dev/.factory/skills", syncedCategories: ["writing"], syncUncategorized: false },
    ];
    const assignments = [
      {
        agentId: "a1",
        skillId: "outline",
        direct: true,
        viaCategory: false,
        excluded: false,
        path: "/Users/dev/.codex/skills/outline",
      },
      {
        agentId: "a2",
        skillId: "outline",
        direct: false,
        viaCategory: true,
        excluded: false,
        path: "/Users/dev/.factory/skills/outline",
      },
    ];

    const gateway = createGateway({
      categories: [{ id: "writing", name: "写作" }],
      skills: [
        {
          ...first,
          id: "outline",
          categoryId: "writing",
          localOrigins: ["Codex"],
          source: {
            repository: "https://github.com/example/skills.git",
            reference: "refs/heads/main",
            memberPath: "skills/outline",
            revision: "abc1234",
          },
        },
      ],
      agents,
      assignments,
    });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, gateway);

    fireEvent.click(await screen.findByText("Writing Outline"));
    const detailDialog = await screen.findByRole("dialog");

    // Description & local origin shown cleanly; category badge shown once in header
    expect(within(detailDialog).getByText("规划长文的结构")).toBeTruthy();
    expect(within(detailDialog).getByText("添加自 Codex")).toBeTruthy();
    expect(within(detailDialog).getAllByText("写作")).toHaveLength(1);

    // Enabled tools shown as compact chips without tool paths by default
    expect(within(detailDialog).getByText("已启用的工具（2）")).toBeTruthy();
    expect(within(detailDialog).getByText("Codex")).toBeTruthy();
    expect(within(detailDialog).getByText("Droid")).toBeTruthy();
    expect(within(detailDialog).queryByText("/Users/dev/.codex/skills/outline")).toBeNull();
    expect(within(detailDialog).queryByText("工具中的位置")).toBeNull();

    // Expanding tool paths reveals unified path rows
    fireEvent.click(within(detailDialog).getByRole("button", { name: "显示路径" }));
    expect(within(detailDialog).getByText("/Users/dev/.codex/skills/outline")).toBeTruthy();
    expect(within(detailDialog).getByText("/Users/dev/.factory/skills/outline")).toBeTruthy();
    fireEvent.click(within(detailDialog).getByRole("button", { name: "收起路径" }));
    expect(within(detailDialog).queryByText("/Users/dev/.codex/skills/outline")).toBeNull();

    // Source and managed path visible directly; technical metadata collapsed by default
    expect(within(detailDialog).getByText("https://github.com/example/skills.git")).toBeTruthy();
    expect(await within(detailDialog).findByText("/managed/outline")).toBeTruthy();
    expect(within(detailDialog).queryByText("skills/outline")).toBeNull();

    fireEvent.click(within(detailDialog).getByRole("button", { name: "更多技术信息" }));
    expect(within(detailDialog).getByText("refs/heads/main")).toBeTruthy();
    expect(within(detailDialog).getByText("skills/outline")).toBeTruthy();
    expect(within(detailDialog).getByText("abc1234")).toBeTruthy();
  });

  it("reorders custom categories via pointer drag while keeping Uncategorized pinned and clicks working", async () => {
    const initialCategories = [
      { id: "writing", name: "写作" },
      { id: "coding", name: "编程" },
      { id: "design", name: "设计" },
    ];
    const reorderedCategories = [
      { id: "coding", name: "编程" },
      { id: "design", name: "设计" },
      { id: "writing", name: "写作" },
    ];
    const reorderCategories = vi.fn().mockResolvedValue({
      categories: reorderedCategories,
      skills: [{ ...first, id: "outline", categoryId: "writing", source: null }],
    });

    const gateway = createGateway(
      {
        categories: initialCategories,
        skills: [{ ...first, id: "outline", categoryId: "writing", source: null }],
      },
      {},
      { reorderCategories },
    );

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, gateway);

    const categoryNav = screen.getByRole("navigation", { name: "分类" });
    const categoryLabels = () =>
      [...categoryNav.querySelectorAll("button[id^='library-nav-']")].map((el) =>
        el.getAttribute("aria-label"),
      );

    expect(categoryLabels()).toEqual(["未分类", "写作", "编程", "设计"]);

    const writingBtn = screen.getByRole("button", { name: "写作" });
    fireEvent.pointerDown(writingBtn, { button: 0, clientY: 10, pointerId: 1, isPrimary: true });
    fireEvent.pointerMove(window, { clientY: 120, pointerId: 1 });
    expect(document.body.dataset.reordering).toBe("true");

    fireEvent.pointerUp(window, { clientY: 120, pointerId: 1 });
    fireEvent.click(writingBtn);

    expect(document.body.dataset.reordering).toBeUndefined();
    await waitFor(() =>
      expect(reorderCategories).toHaveBeenCalledWith(["coding", "design", "writing"]),
    );
    expect(categoryLabels()).toEqual(["未分类", "编程", "设计", "写作"]);
    expect(screen.getByRole("button", { name: "全部 Skill" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(writingBtn.getAttribute("aria-current")).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole("button", { name: "编程" }));
    expect(screen.getByRole("button", { name: "编程" }).getAttribute("aria-current")).toBe("page");
  });

  it("cancels category drag on Escape and supports keyboard and menu reordering", async () => {
    const writing = { id: "writing", name: "写作" };
    const coding = { id: "coding", name: "编程" };
    const reorderCategories = vi
      .fn()
      .mockResolvedValueOnce({ categories: [coding, writing], skills: [] })
      .mockResolvedValueOnce({ categories: [writing, coding], skills: [] });

    const gateway = createGateway(
      { categories: [writing, coding], skills: [] },
      {},
      { reorderCategories },
    );

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, gateway);

    const categoryNav = screen.getByRole("navigation", { name: "分类" });
    const categoryLabels = () =>
      [...categoryNav.querySelectorAll("button[id^='library-nav-']")].map((el) =>
        el.getAttribute("aria-label"),
      );

    // Drag and cancel with Escape
    const writingBtn = screen.getByRole("button", { name: "写作" });
    fireEvent.pointerDown(writingBtn, { button: 0, clientY: 10, pointerId: 1, isPrimary: true });
    fireEvent.pointerMove(window, { clientY: 60, pointerId: 1 });
    expect(document.body.dataset.reordering).toBe("true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.body.dataset.reordering).toBeUndefined();
    expect(reorderCategories).not.toHaveBeenCalled();
    expect(categoryLabels()).toEqual(["未分类", "写作", "编程"]);

    // Keyboard Alt+ArrowDown moves 写作 down
    fireEvent.keyDown(writingBtn, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(reorderCategories).toHaveBeenNthCalledWith(1, ["coding", "writing"]));
    expect(categoryLabels()).toEqual(["未分类", "编程", "写作"]);

    // Menu "上移" moves 写作 back up ("下移" is disabled at bottom)
    fireEvent.click(screen.getByRole("button", { name: "写作 的更多操作" }));
    const moveDownItem = await screen.findByRole("menuitem", { name: "下移" });
    expect(moveDownItem.getAttribute("aria-disabled")).toBe("true");
    const moveUpItem = screen.getByRole("menuitem", { name: "上移" });
    fireEvent.click(moveUpItem);

    await waitFor(() => expect(reorderCategories).toHaveBeenNthCalledWith(2, ["writing", "coding"]));
    expect(categoryLabels()).toEqual(["未分类", "写作", "编程"]);
  });

  it("rolls back category order and notifies when reorder fails", async () => {
    const writing = { id: "writing", name: "写作" };
    const coding = { id: "coding", name: "编程" };
    const reorderCategories = vi.fn().mockRejectedValue(new Error("保存分类顺序失败"));

    const gateway = createGateway(
      { categories: [writing, coding], skills: [] },
      {},
      { reorderCategories },
    );

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, gateway);

    const categoryNav = screen.getByRole("navigation", { name: "分类" });
    const categoryLabels = () =>
      [...categoryNav.querySelectorAll("button[id^='library-nav-']")].map((el) =>
        el.getAttribute("aria-label"),
      );

    fireEvent.keyDown(screen.getByRole("button", { name: "写作" }), {
      key: "ArrowDown",
      altKey: true,
    });

    expect(await screen.findByText("保存分类顺序失败")).toBeTruthy();
    expect(categoryLabels()).toEqual(["未分类", "写作", "编程"]);
  });

  it("switches between clean list and card grid views, persists preference, and hides redundant category pills", async () => {
    const gateway = createGateway({
      categories: [{ id: "writing", name: "写作" }],
      skills: [
        { ...first, id: "outline", categoryId: "writing", source: null },
        { ...second, id: "polish", categoryId: "writing", source: null },
      ],
    });

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, gateway);

    const main = screen.getByRole("main");

    // Card grid view by default: no permanent table header row
    expect(within(main).queryByText("Skill 名称 / 用途")).toBeNull();
    expect(within(main).queryByRole("checkbox", { name: "选择可见成员" })).toBeNull();
    expect(screen.getByRole("button", { name: "网格视图" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    // In "全部 Skill", category pill is displayed alongside items
    const allList = within(main).getByRole("list");
    expect(within(allList).getAllByText("写作")).toHaveLength(2);

    // Navigating into category "写作" hides redundant category pills inside the list
    fireEvent.click(screen.getByRole("button", { name: "写作" }));
    const categoryList = within(main).getByRole("list");
    expect(within(categoryList).queryByText("写作")).toBeNull();

    // Switch back to All skills and switch to List view
    fireEvent.click(screen.getByRole("button", { name: "全部 Skill" }));
    const listBtn = screen.getByRole("button", { name: "列表视图" });
    fireEvent.click(listBtn);
    expect(listBtn.getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem("skill-library:view-mode")).toBe("list");

    // Restart app and confirm list view preference persists
    stop();
    stop = undefined;
    document.body.innerHTML = "";

    const root2 = document.createElement("div");
    document.body.append(root2);
    stop = await startApp(root2, gateway);
    expect(screen.getByRole("button", { name: "列表视图" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("supports Cmd/Ctrl+Click, Shift+Click, Cmd+A, Escape, floating bulk dock, and single-item menus", async () => {
    const third = {
      name: "Story Arc",
      description: "检查叙事节奏",
      path: "/isolated/arc",
      folderName: "arc",
      fingerprint: "arc-digest",
      status: "ready" as const,
    };
    const moveSkills = vi.fn().mockResolvedValue({
      library: {
        categories: [{ id: "writing", name: "写作" }],
        skills: [
          { ...first, id: "outline", categoryId: "writing", source: null },
          { ...second, id: "polish", categoryId: null, source: null },
          { ...third, id: "arc", categoryId: null, source: null },
        ],
      },
      moved: 1,
      undo: "undo-single",
    });

    const gateway = createGateway(
      {
        categories: [{ id: "writing", name: "写作" }],
        skills: [
          { ...first, id: "outline", categoryId: null, source: null },
          { ...second, id: "polish", categoryId: null, source: null },
          { ...third, id: "arc", categoryId: null, source: null },
        ],
      },
      {},
      { moveSkills },
    );

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, gateway);

    // Cmd/Ctrl+Click selects without opening skill detail dialog
    const outlineBtn = screen.getByText("Writing Outline").closest("button")!;
    fireEvent.click(outlineBtn, { metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();

    const toolbar = screen.getByRole("toolbar", { name: "批量操作" });
    expect(within(toolbar).getByText("已选 1 项")).toBeTruthy();

    // Shift+Click range-selects up to Story Arc (3 items)
    const arcBtn = screen.getByText("Story Arc").closest("button")!;
    fireEvent.click(arcBtn, { shiftKey: true });
    expect(within(toolbar).getByText("已选 3 项")).toBeTruthy();
    expect(within(toolbar).getByRole("button", { name: "取消全选" })).toBeTruthy();

    // Escape clears selection and hides floating dock
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("toolbar", { name: "批量操作" })).toBeNull();

    // Cmd/Ctrl+A selects all visible skills when focus is not in an input
    fireEvent.keyDown(document, { key: "a", metaKey: true });
    expect(
      within(screen.getByRole("toolbar", { name: "批量操作" })).getByText("已选 3 项"),
    ).toBeTruthy();

    // Clear selection via dock close button
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "批量操作" })).getByRole("button", {
        name: "取消选择",
      }),
    );
    expect(screen.queryByRole("toolbar", { name: "批量操作" })).toBeNull();

    // Hover/row quick menu moves a single item without pre-selecting checkboxes
    fireEvent.click(screen.getByRole("button", { name: "Writing Outline 的更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "移至分类…" }));
    const moveDialog = await screen.findByRole("dialog");
    fireEvent.click(within(moveDialog).getByRole("button", { name: "移至分类" }));
    await waitFor(() => expect(moveSkills).toHaveBeenCalledWith(["outline"], { kind: "uncategorized" }));

    // Right-click context menu on a skill opens single-item actions
    fireEvent.contextMenu(screen.getByText("Prose Polish").closest("button")!, {
      clientX: 120,
      clientY: 160,
    });
    expect(await screen.findByRole("menuitem", { name: "查看详情" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "选择此项" }));
    expect(
      within(screen.getByRole("toolbar", { name: "批量操作" })).getByText("已选 1 项"),
    ).toBeTruthy();
  });

  it("renders dual-channel empty state for empty categories with online and folder actions only", async () => {
    const chooseFolders = vi.fn().mockResolvedValue([]);
    const gateway = createGateway(
      {
        categories: [
          { id: "writing", name: "写作" },
          { id: "empty-cat", name: "测试分类" },
        ],
        skills: [{ ...first, id: "outline", categoryId: "writing", source: null }],
      },
      {
        chooseFolders,
        online: {
          reserve: vi.fn().mockResolvedValue("preview-empty"),
          read: vi.fn(),
          discard: vi.fn().mockResolvedValue(undefined),
        },
      },
    );

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, gateway);

    expect(await screen.findByText("Writing Outline")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "测试分类" }));

    expect(await screen.findByText("「测试分类」还是空的")).toBeTruthy();
    expect(screen.queryByText(/查找电脑里已有的 Skill/)).toBeNull();
    expect(screen.queryByText("原型方案切换")).toBeNull();

    const onlineButton = screen.getByRole("button", { name: /在线安装/ });
    const folderButton = screen.getByRole("button", { name: /从文件夹添加/ });
    expect(onlineButton).toBeTruthy();
    expect(folderButton).toBeTruthy();

    fireEvent.click(folderButton);
    await waitFor(() => expect(chooseFolders).toHaveBeenCalledTimes(1));

    fireEvent.click(onlineButton);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
