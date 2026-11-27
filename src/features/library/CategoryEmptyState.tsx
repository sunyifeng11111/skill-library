import { ArrowRightIcon, FolderOpenIcon, PlusIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { tr } from "@/shared/language";

export interface CategoryEmptyStateProps {
  /** Localized display name of the active category or uncategorized view. */
  heading: string;
  /** Whether the online installer workflow is available in the current environment. */
  canInstallOnline: boolean;
  /** Triggered when the user chooses to install skills from a URL or command. */
  onOnlineInstall: () => void;
  /** Triggered when the user chooses to import skills from local folders. */
  onAddFromFolder: () => void;
}

/**
 * Empty state shown inside an existing category or the uncategorized view when it contains no skills yet.
 * Uses top-aligned Bento cards with fixed-height previews so both card headings sit on the same baseline.
 */
export function CategoryEmptyState({
  heading,
  canInstallOnline,
  onOnlineInstall,
  onAddFromFolder,
}: CategoryEmptyStateProps): React.ReactElement {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col py-10 md:py-16">
      <div className="text-center">
        <h2 className="font-semibold text-foreground text-xl tracking-tight">
          {tr(`「${heading}」还是空的`, `“${heading}” is empty`)}
        </h2>
        <p className="mt-1.5 text-muted-foreground text-sm">
          {tr(
            "选一种方式添加 Skill，安装后将自动归入当前分类。",
            "Choose how to add skills — anything installed will be filed here.",
          )}
        </p>
      </div>

      <div
        className={cn(
          "mt-8 grid grid-cols-1 items-stretch gap-4",
          canInstallOnline ? "sm:grid-cols-2" : "mx-auto w-full max-w-sm",
        )}
      >
        {canInstallOnline && (
          <button
            className="group flex h-full cursor-pointer flex-col items-stretch gap-5 rounded-2xl border bg-background p-5 text-left shadow-xs/5 outline-none transition-[border-color,background-color,box-shadow] hover:border-ring/60 hover:bg-accent/25 focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
            onClick={onOnlineInstall}
          >
            {/* Monochrome miniature terminal preview */}
            <div
              aria-hidden="true"
              className="flex h-28 w-full shrink-0 items-center justify-center rounded-xl bg-muted/55 p-4"
            >
              <div className="w-full rounded-lg border border-border/80 bg-card p-3 shadow-xs/5 transition-transform duration-200 group-hover:-translate-y-0.5">
                <div className="mb-2 flex items-center gap-1">
                  <span className="size-1.5 rounded-full bg-muted-foreground/30" />
                  <span className="size-1.5 rounded-full bg-muted-foreground/30" />
                  <span className="size-1.5 rounded-full bg-muted-foreground/30" />
                </div>
                <div className="flex items-center gap-1 font-mono text-[11px] text-foreground">
                  <span className="text-muted-foreground">$</span>
                  <span className="truncate">npx skills add</span>
                  <span className="inline-block h-3.5 w-1.5 shrink-0 rounded-[1px] bg-primary/75" />
                </div>
                <div className="mt-2 h-1.5 w-2/3 rounded-full bg-muted-foreground/20" />
              </div>
            </div>

            <div className="flex w-full flex-col">
              <div className="flex w-full items-center justify-between gap-2">
                <span className="font-semibold text-foreground text-sm leading-5">
                  {tr("在线安装", "Install online")}
                </span>
                <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground" />
              </div>
              <p className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
                {tr(
                  "粘贴 Git 仓库链接、GitHub 目录或 npx skills add 命令",
                  "Paste a Git repository URL, GitHub folder, or npx skills add command",
                )}
              </p>
            </div>
          </button>
        )}

        <button
          className="group flex h-full cursor-pointer flex-col items-stretch gap-5 rounded-2xl border border-dashed border-border bg-muted/20 p-5 text-left outline-none transition-[border-color,background-color] hover:border-ring/60 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
          type="button"
          onClick={onAddFromFolder}
        >
          {/* Monochrome miniature SKILL.md stack preview */}
          <div
            aria-hidden="true"
            className="flex h-28 w-full shrink-0 items-center justify-center rounded-xl bg-muted/45 p-4"
          >
            <div className="relative">
              <div className="absolute inset-0 -rotate-6 rounded-lg border border-border/60 bg-background/75 transition-transform duration-200 group-hover:-translate-x-1 group-hover:-rotate-10" />
              <div className="relative flex w-36 flex-col gap-1.5 rounded-lg border border-border/90 bg-card px-3 py-2.5 shadow-xs/5 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:rotate-2">
                <div className="flex items-center gap-1.5">
                  <FolderOpenIcon className="size-3 text-muted-foreground" />
                  <span className="font-medium font-mono text-[11px] text-foreground">
                    SKILL.md
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted-foreground/25" />
                <div className="h-1.5 w-3/4 rounded-full bg-muted-foreground/15" />
              </div>
            </div>
          </div>

          <div className="flex w-full flex-col">
            <div className="flex w-full items-center justify-between gap-2">
              <span className="font-semibold text-foreground text-sm leading-5">
                {tr("从文件夹添加", "Add from a folder")}
              </span>
              <PlusIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:scale-110 group-hover:text-foreground" />
            </div>
            <p className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
              {tr(
                "选择本机文件夹，或直接把 Skill 目录拖进当前窗口",
                "Select a local folder, or drag and drop skill folders right here",
              )}
            </p>
          </div>
        </button>
      </div>
    </div>
  );
}
