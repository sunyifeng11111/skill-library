import {
  ChevronDownIcon,
  FolderIcon,
  GripVerticalIcon,
  HelpCircleIcon,
  InboxIcon,
  LayoutGridIcon,
  MoreHorizontalIcon,
  PanelLeftCloseIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
} from "lucide-react";
import * as React from "react";
import { AgentMark } from "@/components/AgentMark";
import { ShellChromeContext } from "@/components/PageToolbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { AddAgentDialog } from "@/features/agents/AddAgentDialog";
import { AgentPage } from "@/features/agents/AgentPage";
import { RemoveAgentDialog } from "@/features/agents/RemoveAgentDialog";
import { LocalImportDialog } from "@/features/install/LocalImportDialog";
import { OnlineImportDialog } from "@/features/install/OnlineImportDialog";
import { LibraryDialogs } from "@/features/library/LibraryDialogs";
import { LibraryPage } from "@/features/library/LibraryPage";
import { ScanPage } from "@/features/scan/ScanPage";
import { HelpPage } from "@/features/settings/HelpPage";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { SourceAttachmentDialog } from "@/features/updates/SourceAttachmentDialog";
import { UpdatesPage } from "@/features/updates/UpdatesPage";
import { cn } from "@/lib/utils";
import { tr } from "@/shared/language";
import { errorText } from "@/shared/ui";
import { useApp } from "./AppContext";
import { destinationFromLibraryPage, type LibraryPageKind } from "./types";
import { useVerticalReorder } from "./useVerticalReorder";

function SidebarBody({
  mode,
  categoriesOpen,
  onCategoriesOpenChange,
  agentsOpen,
  onAgentsOpenChange,
  onCollapseDesktop,
  onCloseDrawer,
}: {
  mode: "desktop" | "drawer";
  categoriesOpen: boolean;
  onCategoriesOpenChange: (open: boolean) => void;
  agentsOpen: boolean;
  onAgentsOpenChange: (open: boolean) => void;
  onCollapseDesktop: () => void;
  onCloseDrawer: () => void;
}): React.ReactElement {
  const {
    desktop,
    snapshot,
    page,
    setPage,
    openSettings,
    openCreateCategory,
    openRenameCategory,
    openDeleteCategory,
    openAddAgent,
    openRemoveAgent,
    openLocalImport,
    openOnlineImport,
    updates,
    appUpdates,
    reorderCategories,
    reorderAgents,
  } = useApp();

  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const [navOverflowTop, setNavOverflowTop] = React.useState(false);
  const [navOverflowBottom, setNavOverflowBottom] = React.useState(false);

  const updateNavOverflow = React.useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) {
      setNavOverflowTop(false);
      setNavOverflowBottom(false);
      return;
    }
    const hasMoreAbove = el.scrollTop > 1;
    const hasMoreBelow = el.scrollHeight - el.clientHeight - el.scrollTop > 1;
    setNavOverflowTop((prev) => (prev === hasMoreAbove ? prev : hasMoreAbove));
    setNavOverflowBottom((prev) => (prev === hasMoreBelow ? prev : hasMoreBelow));
  }, []);

  React.useEffect(() => {
    updateNavOverflow();
    const el = scrollContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateNavOverflow);
    observer.observe(el);
    for (const child of el.children) {
      observer.observe(child);
    }
    return () => observer.disconnect();
  }, [
    updateNavOverflow,
    categoriesOpen,
    agentsOpen,
    snapshot?.categories.length,
    snapshot?.agents?.length,
  ]);

  const navFadeStyle = React.useMemo<React.CSSProperties>(() => {
    const mask = desktop.updates
      ? "linear-gradient(to bottom, transparent 0%, rgb(0 0 0 / 0.16) 24px, rgb(0 0 0 / 0.55) 44px, #000 56px, #000 calc(100% - 112px), rgb(0 0 0 / 0.45) calc(100% - 76px), rgb(0 0 0 / 0.14) calc(100% - 36px), transparent 100%)"
      : "linear-gradient(to bottom, transparent 0%, rgb(0 0 0 / 0.16) 24px, rgb(0 0 0 / 0.55) 44px, #000 56px, #000 calc(100% - 72px), rgb(0 0 0 / 0.45) calc(100% - 44px), rgb(0 0 0 / 0.14) calc(100% - 18px), transparent 100%)";
    return {
      WebkitMaskImage: mask,
      maskImage: mask,
    };
  }, [desktop.updates]);

  const categoryCounts = React.useMemo(() => {
    const map = new Map<string | null, number>();
    for (const skill of snapshot?.skills ?? []) {
      map.set(skill.categoryId, (map.get(skill.categoryId) ?? 0) + 1);
    }
    return map;
  }, [snapshot]);

  const enabledByAgent = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const assignment of snapshot?.assignments ?? []) {
      if (assignment.path) map.set(assignment.agentId, (map.get(assignment.agentId) ?? 0) + 1);
    }
    return map;
  }, [snapshot]);

  const categoryIds = React.useMemo(
    () => (snapshot?.categories ?? []).map((cat) => cat.id),
    [snapshot?.categories],
  );
  const agentIds = React.useMemo(
    () => (snapshot?.agents ?? []).map((agent) => agent.id),
    [snapshot?.agents],
  );

  const canReorderCategories = Boolean(snapshot && categoryIds.length > 1);
  const canReorderAgents = Boolean(snapshot && desktop.agents && agentIds.length > 1);

  const categoryReorder = useVerticalReorder({
    ids: categoryIds,
    enabled: canReorderCategories,
    scrollContainerRef,
    onReorder: (ids) => {
      void reorderCategories(ids);
    },
  });

  const agentReorder = useVerticalReorder({
    ids: agentIds,
    enabled: canReorderAgents,
    scrollContainerRef,
    onReorder: (ids) => {
      void reorderAgents(ids);
    },
  });

  const navigate = React.useCallback(
    (next: typeof page) => {
      setPage(next);
      onCloseDrawer();
    },
    [setPage, onCloseDrawer],
  );

  const installToTarget = (target: LibraryPageKind) => {
    if (desktop.online) {
      openOnlineImport(target.kind === "all" ? undefined : destinationFromLibraryPage(target));
    } else {
      openLocalImport(destinationFromLibraryPage(target), { mode: "sources" });
    }
  };

  const renderLibraryNavItem = (
    label: string,
    target: LibraryPageKind,
    count: number,
    index?: number,
  ) => {
    const active =
      page.kind === target.kind &&
      (page.kind !== "category" || (target.kind === "category" && page.id === target.id));
    const Icon =
      target.kind === "all"
        ? LayoutGridIcon
        : target.kind === "uncategorized"
          ? InboxIcon
          : FolderIcon;

    const categoryId = target.kind === "category" ? target.id : null;
    const isDraggingThis = categoryId !== null && categoryReorder.draggingId === categoryId;
    const isReorderingCategory = categoryId !== null && categoryReorder.isDraggingAny;

    return (
      <div
        key={categoryId ? `cat-${categoryId}` : target.kind}
        ref={categoryId ? categoryReorder.setItemRef(categoryId) : undefined}
        className={cn(
          "group relative flex items-center",
          categoryId
            ? isDraggingThis
              ? "z-20"
              : isReorderingCategory
                ? "transition-transform duration-150 ease-out"
                : undefined
            : undefined,
        )}
        style={
          categoryId && index !== undefined
            ? categoryReorder.getItemStyle(categoryId, index)
            : undefined
        }
      >
        <button
          aria-current={active ? "page" : undefined}
          aria-label={label}
          className={cn(
            "flex h-9 w-full select-none items-center gap-2.5 rounded-lg pr-2.5 pl-4 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
            isDraggingThis
              ? "cursor-grabbing bg-popover text-popover-foreground shadow-sm ring-1 ring-border"
              : cn(
                  "cursor-pointer",
                  active
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : isReorderingCategory
                      ? "text-sidebar-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                ),
          )}
          disabled={!snapshot}
          id={`library-nav-${categoryId ?? target.kind}`}
          type="button"
          onClick={() => {
            if (categoryId && categoryReorder.consumeSuppressedClick(categoryId)) return;
            navigate(target);
          }}
          onDragStart={categoryId ? (e) => e.preventDefault() : undefined}
          onKeyDown={
            categoryId && canReorderCategories
              ? (e) => {
                  if (e.altKey && e.key === "ArrowUp") {
                    e.preventDefault();
                    categoryReorder.moveBy(categoryId, -1);
                  } else if (e.altKey && e.key === "ArrowDown") {
                    e.preventDefault();
                    categoryReorder.moveBy(categoryId, 1);
                  }
                }
              : undefined
          }
          onPointerDown={
            categoryId && canReorderCategories
              ? categoryReorder.getPointerDownHandler(categoryId)
              : undefined
          }
        >
          {categoryId && canReorderCategories && (
            <GripVerticalIcon
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute left-0.5 size-3 shrink-0 text-muted-foreground transition-opacity",
                isDraggingThis ? "opacity-90" : "opacity-0 group-hover:opacity-60",
              )}
            />
          )}
          <Icon className="size-4 shrink-0 opacity-80" />
          <span className="min-w-0 flex-1 truncate" title={label}>
            {label}
          </span>
          <span
            className={cn(
              "flex min-w-6 shrink-0 justify-end text-xs text-muted-foreground tabular-nums transition-opacity",
              !isReorderingCategory &&
                "group-hover:opacity-0 group-has-[[data-nav-more]:focus-visible]:opacity-0 group-has-[[data-nav-more][data-popup-open]]:opacity-0",
            )}
            data-nav-count=""
          >
            {count}
          </span>
        </button>

        {snapshot && (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label={tr(`${label} 的更多操作`, `More actions for ${label}`)}
                  className={cn(
                    "absolute right-1 transition-opacity",
                    isReorderingCategory
                      ? "pointer-events-none opacity-0"
                      : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100",
                  )}
                  data-nav-more=""
                  data-no-drag=""
                  size="icon-xs"
                  variant="ghost"
                >
                  <MoreHorizontalIcon />
                </Button>
              }
            />
            <MenuPopup align="start" side="right">
              <MenuItem onClick={() => installToTarget(target)}>
                {tr("安装 Skill 到此分类…", "Install skill here…")}
              </MenuItem>
              {categoryId && (
                <>
                  <MenuItem onClick={() => openRenameCategory(categoryId, label)}>
                    {tr("重命名", "Rename")}
                  </MenuItem>
                  {canReorderCategories && index !== undefined && (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        disabled={index === 0}
                        onClick={() => categoryReorder.moveBy(categoryId, -1)}
                      >
                        {tr("上移", "Move up")}
                      </MenuItem>
                      <MenuItem
                        disabled={index === categoryIds.length - 1}
                        onClick={() => categoryReorder.moveBy(categoryId, 1)}
                      >
                        {tr("下移", "Move down")}
                      </MenuItem>
                    </>
                  )}
                  <MenuSeparator />
                  <MenuItem
                    variant="destructive"
                    onClick={() => openDeleteCategory(categoryId, label)}
                  >
                    {tr("删除分类…", "Delete category…")}
                  </MenuItem>
                </>
              )}
            </MenuPopup>
          </Menu>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Scrollable navigation + floating header & footer */}
      <div className="relative min-h-0 flex-1">
        {/* Floating transparent sidebar header (leave left clearance for macOS traffic lights) */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10">
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 -bottom-6 bg-sidebar/55 backdrop-blur-md transition-opacity duration-200",
              navOverflowTop ? "opacity-100" : "opacity-0",
            )}
            style={{
              WebkitMaskImage:
                "linear-gradient(to bottom, #000 0%, #000 calc(100% - 24px), transparent 100%)",
              maskImage:
                "linear-gradient(to bottom, #000 0%, #000 calc(100% - 24px), transparent 100%)",
            }}
          />
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 -bottom-8 bg-linear-to-b from-black/[0.06] via-black/[0.025] to-transparent transition-opacity duration-200 dark:from-black/45 dark:via-black/22 dark:to-transparent",
              navOverflowTop ? "opacity-100" : "opacity-0",
            )}
          />
          <div
            className="pointer-events-auto relative flex h-12 select-none items-center gap-2 pr-3.5 pl-23"
            data-tauri-drag-region=""
            onMouseDown={(e) => {
              const target = e.target as HTMLElement;
              if (
                e.button === 0 &&
                e.detail >= 2 &&
                (target.hasAttribute("data-tauri-drag-region") ||
                  target.closest('[data-tauri-drag-region="deep"]'))
              ) {
                e.preventDefault();
              }
            }}
          >
            <div
              className="flex min-w-0 flex-1 items-center justify-center"
              data-tauri-drag-region="deep"
            >
              <span className="truncate font-semibold text-foreground text-sm tracking-tight">
                Skill Library
              </span>
            </div>
            <Button
              aria-label={tr("收起侧栏", "Collapse sidebar")}
              size="icon-xs"
              title={tr("收起侧栏", "Collapse sidebar")}
              variant="ghost"
              onClick={() => {
                if (mode === "desktop") onCollapseDesktop();
                else onCloseDrawer();
              }}
            >
              <PanelLeftCloseIcon />
            </Button>
          </div>
        </div>

        <div
          ref={scrollContainerRef}
          className={cn(
            "relative z-0 h-full space-y-4 overflow-y-auto px-2 pt-14 scroll-pt-14",
            desktop.updates ? "pb-28 scroll-pb-28" : "pb-18 scroll-pb-18",
          )}
          style={navFadeStyle}
          onScroll={updateNavOverflow}
        >
        <nav aria-label={tr("Skill 库", "Library")} className="space-y-0.5 p-0.5">
          {renderLibraryNavItem(
            tr("全部 Skill", "All skills"),
            { kind: "all" },
            snapshot?.skills.length ?? 0,
          )}
        </nav>

        {/* Categories */}
        <Collapsible open={categoriesOpen} onOpenChange={onCategoriesOpenChange}>
          <div className="flex items-center justify-between px-2 pb-1">
            <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 font-medium text-muted-foreground text-xs transition-colors hover:text-foreground [&[data-panel-open]>svg]:rotate-0">
              <ChevronDownIcon className="size-3.5 -rotate-90 transition-transform" />
              <span>{tr("分类", "Categories")}</span>
            </CollapsibleTrigger>
            <Button
              aria-label={tr("新建分类", "New category")}
              disabled={!snapshot}
              size="icon-xs"
              title={tr("新建分类", "New category")}
              variant="ghost"
              onClick={openCreateCategory}
            >
              <PlusIcon />
            </Button>
          </div>
          <CollapsiblePanel>
            <nav aria-label={tr("分类", "Categories")} className="space-y-0.5 p-0.5">
              {renderLibraryNavItem(
                tr("未分类", "Uncategorized"),
                { kind: "uncategorized" },
                categoryCounts.get(null) ?? 0,
              )}
              {(snapshot?.categories ?? []).map((cat, index) =>
                renderLibraryNavItem(
                  cat.name,
                  { kind: "category", id: cat.id },
                  categoryCounts.get(cat.id) ?? 0,
                  index,
                ),
              )}
            </nav>
          </CollapsiblePanel>
        </Collapsible>

        {/* My Tools / Agents */}
        {desktop.agents && (
          <Collapsible open={agentsOpen} onOpenChange={onAgentsOpenChange}>
            <div className="flex items-center justify-between px-2 pb-1">
              <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 font-medium text-muted-foreground text-xs transition-colors hover:text-foreground [&[data-panel-open]>svg]:rotate-0">
                <ChevronDownIcon className="size-3.5 -rotate-90 transition-transform" />
                <span>{tr("我的工具", "My tools")}</span>
              </CollapsibleTrigger>
              <Button
                aria-label={tr("添加工具", "Add tool")}
                disabled={!snapshot}
                size="icon-xs"
                title={tr("添加工具", "Add tool")}
                variant="ghost"
                onClick={openAddAgent}
              >
                <PlusIcon />
              </Button>
            </div>
            <CollapsiblePanel>
              <nav aria-label={tr("我的工具", "My tools")} className="space-y-0.5 p-0.5">
                {(snapshot?.agents ?? []).map((agent, index) => {
                  const active = page.kind === "agent" && page.id === agent.id;
                  const count = enabledByAgent.get(agent.id) ?? 0;
                  const isDraggingThis = agentReorder.draggingId === agent.id;

                  return (
                    <div
                      key={agent.id}
                      ref={agentReorder.setItemRef(agent.id)}
                      className={cn(
                        "group relative flex items-center",
                        isDraggingThis
                          ? "z-20"
                          : agentReorder.isDraggingAny
                            ? "transition-transform duration-150 ease-out"
                            : undefined,
                      )}
                      style={agentReorder.getItemStyle(agent.id, index)}
                    >
                      <button
                        aria-current={active ? "page" : undefined}
                        aria-label={agent.name}
                        className={cn(
                          "flex h-9 w-full select-none items-center gap-2.5 rounded-lg pr-2.5 pl-4 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          isDraggingThis
                            ? "cursor-grabbing bg-popover text-popover-foreground shadow-sm ring-1 ring-border"
                            : cn(
                                "cursor-pointer",
                                active
                                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                                  : agentReorder.isDraggingAny
                                    ? "text-sidebar-foreground"
                                    : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                              ),
                        )}
                        id={`agent-nav-${agent.id}`}
                        type="button"
                        onClick={() => {
                          if (agentReorder.consumeSuppressedClick(agent.id)) return;
                          navigate({ kind: "agent", id: agent.id });
                        }}
                        onDragStart={(e) => e.preventDefault()}
                        onKeyDown={
                          canReorderAgents
                            ? (e) => {
                                if (e.altKey && e.key === "ArrowUp") {
                                  e.preventDefault();
                                  agentReorder.moveBy(agent.id, -1);
                                } else if (e.altKey && e.key === "ArrowDown") {
                                  e.preventDefault();
                                  agentReorder.moveBy(agent.id, 1);
                                }
                              }
                            : undefined
                        }
                        onPointerDown={
                          canReorderAgents
                            ? agentReorder.getPointerDownHandler(agent.id)
                            : undefined
                        }
                      >
                        {canReorderAgents && (
                          <GripVerticalIcon
                            aria-hidden="true"
                            className={cn(
                              "pointer-events-none absolute left-0.5 size-3 shrink-0 text-muted-foreground transition-opacity",
                              isDraggingThis ? "opacity-90" : "opacity-0 group-hover:opacity-60",
                            )}
                          />
                        )}
                        <AgentMark agent={agent} />
                        <span className="min-w-0 flex-1 truncate" title={agent.name}>
                          {agent.name}
                        </span>
                        <span
                          className={cn(
                            "flex min-w-6 shrink-0 items-center justify-end gap-1.5 transition-opacity",
                            !agentReorder.isDraggingAny &&
                              "group-hover:opacity-0 group-has-[[data-nav-more]:focus-visible]:opacity-0 group-has-[[data-nav-more][data-popup-open]]:opacity-0",
                          )}
                          data-nav-count=""
                        >
                          <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
                        </span>
                      </button>

                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              aria-label={tr(`${agent.name} 的更多操作`, `More actions for ${agent.name}`)}
                              className={cn(
                                "absolute right-1 transition-opacity",
                                agentReorder.isDraggingAny
                                  ? "pointer-events-none opacity-0"
                                  : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100",
                              )}
                              data-nav-more=""
                              data-no-drag=""
                              size="icon-xs"
                              variant="ghost"
                            >
                              <MoreHorizontalIcon />
                            </Button>
                          }
                        />
                        <MenuPopup align="start" side="right">
                          {canReorderAgents && (
                            <>
                              <MenuItem
                                disabled={index === 0}
                                onClick={() => agentReorder.moveBy(agent.id, -1)}
                              >
                                {tr("上移", "Move up")}
                              </MenuItem>
                              <MenuItem
                                disabled={index === agentIds.length - 1}
                                onClick={() => agentReorder.moveBy(agent.id, 1)}
                              >
                                {tr("下移", "Move down")}
                              </MenuItem>
                              <MenuSeparator />
                            </>
                          )}
                          <MenuItem
                            variant="destructive"
                            onClick={() => openRemoveAgent(agent.id)}
                          >
                            {tr("移除工具…", "Remove tool…")}
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </div>
                  );
                })}
              </nav>
            </CollapsiblePanel>
          </Collapsible>
        )}
        </div>

        {/* Floating transparent sidebar footer */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 -top-7 bottom-0 bg-sidebar/55 backdrop-blur-md transition-opacity duration-200",
              navOverflowBottom ? "opacity-100" : "opacity-0",
            )}
            style={{
              WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, #000 28px, #000 100%)",
              maskImage: "linear-gradient(to bottom, transparent 0%, #000 28px, #000 100%)",
            }}
          />
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 -top-10 bottom-0 bg-linear-to-t from-black/[0.06] via-black/[0.025] to-transparent transition-opacity duration-200 dark:from-black/45 dark:via-black/22 dark:to-transparent",
              navOverflowBottom ? "opacity-100" : "opacity-0",
            )}
          />
          <div className="pointer-events-auto relative space-y-1 p-2.5">
            {desktop.updates && (
              <button
                aria-current={page.kind === "updates" ? "page" : undefined}
                aria-label={tr("更新中心", "Updates")}
                className={cn(
                  "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                  page.kind === "updates"
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
                disabled={!snapshot}
                type="button"
                onClick={() => navigate({ kind: "updates" })}
              >
                <RefreshCwIcon className="size-4 shrink-0 opacity-80" />
                <span className="min-w-0 flex-1 truncate">{tr("更新中心", "Updates")}</span>
                {updates.attentionCount > 0 && (
                  <Badge size="sm" variant="warning">
                    {updates.attentionCount}
                  </Badge>
                )}
              </button>
            )}

            <div className="flex items-center gap-1">
              {desktop.settings && (
                <button
                  aria-haspopup="dialog"
                  className="flex h-9 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-sidebar-foreground text-sm transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  disabled={!snapshot}
                  title={
                    appUpdates.hasBadge
                      ? tr("设置（有可用的应用更新）", "Settings (app update available)")
                      : undefined
                  }
                  type="button"
                  onClick={() => {
                    onCloseDrawer();
                    openSettings();
                  }}
                >
                  <SettingsIcon className="size-4 shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1 truncate">{tr("设置", "Settings")}</span>
                  {appUpdates.hasBadge && (
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full bg-info"
                      data-app-update-dot=""
                    />
                  )}
                </button>
              )}
              <Button
                aria-current={page.kind === "help" ? "page" : undefined}
                aria-label={tr("使用帮助", "Help")}
                disabled={!snapshot}
                size="icon"
                title={tr("使用帮助", "Help")}
                variant={page.kind === "help" ? "secondary" : "ghost"}
                onClick={() => navigate({ kind: "help" })}
              >
                <HelpCircleIcon />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AppShell(): React.ReactElement {
  const {
    desktop,
    snapshot,
    loading,
    loadError,
    retryLoad,
    page,
    setPage,
    activeDialog,
    settingsOpen,
    openSettings,
    openLocalImport,
    notify,
    triggerSearchFocus,
  } = useApp();

  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [categoriesOpen, setCategoriesOpen] = React.useState(true);
  const [agentsOpen, setAgentsOpen] = React.useState(true);
  const [dragging, setDragging] = React.useState(false);

  const activeDialogRef = React.useRef(activeDialog);
  activeDialogRef.current = activeDialog;
  const settingsOpenRef = React.useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const pageRef = React.useRef(page);
  pageRef.current = page;
  const snapshotRef = React.useRef(snapshot);
  snapshotRef.current = snapshot;

  // Global keyboard shortcuts
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !activeDialogRef.current && !settingsOpenRef.current) {
        setDrawerOpen(false);
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "f" &&
        snapshotRef.current &&
        pageRef.current.kind !== "help" &&
        pageRef.current.kind !== "updates" &&
        pageRef.current.kind !== "scan" &&
        !activeDialogRef.current &&
        !settingsOpenRef.current
      ) {
        event.preventDefault();
        triggerSearchFocus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [triggerSearchFocus]);

  // Folder drag & drop
  React.useEffect(() => {
    let cleanup: (() => void) | undefined;
    let disposed = false;
    void desktop
      .onFolderDrag((event) => {
        if (disposed) return;
        const blocked = !snapshotRef.current || Boolean(activeDialogRef.current) || settingsOpenRef.current;
        setDragging(event.type === "enter" && !blocked);
        if (event.type === "drop" && !blocked && event.paths.length > 0) {
          const cur = pageRef.current;
          const target =
            cur.kind === "category"
              ? destinationFromLibraryPage(cur)
              : ({ kind: "uncategorized" } as const);
          openLocalImport(target, { mode: "folders", paths: event.paths });
        }
      })
      .then((unsub) => {
        if (disposed) unsub();
        else cleanup = unsub;
      })
      .catch((error) => {
        if (!disposed) {
          notify({
            text: tr(
              `拖放不可用：${errorText(error)}。请使用文件选择器。`,
              `Drag and drop is unavailable. Use the folder picker. ${errorText(error)}`,
            ),
            error: true,
          });
        }
      });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [desktop, notify, openLocalImport]);

  const navigate = React.useCallback((next: typeof page) => {
    setPage(next);
    setDrawerOpen(false);
  }, [setPage]);

  const expandSidebar = React.useCallback(() => {
    if (window.innerWidth < 768) setDrawerOpen(true);
    else setSidebarCollapsed(false);
  }, []);

  const closeDrawer = React.useCallback(() => {
    setDrawerOpen(false);
  }, []);

  const collapseDesktop = React.useCallback(() => {
    setSidebarCollapsed(true);
  }, []);

  const shellChromeValue = React.useMemo(
    () => ({
      sidebarCollapsed,
      onExpandSidebar: expandSidebar,
      onNavigate: navigate,
      onOpenSettings: () => {
        setDrawerOpen(false);
        openSettings();
      },
    }),
    [sidebarCollapsed, expandSidebar, navigate, openSettings],
  );

  const renderMainPage = () => {
    if (loading) {
      return (
        <div className="flex h-full items-center justify-center gap-2.5 text-muted-foreground text-sm">
          <Spinner />
          <span>{tr("正在打开 Skill 库…", "Opening library…")}</span>
        </div>
      );
    }

    if (loadError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <h1 className="font-semibold text-xl">
            {tr("无法打开 Skill 库", "Could not open the library")}
          </h1>
          <p className="max-w-md text-destructive-foreground text-sm" role="alert">
            {loadError}
          </p>
          <Button variant="outline" onClick={retryLoad}>
            {tr("重试", "Retry")}
          </Button>
        </div>
      );
    }

    switch (page.kind) {
      case "all":
      case "uncategorized":
      case "category":
        return <LibraryPage page={page} />;
      case "agent":
        return <AgentPage agentId={page.id} />;
      case "scan":
        return <ScanPage initialFolders={page.initialFolders} />;
      case "updates":
        return <UpdatesPage />;
      case "help":
        return <HelpPage />;
    }
  };

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden h-full shrink-0 border-r border-sidebar-border transition-[width] duration-200 ease-in-out md:block",
          sidebarCollapsed ? "w-0 overflow-hidden border-r-0" : "w-60",
        )}
        id="workspace-sidebar"
      >
        <div className="h-full w-60">
          <SidebarBody
            agentsOpen={agentsOpen}
            categoriesOpen={categoriesOpen}
            mode="desktop"
            onAgentsOpenChange={setAgentsOpen}
            onCategoriesOpenChange={setCategoriesOpen}
            onCloseDrawer={closeDrawer}
            onCollapseDesktop={collapseDesktop}
          />
        </div>
      </aside>

      {/* Mobile / narrow drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div
            aria-hidden="true"
            className="fixed inset-0 bg-black/32 backdrop-blur-xs"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="relative z-10 h-full w-64 border-r bg-sidebar shadow-xl">
            <SidebarBody
              agentsOpen={agentsOpen}
              categoriesOpen={categoriesOpen}
              mode="drawer"
              onAgentsOpenChange={setAgentsOpen}
              onCategoriesOpenChange={setCategoriesOpen}
              onCloseDrawer={closeDrawer}
              onCollapseDesktop={collapseDesktop}
            />
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Page Content */}
        <main className="min-h-0 flex-1 overflow-hidden">
          <ShellChromeContext.Provider value={shellChromeValue}>
            {renderMainPage()}
          </ShellChromeContext.Provider>
        </main>
      </div>

      {/* Drag & drop overlay */}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-xs">
          <div className="rounded-2xl border-2 border-primary border-dashed bg-card px-8 py-6 text-center shadow-lg">
            <p className="font-medium text-base">
              {tr("松开以预览本地 Skill", "Drop to preview local skills")}
            </p>
          </div>
        </div>
      )}

      {/* Global Dialogs */}
      <LibraryDialogs />
      <AddAgentDialog />
      <RemoveAgentDialog />
      <LocalImportDialog />
      <OnlineImportDialog />
      <SourceAttachmentDialog />
      <SettingsDialog />
    </div>
  );
}
