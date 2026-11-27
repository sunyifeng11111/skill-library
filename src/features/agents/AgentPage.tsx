import {
  ChevronDownIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FolderCogIcon,
  FolderOpenIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import * as React from "react";
import { useApp } from "@/app/AppContext";
import { discoveryUndoAction } from "@/app/discoveryUndo";
import { AgentMark } from "@/components/AgentMark";
import { CategoryPicker, validateCategoryTarget } from "@/components/CategoryPicker";
import { renderEmojiSafeText } from "@/components/EmojiSafeText";
import { PageToolbar, useScrolled } from "@/components/PageToolbar";
import { SkillViewModeControl } from "@/components/SkillViewModeControl";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Frame, FramePanel } from "@/components/ui/frame";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  isAdoptableUnmanagedRow,
  isUnmanagedRow,
  type DiscoveredSkill,
} from "@/shared/discovery";
import { tr } from "@/shared/language";
import type {
  Agent,
  AgentAssignment,
  CategoryTarget,
  Skill,
  SyncOutcome,
} from "@/shared/library";
import { errorText } from "@/shared/ui";
import { skillMonogram } from "@/shared/view-mode";
import { AgentDirectoryField, type AgentDirectoryState } from "./AgentDirectoryField";

type CategoryFilter = "all" | "__local__" | "uncategorized" | string;

interface CategoryGroup {
  key: string;
  id: string | null;
  name: string;
  skills: Skill[];
  enabledCount: number;
  syncing: boolean;
}

const EMPTY_INVENTORY: DiscoveredSkill[] = [];

export function AgentPage({ agentId }: { agentId: string }): React.ReactElement | null {
  const {
    desktop,
    snapshot,
    setSnapshot,
    setPage,
    skillViewMode,
    setSkillViewMode,
    notify,
    openRemoveAgent,
    openSkillDetail,
    agentInventoryById,
    scanningAllAgents,
    scanningAgentIds,
    ensureAgentInventoryLoaded,
    refreshAgentInventory,
    searchTrigger,
  } = useApp();

  const gateway = desktop.agents;
  const agent = snapshot?.agents?.find((item) => item.id === agentId);

  const [query, setQuery] = React.useState("");
  const [selectedCategory, setSelectedCategory] = React.useState<CategoryFilter>("all");
  const [onlyEnabled, setOnlyEnabled] = React.useState(false);
  const [stickyIds, setStickyIds] = React.useState<Set<string>>(() => new Set());
  const [expandedGroups, setExpandedGroups] = React.useState<Set<string>>(() => new Set());
  const [showEmptyCategories, setShowEmptyCategories] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // Unmanaged item detail & adopt dialog state
  const [detailUnmanaged, setDetailUnmanaged] = React.useState<DiscoveredSkill | null>(null);
  const [adoptTarget, setAdoptTarget] = React.useState<CategoryTarget>({ kind: "uncategorized" });
  const [adoptTargetError, setAdoptTargetError] = React.useState<string | null>(null);

  // Inline directory editor state
  const [editingDir, setEditingDir] = React.useState(false);
  const [editPath, setEditPath] = React.useState("");
  const [editDirState, setEditDirState] = React.useState<AgentDirectoryState>({
    path: "",
    preview: null,
    checking: false,
    choosing: false,
    error: null,
  });
  const [editDirError, setEditDirError] = React.useState<string | null>(null);

  const searchRef = React.useRef<HTMLInputElement>(null);
  const { scrolled, scrollRef, onScroll, scrollStyle } = useScrolled(agentId);

  const lastSearchTriggerRef = React.useRef(searchTrigger);
  React.useEffect(() => {
    if (searchTrigger !== lastSearchTriggerRef.current) {
      lastSearchTriggerRef.current = searchTrigger;
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  }, [searchTrigger]);

  React.useEffect(() => {
    setQuery("");
    setSelectedCategory("all");
    setOnlyEnabled(false);
    setStickyIds(new Set());
    setExpandedGroups(new Set());
    setShowEmptyCategories(false);
    setDetailUnmanaged(null);
    setAdoptTarget({ kind: "uncategorized" });
    setAdoptTargetError(null);
    setEditingDir(false);
    setEditDirError(null);
    ensureAgentInventoryLoaded(agentId);
  }, [agentId, ensureAgentInventoryLoaded]);

  const inventory = agentInventoryById.get(agentId) ?? EMPTY_INVENTORY;
  const scanning = scanningAllAgents || scanningAgentIds.has(agentId);
  const uncategorizedLabel = tr("未分类", "Uncategorized");

  const assignments = React.useMemo(() => {
    const map = new Map<string, AgentAssignment>();
    if (!snapshot || !agent) return map;
    for (const item of snapshot.assignments ?? []) {
      if (item.agentId === agent.id) {
        map.set(item.skillId, item);
      }
    }
    return map;
  }, [snapshot, agent]);

  const allUnmanagedRows = React.useMemo(
    () => inventory.filter(isAdoptableUnmanagedRow),
    [inventory],
  );

  const conflictPaths = React.useMemo(() => {
    const conflicts = new Set<string>();
    if (!snapshot || allUnmanagedRows.length === 0) return conflicts;

    const fingerprintsByName = new Map<string, Set<string>>();
    for (const skill of snapshot.skills) {
      let set = fingerprintsByName.get(skill.name);
      if (!set) {
        set = new Set();
        fingerprintsByName.set(skill.name, set);
      }
      set.add(skill.fingerprint);
    }
    for (const row of allUnmanagedRows) {
      if (!row.fingerprint) continue;
      let set = fingerprintsByName.get(row.name);
      if (!set) {
        set = new Set();
        fingerprintsByName.set(row.name, set);
      }
      set.add(row.fingerprint);
    }

    for (const row of allUnmanagedRows) {
      if ((fingerprintsByName.get(row.name)?.size ?? 0) > 1) {
        conflicts.add(row.path);
      }
    }
    return conflicts;
  }, [allUnmanagedRows, snapshot]);

  const cleanUnmanagedRows = React.useMemo(
    () => allUnmanagedRows.filter((row) => !conflictPaths.has(row.path)),
    [allUnmanagedRows, conflictPaths],
  );

  const categoryNameById = React.useMemo(
    () => new Map<string, string>((snapshot?.categories ?? []).map((cat) => [cat.id, cat.name])),
    [snapshot],
  );

  const { customGroups, uncategorizedGroup } = React.useMemo(() => {
    if (!snapshot || !agent) {
      return { customGroups: [] as CategoryGroup[], uncategorizedGroup: null as CategoryGroup | null };
    }
    const skillsByCategory = new Map<string | null, Skill[]>();
    for (const skill of snapshot.skills) {
      const key = skill.categoryId;
      let bucket = skillsByCategory.get(key);
      if (!bucket) {
        bucket = [];
        skillsByCategory.set(key, bucket);
      }
      bucket.push(skill);
    }

    const syncedSet = new Set(agent.syncedCategories);
    const nextCustomGroups: CategoryGroup[] = snapshot.categories.map((cat) => {
      const members = skillsByCategory.get(cat.id) ?? [];
      let enabledCount = 0;
      for (const s of members) {
        if (assignments.get(s.id)?.path) enabledCount += 1;
      }
      return {
        key: cat.id,
        id: cat.id,
        name: cat.name,
        skills: members,
        enabledCount,
        syncing: syncedSet.has(cat.id),
      };
    });

    const uncategorizedSkills = skillsByCategory.get(null) ?? [];
    let uncategorizedEnabled = 0;
    for (const s of uncategorizedSkills) {
      if (assignments.get(s.id)?.path) uncategorizedEnabled += 1;
    }
    const nextUncategorizedGroup: CategoryGroup | null =
      uncategorizedSkills.length > 0 || agent.syncUncategorized
        ? {
            key: "uncategorized",
            id: null,
            name: uncategorizedLabel,
            skills: uncategorizedSkills,
            enabledCount: uncategorizedEnabled,
            syncing: agent.syncUncategorized,
          }
        : null;

    return { customGroups: nextCustomGroups, uncategorizedGroup: nextUncategorizedGroup };
  }, [snapshot, agent, assignments, uncategorizedLabel]);

  if (!snapshot || !agent || !gateway) return null;

  const enabledTotal = snapshot.skills.filter((s) => Boolean(assignments.get(s.id)?.path)).length;

  const trimmedQuery = query.trim().toLocaleLowerCase();
  const searchMatches = snapshot.skills.filter(
    (s) =>
      s.name.toLocaleLowerCase().includes(trimmedQuery) ||
      s.description.toLocaleLowerCase().includes(trimmedQuery),
  );

  const unmanagedSearchMatches = trimmedQuery
    ? allUnmanagedRows.filter(
        (row) =>
          row.name.toLocaleLowerCase().includes(trimmedQuery) ||
          (row.description ?? "").toLocaleLowerCase().includes(trimmedQuery),
      )
    : [];

  const emptyCustomGroups = customGroups.filter((g) => g.skills.length === 0 && !g.syncing);
  const activeGroups: CategoryGroup[] = [
    ...customGroups.filter((g) => g.skills.length > 0 || g.syncing || showEmptyCategories),
    ...(uncategorizedGroup ? [uncategorizedGroup] : []),
  ];

  const categoryFilterOptions: {
    key: CategoryFilter;
    label: string;
    enabledCount: number;
    totalCount: number;
    isLocal?: boolean;
  }[] = [
    {
      key: "all",
      label: tr("全部", "All"),
      enabledCount: enabledTotal,
      totalCount: snapshot.skills.length,
    },
    ...(allUnmanagedRows.length > 0
      ? [
          {
            key: "__local__" as const,
            label: tr("仅在本工具", "Local only"),
            enabledCount: allUnmanagedRows.length,
            totalCount: allUnmanagedRows.length,
            isLocal: true,
          },
        ]
      : []),
    ...activeGroups.map((g) => ({
      key: g.key,
      label: g.name,
      enabledCount: g.enabledCount,
      totalCount: g.skills.length,
    })),
  ];

  const activeCategory: CategoryFilter = categoryFilterOptions.some(
    (opt) => opt.key === selectedCategory,
  )
    ? selectedCategory
    : "all";

  const showUnmanagedGroup =
    allUnmanagedRows.length > 0 &&
    (activeCategory === "all" || activeCategory === "__local__");

  const visibleGroups = activeGroups
    .filter((group) => activeCategory === "all" || group.key === activeCategory)
    .map((group) => {
      const visibleSkills = onlyEnabled
        ? group.skills.filter(
            (skill) => Boolean(assignments.get(skill.id)?.path) || stickyIds.has(skill.id),
          )
        : group.skills;
      return { ...group, visibleSkills };
    })
    .filter((group) => !onlyEnabled || group.visibleSkills.length > 0);

  const visibleExpandableKeys = [
    ...visibleGroups.map((group) => group.key),
    ...(showUnmanagedGroup ? ["__local__"] : []),
  ];
  const allVisibleExpanded =
    visibleExpandableKeys.length > 0 &&
    visibleExpandableKeys.every((key) => expandedGroups.has(key));
  const isLocalOpen = expandedGroups.has("__local__");

  const shortcutLabel = /mac/i.test(navigator.platform) ? "⌘F" : "Ctrl+F";

  async function mutate(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      notify({ text: errorText(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveDirectory(e: React.FormEvent) {
    e.preventDefault();
    if (!gateway || !agent || !editDirState.preview || busy || editDirState.choosing) return;
    setBusy(true);
    setEditDirError(null);
    try {
      const next = await gateway.changeDirectory(
        agent.id,
        editDirState.preview.directory,
        !editDirState.preview.exists,
      );
      setSnapshot(next);
      setEditingDir(false);
      notify({ text: tr("已更新工具文件夹。", "Updated tool folder.") });
      void refreshAgentInventory(agent.id, { clearBeforeScan: true, notifyOnError: true });
    } catch (reason) {
      setEditDirError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenPath(path: string) {
    try {
      await desktop.discovery.openInSystem(path);
    } catch (error) {
      notify({ text: errorText(error), error: true });
    }
  }

  function openUnmanagedDetail(row: DiscoveredSkill) {
    setDetailUnmanaged(row);
    setAdoptTarget({ kind: "uncategorized" });
    setAdoptTargetError(null);
  }

  async function handleAdoptRows(rows: DiscoveredSkill[], target?: CategoryTarget) {
    if (!agent || !snapshot || !rows.length) return;
    let validatedTarget: CategoryTarget | undefined;
    if (target) {
      try {
        validatedTarget = validateCategoryTarget(target);
      } catch (err) {
        setAdoptTargetError(errorText(err));
        return;
      }
    }

    await mutate(async () => {
      const existingIds = new Set(snapshot.skills.map((s) => s.id));
      const outcome = await desktop.discovery.commitBatch({
        readyRows: rows,
        conflicts: [],
        copyOnly: false,
        summary: tr(
          `${agent.name} 收进 Skill 库（${rows.length} 项）`,
          `Add from ${agent.name} (${rows.length})`,
        ),
      });
      const failures = outcome.results.filter((r) => r.error);
      let finalSnapshot = outcome.snapshot;
      let moveUndoId: string | null = null;

      if (
        validatedTarget &&
        validatedTarget.kind !== "uncategorized" &&
        failures.length === 0 &&
        rows.length === 1
      ) {
        const adoptedSkill =
          outcome.snapshot.skills.find((s) => !existingIds.has(s.id)) ??
          outcome.snapshot.skills.find((s) => s.fingerprint === rows[0].fingerprint);
        if (adoptedSkill) {
          try {
            const moved = await desktop.library.moveSkills([adoptedSkill.id], validatedTarget);
            finalSnapshot = moved.library;
            moveUndoId = moved.undo;
          } catch (moveErr) {
            setSnapshot(outcome.snapshot);
            setDetailUnmanaged(null);
            await refreshAgentInventory(agent.id);
            notify({ text: errorText(moveErr), error: true });
            return;
          }
        }
      }

      setSnapshot(finalSnapshot);
      setDetailUnmanaged(null);
      await refreshAgentInventory(agent.id);
      const undoAction = discoveryUndoAction({
        batchId: outcome.batchId,
        discovery: desktop.discovery,
        setSnapshot,
        notify,
        restoredText: tr(
          "已撤销刚才的导入，原文件已恢复。",
          "Undid the import and restored original files.",
        ),
        beforeUndo: moveUndoId ? () => desktop.library.undoMove(moveUndoId) : undefined,
        refresh: () => refreshAgentInventory(agent.id),
      });
      if (failures.length) {
        notify({
          text: tr(
            `有 ${failures.length} 项未能导入：${failures[0].error}`,
            `${failures.length} failed: ${failures[0].error}`,
          ),
          error: true,
          action: undoAction,
        });
      } else {
        notify({
          text: tr(
            `已收进 ${outcome.managedCount} 个 Skill，并保持在 ${agent.name} 中开启。`,
            `Added ${outcome.managedCount} ${outcome.managedCount === 1 ? "skill" : "skills"} to your library and kept them enabled in ${agent.name}.`,
          ),
          action: undoAction,
        });
      }
    });
  }

  async function handleToggleSkill(skill: Skill, assignment?: AgentAssignment) {
    if (!agent || !gateway) return;
    const enabled = Boolean(assignment?.path);
    const originals = enabled
      ? []
      : inventory.filter(
          (row) =>
            row.fingerprint === skill.fingerprint && row.identity && isUnmanagedRow(row),
        );

    await mutate(async () => {
      if (!enabled && originals.length) {
        const outcome = await desktop.discovery.commitBatch({
          readyRows: originals,
          conflicts: [],
          copyOnly: false,
          summary: tr(
            `在 ${agent.name} 中开启 ${skill.name}`,
            `Enable ${skill.name} in ${agent.name}`,
          ),
        });
        setSnapshot(outcome.snapshot);
        await refreshAgentInventory(agent.id);
        notify({
          text: tr(
            `已在 ${agent.name} 中开启 ${skill.name}。`,
            `Enabled ${skill.name} in ${agent.name}.`,
          ),
        });
        return;
      }

      const next = await gateway.setSkill(agent.id, skill.id, !enabled);
      if (onlyEnabled && enabled) {
        setStickyIds((prev) => {
          const updated = new Set(prev);
          updated.add(skill.id);
          return updated;
        });
      }
      setSnapshot(next);
      notify({
        text: enabled
          ? tr(
              `已在 ${agent.name} 中关闭 ${skill.name}。`,
              `Disabled ${skill.name} in ${agent.name}.`,
            )
          : tr(
              `已在 ${agent.name} 中开启 ${skill.name}。`,
              `Enabled ${skill.name} in ${agent.name}.`,
            ),
      });
    });
  }

  async function handleSyncCategory(
    currentAgent: Agent,
    group: CategoryGroup,
    enabling: boolean,
  ) {
    if (!gateway) return;
    await mutate(async () => {
      if (onlyEnabled && !enabling) {
        const currentlyEnabledIds = group.skills
          .filter((skill) => Boolean(assignments.get(skill.id)?.path))
          .map((skill) => skill.id);
        if (currentlyEnabledIds.length > 0) {
          setStickyIds((prev) => {
            const updated = new Set(prev);
            for (const id of currentlyEnabledIds) updated.add(id);
            return updated;
          });
        }
      }

      const result: SyncOutcome = await gateway.setCategorySync(
        currentAgent.id,
        group.id,
        enabling,
      );
      setSnapshot(result.library);
      const undo = result.undo;
      notify({
        text: enabling
          ? tr(
              `已为 ${currentAgent.name} 开启「${group.name}」里的全部 Skill，以后新增也会自动开启。`,
              `Enabled all skills in “${group.name}” for ${currentAgent.name}. New skills here will enable automatically.`,
            )
          : tr(
              `已关闭「${group.name}」的整类自动开启。`,
              `Turned off auto-enable for “${group.name}”.`,
            ),
        action: undo
          ? {
              label: tr("撤销", "Undo"),
              run: async () => {
                await mutate(async () => {
                  const reverted = await gateway.undoCategorySync(undo);
                  setSnapshot(reverted.library);
                  notify({ text: tr("已撤销刚才的变更。", "Undid the change.") });
                });
              },
            }
          : undefined,
      });
    });
  }

  const renderSkillRow = (skill: Skill, showCategoryBadge: boolean) => {
    const assignment = assignments.get(skill.id);
    const enabled = Boolean(assignment?.path);
    const categoryName = skill.categoryId
      ? categoryNameById.get(skill.categoryId)
      : tr("未分类", "Uncategorized");
    const isStickyDisabled = onlyEnabled && !enabled && stickyIds.has(skill.id);
    const switchLabel = enabled
      ? tr(`在 ${agent.name} 中停用 ${skill.name}`, `Disable ${skill.name} in ${agent.name}`)
      : tr(`在 ${agent.name} 中启用 ${skill.name}`, `Enable ${skill.name} in ${agent.name}`);

    return (
      <li
        key={skill.id}
        className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-accent/40"
      >
        <button
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          type="button"
          onClick={() => openSkillDetail(skill.id)}
        >
          <span
            aria-hidden="true"
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg font-medium text-[11px] tracking-wide transition-opacity",
              enabled
                ? "bg-muted text-foreground"
                : "bg-muted/60 text-muted-foreground opacity-60",
            )}
          >
            {skillMonogram(skill.name)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span
                className={cn(
                  "truncate text-sm",
                  enabled ? "font-medium text-foreground" : "font-normal text-muted-foreground",
                )}
                title={skill.name}
              >
                {renderEmojiSafeText(skill.name)}
              </span>
              {enabled && assignment?.viaCategory && (
                <Badge size="sm" variant="secondary">
                  {tr("随分类", "Auto")}
                </Badge>
              )}
              {!enabled && assignment?.excluded && (
                <Badge className="text-muted-foreground" size="sm" variant="secondary">
                  {tr("已排除", "Excluded")}
                </Badge>
              )}
              {isStickyDisabled && (
                <Badge className="text-muted-foreground" size="sm" variant="secondary">
                  {tr("已关闭", "Disabled")}
                </Badge>
              )}
              {showCategoryBadge && categoryName && (
                <Badge
                  className="max-w-36 justify-start overflow-hidden"
                  size="sm"
                  title={categoryName}
                  variant="secondary"
                >
                  <span className="truncate">{categoryName}</span>
                </Badge>
              )}
            </span>
            {skill.description && (
              <span
                className={cn(
                  "truncate text-muted-foreground text-xs",
                  !enabled && "opacity-75",
                )}
                title={skill.description}
              >
                {renderEmojiSafeText(skill.description)}
              </span>
            )}
          </span>
        </button>

        <Switch
          aria-label={switchLabel}
          checked={enabled}
          disabled={busy}
          title={switchLabel}
          onCheckedChange={() => void handleToggleSkill(skill, assignment)}
        />
      </li>
    );
  };

  const renderSkillCard = (skill: Skill, showCategoryBadge: boolean) => {
    const assignment = assignments.get(skill.id);
    const enabled = Boolean(assignment?.path);
    const categoryName = skill.categoryId
      ? categoryNameById.get(skill.categoryId)
      : tr("未分类", "Uncategorized");
    const isStickyDisabled = onlyEnabled && !enabled && stickyIds.has(skill.id);
    const switchLabel = enabled
      ? tr(`在 ${agent.name} 中停用 ${skill.name}`, `Disable ${skill.name} in ${agent.name}`)
      : tr(`在 ${agent.name} 中启用 ${skill.name}`, `Enable ${skill.name} in ${agent.name}`);

    return (
      <li
        key={skill.id}
        className={cn(
          "group/card relative flex flex-col justify-between gap-3 rounded-xl border p-4 shadow-xs/5 transition-[border-color,background-color,box-shadow]",
          enabled
            ? "border-border bg-background hover:border-ring/60"
            : "border-border/75 bg-background/65 hover:border-ring/50 hover:bg-background",
        )}
      >
        <div className="flex items-start justify-between gap-2.5">
          <button
            className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            type="button"
            onClick={() => openSkillDetail(skill.id)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-md font-medium text-[10px] tracking-wide transition-opacity",
                  enabled
                    ? "bg-muted text-foreground"
                    : "bg-muted/60 text-muted-foreground opacity-60",
                )}
              >
                {skillMonogram(skill.name)}
              </span>
              <span
                className={cn(
                  "truncate text-sm",
                  enabled ? "font-medium text-foreground" : "font-normal text-muted-foreground",
                )}
                title={skill.name}
              >
                {renderEmojiSafeText(skill.name)}
              </span>
            </span>
            {skill.description && (
              <span
                className={cn(
                  "line-clamp-2 min-h-9 text-muted-foreground text-xs leading-relaxed",
                  !enabled && "opacity-75",
                )}
                title={skill.description}
              >
                {renderEmojiSafeText(skill.description)}
              </span>
            )}
          </button>

          <div className="mt-0.5 shrink-0">
            <Switch
              aria-label={switchLabel}
              checked={enabled}
              disabled={busy}
              title={switchLabel}
              onCheckedChange={() => void handleToggleSkill(skill, assignment)}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {enabled && assignment?.viaCategory ? (
            <Badge size="sm" variant="secondary">
              {tr("随分类", "Auto")}
            </Badge>
          ) : enabled ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
              {tr("已启用", "Enabled")}
            </span>
          ) : null}
          {!enabled && assignment?.excluded && (
            <Badge className="text-muted-foreground" size="sm" variant="secondary">
              {tr("已排除", "Excluded")}
            </Badge>
          )}
          {isStickyDisabled && (
            <Badge className="text-muted-foreground" size="sm" variant="secondary">
              {tr("已关闭", "Disabled")}
            </Badge>
          )}
          {!enabled && !assignment?.excluded && !isStickyDisabled && (
            <span className="text-muted-foreground/75 text-xs">{tr("未启用", "Off")}</span>
          )}
          {showCategoryBadge && categoryName && (
            <Badge
              className="max-w-36 justify-start overflow-hidden"
              size="sm"
              title={categoryName}
              variant="secondary"
            >
              <span className="truncate">{categoryName}</span>
            </Badge>
          )}
        </div>
      </li>
    );
  };

  const renderUnmanagedRow = (row: DiscoveredSkill) => {
    const isConflict = conflictPaths.has(row.path);
    const typeLabel =
      row.status === "externalLink"
        ? tr("外部软链", "External link")
        : tr("独立文件夹", "Local folder");

    return (
      <li
        key={row.path}
        className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-accent/40"
      >
        <button
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          type="button"
          onClick={() => openUnmanagedDetail(row)}
        >
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-foreground/20 bg-muted/50 font-medium text-[11px] text-foreground tracking-wide"
          >
            {skillMonogram(row.name)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate font-medium text-foreground text-sm" title={row.name}>
                {renderEmojiSafeText(row.name)}
              </span>
              <Badge size="sm" variant="outline">
                {typeLabel}
              </Badge>
              {isConflict && (
                <Badge size="sm" variant="warning">
                  {tr("同名差异", "Differs")}
                </Badge>
              )}
            </span>
            <span
              className="truncate text-muted-foreground text-xs"
              title={row.description || row.path}
            >
              {renderEmojiSafeText(row.description || row.path)}
            </span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            aria-label={tr(`在访达中打开 ${row.name}`, `Reveal ${row.name}`)}
            size="xs"
            title={row.path}
            variant="ghost"
            onClick={() => void handleOpenPath(row.path)}
          >
            <FolderOpenIcon />
            {tr("访达", "Reveal")}
          </Button>
          {isConflict ? (
            <Button
              disabled={busy}
              size="xs"
              variant="outline"
              onClick={() => setPage({ kind: "scan" })}
            >
              {tr("对比并处理", "Resolve")}
            </Button>
          ) : (
            <Button
              disabled={busy}
              size="xs"
              variant="outline"
              onClick={() => void handleAdoptRows([row])}
            >
              {tr("收进库", "Add to library")}
            </Button>
          )}
        </div>
      </li>
    );
  };

  const renderUnmanagedCard = (row: DiscoveredSkill) => {
    const isConflict = conflictPaths.has(row.path);
    const typeLabel =
      row.status === "externalLink"
        ? tr("外部软链", "External link")
        : tr("独立文件夹", "Local folder");

    return (
      <li
        key={row.path}
        className="group/card relative flex flex-col justify-between gap-3 rounded-xl border border-dashed border-foreground/20 bg-background/80 p-4 shadow-xs/5 transition-[border-color,background-color] hover:border-foreground/35 hover:bg-background"
      >
        <button
          className="flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          type="button"
          onClick={() => openUnmanagedDetail(row)}
        >
          <span className="flex min-w-0 items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center rounded-md border border-dashed border-foreground/20 bg-muted/50 font-medium text-[10px] text-foreground tracking-wide"
              >
                {skillMonogram(row.name)}
              </span>
              <span className="truncate font-medium text-foreground text-sm" title={row.name}>
                {renderEmojiSafeText(row.name)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <Badge size="sm" variant="outline">
                {typeLabel}
              </Badge>
              {isConflict && (
                <Badge size="sm" variant="warning">
                  {tr("同名差异", "Differs")}
                </Badge>
              )}
            </span>
          </span>
          <span
            className="line-clamp-2 min-h-9 text-muted-foreground text-xs leading-relaxed"
            title={row.description || row.path}
          >
            {renderEmojiSafeText(row.description || row.path)}
          </span>
        </button>

        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            aria-label={tr(`在访达中打开 ${row.name}`, `Reveal ${row.name}`)}
            size="xs"
            title={row.path}
            variant="ghost"
            onClick={() => void handleOpenPath(row.path)}
          >
            <FolderOpenIcon />
            {tr("访达", "Reveal")}
          </Button>
          {isConflict ? (
            <Button
              disabled={busy}
              size="xs"
              variant="outline"
              onClick={() => setPage({ kind: "scan" })}
            >
              {tr("对比并处理", "Resolve")}
            </Button>
          ) : (
            <Button
              disabled={busy}
              size="xs"
              variant="outline"
              onClick={() => void handleAdoptRows([row])}
            >
              {tr("收进库", "Add to library")}
            </Button>
          )}
        </div>
      </li>
    );
  };

  const totalSearchMatches = searchMatches.length + unmanagedSearchMatches.length;

  return (
    <section className="relative flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <PageToolbar
        actions={
          <InputGroup className="w-44 sm:w-56 lg:w-64">
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
        }
        breadcrumb={tr(`我的工具 ／ ${agent.name}`, `My tools / ${agent.name}`)}
        scrolled={scrolled}
      />

      {/* Scrollable content */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6 pt-18 pb-6 scroll-pt-16 md:px-8"
        style={scrollStyle}
        onScroll={onScroll}
      >
        <div className="mx-auto flex max-w-5xl flex-col gap-5">
          {/* Header */}
          <header className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-card shadow-xs/5">
                <AgentMark agent={agent} className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="break-words font-semibold text-2xl tracking-tight">{agent.name}</h1>
                <p className="mt-0.5 text-muted-foreground text-xs">
                  {tr(
                    `已启用 ${enabledTotal} / ${snapshot.skills.length} 个 Skill`,
                    `${enabledTotal} of ${snapshot.skills.length} skills enabled`,
                  )}
                  {allUnmanagedRows.length > 0 && (
                    <>
                      <span className="mx-1.5 opacity-50">·</span>
                      <span>
                        {tr(
                          `${allUnmanagedRows.length} 个仅在本工具`,
                          `${allUnmanagedRows.length} local only`,
                        )}
                      </span>
                    </>
                  )}
                  <span className="mx-1.5 opacity-50">·</span>
                  <span className="break-all font-mono">{agent.directory}</span>
                </p>
              </div>
            </div>

            <div className="shrink-0">
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      aria-label={tr("更多操作", "More actions")}
                      disabled={busy}
                      id="agent-page-more"
                      size="icon"
                      title={tr("更多操作", "More actions")}
                      variant="ghost"
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  }
                />
                <MenuPopup align="end">
                  <MenuItem
                    disabled={scanning || busy}
                    onClick={() => void refreshAgentInventory(agent.id, { notifyOnError: true })}
                  >
                    <RefreshCwIcon />
                    {scanning
                      ? tr("正在检查文件夹…", "Scanning folder…")
                      : tr("重新检查文件夹", "Rescan folder")}
                  </MenuItem>
                  <MenuItem
                    disabled={busy}
                    onClick={() => {
                      setEditPath(agent.directory);
                      setEditDirError(null);
                      setEditingDir(true);
                    }}
                  >
                    <FolderCogIcon />
                    {tr("修改工具文件夹…", "Change tool folder…")}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    disabled={busy}
                    variant="destructive"
                    onClick={() => openRemoveAgent(agent.id)}
                  >
                    <Trash2Icon />
                    {tr("从「我的工具」移除…", "Remove from My tools…")}
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
          </header>

          {/* Inline directory editor */}
          {editingDir && (
            <Frame>
              <FramePanel>
                <form
                  className="flex flex-col gap-3"
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && !busy) {
                      e.preventDefault();
                      setEditingDir(false);
                    }
                  }}
                  onSubmit={(e) => void handleSaveDirectory(e)}
                >
                  <AgentDirectoryField
                    agentId={agent.id}
                    autoFocus
                    disabled={busy}
                    externalError={editDirError}
                    gateway={gateway}
                    path={editPath}
                    onPathChange={(next) => {
                      setEditPath(next);
                      setEditDirError(null);
                    }}
                    onStateChange={setEditDirState}
                  />
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      disabled={busy}
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingDir(false)}
                    >
                      {tr("取消", "Cancel")}
                    </Button>
                    <Button
                      disabled={!editDirState.preview || editDirState.choosing || busy}
                      loading={busy}
                      size="sm"
                      type="submit"
                    >
                      {editDirState.preview && !editDirState.preview.exists
                        ? tr("创建目录并保存", "Create folder and save")
                        : tr("保存目录", "Save folder")}
                    </Button>
                  </div>
                </form>
              </FramePanel>
            </Frame>
          )}

          {/* Search mode */}
          {trimmedQuery ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-medium text-muted-foreground text-sm">
                  {tr(
                    `匹配的 Skill · ${totalSearchMatches}`,
                    `Matching skills · ${totalSearchMatches}`,
                  )}
                </h2>
                <div className="flex items-center gap-2">
                  <SkillViewModeControl value={skillViewMode} onChange={setSkillViewMode} />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setQuery("");
                      searchRef.current?.focus();
                    }}
                  >
                    {tr("清空搜索", "Clear search")}
                  </Button>
                </div>
              </div>
              {totalSearchMatches === 0 ? (
                <p className="py-12 text-center text-muted-foreground text-sm">
                  {tr("没有匹配的 Skill。", "No matching skills.")}
                </p>
              ) : (
                <div className="flex flex-col gap-3.5">
                  {searchMatches.length > 0 &&
                    (skillViewMode === "list" ? (
                      <Frame>
                        <FramePanel className="overflow-hidden p-0">
                          <ul className="divide-y">
                            {searchMatches.map((skill) =>
                              renderSkillRow(skill, snapshot.categories.length > 0),
                            )}
                          </ul>
                        </FramePanel>
                      </Frame>
                    ) : (
                      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {searchMatches.map((skill) =>
                          renderSkillCard(skill, snapshot.categories.length > 0),
                        )}
                      </ul>
                    ))}

                  {unmanagedSearchMatches.length > 0 && (
                    <Frame className={skillViewMode === "grid" ? "p-1.5" : undefined}>
                      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                        <span className="font-semibold text-foreground text-xs">
                          {tr(`仅在 ${agent.name} 中`, `Only in ${agent.name}`)}
                        </span>
                        <span className="text-muted-foreground text-xs tabular-nums">
                          {tr(
                            `${unmanagedSearchMatches.length} 项未纳入 Skill 库`,
                            `${unmanagedSearchMatches.length} not in library`,
                          )}
                        </span>
                      </div>
                      {skillViewMode === "list" ? (
                        <FramePanel className="overflow-hidden border-dashed p-0">
                          <ul className="divide-y">
                            {unmanagedSearchMatches.map(renderUnmanagedRow)}
                          </ul>
                        </FramePanel>
                      ) : (
                        <ul className="grid grid-cols-1 gap-2 p-1 sm:grid-cols-2 xl:grid-cols-3">
                          {unmanagedSearchMatches.map(renderUnmanagedCard)}
                        </ul>
                      )}
                    </Frame>
                  )}
                </div>
              )}
            </div>
          ) : snapshot.skills.length === 0 && allUnmanagedRows.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{tr("Skill 库里还没有 Skill", "No skills in library")}</EmptyTitle>
                <EmptyDescription>
                  {tr(
                    "先去「全部 Skill」添加，再回到这里按需开启。",
                    "Add skills from All skills first, then enable them here.",
                  )}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              {/* Filter bar: category pills + optional sticky "Enabled only" toggle */}
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                {categoryFilterOptions.length > 2 || allUnmanagedRows.length > 0 ? (
                  <div
                    aria-label={tr("按分类筛选", "Filter by category")}
                    className="flex flex-wrap items-center gap-1.5"
                    role="group"
                  >
                    {categoryFilterOptions.map((option) => {
                      const active = activeCategory === option.key;
                      return (
                        <button
                          key={option.key}
                          aria-pressed={active}
                          className={cn(
                            "inline-flex h-7 max-w-48 cursor-pointer items-center gap-1.5 rounded-full px-2.5 font-medium text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                            active
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                          title={option.label}
                          type="button"
                          onClick={() => {
                            setSelectedCategory(option.key);
                            setStickyIds(new Set());
                            if (option.key !== "all") {
                              setExpandedGroups((prev) => {
                                if (prev.has(option.key)) return prev;
                                const next = new Set(prev);
                                next.add(option.key);
                                return next;
                              });
                            }
                          }}
                        >
                          <span className="truncate">{option.label}</span>
                          <span
                            className={cn(
                              "shrink-0 text-[11px] tabular-nums",
                              active ? "opacity-75" : "text-muted-foreground/80",
                            )}
                          >
                            {option.isLocal
                              ? option.totalCount
                              : `${option.enabledCount}/${option.totalCount}`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div />
                )}

                <div className="flex shrink-0 items-center gap-2">
                  {visibleExpandableKeys.length > 1 && (
                    <Button
                      className="h-7 px-2.5 text-muted-foreground text-xs hover:text-foreground"
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        setExpandedGroups((prev) => {
                          const next = new Set(prev);
                          if (allVisibleExpanded) {
                            for (const key of visibleExpandableKeys) next.delete(key);
                          } else {
                            for (const key of visibleExpandableKeys) next.add(key);
                          }
                          return next;
                        });
                      }}
                    >
                      {allVisibleExpanded ? <ChevronsDownUpIcon /> : <ChevronsUpDownIcon />}
                      <span>
                        {allVisibleExpanded
                          ? tr("全部收起", "Collapse all")
                          : tr("全部展开", "Expand all")}
                      </span>
                    </Button>
                  )}
                  <button
                    aria-pressed={onlyEnabled}
                    className={cn(
                      "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                      onlyEnabled
                        ? "bg-secondary font-medium text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                    type="button"
                    onClick={() => {
                      const nextOnlyEnabled = !onlyEnabled;
                      setOnlyEnabled(nextOnlyEnabled);
                      setStickyIds(new Set());
                      if (nextOnlyEnabled) {
                        const targetKeys = activeGroups
                          .filter(
                            (group) =>
                              (activeCategory === "all" || group.key === activeCategory) &&
                              group.enabledCount > 0,
                          )
                          .map((group) => group.key);
                        if (targetKeys.length > 0) {
                          setExpandedGroups((prev) => {
                            const next = new Set(prev);
                            for (const key of targetKeys) next.add(key);
                            return next;
                          });
                        }
                      }
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 rounded-full transition-colors",
                        onlyEnabled ? "bg-primary" : "bg-muted-foreground/40",
                      )}
                    />
                    <span>{tr("仅看已启用", "Enabled only")}</span>
                  </button>
                  <SkillViewModeControl value={skillViewMode} onChange={setSkillViewMode} />
                </div>
              </div>

              {/* Unified Category Groups + Integrated Local Group */}
              {visibleGroups.length === 0 && !showUnmanagedGroup ? (
                <div className="flex flex-col items-center gap-3 py-12 text-center">
                  <p className="text-muted-foreground text-sm">
                    {onlyEnabled
                      ? tr(
                          "当前还没有已启用的 Skill。",
                          "No skills are enabled in this view yet.",
                        )
                      : tr("当前筛选条件下没有 Skill。", "No skills match the current filter.")}
                  </p>
                  <div className="flex items-center gap-2">
                    {onlyEnabled && (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          setOnlyEnabled(false);
                          setStickyIds(new Set());
                        }}
                      >
                        {tr("显示全部 Skill", "Show all skills")}
                      </Button>
                    )}
                    {activeCategory !== "all" && (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          setSelectedCategory("all");
                          setStickyIds(new Set());
                        }}
                      >
                        {tr("查看全部分类", "Show all categories")}
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-3.5">
                  {visibleGroups.map((group) => {
                    const isOpen = expandedGroups.has(group.key);
                    const syncAriaLabel = tr(
                      `整类自动开启「${group.name}」`,
                      `Auto-enable “${group.name}”`,
                    );
                    const syncHint = tr(
                      "开启后，当前及新加入该分类的 Skill 自动生效",
                      "New skills in this category turn on automatically",
                    );

                    return (
                      <Frame key={group.key}>
                        <Collapsible
                          open={isOpen}
                          onOpenChange={(open) => {
                            setExpandedGroups((prev) => {
                              const next = new Set(prev);
                              if (open) next.add(group.key);
                              else next.delete(group.key);
                              return next;
                            });
                          }}
                        >
                          <div className="flex items-center justify-between gap-3 px-3 py-2">
                            <CollapsibleTrigger className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-muted">
                              <ChevronDownIcon
                                className={cn(
                                  "size-4 shrink-0 text-muted-foreground transition-transform duration-150",
                                  !isOpen && "-rotate-90",
                                )}
                              />
                              <span
                                className="truncate font-semibold text-foreground text-sm"
                                title={group.name}
                              >
                                {renderEmojiSafeText(group.name)}
                              </span>
                              <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                                {tr(
                                  `${group.enabledCount} / ${group.skills.length} 已启用`,
                                  `${group.enabledCount} / ${group.skills.length} enabled`,
                                )}
                              </span>
                            </CollapsibleTrigger>

                            <div
                              className="flex shrink-0 items-center gap-2"
                              title={syncHint}
                            >
                              <span
                                className={cn(
                                  "select-none text-xs",
                                  group.syncing
                                    ? "font-medium text-foreground"
                                    : "text-muted-foreground",
                                )}
                              >
                                {group.syncing
                                  ? tr("自动同步中", "Auto-sync on")
                                  : tr("自动同步", "Auto-sync")}
                              </span>
                              <Switch
                                aria-label={syncAriaLabel}
                                checked={group.syncing}
                                disabled={busy}
                                title={syncHint}
                                onCheckedChange={(checked) =>
                                  void handleSyncCategory(agent, group, checked)
                                }
                              />
                            </div>
                          </div>

                          <CollapsiblePanel>
                            {group.visibleSkills.length === 0 ? (
                              <FramePanel className="overflow-hidden p-0">
                                <p className="px-4 py-4 text-muted-foreground text-xs">
                                  {tr("此分类还没有 Skill。", "This category has no skills yet.")}
                                </p>
                              </FramePanel>
                            ) : skillViewMode === "list" ? (
                              <FramePanel className="overflow-hidden p-0">
                                <ul className="divide-y">
                                  {group.visibleSkills.map((skill) => renderSkillRow(skill, false))}
                                </ul>
                              </FramePanel>
                            ) : (
                              <ul className="grid grid-cols-1 gap-2 p-1 sm:grid-cols-2 xl:grid-cols-3">
                                {group.visibleSkills.map((skill) => renderSkillCard(skill, false))}
                              </ul>
                            )}
                          </CollapsiblePanel>
                        </Collapsible>
                      </Frame>
                    );
                  })}

                  {showUnmanagedGroup && (
                    <Frame key="__local__">
                      <Collapsible
                        open={isLocalOpen}
                        onOpenChange={(open) => {
                          setExpandedGroups((prev) => {
                            const next = new Set(prev);
                            if (open) next.add("__local__");
                            else next.delete("__local__");
                            return next;
                          });
                        }}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                          <CollapsibleTrigger className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-muted">
                            <ChevronDownIcon
                              className={cn(
                                "size-4 shrink-0 text-muted-foreground transition-transform duration-150",
                                !isLocalOpen && "-rotate-90",
                              )}
                            />
                            <span className="truncate font-semibold text-foreground text-sm">
                              {tr(`仅在 ${agent.name} 中`, `Only in ${agent.name}`)}
                            </span>
                            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                              {tr(
                                `${allUnmanagedRows.length} 项未纳入 Skill 库`,
                                `${allUnmanagedRows.length} not in library`,
                              )}
                            </span>
                          </CollapsibleTrigger>

                          <div className="flex shrink-0 items-center gap-1.5">
                            <Button
                              disabled={busy}
                              size="xs"
                              variant="ghost"
                              onClick={() => setPage({ kind: "scan" })}
                            >
                              {tr("扫描页对比…", "Compare in Scan…")}
                            </Button>
                            {cleanUnmanagedRows.length > 0 && (
                              <Button
                                disabled={busy}
                                size="xs"
                                onClick={() => void handleAdoptRows(cleanUnmanagedRows)}
                              >
                                {cleanUnmanagedRows.length === allUnmanagedRows.length
                                  ? tr("全部收进 Skill 库", "Add all to library")
                                  : tr(
                                      `收进无冲突项（${cleanUnmanagedRows.length}）`,
                                      `Add ready (${cleanUnmanagedRows.length})`,
                                    )}
                              </Button>
                            )}
                          </div>
                        </div>

                        <CollapsiblePanel>
                          {skillViewMode === "list" ? (
                            <FramePanel className="overflow-hidden border-dashed p-0">
                              <ul className="divide-y">
                                {allUnmanagedRows.map(renderUnmanagedRow)}
                              </ul>
                            </FramePanel>
                          ) : (
                            <ul className="grid grid-cols-1 gap-2 p-1 sm:grid-cols-2 xl:grid-cols-3">
                              {allUnmanagedRows.map(renderUnmanagedCard)}
                            </ul>
                          )}
                        </CollapsiblePanel>
                      </Collapsible>
                    </Frame>
                  )}
                </div>
              )}

              {/* Subtle empty categories toggle */}
              {emptyCustomGroups.length > 0 && activeCategory === "all" && !onlyEnabled && (
                <div className="flex justify-end px-1">
                  <button
                    className="cursor-pointer rounded text-muted-foreground text-xs underline-offset-4 outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    type="button"
                    onClick={() => setShowEmptyCategories((prev) => !prev)}
                  >
                    {showEmptyCategories
                      ? tr(
                          `隐藏 ${emptyCustomGroups.length} 个空分类`,
                          `Hide ${emptyCustomGroups.length} empty ${emptyCustomGroups.length === 1 ? "category" : "categories"}`,
                        )
                      : tr(
                          `显示 ${emptyCustomGroups.length} 个空分类`,
                          `Show ${emptyCustomGroups.length} empty ${emptyCustomGroups.length === 1 ? "category" : "categories"}`,
                        )}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Unmanaged skill detail & adopt dialog */}
      <Dialog
        open={Boolean(detailUnmanaged)}
        onOpenChange={(open) => {
          if (!open && !busy) setDetailUnmanaged(null);
        }}
      >
        <DialogPopup className="max-w-lg">
          {detailUnmanaged && (
            <>
              <DialogHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle>{renderEmojiSafeText(detailUnmanaged.name)}</DialogTitle>
                  <Badge size="sm" variant="outline">
                    {detailUnmanaged.status === "externalLink"
                      ? tr("外部软链", "External link")
                      : tr("独立文件夹", "Local folder")}
                  </Badge>
                  {conflictPaths.has(detailUnmanaged.path) && (
                    <Badge size="sm" variant="warning">
                      {tr("同名差异", "Differs")}
                    </Badge>
                  )}
                </div>
                <DialogDescription>
                  {renderEmojiSafeText(detailUnmanaged.description || detailUnmanaged.path)}
                </DialogDescription>
              </DialogHeader>

              <DialogPanel className="flex flex-col gap-4">
                <Frame>
                  <FramePanel className="divide-y p-0">
                    <div className="flex flex-col gap-1 px-4 py-3 text-xs">
                      <span className="font-medium text-muted-foreground">
                        {tr("当前工具位置", "Location in tool")}
                      </span>
                      <span className="break-all font-mono text-foreground">
                        {detailUnmanaged.path}
                      </span>
                    </div>
                    {detailUnmanaged.status === "externalLink" && detailUnmanaged.target && (
                      <div className="flex flex-col gap-1 px-4 py-3 text-xs">
                        <span className="font-medium text-muted-foreground">
                          {tr("链接指向", "Link target")}
                        </span>
                        <span className="break-all font-mono text-foreground">
                          {detailUnmanaged.target}
                        </span>
                      </div>
                    )}
                    {detailUnmanaged.source?.repository && (
                      <div className="flex flex-col gap-1 px-4 py-3 text-xs">
                        <span className="font-medium text-muted-foreground">
                          {tr("来源仓库", "Source repository")}
                        </span>
                        <span className="break-all font-mono text-foreground">
                          {detailUnmanaged.source.repository}
                        </span>
                      </div>
                    )}
                  </FramePanel>
                </Frame>

                {conflictPaths.has(detailUnmanaged.path) ? (
                  <Alert variant="warning">
                    <AlertTitle>
                      {tr(
                        "发现同名但内容不同的版本",
                        "Same name with different content found",
                      )}
                    </AlertTitle>
                    <AlertDescription>
                      {tr(
                        "Skill 库或其他工具中已存在同名但内容不一致的 Skill。请前往「扫描本地 Skill」对比 SKILL.md 差异后再选择保留方式。",
                        "Another version with the same name but different content already exists. Review the SKILL.md diff in Scan before importing.",
                      )}
                    </AlertDescription>
                  </Alert>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <CategoryPicker
                      categories={snapshot.categories}
                      disabled={busy}
                      invalid={Boolean(adoptTargetError)}
                      value={adoptTarget}
                      onChange={(next) => {
                        setAdoptTarget(next);
                        setAdoptTargetError(null);
                      }}
                    />
                    {adoptTargetError && (
                      <p className="text-destructive-foreground text-xs" role="alert">
                        {adoptTargetError}
                      </p>
                    )}
                  </div>
                )}
              </DialogPanel>

              <DialogFooter className="sm:justify-between">
                <Button
                  disabled={busy}
                  variant="outline"
                  onClick={() => void handleOpenPath(detailUnmanaged.path)}
                >
                  <FolderOpenIcon />
                  {tr("在访达中打开", "Reveal in Finder")}
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() => setDetailUnmanaged(null)}
                  >
                    {tr("关闭", "Close")}
                  </Button>
                  {conflictPaths.has(detailUnmanaged.path) ? (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setDetailUnmanaged(null);
                        setPage({ kind: "scan" });
                      }}
                    >
                      {tr("前往扫描页对比", "Compare in Scan")}
                    </Button>
                  ) : (
                    <Button
                      disabled={busy}
                      loading={busy}
                      onClick={() => void handleAdoptRows([detailUnmanaged], adoptTarget)}
                    >
                      {tr("收进 Skill 库", "Add to library")}
                    </Button>
                  )}
                </div>
              </DialogFooter>
            </>
          )}
        </DialogPopup>
      </Dialog>
    </section>
  );
}
