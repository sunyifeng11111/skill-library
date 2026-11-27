// @vitest-environment happy-dom

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp } from "../src/app";
import type { AgentGateway, DesktopGateway, LibrarySnapshot } from "../src/shared/library";
import type { PackageProposal } from "../src/shared/online";
import type { PackageUpdateCheck, UpdateGateway } from "../src/shared/updates";

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
  document.documentElement.lang = "zh-CN";
});

const sampleProposal: PackageProposal = {
  name: "awesome-skills",
  origin: { repository: "https://github.com/acme/awesome-skills", reference: "main" },
  revision: "abc1234",
  members: [
    {
      path: "/tmp/preview/writer",
      name: "Pro Writer",
      description: "写作助手",
      folderName: "writer",
      fingerprint: "fp-writer",
      status: "ready",
      alreadyInstalled: false,
      source: {
        repository: "https://github.com/acme/awesome-skills",
        memberPath: "skills/writer",
        revision: "abc1234",
        reference: "main",
      },
    },
  ],
  problems: [],
};

function makeMember(
  slug: string,
  name: string,
  options?: { status?: "ready" | "duplicate"; alreadyInstalled?: boolean },
): PackageProposal["members"][number] {
  return {
    path: `/tmp/preview/${slug}`,
    name,
    description: `${name} 描述`,
    folderName: slug,
    fingerprint: `fp-${slug}`,
    status: options?.status ?? "ready",
    alreadyInstalled: options?.alreadyInstalled ?? false,
    source: {
      repository: "https://github.com/acme/awesome-skills",
      memberPath: `skills/${slug}`,
      revision: "abc1234",
      reference: "main",
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeUpdateGateway(overrides?: Partial<UpdateGateway>): UpdateGateway {
  return {
    check: vi.fn().mockResolvedValue([]),
    checkOne: vi.fn(),
    preview: vi.fn(),
    apply: vi.fn(),
    attach: vi.fn(),
    ...overrides,
  };
}

async function openOnlinePreview(
  proposal: PackageProposal,
  options?: {
    initial?: LibrarySnapshot;
    agents?: AgentGateway;
    updates?: UpdateGateway;
    commitImport?: DesktopGateway["library"]["commitImport"];
  },
) {
  const initial: LibrarySnapshot = options?.initial ?? {
    categories: [],
    skills: [],
    agents: [],
    assignments: [],
  };

  const desktop: DesktopGateway = {
    chooseFolders: vi.fn().mockResolvedValue([]),
    onFolderDrag: vi.fn().mockResolvedValue(() => {}),
    online: {
      reserve: vi.fn().mockResolvedValue("preview-1"),
      read: vi.fn().mockResolvedValue(proposal),
      discard: vi.fn().mockResolvedValue(undefined),
    },
    agents: options?.agents,
    updates: options?.updates,
    library: {
      snapshot: vi.fn().mockResolvedValue(initial),
      previewFolders: vi.fn().mockResolvedValue([]),
      commitImport: options?.commitImport ?? vi.fn(),
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

  fireEvent.click(screen.getByRole("button", { name: "添加到 Skill 库" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "在线安装" }));

  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("安装命令或 HTTPS 仓库链接"), {
    target: { value: "npx skills add acme/awesome-skills" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "预览来源" }));
  await within(dialog).findByRole("heading", { name: "安装预览" });
  return dialog;
}

function makeAgentsGateway(overrides?: Partial<AgentGateway>): AgentGateway {
  return {
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
    ...overrides,
  };
}

describe("online skill installation (React + coss ui)", () => {
  it("reads an online source, previews members, and installs without preset tool selection", async () => {
    const initial: LibrarySnapshot = {
      categories: [],
      skills: [],
      agents: [
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
      lastInstallAgents: ["codex"],
    };

    const libraryCommitImport = vi.fn().mockResolvedValue({
      library: {
        ...initial,
        categories: [{ id: "awesome", name: "awesome-skills" }],
        skills: [
          {
            id: "writer-1",
            name: "Pro Writer",
            description: "写作助手",
            folderName: "writer",
            fingerprint: "fp-writer",
            categoryId: "awesome",
            source: sampleProposal.members[0].source,
          },
        ],
      },
      added: ["writer-1"],
      duplicates: 0,
    });

    const agents = makeAgentsGateway();
    const dialog = await openOnlinePreview(sampleProposal, {
      initial,
      agents,
      commitImport: libraryCommitImport,
    });

    expect(await within(dialog).findByText("Pro Writer")).toBeTruthy();
    expect(within(dialog).queryByText("初始 Agent")).toBeNull();
    expect(within(dialog).queryByRole("checkbox", { name: "Codex" })).toBeNull();
    expect(agents.previewInstall).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "安装 1 项" }));
    await waitFor(() =>
      expect(libraryCommitImport).toHaveBeenCalledWith(expect.any(Array), {
        kind: "new",
        name: "awesome-skills",
      }),
    );
    expect(agents.commitImport).not.toHaveBeenCalled();
    expect(await screen.findByText("Pro Writer")).toBeTruthy();
  });

  it("checks category auto-sync conflicts without showing preset tool selection", async () => {
    const initial: LibrarySnapshot = {
      categories: [{ id: "writing", name: "写作" }],
      skills: [],
      agents: [
        {
          id: "codex",
          kind: "codex",
          name: "Codex",
          directory: "/Users/dev/.codex/skills",
          syncedCategories: ["writing"],
          syncUncategorized: false,
        },
      ],
      assignments: [],
    };

    const agents = makeAgentsGateway({
      previewInstall: vi.fn().mockResolvedValue({
        targets: [{ agentId: "codex", direct: false, viaCategory: true }],
        conflicts: [],
      }),
    });

    const dialog = await openOnlinePreview(sampleProposal, { initial, agents });
    expect(within(dialog).queryByText("初始 Agent")).toBeNull();

    fireEvent.click(within(dialog).getByRole("combobox", { name: "目标分类" }));
    const writingOption = await screen.findByRole("option", { name: "写作" });
    fireEvent.pointerDown(writingOption);
    fireEvent.click(writingOption);

    await waitFor(() =>
      expect(agents.previewInstall).toHaveBeenCalledWith(
        ["writer"],
        { kind: "existing", id: "writing" },
        [],
      ),
    );
    expect(await within(dialog).findByText("安装后将随分类自动同步到 Codex")).toBeTruthy();
  });

  it("supports tri-state select all for installable preview members while skipping duplicates", async () => {
    const dialog = await openOnlinePreview({
      name: "awesome-skills",
      origin: { repository: "https://github.com/acme/awesome-skills", reference: "main" },
      revision: "abc1234",
      members: [
        makeMember("writer", "Pro Writer"),
        makeMember("reviewer", "Code Reviewer"),
        makeMember("existing", "Existing Skill", {
          status: "duplicate",
          alreadyInstalled: true,
        }),
      ],
      problems: [],
    });

    const selectAll = within(dialog).getByRole("checkbox", { name: "全选" });
    const writerCheckbox = within(dialog).getByRole("checkbox", { name: "Pro Writer" });
    const reviewerCheckbox = within(dialog).getByRole("checkbox", { name: "Code Reviewer" });
    const existingCheckbox = within(dialog).getByRole("checkbox", { name: "Existing Skill" });

    expect(selectAll.getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).getByText("已选 2 / 3")).toBeTruthy();
    expect(within(dialog).getByText("可安装 2 项")).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "安装 2 项" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(existingCheckbox.getAttribute("aria-checked")).toBe("false");
    expect(existingCheckbox.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(selectAll);
    expect(selectAll.getAttribute("aria-checked")).toBe("false");
    expect(writerCheckbox.getAttribute("aria-checked")).toBe("false");
    expect(reviewerCheckbox.getAttribute("aria-checked")).toBe("false");
    expect(within(dialog).getByText("已选 0 / 3")).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "安装 0 项" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(writerCheckbox);
    expect(selectAll.getAttribute("aria-checked")).toBe("mixed");
    expect(writerCheckbox.getAttribute("aria-checked")).toBe("true");
    expect(reviewerCheckbox.getAttribute("aria-checked")).toBe("false");
    expect(within(dialog).getByText("已选 1 / 3")).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "安装 1 项" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(selectAll);
    expect(selectAll.getAttribute("aria-checked")).toBe("true");
    expect(writerCheckbox.getAttribute("aria-checked")).toBe("true");
    expect(reviewerCheckbox.getAttribute("aria-checked")).toBe("true");
    expect(existingCheckbox.getAttribute("aria-checked")).toBe("false");
    expect(existingCheckbox.getAttribute("aria-disabled")).toBe("true");
    expect(within(dialog).getByText("已选 2 / 3")).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "安装 2 项" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("disables select all when all preview members are duplicates", async () => {
    const dialog = await openOnlinePreview({
      name: "awesome-skills",
      origin: { repository: "https://github.com/acme/awesome-skills", reference: "main" },
      revision: "abc1234",
      members: [
        makeMember("existing-a", "Existing A", { status: "duplicate", alreadyInstalled: true }),
        makeMember("existing-b", "Existing B", { status: "duplicate", alreadyInstalled: false }),
      ],
      problems: [],
    });

    const selectAll = within(dialog).getByRole("checkbox", { name: "全选" });
    expect(selectAll.getAttribute("aria-checked")).toBe("false");
    expect(selectAll.getAttribute("aria-disabled")).toBe("true");
    expect(within(dialog).getByText("可安装 0 项")).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "安装 0 项" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps the dialog open when clicking the backdrop while downloading taste-skill and finishes installing", async () => {
    const tasteProposal: PackageProposal = {
      name: "taste-skill",
      origin: { repository: "https://github.com/leonxlnx/taste-skill.git", reference: "refs/heads/main" },
      revision: "d1a2bb41d927083ac7118f60cfc9cdf711810ea0",
      members: [
        {
          path: "/tmp/preview/taste-skill",
          name: "design-taste-frontend",
          description: "tasteskill 2.5.1, the anti-slop frontend skill.",
          folderName: "taste-skill",
          fingerprint: "fp-taste-skill",
          status: "ready",
          alreadyInstalled: false,
          source: {
            repository: "https://github.com/leonxlnx/taste-skill.git",
            memberPath: "skills/taste-skill",
            revision: "d1a2bb41d927083ac7118f60cfc9cdf711810ea0",
            reference: "refs/heads/main",
          },
        },
      ],
      problems: [],
    };
    const initial: LibrarySnapshot = {
      categories: [],
      skills: [],
      agents: [],
      assignments: [],
    };
    let resolveRead!: (proposal: PackageProposal) => void;
    const readPromise = new Promise<PackageProposal>((resolve) => {
      resolveRead = resolve;
    });
    const discard = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn(
      (
        _id: string,
        _input: string,
        onProgress: (progress: "resolving" | "downloading" | "readingMembers") => void,
      ) => {
        onProgress("resolving");
        onProgress("downloading");
        return readPromise;
      },
    );
    const commitImport = vi.fn().mockResolvedValue({
      library: {
        ...initial,
        categories: [{ id: "taste", name: "taste-skill" }],
        skills: [
          {
            id: "taste-1",
            name: "design-taste-frontend",
            description: "tasteskill 2.5.1, the anti-slop frontend skill.",
            folderName: "taste-skill",
            fingerprint: "fp-taste-skill",
            categoryId: "taste",
            source: tasteProposal.members[0].source,
          },
        ],
      },
      added: ["taste-1"],
      duplicates: 0,
    });

    const desktop: DesktopGateway = {
      chooseFolders: vi.fn().mockResolvedValue([]),
      onFolderDrag: vi.fn().mockResolvedValue(() => {}),
      online: {
        reserve: vi.fn().mockResolvedValue("preview-taste"),
        read,
        discard,
      },
      library: {
        snapshot: vi.fn().mockResolvedValue(initial),
        previewFolders: vi.fn().mockResolvedValue([]),
        commitImport,
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

    fireEvent.click(screen.getByRole("button", { name: "添加到 Skill 库" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "在线安装" }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("安装命令或 HTTPS 仓库链接"), {
      target: { value: "https://github.com/Leonxlnx/taste-skill" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "预览来源" }));

    expect(await within(dialog).findByText("正在下载仓库…")).toBeTruthy();

    for (const target of [
      document.querySelector('[data-slot="dialog-viewport"]'),
      document.querySelector('[data-slot="dialog-backdrop"]'),
    ]) {
      expect(target).toBeTruthy();
      fireEvent.pointerDown(target!, { button: 0 });
      fireEvent.pointerUp(target!, { button: 0 });
      fireEvent.click(target!, { button: 0 });
    }

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(within(screen.getByRole("dialog")).getByText("正在下载仓库…")).toBeTruthy();
    });
    expect(discard).not.toHaveBeenCalled();

    resolveRead(tasteProposal);

    await within(screen.getByRole("dialog")).findByRole("heading", { name: "安装预览" });
    expect(within(screen.getByRole("dialog")).getByText("design-taste-frontend")).toBeTruthy();

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "安装 1 项" }));
    await waitFor(() =>
      expect(commitImport).toHaveBeenCalledWith(
        [
          {
            path: "/tmp/preview/taste-skill",
            source: tasteProposal.members[0].source,
            fingerprint: "fp-taste-skill",
          },
        ],
        { kind: "new", name: "taste-skill" },
      ),
    );
    expect(await screen.findByText("design-taste-frontend")).toBeTruthy();
  });

  it("keeps the dialog open when clicking the backdrop on the preview step", async () => {
    const discard = vi.fn().mockResolvedValue(undefined);
    const initial: LibrarySnapshot = {
      categories: [],
      skills: [],
      agents: [],
      assignments: [],
    };
    const desktop: DesktopGateway = {
      chooseFolders: vi.fn().mockResolvedValue([]),
      onFolderDrag: vi.fn().mockResolvedValue(() => {}),
      online: {
        reserve: vi.fn().mockResolvedValue("preview-1"),
        read: vi.fn().mockResolvedValue(sampleProposal),
        discard,
      },
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

    fireEvent.click(screen.getByRole("button", { name: "添加到 Skill 库" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "在线安装" }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("安装命令或 HTTPS 仓库链接"), {
      target: { value: "npx skills add acme/awesome-skills" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "预览来源" }));
    await within(dialog).findByRole("heading", { name: "安装预览" });

    for (const target of [
      document.querySelector('[data-slot="dialog-viewport"]'),
      document.querySelector('[data-slot="dialog-backdrop"]'),
    ]) {
      expect(target).toBeTruthy();
      fireEvent.pointerDown(target!, { button: 0 });
      fireEvent.pointerUp(target!, { button: 0 });
      fireEvent.click(target!, { button: 0 });
    }

    await waitFor(() => {
      expect(within(screen.getByRole("dialog")).getByRole("heading", { name: "安装预览" })).toBeTruthy();
    });
    expect(discard).not.toHaveBeenCalled();
  });

  it("allows explicit Cancel and Escape during loading and ignores stale read settlement", async () => {
    const initial: LibrarySnapshot = {
      categories: [],
      skills: [],
      agents: [],
      assignments: [],
    };

    for (const trigger of ["cancel", "escape"] as const) {
      let resolveRead!: (proposal: PackageProposal) => void;
      let rejectRead!: (err: Error) => void;
      const readPromise = new Promise<PackageProposal>((resolve, reject) => {
        resolveRead = resolve;
        rejectRead = reject;
      });
      const discard = vi.fn().mockResolvedValue(undefined);
      const desktop: DesktopGateway = {
        chooseFolders: vi.fn().mockResolvedValue([]),
        onFolderDrag: vi.fn().mockResolvedValue(() => {}),
        online: {
          reserve: vi.fn().mockResolvedValue(`preview-${trigger}`),
          read: vi.fn((_id, _input, onProgress) => {
            onProgress("downloading");
            return readPromise;
          }),
          discard,
        },
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

      fireEvent.click(screen.getByRole("button", { name: "添加到 Skill 库" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "在线安装" }));

      const dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText("安装命令或 HTTPS 仓库链接"), {
        target: { value: "https://github.com/Leonxlnx/taste-skill" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "预览来源" }));
      expect(await within(dialog).findByText("正在下载仓库…")).toBeTruthy();

      if (trigger === "cancel") {
        fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
      } else {
        fireEvent.keyDown(document, { key: "Escape" });
      }

      await waitFor(() => expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull());
      expect(discard).toHaveBeenCalledWith(`preview-${trigger}`);

      if (trigger === "cancel") {
        resolveRead(sampleProposal);
      } else {
        rejectRead(new Error("late failure"));
      }
      await Promise.resolve();
      expect(screen.queryByRole("dialog")).toBeNull();

      stop();
      stop = undefined;
      document.body.innerHTML = "";
    }
  });

  it("blocks outside click and Escape while saving an online import", async () => {
    let resolveCommit!: (value: Awaited<ReturnType<DesktopGateway["library"]["commitImport"]>>) => void;
    const commitPromise = new Promise<
      Awaited<ReturnType<DesktopGateway["library"]["commitImport"]>>
    >((resolve) => {
      resolveCommit = resolve;
    });
    const commitImport = vi.fn().mockReturnValue(commitPromise);

    const dialog = await openOnlinePreview(sampleProposal, { commitImport });
    fireEvent.click(within(dialog).getByRole("button", { name: "安装 1 项" }));

    await waitFor(() =>
      expect(
        (within(dialog).getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );

    const viewport = document.querySelector('[data-slot="dialog-viewport"]');
    expect(viewport).toBeTruthy();
    fireEvent.pointerDown(viewport!, { button: 0 });
    fireEvent.pointerUp(viewport!, { button: 0 });
    fireEvent.click(viewport!, { button: 0 });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).getByRole("heading", { name: "安装预览" })).toBeTruthy();

    resolveCommit({
      library: {
        categories: [{ id: "awesome", name: "awesome-skills" }],
        skills: [
          {
            id: "writer-1",
            name: "Pro Writer",
            description: "写作助手",
            folderName: "writer",
            fingerprint: "fp-writer",
            categoryId: "awesome",
            source: sampleProposal.members[0].source,
          },
        ],
        agents: [],
        assignments: [],
      },
      added: ["writer-1"],
      duplicates: 0,
    });

    await waitFor(() =>
      expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull(),
    );
    expect(screen.queryByRole("heading", { name: "安装预览" })).toBeNull();
    expect(await screen.findByText("Pro Writer")).toBeTruthy();
  });

  it("syncs tracked online sources immediately and triggers an update check after installing into an empty library", async () => {
    const initial: LibrarySnapshot = {
      categories: [],
      skills: [],
      agents: [],
      assignments: [],
    };
    const installedLibrary: LibrarySnapshot = {
      ...initial,
      categories: [{ id: "awesome", name: "awesome-skills" }],
      skills: [
        {
          id: "writer-1",
          name: "Pro Writer",
          description: "写作助手",
          folderName: "writer",
          fingerprint: "fp-writer",
          categoryId: "awesome",
          source: sampleProposal.members[0].source,
        },
      ],
    };

    const secondCheck = deferred<PackageUpdateCheck[]>();
    const check = vi
      .fn<UpdateGateway["check"]>()
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(secondCheck.promise);

    const dialog = await openOnlinePreview(sampleProposal, {
      initial,
      updates: makeUpdateGateway({ check }),
      commitImport: vi.fn().mockResolvedValue({
        library: installedLibrary,
        added: ["writer-1"],
        duplicates: 0,
      }),
    });

    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));

    fireEvent.click(within(dialog).getByRole("button", { name: "安装 1 项" }));
    await waitFor(() => expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull());
    expect(check).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "更新中心" }));
    const main = screen.getByRole("main");
    expect(await within(main).findByText("你的 1 个在线 Skill 都是最新版本")).toBeTruthy();
    expect(within(main).getByText("正在检查更新…")).toBeTruthy();

    fireEvent.click(within(main).getByRole("button", { name: /已追踪的在线来源/ }));
    expect(await within(main).findByText("awesome-skills")).toBeTruthy();

    secondCheck.resolve([
      {
        package: { repository: sampleProposal.origin.repository, reference: sampleProposal.origin.reference },
        memberIds: ["writer-1"],
        status: "current",
        revision: sampleProposal.revision,
        error: null,
      },
    ]);

    expect(await within(main).findByText("刚刚检查 · 无需任何操作")).toBeTruthy();
    expect(within(main).getByText("awesome-skills")).toBeTruthy();
  });

  it("keeps newly installed online source and rechecks when startup check was still in flight", async () => {
    const initial: LibrarySnapshot = {
      categories: [],
      skills: [],
      agents: [],
      assignments: [],
    };
    const installedLibrary: LibrarySnapshot = {
      ...initial,
      categories: [{ id: "awesome", name: "awesome-skills" }],
      skills: [
        {
          id: "writer-1",
          name: "Pro Writer",
          description: "写作助手",
          folderName: "writer",
          fingerprint: "fp-writer",
          categoryId: "awesome",
          source: sampleProposal.members[0].source,
        },
      ],
    };

    const firstCheck = deferred<PackageUpdateCheck[]>();
    const secondCheck = deferred<PackageUpdateCheck[]>();
    const check = vi
      .fn<UpdateGateway["check"]>()
      .mockReturnValueOnce(firstCheck.promise)
      .mockReturnValueOnce(secondCheck.promise);

    const dialog = await openOnlinePreview(sampleProposal, {
      initial,
      updates: makeUpdateGateway({ check }),
      commitImport: vi.fn().mockResolvedValue({
        library: installedLibrary,
        added: ["writer-1"],
        duplicates: 0,
      }),
    });

    expect(check).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "安装 1 项" }));
    await waitFor(() => expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "更新中心" }));
    const main = screen.getByRole("main");
    fireEvent.click(await within(main).findByRole("button", { name: /已追踪的在线来源/ }));
    expect(await within(main).findByText("awesome-skills")).toBeTruthy();

    // Stale startup check finishes with pre-install empty list; should be ignored and trigger a recheck.
    firstCheck.resolve([]);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    expect(within(main).getByText("awesome-skills")).toBeTruthy();

    secondCheck.resolve([
      {
        package: { repository: sampleProposal.origin.repository, reference: sampleProposal.origin.reference },
        memberIds: ["writer-1"],
        status: "current",
        revision: sampleProposal.revision,
        error: null,
      },
    ]);

    expect(await within(main).findByText("刚刚检查 · 无需任何操作")).toBeTruthy();
    expect(within(main).getByText("awesome-skills")).toBeTruthy();
  });

  it("updates an existing tracked source with newly installed members and available status", async () => {
    const repo = sampleProposal.origin.repository;
    const ref = sampleProposal.origin.reference;
    const initial: LibrarySnapshot = {
      categories: [{ id: "awesome", name: "awesome-skills" }],
      skills: [
        {
          id: "s-old",
          name: "Legacy Skill",
          description: "旧版本成员",
          folderName: "legacy",
          fingerprint: "fp-legacy",
          categoryId: "awesome",
          source: {
            repository: repo,
            memberPath: "skills/legacy",
            revision: "old-rev",
            reference: ref,
          },
        },
      ],
      agents: [],
      assignments: [],
    };
    const updatedLibrary: LibrarySnapshot = {
      ...initial,
      skills: [
        ...initial.skills,
        {
          id: "writer-1",
          name: "Pro Writer",
          description: "写作助手",
          folderName: "writer",
          fingerprint: "fp-writer",
          categoryId: "awesome",
          source: sampleProposal.members[0].source,
        },
      ],
    };

    const initialEntry: PackageUpdateCheck = {
      package: { repository: repo, reference: ref },
      memberIds: ["s-old"],
      status: "current",
      revision: "old-rev",
      error: null,
    };
    const syncedEntry: PackageUpdateCheck = {
      package: { repository: repo, reference: ref },
      memberIds: ["s-old", "writer-1"],
      status: "available",
      revision: sampleProposal.revision,
      error: null,
    };
    const secondCheck = deferred<PackageUpdateCheck[]>();
    const check = vi
      .fn<UpdateGateway["check"]>()
      .mockResolvedValueOnce([initialEntry])
      .mockReturnValueOnce(secondCheck.promise);

    const dialog = await openOnlinePreview(sampleProposal, {
      initial,
      updates: makeUpdateGateway({ check }),
      commitImport: vi.fn().mockResolvedValue({
        library: updatedLibrary,
        added: ["writer-1"],
        duplicates: 0,
      }),
    });

    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));

    fireEvent.click(within(dialog).getByRole("button", { name: "安装 1 项" }));
    await waitFor(() => expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull());
    expect(check).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "更新中心" }));
    expect(await screen.findByText("有 1 个 Skill 可更新")).toBeTruthy();
    expect(screen.getByText("Legacy Skill")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /已追踪的在线来源/ }));
    expect(await screen.findByText(/已安装 2 个 Skill：Legacy Skill、Pro Writer/)).toBeTruthy();

    secondCheck.resolve([syncedEntry]);
    await waitFor(() => expect(screen.queryByText("正在检查更新…")).toBeNull());
    expect(screen.getByText("有 1 个 Skill 可更新")).toBeTruthy();
  });

  it("does not recheck updates when all committed skills were duplicates", async () => {
    const initial: LibrarySnapshot = {
      categories: [],
      skills: [],
      agents: [],
      assignments: [],
    };
    const firstCheck = deferred<PackageUpdateCheck[]>();
    const check = vi.fn<UpdateGateway["check"]>().mockReturnValueOnce(firstCheck.promise);

    const dialog = await openOnlinePreview(sampleProposal, {
      initial,
      updates: makeUpdateGateway({ check }),
      commitImport: vi.fn().mockResolvedValue({
        library: initial,
        added: [],
        duplicates: 1,
      }),
    });

    firstCheck.resolve([]);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));

    fireEvent.click(within(dialog).getByRole("button", { name: "安装 1 项" }));
    await waitFor(() => expect(document.querySelector('[data-slot="dialog-popup"]')).toBeNull());
    expect(check).toHaveBeenCalledTimes(1);
  });
});
