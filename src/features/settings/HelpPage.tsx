import { ChevronDownIcon, HelpCircleIcon } from "lucide-react";
import type * as React from "react";
import { PageToolbar, useScrolled } from "@/components/PageToolbar";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Frame, FramePanel } from "@/components/ui/frame";
import { tr } from "@/shared/language";

export function HelpPage(): React.ReactElement {
  const { scrolled, scrollRef, onScroll, scrollStyle } = useScrolled();
  const topics: [string, string][] = [
    [
      tr("如何安装 Skill？", "How do I install skills?"),
      tr(
        "在 Skill 库点「添加到 Skill 库 → 在线安装」，粘贴 HTTPS Git 仓库链接、GitHub 目录链接或 npx skills add 命令。本地添加时可以查找电脑里已有的 Skill，或从文件夹添加。相同内容只保存一份，工具继续使用原文件。",
        "In the library, choose Add to library → Install online and paste an HTTPS Git repository URL, a GitHub folder URL, or an npx skills add command. Find existing skills on your computer or add them from a folder. Identical copies are saved once. Your tools keep using their original files.",
      ),
    ],
    [
      tr("如何整理分类？", "How do I organize skills?"),
      tr(
        "按名称或用途搜索，勾选需要整理的 Skill，再点「移至分类」。移动后可撤销。",
        "Search by name or purpose, select the skills you want to organize, then choose Move to category. You can undo the move.",
      ),
    ],
    [
      tr("如何在工具里使用 Skill？", "How do I use a skill in my tool?"),
      tr(
        "在「我的工具」里打开某个工具（如 Claude Code 或 Codex），打开对应 Skill 的开关即可使用；如果该工具目录里原本就有未纳入 Skill 库的 Skill，可在「仅在当前工具中」分组里单条或全部收进 Skill 库统一管理。",
        "Under My tools, open a tool such as Claude Code or Codex and turn on the switch next to any skill. If the tool folder already has unmanaged skills, review or add them individually or together from the local group.",
      ),
    ],
    [
      tr("更新失败怎么办？", "What if a Skill update fails?"),
      tr(
        "检查网络和来源地址，再重试失败的包。更新完成前，工具仍然可以使用上次安装的版本。",
        "Check your connection and the source URL, then retry the failed package. Your tools can keep using the installed version until the update succeeds.",
      ),
    ],
    [
      tr("如何更新 Skill Library 应用本身？", "How do I update Skill Library itself?"),
      tr(
        "侧栏「更新中心」专门用于更新库里的 Skill；如需升级 Skill Library 客户端，请打开「设置 → 关于与更新」点击「检查更新」。应用默认在启动时静默检查 GitHub Releases 稳定版，不会影响你的 Skill 库与 Agent 配置；如网络受限，也可直接前往 GitHub Releases 手动下载。",
        "Updates in the sidebar only manages Skill updates in your library. To update the Skill Library app itself, open Settings → About & updates and click Check for updates. Stable GitHub Releases are checked quietly on startup without affecting your library or Agent settings, and manual download from GitHub Releases is always available.",
      ),
    ],
    [
      tr("如何备份或恢复 Skill 库？", "How do I back up or restore the library?"),
      tr(
        "打开「设置 → 数据管理」，可以导出或导入整库备份（导入前会显示替换范围，且保留本机原文件备份）、恢复接管前自动备份的原工具文件夹，或在需要时重置 Skill 库。",
        "Open Library data in Settings to export or import a full library backup (reviewing what changes before confirming while keeping local original backups), restore original tool folders backed up during adoption, or reset the library.",
      ),
    ],
  ];

  return (
    <section className="relative flex h-full flex-col overflow-hidden">
      <PageToolbar breadcrumb={tr("Skill 库 ／ 使用帮助", "Library / Help")} scrolled={scrolled} />

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6 pt-18 pb-6 scroll-pt-16 md:px-8"
        style={scrollStyle}
        onScroll={onScroll}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <header className="flex items-start gap-3">
            <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card text-foreground shadow-xs/5">
              <HelpCircleIcon className="size-4.5" />
            </div>
            <div>
              <h1 className="font-semibold text-2xl tracking-tight">
                {tr("使用帮助", "Help")}
              </h1>
              <p className="mt-1 text-muted-foreground text-sm">
                {tr(
                  "了解如何安装、分类、同步到各 AI 工具以及备份你的 Skill 库。",
                  "Learn how to install, organize, sync skills to your AI tools, and back up your library.",
                )}
              </p>
            </div>
          </header>

          <Frame>
            <FramePanel className="divide-y p-0">
              {topics.map(([question, answer], idx) => (
                <Collapsible key={question} defaultOpen={idx === 0}>
                  <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-4 px-5 py-4 text-left font-medium text-sm transition-colors hover:bg-accent/50 [&[data-panel-open]>svg]:rotate-180">
                    <span>{question}</span>
                    <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-200" />
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <p className="px-5 pb-4 text-muted-foreground text-sm leading-relaxed">
                      {answer}
                    </p>
                  </CollapsiblePanel>
                </Collapsible>
              ))}
            </FramePanel>
          </Frame>
        </div>
      </div>
    </section>
  );
}
