import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FolderPlusIcon,
  GitCompareArrowsIcon,
  RefreshCwIcon,
  ScanSearchIcon,
  Trash2Icon,
} from "lucide-react";
import * as React from "react";
import { useApp } from "@/app/AppContext";
import { discoveryUndoAction } from "@/app/discoveryUndo";
import { renderEmojiSafeText } from "@/components/EmojiSafeText";
import { PageToolbar, useScrolled } from "@/components/PageToolbar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Frame, FramePanel } from "@/components/ui/frame";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type {
  DiscoveredSkill,
  SkillManifestDiff,
  UnifiedConflictDecision,
} from "@/shared/discovery";
import { tr } from "@/shared/language";
import { errorText } from "@/shared/ui";
import { classifyScanRows, type ConflictGroup } from "./classify";

type ChoiceValue = "keepBoth" | "skip" | `canonical:${string}`;

function formatModifiedTime(ts: number | null): string {
  if (!ts) return "";
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const diffDays = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (diffDays === 0) return tr("今天更新", "Updated today");
  if (diffDays === 1) return tr("昨天更新", "Updated yesterday");
  if (diffDays > 1 && diffDays < 30) return tr(`${diffDays} 天前更新`, `Updated ${diffDays}d ago`);
  return date.toLocaleDateString(document.documentElement.lang || undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function ScanPage({ initialFolders }: { initialFolders?: string[] }): React.ReactElement {
  const {
    desktop,
    snapshot,
    setSnapshot,
    setPage,
    syncAgentInventoriesFromScan,
    refreshAgentInventories,
    notify,
  } = useApp();
  const { scrolled, scrollRef, onScroll, scrollStyle } = useScrolled();

  const [customCollections, setCustomCollections] = React.useState<string[]>(
    () => initialFolders ?? [],
  );
  const [rows, setRows] = React.useState<DiscoveredSkill[]>([]);
  const [scanning, setScanning] = React.useState(false);
  const [committing, setCommitting] = React.useState(false);
  const [copyOnly, setCopyOnly] = React.useState(false);
  const [readyExpanded, setReadyExpanded] = React.useState(false);
  const [selectedReady, setSelectedReady] = React.useState<Set<string>>(() => new Set());
  const [conflictChoices, setConflictChoices] = React.useState<Map<string, ChoiceValue>>(
    () => new Map(),
  );
  const [expandedDiffs, setExpandedDiffs] = React.useState<Set<string>>(() => new Set());
  const [diffCache, setDiffCache] = React.useState<
    Map<string, SkillManifestDiff | "loading" | string>
  >(() => new Map());
  const [lastErrors, setLastErrors] = React.useState<string[]>([]);
  const [trashConfirmRow, setTrashConfirmRow] = React.useState<DiscoveredSkill | null>(null);
  const [trashing, setTrashing] = React.useState(false);

  const genRef = React.useRef(0);
  const snapshotRef = React.useRef(snapshot);
  snapshotRef.current = snapshot;

  const classified = React.useMemo(() => classifyScanRows(rows, snapshot), [rows, snapshot]);

  const runScan = React.useCallback(
    async (collections: string[]) => {
      const token = ++genRef.current;
      setScanning(true);
      setLastErrors([]);
      try {
        const scanned = await desktop.discovery.scan(collections, null, true);
        if (genRef.current !== token) return;
        setRows(scanned);
        const next = classifyScanRows(scanned, snapshotRef.current);
        setSelectedReady(new Set(next.ready.map((item) => item.key)));
        const nextChoices = new Map<string, ChoiceValue>();
        for (const group of next.conflicts) nextChoices.set(group.name, "keepBoth");
        setConflictChoices(nextChoices);
        setExpandedDiffs(new Set());
        syncAgentInventoriesFromScan(scanned, snapshotRef.current);
      } catch (error) {
        if (genRef.current === token) notify({ text: errorText(error), error: true });
      } finally {
        if (genRef.current === token) setScanning(false);
      }
    },
    [desktop, notify, syncAgentInventoriesFromScan],
  );

  React.useEffect(() => {
    void runScan(customCollections);
  }, [runScan, customCollections]);

  async function handleAddCustomFolders() {
    if (scanning || committing) return;
    try {
      const picked = await desktop.chooseFolders();
      if (!picked.length) return;
      setCustomCollections((prev) => [...new Set([...prev, ...picked])]);
    } catch (error) {
      notify({ text: errorText(error), error: true });
    }
  }

  async function handleToggleDiff(group: ConflictGroup) {
    if (expandedDiffs.has(group.name)) {
      setExpandedDiffs((prev) => {
        const next = new Set(prev);
        next.delete(group.name);
        return next;
      });
      return;
    }
    setExpandedDiffs((prev) => new Set(prev).add(group.name));
    if (group.versions.length < 2) return;
    const [v1, v2] = group.versions;
    const cacheKey = `${group.name}::${v1.id}::${v2.id}`;
    if (diffCache.has(cacheKey)) return;

    setDiffCache((prev) => new Map(prev).set(cacheKey, "loading"));
    try {
      const leftPath =
        v1.path ?? (v1.librarySkillId ? await desktop.library.managedPath(v1.librarySkillId) : null);
      const rightPath =
        v2.path ?? (v2.librarySkillId ? await desktop.library.managedPath(v2.librarySkillId) : null);
      if (!leftPath || !rightPath) {
        setDiffCache((prev) =>
          new Map(prev).set(
            cacheKey,
            tr("无法定位对比文件路径。", "Could not locate files to compare."),
          ),
        );
      } else {
        const diff = await desktop.discovery.compareManifests(leftPath, rightPath);
        setDiffCache((prev) => new Map(prev).set(cacheKey, diff));
      }
    } catch (error) {
      setDiffCache((prev) => new Map(prev).set(cacheKey, errorText(error)));
    }
  }

  async function handleConfirmTrash() {
    if (!trashConfirmRow || trashing) return;
    setTrashing(true);
    try {
      await desktop.discovery.trashBrokenLink(trashConfirmRow.path);
      const nextRows = rows.filter((item) => item.path !== trashConfirmRow.path);
      setRows(nextRows);
      syncAgentInventoriesFromScan(nextRows, snapshot);
      notify({
        text: tr(
          `已将失效链接「${trashConfirmRow.name}」移入废纸篓。`,
          `Moved broken link “${trashConfirmRow.name}” to Trash.`,
        ),
      });
      setTrashConfirmRow(null);
    } catch (error) {
      notify({ text: errorText(error), error: true });
    } finally {
      setTrashing(false);
    }
  }

  const actionableCount = React.useMemo(() => {
    let count = selectedReady.size;
    for (const group of classified.conflicts) {
      if ((conflictChoices.get(group.name) ?? "keepBoth") !== "skip") count += 1;
    }
    return count;
  }, [selectedReady, classified.conflicts, conflictChoices]);

  async function handleSubmitBatch() {
    if (committing || scanning) return;
    const readyRows: DiscoveredSkill[] = [];
    for (const item of classified.ready) {
      if (selectedReady.has(item.key)) readyRows.push(...item.rows);
    }
    const conflicts: UnifiedConflictDecision[] = [];
    for (const group of classified.conflicts) {
      const choice = conflictChoices.get(group.name) ?? "keepBoth";
      if (choice === "skip") {
        conflicts.push({ action: "skip" });
      } else if (choice === "keepBoth") {
        conflicts.push({ action: "keepBoth", rows: group.allRows });
      } else if (choice.startsWith("canonical:")) {
        const targetId = choice.slice("canonical:".length);
        const target = group.versions.find((v) => v.id === targetId);
        if (target) {
          conflicts.push({
            action: "useCanonical",
            canonicalPath: target.rows[0]?.path ?? target.path ?? "",
            canonicalSkillId: target.librarySkillId,
            rows: group.allRows,
          });
        }
      }
    }

    if (!readyRows.length && !conflicts.some((c) => c.action !== "skip")) return;

    setCommitting(true);
    setLastErrors([]);
    try {
      const outcome = await desktop.discovery.commitBatch({ readyRows, conflicts, copyOnly });
      setSnapshot(outcome.snapshot);
      const failures = outcome.results.filter((r) => r.error).map((r) => r.error!);
      setLastErrors(failures);
      const undoAction = discoveryUndoAction({
        batchId: outcome.batchId,
        discovery: desktop.discovery,
        setSnapshot,
        notify,
        restoredText: tr(
          "已撤销刚才的变更，原文件已恢复。",
          "Undid the recent change and restored original files.",
        ),
        refresh: (restored) => {
          void refreshAgentInventories({ force: true, snapshotOverride: restored });
        },
      });

      if (failures.length) {
        notify({
          text: tr(
            `已完成部分处理，另有 ${failures.length} 项失败。`,
            `Completed with ${failures.length} failed ${failures.length === 1 ? "item" : "items"}.`,
          ),
          error: true,
          action: undoAction,
        });
        await runScan(customCollections);
      } else {
        const message = copyOnly
          ? tr(
              `已复制 ${outcome.importedCount} 个 Skill 到 Skill 库，原工具目录未改动。`,
              `Copied ${outcome.importedCount} skills to the library without changing tool folders.`,
            )
          : tr(
              outcome.backedUpCount > 0
                ? `已纳入统一管理（${outcome.managedCount} 处位置），原文件已自动备份。`
                : `已纳入统一管理（${outcome.managedCount} 处位置）。`,
              outcome.backedUpCount > 0
                ? `Managed ${outcome.managedCount} locations. Original files were backed up automatically.`
                : `Managed ${outcome.managedCount} locations.`,
            );
        notify({ text: message, action: undoAction });
        void refreshAgentInventories({ force: true, snapshotOverride: outcome.snapshot });
        setPage({ kind: "all" });
      }
    } catch (error) {
      notify({ text: errorText(error), error: true });
    } finally {
      setCommitting(false);
    }
  }

  const totalActionableSkills = classified.ready.length + classified.conflicts.length;
  const totalLocations =
    classified.ready.reduce((sum, item) => sum + item.rows.length, 0) +
    classified.conflicts.reduce(
      (sum, g) => sum + g.allRows.filter((r) => r.status !== "managedLink").length,
      0,
    );

  const summaryParts: string[] = [];
  if (classified.scannedSources > 0) {
    summaryParts.push(
      tr(`已检查 ${classified.scannedSources} 个目录`, `Scanned ${classified.scannedSources} folders`),
    );
  }
  if (totalActionableSkills > 0) {
    summaryParts.push(
      tr(
        `发现 ${totalActionableSkills} 个待处理的 Skill（共 ${totalLocations} 处位置）`,
        `Found ${totalActionableSkills} skills to manage (${totalLocations} locations)`,
      ),
    );
  }
  if (classified.alreadyManagedCount > 0) {
    summaryParts.push(
      tr(
        `另有 ${classified.alreadyManagedCount} 个已纳入管理`,
        `${classified.alreadyManagedCount} already managed`,
      ),
    );
  }

  const duplicateCount = classified.ready.reduce(
    (acc, item) => acc + Math.max(0, item.rows.length - 1),
    0,
  );

  return (
    <section className="relative flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <PageToolbar
        actions={
          <>
            <Button
              disabled={scanning || committing}
              size="sm"
              variant="outline"
              onClick={() => void handleAddCustomFolders()}
            >
              <FolderPlusIcon />
              {tr("添加目录…", "Add folder…")}
            </Button>
            <Button
              disabled={scanning || committing}
              loading={scanning}
              size="sm"
              variant="outline"
              onClick={() => void runScan(customCollections)}
            >
              <RefreshCwIcon />
              {scanning ? tr("扫描中…", "Scanning…") : tr("重新扫描", "Rescan")}
            </Button>
          </>
        }
        breadcrumb={tr("Skill 库 ／ 扫描本地 Skill", "Library / Scan local skills")}
        scrolled={scrolled}
      />

      {/* Body */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6 pt-18 pb-6 scroll-pt-16 md:px-8"
        style={scrollStyle}
        onScroll={onScroll}
      >
        <div className="mx-auto flex max-w-4xl flex-col gap-5">
          <header>
            <h1 className="font-semibold text-2xl tracking-tight">
              {tr("扫描本地 Skill", "Scan local skills")}
            </h1>
            <p className="mt-1 text-muted-foreground text-sm">
              {scanning
                ? tr(
                    "正在只读检查本机各 AI 工具目录，不会改动任何文件…",
                    "Scanning local tool folders read-only without changing any files…",
                  )
                : summaryParts.length > 0
                  ? summaryParts.join(" · ")
                  : tr(
                      "仅读取检查本机 AI 工具目录，确认前不会改动任何文件。",
                      "Read-only scan of your local AI tool folders. Nothing changes until you confirm.",
                    )}
            </p>
          </header>

          {scanning ? (
            <div className="flex items-center justify-center gap-3 py-12 text-muted-foreground text-sm">
              <Spinner />
              <span>{tr("正在扫描本机工具目录…", "Scanning local tool folders…")}</span>
            </div>
          ) : (
            <>
              {lastErrors.length > 0 && (
                <Alert variant="error">
                  <AlertTitle>
                    {tr("部分项目未能完成：", "Some items could not be processed:")}
                  </AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4 text-xs">
                      {lastErrors.map((msg, i) => (
                        <li key={i}>{msg}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {!totalActionableSkills && !classified.invalid.length ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      {classified.alreadyManagedCount > 0 ? (
                        <CheckCircle2Icon />
                      ) : (
                        <ScanSearchIcon />
                      )}
                    </EmptyMedia>
                    <EmptyTitle>
                      {classified.alreadyManagedCount > 0
                        ? tr("本机工具中的 Skill 已全部纳入管理", "All local skills are already managed")
                        : tr("未在常用工具目录中发现新的 Skill", "No new skills found in your tool folders")}
                    </EmptyTitle>
                    <EmptyDescription>
                      {tr(
                        "可以点击右上角「添加目录…」扫描其他自定义路径，或直接拖入 Skill 文件夹。",
                        "Use “Add folder…” above to scan another directory, or drag and drop a skill folder.",
                      )}
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button variant="outline" onClick={() => setPage({ kind: "all" })}>
                      {tr("返回 Skill 库", "Back to library")}
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : (
                <>
                  {/* Group 1: Ready to manage */}
                  {classified.ready.length > 0 && (
                    <Frame>
                      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <h2 className="font-semibold text-sm">
                            {tr("可直接托管", "Ready to manage")}
                          </h2>
                          <Badge size="sm" variant="secondary">
                            {tr(`${classified.ready.length} 项`, `${classified.ready.length}`)}
                          </Badge>
                        </div>
                        <Button
                          aria-expanded={readyExpanded}
                          size="xs"
                          variant="ghost"
                          onClick={() => setReadyExpanded((v) => !v)}
                        >
                          {readyExpanded
                            ? tr("收起列表", "Collapse list")
                            : tr("展开微调", "Review items")}
                        </Button>
                      </div>

                      <FramePanel className="divide-y p-0">
                        <div className="flex items-start gap-3 px-4 py-3.5">
                          <Checkbox
                            aria-label={tr("全选可直接托管的 Skill", "Select all ready skills")}
                            checked={
                              selectedReady.size === classified.ready.length &&
                              classified.ready.length > 0
                            }
                            className="mt-0.5"
                            disabled={committing}
                            id="scan-select-all-ready"
                            indeterminate={
                              selectedReady.size > 0 && selectedReady.size < classified.ready.length
                            }
                            onCheckedChange={(checked) => {
                              setSelectedReady(
                                checked
                                  ? new Set(classified.ready.map((item) => item.key))
                                  : new Set(),
                              );
                            }}
                          />
                          <label className="flex cursor-pointer flex-col gap-0.5" htmlFor="scan-select-all-ready">
                            <strong className="font-medium text-sm">
                              {duplicateCount > 0
                                ? tr(
                                    `已勾选 ${selectedReady.size} / ${classified.ready.length} 项（含 ${duplicateCount} 处相同副本已自动合并）`,
                                    `Selected ${selectedReady.size} of ${classified.ready.length} (${duplicateCount} identical copies merged)`,
                                  )
                                : tr(
                                    `已勾选 ${selectedReady.size} / ${classified.ready.length} 项`,
                                    `Selected ${selectedReady.size} of ${classified.ready.length}`,
                                  )}
                            </strong>
                            <span className="text-muted-foreground text-xs">
                              {tr(
                                "各工具中完全一致的副本将自动合并为一份，所有关联工具同步生效。",
                                "Identical copies across tools merge into one managed copy and stay linked.",
                              )}
                            </span>
                          </label>
                        </div>

                        {readyExpanded && (
                          <ul className="divide-y">
                            {classified.ready.map((item, idx) => (
                              <li key={item.key}>
                                <div className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/40">
                                  <Checkbox
                                    aria-label={item.name}
                                    checked={selectedReady.has(item.key)}
                                    disabled={committing}
                                    id={`scan-ready-${idx}`}
                                    onCheckedChange={(checked) => {
                                      setSelectedReady((prev) => {
                                        const next = new Set(prev);
                                        if (checked) next.add(item.key);
                                        else next.delete(item.key);
                                        return next;
                                      });
                                    }}
                                  />
                                  <label
                                    className="flex min-w-0 flex-1 cursor-pointer flex-col"
                                    htmlFor={`scan-ready-${idx}`}
                                  >
                                    <span className="truncate font-medium text-sm">
                                      {renderEmojiSafeText(item.name)}
                                    </span>
                                    {item.description && (
                                      <span className="truncate text-muted-foreground text-xs">
                                        {renderEmojiSafeText(item.description)}
                                      </span>
                                    )}
                                  </label>
                                  <span
                                    className="max-w-44 shrink-0 truncate text-muted-foreground text-xs"
                                    title={item.sources.join(" · ")}
                                  >
                                    {item.sources.join(" · ")}
                                  </span>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </FramePanel>
                    </Frame>
                  )}

                  {/* Group 2: Conflicts */}
                  {classified.conflicts.length > 0 && (
                    <Frame>
                      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <h2 className="font-semibold text-sm">
                            {tr("同名但内容不同", "Same name, different content")}
                          </h2>
                          <Badge size="sm" variant="warning">
                            {tr(`${classified.conflicts.length} 项`, `${classified.conflicts.length}`)}
                          </Badge>
                        </div>
                        <span className="text-muted-foreground text-xs">
                          {tr("默认全部保留，不会覆盖", "Keeping all versions by default")}
                        </span>
                      </div>

                      <div className="flex flex-col gap-1">
                        {classified.conflicts.map((group) => {
                          const diffOpen = expandedDiffs.has(group.name);
                          const currentChoice = conflictChoices.get(group.name) ?? "keepBoth";
                          const [v1, v2] = group.versions;
                          const diffKey = v1 && v2 ? `${group.name}::${v1.id}::${v2.id}` : "";
                          const cachedDiff = diffKey ? diffCache.get(diffKey) : undefined;

                          return (
                            <FramePanel key={group.name} className="flex flex-col gap-3 p-4">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex min-w-0 items-center gap-2">
                                  <strong className="min-w-0 truncate font-semibold text-sm" title={group.name}>
                                    {group.name}
                                  </strong>
                                  <Badge size="sm" variant="outline">
                                    {tr(
                                      `发现 ${group.versions.length} 个不同版本`,
                                      `${group.versions.length} different versions`,
                                    )}
                                  </Badge>
                                </div>
                                <Button
                                  aria-expanded={diffOpen}
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => void handleToggleDiff(group)}
                                >
                                  <GitCompareArrowsIcon />
                                  {diffOpen
                                    ? tr("收起差异", "Hide diff")
                                    : tr("对比差异", "Compare diff")}
                                </Button>
                              </div>

                              <div className="flex flex-wrap gap-1.5">
                                {group.versions.map((v) => {
                                  const timeText = formatModifiedTime(v.modifiedAt);
                                  const badgeText = timeText ? `${v.label}（${timeText}）` : v.label;
                                  return (
                                    <Badge
                                      key={v.id}
                                      className="max-w-full justify-start overflow-hidden"
                                      size="sm"
                                      title={v.path ? `${badgeText}\n${v.path}` : badgeText}
                                      variant="secondary"
                                    >
                                      <span className="truncate">{badgeText}</span>
                                    </Badge>
                                  );
                                })}
                              </div>

                              {diffOpen && v1 && v2 && (
                                <div className="overflow-hidden rounded-lg border bg-code text-xs">
                                  <div className="border-b bg-muted/50 px-3 py-1.5 font-mono text-muted-foreground text-[11px]">
                                    SKILL.md · {v1.label} vs {v2.label}
                                  </div>
                                  {!cachedDiff || cachedDiff === "loading" ? (
                                    <div className="p-3 text-muted-foreground">
                                      {tr("正在读取差异…", "Loading diff…")}
                                    </div>
                                  ) : typeof cachedDiff === "string" ? (
                                    <div className="p-3 text-destructive-foreground">{cachedDiff}</div>
                                  ) : cachedDiff.sameManifest ? (
                                    <div className="p-3 text-muted-foreground">
                                      {tr(
                                        "两者的 SKILL.md 文本一致，差异位于文件夹内的其他附属文件。",
                                        "SKILL.md is identical; differences are in other files inside the folder.",
                                      )}
                                    </div>
                                  ) : !cachedDiff.lines.length ? (
                                    <div className="p-3 text-muted-foreground">
                                      {tr("无可显示的文本差异。", "No text differences to display.")}
                                    </div>
                                  ) : (
                                    <div className="max-h-60 overflow-auto py-1 font-mono text-[11px] leading-5">
                                      {cachedDiff.lines.map((line, i) => (
                                        <div
                                          key={i}
                                          className={cn(
                                            "whitespace-pre-wrap break-all px-3",
                                            line.kind === "added" &&
                                              "bg-success/10 text-success-foreground",
                                            line.kind === "removed" &&
                                              "bg-destructive/10 text-destructive-foreground",
                                            line.kind === "context" && "text-muted-foreground",
                                          )}
                                        >
                                          {line.kind === "added"
                                            ? "+ "
                                            : line.kind === "removed"
                                              ? "- "
                                              : "  "}
                                          {line.text}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}

                              <RadioGroup
                                className="gap-1.5"
                                disabled={committing}
                                value={currentChoice}
                                onValueChange={(val) => {
                                  setConflictChoices((prev) =>
                                    new Map(prev).set(group.name, val as ChoiceValue),
                                  );
                                }}
                              >
                                <label
                                  className={cn(
                                    "flex cursor-pointer items-start gap-2.5 rounded-lg p-2.5 transition-colors",
                                    currentChoice === "keepBoth" ? "bg-accent" : "hover:bg-accent/50",
                                  )}
                                >
                                  <Radio className="mt-0.5" value="keepBoth" />
                                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <strong className="font-medium text-sm">
                                      {tr("两个版本都保留（推荐）", "Keep all versions (Recommended)")}
                                    </strong>
                                    <span className="text-muted-foreground text-xs">
                                      {tr(
                                        "分别保存到 Skill 库，各工具继续使用各自当前的版本，零覆盖风险。",
                                        "Save each version separately; each tool keeps its current version.",
                                      )}
                                    </span>
                                  </div>
                                </label>

                                {group.versions.map((v) => (
                                  <label
                                    key={v.id}
                                    className={cn(
                                      "flex cursor-pointer items-start gap-2.5 rounded-lg p-2.5 transition-colors",
                                      currentChoice === `canonical:${v.id}`
                                        ? "bg-accent"
                                        : "hover:bg-accent/50",
                                    )}
                                  >
                                    <Radio className="mt-0.5" value={`canonical:${v.id}`} />
                                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                      <strong className="break-words font-medium text-sm">
                                        {tr(
                                          `统一使用 ${v.label} 的版本`,
                                          `Use the ${v.label} version for all`,
                                        )}
                                      </strong>
                                      <span className="text-muted-foreground text-xs">
                                        {copyOnly
                                          ? tr(
                                              "仅将该版本复制到 Skill 库，其他工具目录不变。",
                                              "Copy only this version into the library without changing tool folders.",
                                            )
                                          : tr(
                                              "其他工具改为使用此版本，原文件夹自动备份，可随时恢复。",
                                              "Other tools switch to this version; their original folders are backed up.",
                                            )}
                                      </span>
                                    </div>
                                  </label>
                                ))}

                                <label
                                  className={cn(
                                    "flex cursor-pointer items-start gap-2.5 rounded-lg p-2.5 transition-colors",
                                    currentChoice === "skip" ? "bg-accent" : "hover:bg-accent/50",
                                  )}
                                >
                                  <Radio className="mt-0.5" value="skip" />
                                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <strong className="font-medium text-sm">
                                      {tr("暂时跳过", "Skip for now")}
                                    </strong>
                                    <span className="text-muted-foreground text-xs">
                                      {tr("本次不处理，保持原样。", "Leave untouched for now.")}
                                    </span>
                                  </div>
                                </label>
                              </RadioGroup>
                            </FramePanel>
                          );
                        })}
                      </div>
                    </Frame>
                  )}

                  {/* Group 3: Invalid / unreadable */}
                  {classified.invalid.length > 0 && (
                    <Frame>
                      <Collapsible>
                        <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-2 px-4 py-2.5 text-left text-sm [&[data-panel-open]>svg]:rotate-180">
                          <span className="font-medium text-muted-foreground">
                            {tr(
                              `${classified.invalid.length} 项无法读取（不影响其他项）`,
                              `${classified.invalid.length} unreadable (does not block others)`,
                            )}
                          </span>
                          <ChevronDownIcon className="size-4 text-muted-foreground transition-transform" />
                        </CollapsibleTrigger>
                        <CollapsiblePanel>
                          <FramePanel className="divide-y p-0">
                            {classified.invalid.map((row) => (
                              <div
                                key={row.path}
                                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                              >
                                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                  <strong className="break-words font-medium text-sm">
                                    {row.name} · {row.sourceName}
                                  </strong>
                                  <span className="text-muted-foreground text-xs">
                                    {row.brokenLink
                                      ? tr(
                                          "失效的软链接（指向的目标已不存在）",
                                          "Broken symlink (target no longer exists)",
                                        )
                                      : row.reason || tr("无法读取 SKILL.md", "Could not read SKILL.md")}
                                  </span>
                                  <span className="truncate font-mono text-[11px] text-muted-foreground/80">
                                    {row.path}
                                  </span>
                                </div>
                                {row.brokenLink ? (
                                  <Button
                                    disabled={committing}
                                    size="xs"
                                    variant="destructive-outline"
                                    onClick={() => setTrashConfirmRow(row)}
                                  >
                                    <Trash2Icon />
                                    {tr("移除失效链接", "Remove broken link")}
                                  </Button>
                                ) : (
                                  <Button
                                    disabled={committing}
                                    size="xs"
                                    variant="outline"
                                    onClick={() =>
                                      void desktop.discovery.openInSystem(row.path).catch((err) =>
                                        notify({ text: errorText(err), error: true }),
                                      )
                                    }
                                  >
                                    <ExternalLinkIcon />
                                    {tr("打开文件修复", "Open to fix")}
                                  </Button>
                                )}
                              </div>
                            ))}
                          </FramePanel>
                        </CollapsiblePanel>
                      </Collapsible>
                    </Frame>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Sticky bottom action footer */}
      {!scanning && totalActionableSkills > 0 && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-t bg-background/95 px-6 py-3.5 backdrop-blur-sm sm:flex-nowrap">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2 text-sm">
              <Checkbox
                aria-label={tr("仅复制到 Skill 库，暂不改动原工具", "Copy to library only without changing tools")}
                checked={copyOnly}
                disabled={committing}
                id="scan-copy-only"
                onCheckedChange={(checked) => setCopyOnly(Boolean(checked))}
              />
              <label className="cursor-pointer font-medium" htmlFor="scan-copy-only">
                {tr("仅复制到 Skill 库，暂不改动原工具", "Copy to library only without changing tools")}
              </label>
            </div>
            <p className="text-muted-foreground text-xs">
              {copyOnly
                ? tr(
                    "仅复制内容到 Skill 库，原工具目录保持不动，也不会建立关联。",
                    "Copies files into the library only; tool folders stay untouched.",
                  )
                : tr(
                    "纳入托管后，各工具原文件夹会自动备份，随时可在「设置 → 数据管理」中一键恢复。",
                    "Original folders are backed up automatically and can be restored anytime in Settings → Library data.",
                  )}
            </p>
          </div>

          <Button
            className="shrink-0"
            disabled={committing || actionableCount === 0}
            loading={committing}
            onClick={() => void handleSubmitBatch()}
          >
            {committing
              ? tr("正在处理…", "Applying…")
              : copyOnly
                ? tr(`仅复制到 Skill 库（${actionableCount} 项）`, `Copy to library (${actionableCount})`)
                : tr(`一键纳入管理（${actionableCount} 项）`, `Manage all (${actionableCount})`)}
          </Button>
        </div>
      )}

      {/* Trash broken link confirm dialog */}
      <Dialog
        open={Boolean(trashConfirmRow)}
        onOpenChange={(open) => {
          if (!open && !trashing) setTrashConfirmRow(null);
        }}
      >
        <DialogPopup showCloseButton={!trashing}>
          <DialogHeader>
            <DialogTitle>{tr("移入废纸篓？", "Move to Trash?")}</DialogTitle>
          </DialogHeader>
          {trashConfirmRow && (
            <DialogPanel>
              <div className="flex flex-col gap-3 text-sm">
                <p>
                  {tr(
                    `将移除 ${trashConfirmRow.sourceName} 中的失效软链接「${trashConfirmRow.name}」，并移入系统废纸篓。`,
                    `Remove the broken symlink “${trashConfirmRow.name}” in ${trashConfirmRow.sourceName} and move it to Trash.`,
                  )}
                </p>
                <code className="break-all rounded-lg border bg-muted/50 px-3 py-2 font-mono text-xs">
                  {trashConfirmRow.path}
                </code>
                <p className="text-muted-foreground text-xs">
                  {tr(
                    "该链接指向的目标已不存在，移入废纸篓不会影响其他 Skill，需要时也可从废纸篓找回。",
                    "Its target no longer exists. Moving it to Trash does not affect other skills, and you can recover it from Trash if needed.",
                  )}
                </p>
              </div>
            </DialogPanel>
          )}
          <DialogFooter variant="bare">
            <Button
              disabled={trashing}
              variant="outline"
              onClick={() => setTrashConfirmRow(null)}
            >
              {tr("取消", "Cancel")}
            </Button>
            <Button
              disabled={trashing}
              loading={trashing}
              variant="destructive"
              onClick={() => void handleConfirmTrash()}
            >
              {tr("移入废纸篓", "Move to Trash")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
