// @vitest-environment happy-dom

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp } from "../src/app";
import type { DesktopGateway, LibrarySnapshot } from "../src/shared/library";
import type { PackageUpdateCheck, UpdateGateway } from "../src/shared/updates";

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = "";
  document.documentElement.lang = "zh-CN";
});

function createGateway(initial: LibrarySnapshot, updates: UpdateGateway): DesktopGateway {
  return {
    chooseFolders: vi.fn().mockResolvedValue([]),
    onFolderDrag: vi.fn().mockResolvedValue(() => {}),
    updates,
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
}

describe("package updates center (React + coss ui)", () => {
  it("lists available updates and updates a skill to up-to-date zen state", async () => {
    const repo = "https://github.com/acme/skills";
    const initial: LibrarySnapshot = {
      categories: [{ id: "writing", name: "写作" }],
      skills: [
        {
          id: "s1",
          name: "Draft Helper",
          description: "协助起草",
          folderName: "draft-helper",
          fingerprint: "fp-1",
          categoryId: "writing",
          source: { repository: repo, memberPath: "draft", revision: "old-rev", reference: "main" },
        },
      ],
    };

    const availableCheck: PackageUpdateCheck = {
      package: { repository: repo, reference: "main" },
      memberIds: ["s1"],
      outdatedMemberIds: ["s1"],
      status: "available",
      revision: "new-rev",
      error: null,
    };

    const apply = vi.fn().mockResolvedValue({
      library: {
        ...initial,
        skills: [
          {
            ...initial.skills[0],
            source: { ...initial.skills[0].source!, revision: "new-rev" },
          },
        ],
      },
      updated: ["s1"],
      added: [],
      skipped: [],
      backup: null,
    });

    const updates: UpdateGateway = {
      check: vi.fn().mockResolvedValue([availableCheck]),
      checkOne: vi.fn().mockResolvedValue(availableCheck),
      preview: vi.fn().mockResolvedValue({ outdated: [], additions: [], additionsConfirmed: true }),
      apply,
      attach: vi.fn(),
    };

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, createGateway(initial, updates));

    fireEvent.click(screen.getByRole("button", { name: "更新中心" }));
    expect(await screen.findByText("有 1 个 Skill 可更新")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith(availableCheck.package, {
        revision: "new-rev",
        backupMembers: [],
        additions: [],
        target: null,
        memberIds: ["s1"],
      }),
    );

    expect(await screen.findByText("你的 1 个在线 Skill 都是最新版本")).toBeTruthy();
  });

  it("shows only actually changed skills from a monorepo and updates them individually", async () => {
    const repo = "https://github.com/mattpocock/skills.git";
    const oldRev = "d65391149dbb5fe76478e76fa8d5122b2aa5a70e";
    const newRev = "6f7f7831a625f040a8e06a0e7954826b87ce775a";
    const initial: LibrarySnapshot = {
      categories: [{ id: "matt", name: "Matt" }],
      skills: [
        {
          id: "s-changed",
          name: "domain-modeling",
          description: "领域建模",
          folderName: "domain-modeling",
          fingerprint: "fp-dm",
          categoryId: "matt",
          source: {
            repository: repo,
            memberPath: "skills/engineering/domain-modeling",
            revision: oldRev,
            reference: "refs/heads/main",
          },
        },
        {
          id: "s-unchanged",
          name: "tdd",
          description: "测试驱动开发",
          folderName: "tdd",
          fingerprint: "fp-tdd",
          categoryId: "matt",
          source: {
            repository: repo,
            memberPath: "skills/engineering/tdd",
            revision: oldRev,
            reference: "refs/heads/main",
          },
        },
      ],
    };

    const availableCheck: PackageUpdateCheck = {
      package: { repository: repo, reference: "refs/heads/main" },
      memberIds: ["s-changed", "s-unchanged"],
      outdatedMemberIds: ["s-changed"],
      status: "available",
      revision: newRev,
      updatedAt: 1764072503,
      error: null,
    };

    const apply = vi.fn().mockResolvedValue({
      library: {
        ...initial,
        skills: initial.skills.map((skill) => ({
          ...skill,
          source: { ...skill.source!, revision: newRev },
        })),
      },
      updated: ["s-changed"],
      added: [],
      skipped: [],
      backup: null,
    });

    const updates: UpdateGateway = {
      check: vi.fn().mockResolvedValue([availableCheck]),
      checkOne: vi.fn().mockResolvedValue(availableCheck),
      preview: vi.fn(),
      apply,
      attach: vi.fn(),
    };

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, createGateway(initial, updates));

    const navUpdatesButton = screen.getByRole("button", { name: "更新中心" });
    await waitFor(() => expect(navUpdatesButton.textContent).toContain("1"));

    fireEvent.click(navUpdatesButton);
    const main = screen.getByRole("main");
    expect(await within(main).findByText("有 1 个 Skill 可更新")).toBeTruthy();
    expect(within(main).getByText("domain-modeling")).toBeTruthy();
    expect(within(main).queryByText("tdd")).toBeNull();

    fireEvent.click(within(main).getByRole("button", { name: "更新" }));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith(availableCheck.package, {
        revision: newRev,
        backupMembers: [],
        additions: [],
        target: null,
        memberIds: ["s-changed"],
      }),
    );

    expect(await within(main).findByText("你的 2 个在线 Skill 都是最新版本")).toBeTruthy();
  });

  it("keeps remaining outdated skill available after updating only one of two changed skills", async () => {
    const repo = "https://github.com/mattpocock/skills.git";
    const oldRev = "d65391149dbb5fe76478e76fa8d5122b2aa5a70e";
    const newRev = "6f7f7831a625f040a8e06a0e7954826b87ce775a";
    const initial: LibrarySnapshot = {
      categories: [{ id: "matt", name: "Matt" }],
      skills: [
        {
          id: "s1",
          name: "domain-modeling",
          description: "领域建模",
          folderName: "domain-modeling",
          fingerprint: "fp-1",
          categoryId: "matt",
          source: {
            repository: repo,
            memberPath: "skills/engineering/domain-modeling",
            revision: oldRev,
            reference: "refs/heads/main",
          },
        },
        {
          id: "s2",
          name: "tdd",
          description: "测试驱动开发",
          folderName: "tdd",
          fingerprint: "fp-2",
          categoryId: "matt",
          source: {
            repository: repo,
            memberPath: "skills/engineering/tdd",
            revision: oldRev,
            reference: "refs/heads/main",
          },
        },
      ],
    };

    const availableCheck: PackageUpdateCheck = {
      package: { repository: repo, reference: "refs/heads/main" },
      memberIds: ["s1", "s2"],
      outdatedMemberIds: ["s1", "s2"],
      status: "available",
      revision: newRev,
      updatedAt: 1764072503,
      error: null,
    };

    const apply = vi.fn().mockResolvedValue({
      library: {
        ...initial,
        skills: [
          { ...initial.skills[0], source: { ...initial.skills[0].source!, revision: newRev } },
          initial.skills[1],
        ],
      },
      updated: ["s1"],
      added: [],
      skipped: [],
      backup: null,
    });

    const updates: UpdateGateway = {
      check: vi.fn().mockResolvedValue([availableCheck]),
      checkOne: vi.fn().mockResolvedValue(availableCheck),
      preview: vi.fn(),
      apply,
      attach: vi.fn(),
    };

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, createGateway(initial, updates));

    const navUpdatesButton = screen.getByRole("button", { name: "更新中心" });
    await waitFor(() => expect(navUpdatesButton.textContent).toContain("2"));

    fireEvent.click(navUpdatesButton);
    const main = screen.getByRole("main");
    expect(await within(main).findByText("有 2 个 Skill 可更新")).toBeTruthy();

    const updateButtons = within(main).getAllByRole("button", { name: "更新" });
    fireEvent.click(updateButtons[0]);

    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith(availableCheck.package, {
        revision: newRev,
        backupMembers: [],
        additions: [],
        target: null,
        memberIds: ["s1"],
      }),
    );

    expect(await within(main).findByText("有 1 个 Skill 可更新")).toBeTruthy();
    expect(within(main).queryByText("domain-modeling")).toBeNull();
    expect(within(main).getByText("tdd")).toBeTruthy();
    await waitFor(() => expect(navUpdatesButton.textContent).toContain("1"));
  });

  it("shows update timestamp, changed files, and opens compare URL from review dialog", async () => {
    const repo = "https://github.com/mattpocock/skills.git";
    const oldRev = "d65391149dbb5fe76478e76fa8d5122b2aa5a70e";
    const newRev = "6f7f7831a625f040a8e06a0e7954826b87ce775a";
    const compareUrl = `https://github.com/mattpocock/skills/compare/${oldRev}...${newRev}`;
    const repoUrl = "https://github.com/mattpocock/skills";

    const initial: LibrarySnapshot = {
      categories: [{ id: "matt", name: "Matt" }],
      skills: [
        {
          id: "s1",
          name: "domain-modeling",
          description: "领域建模",
          folderName: "domain-modeling",
          fingerprint: "fp-1",
          categoryId: "matt",
          source: {
            repository: repo,
            memberPath: "skills/engineering/domain-modeling",
            revision: oldRev,
            reference: "refs/heads/main",
          },
        },
      ],
    };

    const availableCheck: PackageUpdateCheck = {
      package: { repository: repo, reference: "refs/heads/main" },
      memberIds: ["s1"],
      outdatedMemberIds: ["s1"],
      status: "available",
      revision: newRev,
      updatedAt: 1764072503,
      error: null,
    };

    const openSourceUrl = vi.fn().mockResolvedValue(undefined);
    const updates: UpdateGateway = {
      check: vi.fn().mockResolvedValue([availableCheck]),
      checkOne: vi.fn().mockResolvedValue(availableCheck),
      preview: vi.fn().mockResolvedValue({
        outdated: [
          {
            id: "s1",
            name: "domain-modeling",
            skipReason: null,
            changedFiles: ["GLOSSARY-FORMAT.md"],
          },
        ],
        additions: [],
        additionsConfirmed: true,
        updatedAt: 1764072503,
        fromRevision: oldRev,
        repositoryUrl: repoUrl,
        compareUrl,
      }),
      apply: vi.fn(),
      attach: vi.fn(),
      openSourceUrl,
    };

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, createGateway(initial, updates));

    fireEvent.click(screen.getByRole("button", { name: "更新中心" }));
    const main = screen.getByRole("main");
    fireEvent.click(await within(main).findByRole("button", { name: "查看更新" }));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/更新于/)).toBeTruthy();
    expect(within(dialog).getByText(`${oldRev.slice(0, 7)} → ${newRev.slice(0, 7)}`)).toBeTruthy();
    expect(within(dialog).getByText("GLOSSARY-FORMAT.md")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "查看仓库对比" }));
    await waitFor(() => expect(openSourceUrl).toHaveBeenCalledWith(compareUrl));
  });

  it("opens repository root URL from tracked online sources browse dialog when up to date", async () => {
    const repo = "https://github.com/mattpocock/skills.git";
    const currentRev = "6f7f7831a625f040a8e06a0e7954826b87ce775a";
    const repoUrl = "https://github.com/mattpocock/skills";

    const initial: LibrarySnapshot = {
      categories: [{ id: "matt", name: "Matt" }],
      skills: [
        {
          id: "s1",
          name: "domain-modeling",
          description: "领域建模",
          folderName: "domain-modeling",
          fingerprint: "fp-1",
          categoryId: "matt",
          source: {
            repository: repo,
            memberPath: "skills/engineering/domain-modeling",
            revision: currentRev,
            reference: "refs/heads/main",
          },
        },
      ],
    };

    const currentCheck: PackageUpdateCheck = {
      package: { repository: repo, reference: "refs/heads/main" },
      memberIds: ["s1"],
      outdatedMemberIds: [],
      status: "current",
      revision: currentRev,
      updatedAt: null,
      error: null,
    };

    const openSourceUrl = vi.fn().mockResolvedValue(undefined);
    const updates: UpdateGateway = {
      check: vi.fn().mockResolvedValue([currentCheck]),
      checkOne: vi.fn().mockResolvedValue(currentCheck),
      preview: vi.fn().mockResolvedValue({
        outdated: [],
        additions: [],
        additionsConfirmed: true,
        updatedAt: 1764072503,
        fromRevision: null,
        repositoryUrl: repoUrl,
        compareUrl: null,
      }),
      apply: vi.fn(),
      attach: vi.fn(),
      openSourceUrl,
    };

    const root = document.createElement("div");
    document.body.append(root);
    stop = await startApp(root, createGateway(initial, updates));

    fireEvent.click(screen.getByRole("button", { name: "更新中心" }));
    const main = screen.getByRole("main");
    fireEvent.click(await within(main).findByRole("button", { name: /已追踪的在线来源/ }));
    fireEvent.click(await within(main).findByRole("button", { name: "查看同源 Skill" }));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/更新于/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "打开仓库地址" }));
    await waitFor(() => expect(openSourceUrl).toHaveBeenCalledWith(repoUrl));
  });
});
