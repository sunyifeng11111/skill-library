import {
  ArrowDownAZIcon,
  CheckSquareIcon,
  EyeIcon,
  FolderInputIcon,
  FolderOpenIcon,
  GlobeIcon,
  LayersIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ScanSearchIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import * as React from "react";
import { useApp } from "@/app/AppContext";
import { destinationFromLibraryPage, type LibraryPageKind } from "@/app/types";
import { AgentMark } from "@/components/AgentMark";
import { renderEmojiSafeText } from "@/components/EmojiSafeText";
import { PageToolbar, useScrolled } from "@/components/PageToolbar";
import { SkillViewModeControl } from "@/components/SkillViewModeControl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Frame, FramePanel } from "@/components/ui/frame";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { Separator } from "@/components/ui/separator";
import { assignmentReason } from "@/features/agents/presentation";
import { cn } from "@/lib/utils";
import { tr } from "@/shared/language";
import type { Agent, AgentAssignment, Skill } from "@/shared/library";
import { skillMonogram } from "@/shared/view-mode";
import { CategoryEmptyState } from "./CategoryEmptyState";

export function LibraryPage({ page }: { page: LibraryPageKind }): React.ReactElement {
  const {
    desktop,
    snapshot,
    setPage,
    activeDialog,
    settingsOpen,
    skillViewMode: viewMode,
    setSkillViewMode: updateViewMode,
    openDeleteCategory,
    openSkillDetail,
    openMoveSkills,
    openUnloadSkills,
    openLocalFoldersPicker,
    openOnlineImport,
    searchTrigger,
  } = useApp();

  const [query, setQuery] = React.useState("");
  const [sortByName, setSortByName] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = React.useState<{
    skill: Skill;
    x: number;
    y: number;
  } | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const lastSelectedIdRef = React.useRef<string | null>(null);
  const shiftCheckboxRef = React.useRef(false);

  const pageKey = page.kind === "category" ? `category:${page.id}` : page.kind;
  const { scrolled, scrollRef, onScroll, scrollStyle } = useScrolled(pageKey);
  React.useEffect(() => {
    setQuery("");
    setSelected(new Set());
    setContextMenu(null);
    lastSelectedIdRef.current = null;
  }, [pageKey]);

  const lastSearchTriggerRef = React.useRef(searchTrigger);
  React.useEffect(() => {
    if (searchTrigger !== lastSearchTriggerRef.current) {
      lastSearchTriggerRef.current = searchTrigger;
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  }, [searchTrigger]);

  const inPage = React.useMemo(() => {
    if (!snapshot) return [];
    switch (page.kind) {
      case "all":
        return snapshot.skills;
      case "uncategorized":
        return snapshot.skills.filter((s) => s.categoryId === null);
      case "category":
        return snapshot.skills.filter((s) => s.categoryId === page.id);
    }
  }, [snapshot, page]);

  // Prune removed skills from selection
  React.useEffect(() => {
    const live = new Set(inPage.map((s) => s.id));
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    if (lastSelectedIdRef.current && !live.has(lastSelectedIdRef.current)) {
      lastSelectedIdRef.current = null;
    }
  }, [inPage]);

  const trimmedQuery = query.trim().toLocaleLowerCase();
  const visible = React.useMemo(() => {
    const matches = inPage.filter(
      (skill) =>
        skill.name.toLocaleLowerCase().includes(trimmedQuery) ||
        skill.description.toLocaleLowerCase().includes(trimmedQuery),
    );
    if (sortByName) {
      matches.sort((a, b) => a.name.localeCompare(b.name, document.documentElement.lang));
    }
    return matches;
  }, [inPage, trimmedQuery, sortByName]);

  const visibleRef = React.useRef(visible);
  visibleRef.current = visible;
  const selectedRef = React.useRef(selected);
  selectedRef.current = selected;
  const activeDialogRef = React.useRef(activeDialog);
  activeDialogRef.current = activeDialog;
  const settingsOpenRef = React.useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const contextMenuRef = React.useRef(contextMenu);
  contextMenuRef.current = contextMenu;

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (activeDialogRef.current || settingsOpenRef.current) return;

      if (event.key === "Escape") {
        if (document.querySelector('[data-slot="menu-popup"][data-open]')) return;
        if (selectedRef.current.size > 0 || contextMenuRef.current) {
          setSelected(new Set());
          lastSelectedIdRef.current = null;
          setContextMenu(null);
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        const activeEl = document.activeElement as HTMLElement | null;
        if (
          activeEl &&
          (activeEl.tagName === "INPUT" ||
            activeEl.tagName === "TEXTAREA" ||
            activeEl.tagName === "SELECT" ||
            activeEl.isContentEditable)
        ) {
          return;
        }
        const currentVisible = visibleRef.current;
        if (currentVisible.length > 0) {
          event.preventDefault();
          setSelected(new Set(currentVisible.map((skill) => skill.id)));
          lastSelectedIdRef.current = currentVisible[currentVisible.length - 1].id;
        }
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const contextMenuAnchor = React.useMemo(
    () =>
      contextMenu
        ? {
            getBoundingClientRect: () =>
              ({
                width: 0,
                height: 0,
                x: contextMenu.x,
                y: contextMenu.y,
                top: contextMenu.y,
                left: contextMenu.x,
                right: contextMenu.x,
                bottom: contextMenu.y,
                toJSON: () => ({}),
              }) as DOMRect,
          }
        : undefined,
    [contextMenu],
  );

  if (!snapshot) return <div />;

  const activeCategory =
    page.kind === "category"
      ? snapshot.categories.find((c) => c.id === page.id)
      : undefined;

  const heading =
    activeCategory?.name ??
    (page.kind === "uncategorized"
      ? tr("未分类", "Uncategorized")
      : tr("全部 Skill", "All skills"));

  const target = page.kind === "all" ? undefined : destinationFromLibraryPage(page);
  const localTarget = target ?? { kind: "uncategorized" as const };

  const totalLabel = tr(`共 ${inPage.length} 个 Skill`, `${inPage.length} skills`);
  const summaryText = trimmedQuery
    ? tr(`找到 ${visible.length} 项 · ${totalLabel}`, `${visible.length} matches · ${totalLabel}`)
    : page.kind === "all"
      ? tr(
          `${totalLabel} · ${snapshot.categories.length} 个自建分类`,
          `${totalLabel} · ${snapshot.categories.length} custom categories`,
        )
      : totalLabel;

  const duplicateNames = new Map<string, number>();
  for (const s of snapshot.skills) {
    duplicateNames.set(s.name, (duplicateNames.get(s.name) ?? 0) + 1);
  }
  const categoryNames = new Map(snapshot.categories.map((c) => [c.id, c.name]));
  const agentDetails = new Map((snapshot.agents ?? []).map((a) => [a.id, a]));
  const enabledBySkill = new Map<string, { agent: Agent; assignment: AgentAssignment }[]>();
  for (const assignment of snapshot.assignments ?? []) {
    const agent = agentDetails.get(assignment.agentId);
    if (!agent || !assignment.path) continue;
    const list = enabledBySkill.get(assignment.skillId) ?? [];
    list.push({ agent, assignment });
    enabledBySkill.set(assignment.skillId, list);
  }

  const isSelecting = selected.size > 0;
  const visibleSelectedCount = visible.filter((s) => selected.has(s.id)).length;
  const allVisibleSelected = visible.length > 0 && visibleSelectedCount === visible.length;
  const showCategoryPill = page.kind === "all" && snapshot.categories.length > 0;

  const isFirstEmpty = snapshot.skills.length === 0 && page.kind === "all" && !trimmedQuery;
  const shortcutLabel = /mac/i.test(navigator.platform) ? "⌘F" : "Ctrl+F";

  const clearSelection = () => {
    setSelected(new Set());
    lastSelectedIdRef.current = null;
  };

  const toggleAllVisible = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of visible) {
        if (checked) next.add(s.id);
        else next.delete(s.id);
      }
      return next;
    });
    if (!checked) {
      lastSelectedIdRef.current = null;
    } else if (visible.length > 0) {
      lastSelectedIdRef.current = visible[visible.length - 1].id;
    }
  };

  const selectRange = (targetId: string) => {
    const targetIndex = visible.findIndex((s) => s.id === targetId);
    if (targetIndex === -1) return;
    const anchorIndex = lastSelectedIdRef.current
      ? visible.findIndex((s) => s.id === lastSelectedIdRef.current)
      : -1;
    const startIndex = anchorIndex === -1 ? 0 : anchorIndex;
    const from = Math.min(startIndex, targetIndex);
    const to = Math.max(startIndex, targetIndex);
    setSelected((prev) => {
      const next = new Set(prev);
      for (let i = from; i <= to; i += 1) {
        next.add(visible[i].id);
      }
      return next;
    });
    lastSelectedIdRef.current = targetId;
  };

  const toggleOne = (id: string, checked: boolean, shiftKey = false) => {
    if (shiftKey && checked) {
      selectRange(id);
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    if (checked) {
      lastSelectedIdRef.current = id;
    } else if (lastSelectedIdRef.current === id) {
      lastSelectedIdRef.current = null;
    }
  };

  const handleItemClick = (skill: Skill, event: React.MouseEvent) => {
    if (event.shiftKey) {
      event.preventDefault();
      selectRange(skill.id);
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      toggleOne(skill.id, !selected.has(skill.id));
      return;
    }
    openSkillDetail(skill.id);
  };

  const openContextMenu = (skill: Skill, event: React.MouseEvent) => {
    event.preventDefault();
    setContextMenu({ skill, x: event.clientX, y: event.clientY });
  };

  const getSkillMeta = (skill: Skill) => {
    const category = categoryNames.get(skill.categoryId ?? "") ?? tr("未分类", "Uncategorized");
    const sameName = (duplicateNames.get(skill.name) ?? 0) > 1;
    const enabled = enabledBySkill.get(skill.id) ?? [];
    const checkboxLabel = sameName
      ? tr(
          `选择 ${skill.name}（${skill.localOrigins?.join(" · ") || skill.folderName}）`,
          `Select ${skill.name} (${skill.localOrigins?.join(" · ") || skill.folderName})`,
        )
      : tr(`选择 ${skill.name}`, `Select ${skill.name}`);
    return { category, enabled, checkboxLabel };
  };

  const renderToolChips = (
    enabled: { agent: Agent; assignment: AgentAssignment }[],
    category: string,
  ) => {
    if (enabled.length === 0) {
      return <span className="text-muted-foreground text-xs">{tr("仅收藏", "Library only")}</span>;
    }
    return (
      <>
        {(enabled.length <= 5 ? enabled : enabled.slice(0, 4)).map(({ agent, assignment }) => (
          <span
            key={agent.id}
            aria-label={agent.name}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted"
            role="img"
            title={`${agent.name} · ${assignmentReason(assignment, category)}`}
          >
            <AgentMark agent={agent} className="size-3.5" />
          </span>
        ))}
        {enabled.length > 5 && (
          <span
            aria-label={tr(
              `还有 ${enabled.length - 4} 个已启用工具`,
              `${enabled.length - 4} more enabled tools`,
            )}
            className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md bg-muted px-1 font-medium text-[11px] text-muted-foreground"
            title={enabled
              .slice(4)
              .map(({ agent }) => agent.name)
              .join("、")}
          >
            +{enabled.length - 4}
          </span>
        )}
      </>
    );
  };

  const renderSkillMenuItems = (skill: Skill, isContextGroup: boolean) => {
    if (isContextGroup) {
      return (
        <>
          <MenuItem
            onClick={() =>
              openMoveSkills([...selected], destinationFromLibraryPage(page), clearSelection)
            }
          >
            <FolderInputIcon />
            {tr(`移至分类（已选 ${selected.size} 项）…`, `Move ${selected.size} to category…`)}
          </MenuItem>
          <MenuItem onClick={clearSelection}>
            <XIcon />
            {tr("取消选择", "Clear selection")}
          </MenuItem>
          {desktop.agents && (
            <>
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                onClick={() => openUnloadSkills([...selected], clearSelection)}
              >
                <Trash2Icon />
                {tr(`卸载所选（${selected.size} 项）…`, `Uninstall ${selected.size} skills…`)}
              </MenuItem>
            </>
          )}
        </>
      );
    }

    const isSelected = selected.has(skill.id);
    return (
      <>
        <MenuItem onClick={() => openSkillDetail(skill.id)}>
          <EyeIcon />
          {tr("查看详情", "View details")}
        </MenuItem>
        <MenuItem
          onClick={() => openMoveSkills([skill.id], destinationFromLibraryPage(page))}
        >
          <FolderInputIcon />
          {tr("移至分类…", "Move to category…")}
        </MenuItem>
        <MenuItem onClick={() => toggleOne(skill.id, !isSelected)}>
          <CheckSquareIcon />
          {isSelected ? tr("取消选择", "Deselect") : tr("选择此项", "Select")}
        </MenuItem>
        {desktop.agents && (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => openUnloadSkills([skill.id])}>
              <Trash2Icon />
              {tr("卸载 Skill…", "Uninstall skill…")}
            </MenuItem>
          </>
        )}
      </>
    );
  };

  const renderRowMoreMenu = (skill: Skill, visibilityClass: string) => (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label={tr(`${skill.name} 的更多操作`, `More actions for ${skill.name}`)}
            className={visibilityClass}
            size="icon-xs"
            variant="ghost"
          >
            <MoreHorizontalIcon />
          </Button>
        }
      />
      <MenuPopup align="end">{renderSkillMenuItems(skill, false)}</MenuPopup>
    </Menu>
  );

  const renderSkillCheckbox = (skill: Skill, checkboxLabel: string, className: string) => (
    <Checkbox
      aria-label={checkboxLabel}
      checked={selected.has(skill.id)}
      className={className}
      onCheckedChange={(checked) => {
        const shift = shiftCheckboxRef.current;
        shiftCheckboxRef.current = false;
        toggleOne(skill.id, Boolean(checked), shift);
      }}
      onClick={(e) => {
        shiftCheckboxRef.current = e.shiftKey;
      }}
      onMouseDown={(e) => {
        shiftCheckboxRef.current = e.shiftKey;
      }}
    />
  );

  const renderSkillRow = (skill: Skill) => {
    const { category, enabled, checkboxLabel } = getSkillMeta(skill);
    const isSelected = selected.has(skill.id);

    return (
      <li
        key={skill.id}
        className={cn(
          "group/row flex items-center gap-3 px-4 py-3 transition-colors",
          isSelected ? "bg-accent/80" : "hover:bg-accent/40",
        )}
        onContextMenu={(e) => openContextMenu(skill, e)}
      >
        <div className="relative flex size-8 shrink-0 items-center justify-center">
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none flex size-8 items-center justify-center rounded-lg bg-muted font-medium text-[11px] text-muted-foreground tracking-wide transition-[opacity,transform] duration-150",
              isSelecting || isSelected
                ? "scale-90 opacity-0"
                : "group-hover/row:scale-90 group-hover/row:opacity-0 group-has-[[data-slot=checkbox]:focus-visible]/row:scale-90 group-has-[[data-slot=checkbox]:focus-visible]/row:opacity-0",
            )}
          >
            {skillMonogram(skill.name)}
          </span>
          {renderSkillCheckbox(
            skill,
            checkboxLabel,
            cn(
              "absolute transition-[opacity,transform] duration-150",
              isSelecting || isSelected
                ? "scale-100 opacity-100"
                : "scale-90 opacity-0 group-hover/row:scale-100 group-hover/row:opacity-100 focus-visible:scale-100 focus-visible:opacity-100",
            ),
          )}
        </div>

        <button
          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left outline-none focus-visible:underline"
          type="button"
          onClick={(e) => handleItemClick(skill, e)}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-foreground text-sm" title={skill.name}>
              {renderEmojiSafeText(skill.name)}
            </span>
            {showCategoryPill && (
              <Badge
                className="max-w-28 shrink-0 justify-start overflow-hidden"
                size="sm"
                title={category}
                variant="secondary"
              >
                <span className="truncate">{category}</span>
              </Badge>
            )}
          </div>
          {skill.description && (
            <span className="truncate text-muted-foreground text-xs" title={skill.description}>
              {renderEmojiSafeText(skill.description)}
            </span>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          {renderToolChips(enabled, category)}
          {renderRowMoreMenu(
            skill,
            "ml-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100",
          )}
        </div>
      </li>
    );
  };

  const renderSkillCard = (skill: Skill) => {
    const { category, enabled, checkboxLabel } = getSkillMeta(skill);
    const isSelected = selected.has(skill.id);

    return (
      <li
        key={skill.id}
        className={cn(
          "group/card relative flex flex-col justify-between gap-3 rounded-xl border bg-background p-4 shadow-xs/5 transition-[border-color,background-color,box-shadow]",
          isSelected
            ? "border-foreground/40 bg-accent/50 ring-1 ring-foreground/20"
            : "hover:border-ring/60",
        )}
        onContextMenu={(e) => openContextMenu(skill, e)}
      >
        <div className="flex items-start justify-between gap-2">
          <button
            className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1.5 text-left outline-none focus-visible:underline"
            type="button"
            onClick={(e) => handleItemClick(skill, e)}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate font-medium text-foreground text-sm" title={skill.name}>
                {renderEmojiSafeText(skill.name)}
              </span>
              {showCategoryPill && (
                <Badge
                  className="max-w-28 shrink-0 justify-start overflow-hidden"
                  size="sm"
                  title={category}
                  variant="secondary"
                >
                  <span className="truncate">{category}</span>
                </Badge>
              )}
            </div>
            {skill.description && (
              <span
                className="line-clamp-2 min-h-9 text-muted-foreground text-xs leading-relaxed"
                title={skill.description}
              >
                {renderEmojiSafeText(skill.description)}
              </span>
            )}
          </button>

          {renderSkillCheckbox(
            skill,
            checkboxLabel,
            cn(
              "mt-0.5 shrink-0 transition-opacity duration-150",
              isSelecting || isSelected
                ? "opacity-100"
                : "opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100",
            ),
          )}
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {renderToolChips(enabled, category)}
          </div>
          {renderRowMoreMenu(
            skill,
            "shrink-0 opacity-0 transition-opacity group-hover/card:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100",
          )}
        </div>
      </li>
    );
  };

  return (
    <section className="relative flex h-full flex-col overflow-hidden">
      {/* Top toolbar */}
      <PageToolbar
        actions={
          <>
            <InputGroup className="w-40 sm:w-52 lg:w-64">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                ref={searchRef}
                aria-label={tr("搜索名称或用途", "Search names or descriptions")}
                placeholder={tr("搜索 Skill", "Search skills")}
                size="sm"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <InputGroupAddon align="inline-end">
                <Kbd aria-hidden="true">{shortcutLabel}</Kbd>
              </InputGroupAddon>
            </InputGroup>

            <Menu>
              <MenuTrigger
                render={
                  <Button size="sm">
                    <PlusIcon />
                    {tr("添加到 Skill 库", "Add to library")}
                  </Button>
                }
              />
              <MenuPopup align="end">
                <MenuItem onClick={() => setPage({ kind: "scan" })}>
                  <ScanSearchIcon />
                  {tr("查找电脑里已有的 Skill", "Find skills on this computer")}
                </MenuItem>
                <MenuItem onClick={() => void openLocalFoldersPicker(localTarget)}>
                  <FolderOpenIcon />
                  {tr("从文件夹添加", "Add from a folder")}
                </MenuItem>
                {desktop.online && (
                  <MenuItem onClick={() => openOnlineImport(target)}>
                    <GlobeIcon />
                    {tr("在线安装", "Install online")}
                  </MenuItem>
                )}
              </MenuPopup>
            </Menu>
          </>
        }
        breadcrumb={tr(`Skill 库 ／ ${heading}`, `Library / ${heading}`)}
        scrolled={scrolled}
      />

      {/* Scrollable body */}
      <div
        ref={scrollRef}
        className={cn(
          "flex-1 overflow-y-auto px-6 pt-18 pb-6 scroll-pt-16 md:px-8",
          isSelecting && "pb-24",
        )}
        style={scrollStyle}
        onScroll={onScroll}
      >
        <div className="mx-auto flex max-w-5xl flex-col gap-5">
          {/* Header */}
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="break-words font-semibold text-2xl tracking-tight">{heading}</h1>
              <p className="mt-1 text-muted-foreground text-xs">{summaryText}</p>
            </div>
            {activeCategory && (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => openDeleteCategory(activeCategory.id, activeCategory.name)}
                >
                  {tr("删除分类", "Delete category")}
                </Button>
              </div>
            )}
          </header>

          {/* Controls bar: sort + list/grid view switcher */}
          {inPage.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                aria-pressed={sortByName}
                className={!sortByName ? "text-muted-foreground hover:text-foreground" : undefined}
                size="sm"
                variant={sortByName ? "secondary" : "ghost"}
                onClick={() => setSortByName((v) => !v)}
              >
                <ArrowDownAZIcon />
                {sortByName ? tr("按名称", "By name") : tr("默认顺序", "Default order")}
              </Button>

              <SkillViewModeControl value={viewMode} onChange={updateViewMode} />
            </div>
          )}

          {/* Empty states or Skill list / card grid */}
          {!visible.length ? (
            !trimmedQuery && !isFirstEmpty ? (
              <CategoryEmptyState
                canInstallOnline={Boolean(desktop.online)}
                heading={heading}
                onAddFromFolder={() => void openLocalFoldersPicker(localTarget)}
                onOnlineInstall={() => openOnlineImport(target)}
              />
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    {trimmedQuery ? <SearchIcon /> : <LayersIcon />}
                  </EmptyMedia>
                  <EmptyTitle>
                    {trimmedQuery
                      ? tr("没有匹配的 Skill", "No matching skills")
                      : tr("开始统一管理你的 Skill", "Start managing your skills in one place")}
                  </EmptyTitle>
                  <EmptyDescription>
                    {trimmedQuery
                      ? tr("试试其他关键词，或清空搜索查看全部。", "Try another keyword or clear your search.")
                      : tr(
                          "自动扫描本机已安装的 Claude Code、Cursor、Codex 等 AI 工具目录，一次收拢到 Skill 库，各工具继续无缝使用。",
                          "Scan Claude Code, Cursor, Codex, and other local AI tool folders to manage all your skills from one library.",
                        )}
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  {trimmedQuery ? (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setQuery("");
                        searchRef.current?.focus();
                      }}
                    >
                      {tr("清空搜索", "Clear search")}
                    </Button>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <Button onClick={() => setPage({ kind: "scan" })}>
                          <ScanSearchIcon />
                          {tr("扫描本机工具中的 Skill", "Scan skills in local tools")}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => void openLocalFoldersPicker(localTarget)}
                        >
                          <FolderOpenIcon />
                          {tr("从文件夹添加", "Add from a folder")}
                        </Button>
                      </div>
                      <p className="text-muted-foreground text-xs">
                        {tr(
                          "扫描过程仅读取检查，不会改动原文件。",
                          "Scanning is read-only and never modifies your original files.",
                        )}
                      </p>
                    </>
                  )}
                </EmptyContent>
              </Empty>
            )
          ) : viewMode === "list" ? (
            <Frame>
              <FramePanel className="overflow-hidden p-0">
                <ul className="divide-y">{visible.map(renderSkillRow)}</ul>
              </FramePanel>
            </Frame>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map(renderSkillCard)}
            </ul>
          )}
        </div>
      </div>

      {/* Floating Bottom Action Dock */}
      {isSelecting && (
        <div className="pointer-events-none absolute inset-x-0 bottom-5 z-30 flex justify-center px-4">
          <div
            aria-label={tr("批量操作", "Bulk actions")}
            className="pointer-events-auto flex max-w-full flex-wrap items-center gap-1.5 rounded-full border bg-popover/95 px-3 py-1.5 shadow-lg/10 backdrop-blur-md"
            role="toolbar"
          >
            <Badge variant="secondary">
              {tr(`已选 ${selected.size} 项`, `${selected.size} selected`)}
            </Badge>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => toggleAllVisible(!allVisibleSelected)}
            >
              {allVisibleSelected
                ? tr("取消全选", "Deselect all")
                : tr("全选", "Select all")}
            </Button>
            <Separator className="h-4 self-center mx-0.5" orientation="vertical" />
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                openMoveSkills([...selected], destinationFromLibraryPage(page), clearSelection)
              }
            >
              <FolderInputIcon />
              {tr("移至分类", "Move to category")}
            </Button>
            {desktop.agents && (
              <Button
                size="xs"
                variant="destructive-outline"
                onClick={() => openUnloadSkills([...selected], clearSelection)}
              >
                <Trash2Icon />
                {tr("卸载 Skill", "Uninstall skills")}
              </Button>
            )}
            <Button
              aria-label={tr("取消选择", "Clear selection")}
              size="icon-xs"
              title={tr("取消选择", "Clear selection")}
              variant="ghost"
              onClick={clearSelection}
            >
              <XIcon />
            </Button>
          </div>
        </div>
      )}

      {/* Controlled Right-Click Context Menu */}
      <Menu
        open={Boolean(contextMenu)}
        onOpenChange={(open) => {
          if (!open) setContextMenu(null);
        }}
      >
        <MenuPopup align="start" anchor={contextMenuAnchor} side="bottom">
          {contextMenu &&
            renderSkillMenuItems(
              contextMenu.skill,
              selected.has(contextMenu.skill.id) && selected.size > 1,
            )}
        </MenuPopup>
      </Menu>
    </section>
  );
}
