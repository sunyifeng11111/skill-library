import { ChevronDownIcon } from "lucide-react";
import * as React from "react";
import { useApp } from "@/app/AppContext";
import { AgentMark } from "@/components/AgentMark";
import { CategoryPicker, validateCategoryTarget } from "@/components/CategoryPicker";
import { renderEmojiSafeText } from "@/components/EmojiSafeText";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { assignmentReason } from "@/features/agents/presentation";
import { cn } from "@/lib/utils";
import { tr } from "@/shared/language";
import type { CategoryTarget, UnloadPreview } from "@/shared/library";
import { errorText } from "@/shared/ui";

export function LibraryDialogs(): React.ReactElement {
  return (
    <>
      <CategoryNameDialog />
      <DeleteCategoryDialog />
      <SkillDetailDialog />
      <MoveSkillsDialog />
      <UnloadSkillsDialog />
    </>
  );
}

function CategoryNameDialog(): React.ReactElement | null {
  const {
    desktop,
    setSnapshot,
    setPage,
    activeDialog,
    closeDialog,
    setDialogBusy,
  } = useApp();

  const isCreate = activeDialog?.type === "createCategory";
  const isRename = activeDialog?.type === "renameCategory";
  const open = isCreate || isRename;

  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (isCreate) {
      setValue("");
      setError(null);
      setSaving(false);
    } else if (isRename) {
      setValue(activeDialog.name);
      setError(null);
      setSaving(false);
    }
  }, [isCreate, isRename, activeDialog]);

  if (!open) return null;

  const title = isCreate
    ? tr("新建分类", "New category")
    : tr(`重命名「${activeDialog.name}」`, `Rename “${activeDialog.name}”`);
  const submitLabel = isCreate ? tr("创建分类", "Create category") : tr("保存修改", "Save changes");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError(tr("请输入分类名称。", "Enter a category name."));
      return;
    }
    setSaving(true);
    setError(null);
    setDialogBusy(true);
    try {
      if (isCreate) {
        const next = await desktop.library.createCategory(trimmed);
        const created = next.categories.find((c) => c.name === trimmed);
        setSnapshot(next);
        if (created) setPage({ kind: "category", id: created.id });
      } else if (isRename) {
        const next = await desktop.library.renameCategory(activeDialog.id, trimmed);
        setSnapshot(next);
      }
      setDialogBusy(false);
      closeDialog();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
      setDialogBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) closeDialog();
      }}
    >
      <DialogPopup showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            className="flex flex-col gap-2"
            id="category-name-form"
            onSubmit={(e) => void handleSubmit(e)}
          >
            <Label htmlFor="category-name-input">{tr("分类名称", "Category name")}</Label>
            <Input
              aria-invalid={Boolean(error) || undefined}
              autoFocus
              disabled={saving}
              id="category-name-input"
              placeholder={tr("例如：写作", "e.g. Writing")}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
            />
            {error && (
              <p className="text-destructive-foreground text-xs" role="alert">
                {error}
              </p>
            )}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button disabled={saving} type="button" variant="outline" onClick={closeDialog}>
            {tr("取消", "Cancel")}
          </Button>
          <Button disabled={saving} form="category-name-form" loading={saving} type="submit">
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DeleteCategoryDialog(): React.ReactElement | null {
  const { desktop, setSnapshot, activeDialog, closeDialog, setDialogBusy, notify } = useApp();
  const open = activeDialog?.type === "deleteCategory";
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setSaving(false);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  async function handleConfirm() {
    if (!open || saving) return;
    setSaving(true);
    setError(null);
    setDialogBusy(true);
    try {
      const next = await desktop.library.deleteCategory(activeDialog.id);
      setSnapshot(next);
      setDialogBusy(false);
      closeDialog();
      notify({
        text: tr(`已删除「${activeDialog.name}」。`, `Deleted “${activeDialog.name}”.`),
      });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
      setDialogBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) closeDialog();
      }}
    >
      <DialogPopup showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{tr("删除分类", "Delete category")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3 text-sm">
            <p>
              {tr(
                `删除「${activeDialog.name}」后，里面的 Skill 会移至「未分类」。`,
                `Deleting “${activeDialog.name}” moves its skills to Uncategorized.`,
              )}
            </p>
            {error && (
              <p className="text-destructive-foreground text-xs" role="alert">
                {error}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button disabled={saving} variant="outline" onClick={closeDialog}>
            {tr("取消", "Cancel")}
          </Button>
          <Button
            disabled={saving}
            loading={saving}
            variant="destructive"
            onClick={() => void handleConfirm()}
          >
            {tr("删除分类", "Delete category")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SkillDetailDialog(): React.ReactElement | null {
  const {
    desktop,
    snapshot,
    activeDialog,
    closeDialog,
    openUnloadSkills,
    openAttachSource,
  } = useApp();

  const open = activeDialog?.type === "skillDetail";
  const skillId = open ? activeDialog.skillId : "";
  const [managedPath, setManagedPath] = React.useState<string>("");
  const [showToolPaths, setShowToolPaths] = React.useState(false);
  const [showTechDetails, setShowTechDetails] = React.useState(false);

  React.useEffect(() => {
    if (!open || !skillId) return;
    let active = true;
    setShowToolPaths(false);
    setShowTechDetails(false);
    setManagedPath(tr("正在读取…", "Reading…"));
    void desktop.library
      .managedPath(skillId)
      .then((path) => {
        if (active) setManagedPath(path);
      })
      .catch((reason) => {
        if (active) setManagedPath(errorText(reason));
      });
    return () => {
      active = false;
    };
  }, [open, skillId, desktop]);

  if (!open || !snapshot) return null;
  const skill = snapshot.skills.find((s) => s.id === skillId);
  if (!skill) return null;

  const category =
    snapshot.categories.find((c) => c.id === skill.categoryId)?.name ??
    tr("未分类", "Uncategorized");

  const agentMap = new Map((snapshot.agents ?? []).map((a) => [a.id, a]));
  const enabled = (snapshot.assignments ?? [])
    .filter((a) => a.skillId === skill.id && a.path && agentMap.has(a.agentId))
    .map((assignment) => ({ agent: agentMap.get(assignment.agentId)!, assignment }));

  const technicalRows: { label: string; value: string; mono?: boolean }[] = [
    ...(skill.source
      ? [
          ...(skill.source.reference
            ? [{ label: tr("来源引用", "Source ref"), value: skill.source.reference, mono: true }]
            : []),
          { label: tr("包内位置", "Path in package"), value: skill.source.memberPath, mono: true },
          {
            label: tr("安装修订", "Installed revision"),
            value:
              skill.source.revision || tr("尚未安装上游版本", "No upstream version installed"),
            mono: true,
          },
        ]
      : []),
    { label: tr("原文件夹", "Original folder"), value: skill.folderName, mono: true },
  ];

  const sourceRows: { label: string; value: string; mono?: boolean; muted?: boolean }[] = [
    {
      label: tr("来源", "Source"),
      value:
        skill.source?.repository ??
        tr("手动导入（未关联更新地址）", "Manually imported (no update URL)"),
      mono: Boolean(skill.source?.repository),
      muted: !skill.source?.repository,
    },
    { label: tr("Skill 库中的位置", "Location in library"), value: managedPath, mono: true },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate" title={skill.name}>
              {renderEmojiSafeText(skill.name)}
            </span>
            <Badge
              className="max-w-44 shrink-0 justify-start overflow-hidden"
              title={category}
              variant="secondary"
            >
              <span className="truncate">{category}</span>
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <DialogPanel>
          <div className="flex flex-col gap-4">
            {/* Summary: description & local origin */}
            <div className="flex flex-col gap-1.5">
              <p
                className={cn(
                  "break-words text-sm leading-relaxed",
                  skill.description ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {skill.description
                  ? renderEmojiSafeText(skill.description)
                  : tr("暂无用途说明", "No description")}
              </p>
              {skill.localOrigins?.length ? (
                <p className="text-muted-foreground text-xs">
                  {tr("添加自 ", "Added from ")}
                  {skill.localOrigins.join(" · ")}
                </p>
              ) : null}
            </div>

            {/* Enabled tools: compact chips by default, toggleable path list */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-medium text-muted-foreground text-xs">
                  {enabled.length > 0
                    ? tr(`已启用的工具（${enabled.length}）`, `Enabled tools (${enabled.length})`)
                    : tr("已启用的工具", "Enabled tools")}
                </h3>
                {enabled.length > 0 && (
                  <Button
                    aria-expanded={showToolPaths}
                    className="-me-1.5 text-muted-foreground hover:text-foreground"
                    size="xs"
                    variant="ghost"
                    onClick={() => setShowToolPaths((prev) => !prev)}
                  >
                    {showToolPaths ? tr("收起路径", "Hide paths") : tr("显示路径", "Show paths")}
                    <ChevronDownIcon
                      className={cn(
                        "size-3.5 transition-transform duration-150",
                        showToolPaths && "rotate-180",
                      )}
                    />
                  </Button>
                )}
              </div>

              {enabled.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {tr("仅收藏，暂未在任何工具中启用", "Library only — not enabled in any tool")}
                </p>
              ) : !showToolPaths ? (
                <ul className="flex flex-wrap gap-1.5">
                  {enabled.map(({ agent, assignment }) => {
                    const reason = assignmentReason(assignment, category);
                    const toolPath = assignment.path ?? agent.directory;
                    const chipTag = assignment.viaCategory
                      ? assignment.direct
                        ? tr("单独＋分类", "Direct + category")
                        : tr("随分类", "Category")
                      : null;
                    return (
                      <li
                        key={agent.id}
                        className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-muted/80 px-2.5 py-1.5 text-xs"
                        title={`${agent.name} · ${reason}\n${toolPath}`}
                      >
                        <AgentMark agent={agent} className="size-3.5" />
                        <span className="truncate font-medium text-foreground">{agent.name}</span>
                        {chipTag && (
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            · {chipTag}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <ul className="divide-y divide-border/60 overflow-hidden rounded-xl bg-muted/45">
                  {enabled.map(({ agent, assignment }) => {
                    const reason = assignmentReason(assignment, category);
                    const toolPath = assignment.path ?? agent.directory;
                    return (
                      <li key={agent.id} className="flex flex-col gap-1 px-3.5 py-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex min-w-0 items-center gap-2">
                            <AgentMark agent={agent} className="size-3.5" />
                            <span className="truncate font-medium text-foreground text-xs">
                              {agent.name}
                            </span>
                          </span>
                          <span className="shrink-0 text-muted-foreground text-xs">{reason}</span>
                        </div>
                        <p className="break-all ps-5.5 font-mono text-muted-foreground text-xs">
                          {toolPath}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Source & storage location + collapsible technical details */}
            <section className="flex flex-col gap-2">
              <h3 className="font-medium text-muted-foreground text-xs">
                {tr("来源与位置", "Source & location")}
              </h3>
              <div className="overflow-hidden rounded-xl bg-muted/45">
                <dl className="flex flex-col gap-2.5 p-3.5">
                  {sourceRows.map((row) => (
                    <div
                      key={row.label}
                      className="grid grid-cols-1 gap-0.5 sm:grid-cols-[112px_1fr] sm:gap-3"
                    >
                      <dt className="font-medium text-muted-foreground text-xs">{row.label}</dt>
                      <dd
                        className={cn(
                          row.mono
                            ? "break-all font-mono text-xs"
                            : "break-words text-sm",
                          row.muted ? "text-muted-foreground" : "text-foreground",
                        )}
                      >
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>

                {technicalRows.length > 0 && (
                  <Collapsible open={showTechDetails} onOpenChange={setShowTechDetails}>
                    <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-2 border-t border-border/60 px-3.5 py-2.5 text-left font-medium text-muted-foreground text-xs outline-none transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                      <span>{tr("更多技术信息", "More technical details")}</span>
                      <ChevronDownIcon
                        className={cn(
                          "size-3.5 shrink-0 transition-transform duration-150",
                          showTechDetails && "rotate-180",
                        )}
                      />
                    </CollapsibleTrigger>
                    <CollapsiblePanel>
                      <dl className="flex flex-col gap-2.5 border-t border-border/50 px-3.5 py-3">
                        {technicalRows.map((row, idx) => (
                          <div
                            key={`${row.label}-${idx}`}
                            className="grid grid-cols-1 gap-0.5 sm:grid-cols-[112px_1fr] sm:gap-3"
                          >
                            <dt className="font-medium text-muted-foreground text-xs">
                              {row.label}
                            </dt>
                            <dd
                              className={
                                row.mono
                                  ? "break-all font-mono text-foreground text-xs"
                                  : "break-words text-foreground text-sm"
                              }
                            >
                              {row.value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </CollapsiblePanel>
                  </Collapsible>
                )}
              </div>
            </section>
          </div>
        </DialogPanel>

        <DialogFooter>
          {desktop.agents && (
            <Button
              variant="destructive-outline"
              onClick={() => openUnloadSkills([skill.id])}
            >
              {tr("卸载 Skill", "Uninstall skills")}
            </Button>
          )}
          {!skill.source && desktop.online && desktop.updates && (
            <Button variant="outline" onClick={() => openAttachSource(skill)}>
              {tr("关联更新地址", "Link update URL")}
            </Button>
          )}
          <Button variant="outline" onClick={closeDialog}>
            {tr("关闭", "Close")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function MoveSkillsDialog(): React.ReactElement | null {
  const { desktop, snapshot, setSnapshot, activeDialog, closeDialog, setDialogBusy, notify } =
    useApp();

  const open = activeDialog?.type === "moveSkills";
  const [target, setTarget] = React.useState<CategoryTarget>({ kind: "uncategorized" });
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setTarget(activeDialog.defaultTarget);
      setError(null);
      setSaving(false);
    }
  }, [open, activeDialog]);

  if (!open || !snapshot) return null;

  const ids = activeDialog.skillIds;
  const names = snapshot.skills
    .filter((skill) => ids.includes(skill.id))
    .map((skill) => skill.name);

  async function handleConfirm() {
    if (!open || saving) return;
    setError(null);
    let validated: CategoryTarget;
    try {
      validated = validateCategoryTarget(target);
    } catch (reason) {
      setError(errorText(reason));
      return;
    }
    setSaving(true);
    setDialogBusy(true);
    try {
      const moved = await desktop.library.moveSkills(ids, validated);
      setSnapshot(moved.library);
      activeDialog.onMoved?.();
      setDialogBusy(false);
      closeDialog();
      const undoId = moved.undo;
      notify({
        text: moved.moved
          ? tr(`已移动 ${moved.moved} 项。`, `Moved ${moved.moved} skills.`)
          : tr("所选 Skill 已在目标分类。", "The selected skills are already in this category."),
        action: undoId
          ? {
              label: tr("撤销移动", "Undo move"),
              run: async () => {
                try {
                  setSnapshot(await desktop.library.undoMove(undoId));
                  notify({ text: tr("已恢复原分类。", "Restored the original categories.") });
                } catch (err) {
                  notify({ text: errorText(err), error: true });
                }
              },
            }
          : undefined,
      });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
      setDialogBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) closeDialog();
      }}
    >
      <DialogPopup showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{tr("移至分类", "Move to category")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <p className="text-muted-foreground text-sm">
              {tr(`已选 ${ids.length} 项 · ${names.join("、")}`, `${ids.length} selected · ${names.join(", ")}`)}
            </p>
            <CategoryPicker
              categories={snapshot.categories}
              disabled={saving}
              invalid={Boolean(error)}
              value={target}
              onChange={(next) => {
                setTarget(next);
                if (error) setError(null);
              }}
            />
            {error && (
              <p className="text-destructive-foreground text-xs" role="alert">
                {error}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button disabled={saving} variant="outline" onClick={closeDialog}>
            {tr("取消", "Cancel")}
          </Button>
          <Button disabled={saving} loading={saving} onClick={() => void handleConfirm()}>
            {tr("移至分类", "Move to category")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function UnloadSkillsDialog(): React.ReactElement | null {
  const { desktop, setSnapshot, activeDialog, closeDialog, setDialogBusy, notify } = useApp();
  const open = activeDialog?.type === "unloadSkills";
  const agents = desktop.agents;

  const [preview, setPreview] = React.useState<UnloadPreview | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || !agents) return;
    let active = true;
    setPreview(null);
    setLoading(true);
    setSaving(false);
    setError(null);
    void agents
      .previewUnload(activeDialog.skillIds)
      .then((result) => {
        if (active) setPreview(result);
      })
      .catch((reason) => {
        if (active) setError(errorText(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, activeDialog, agents]);

  if (!open || !agents) return null;
  const onUnloaded = activeDialog.onUnloaded;

  async function handleConfirm() {
    if (!agents || !preview || saving) return;
    setSaving(true);
    setError(null);
    setDialogBusy(true);
    try {
      const next = await agents.unload(preview);
      setSnapshot(next);
      onUnloaded?.();
      setDialogBusy(false);
      closeDialog();
      notify({
        text: tr(
          `已卸载 ${preview.members.length} 项。`,
          `Uninstalled ${preview.members.length} skills.`,
        ),
      });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
      setDialogBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) closeDialog();
      }}
    >
      <DialogPopup showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{tr("卸载 Skill", "Uninstall skills")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3 text-sm">
            {loading && (
              <p className="text-muted-foreground" role="status">
                {tr("正在检查受影响的工具…", "Checking affected tools…")}
              </p>
            )}
            {preview && (
              <>
                <p>
                  {tr(
                    `将从 Skill 库删除 ${preview.members.length} 个 Skill。`,
                    `This deletes ${preview.members.length} skills from your library.`,
                  )}
                </p>
                <p className="font-medium text-foreground">
                  {preview.members.map((m) => m.name).join("、")}
                </p>
                <div className="flex flex-col gap-1.5">
                  <strong className="font-medium text-xs text-muted-foreground">
                    {tr("受影响的工具", "Affected tools")}
                  </strong>
                  {preview.agents.length > 0 ? (
                    <ul className="space-y-1 rounded-lg border bg-muted/40 p-2.5 text-xs">
                      {preview.agents.map((a) => (
                        <li key={a.id}>
                          {tr(
                            `${a.name} · ${a.paths.length} 项`,
                            `${a.name} · ${a.paths.length} links`,
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted-foreground text-xs">{tr("无", "None")}</p>
                  )}
                </div>
              </>
            )}
            {error && (
              <p className="text-destructive-foreground text-xs" role="alert">
                {error}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button disabled={saving} variant="outline" onClick={closeDialog}>
            {tr("取消", "Cancel")}
          </Button>
          {preview && (
            <Button
              disabled={saving}
              loading={saving}
              variant="destructive"
              onClick={() => void handleConfirm()}
            >
              {tr("确认卸载", "Uninstall")}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
