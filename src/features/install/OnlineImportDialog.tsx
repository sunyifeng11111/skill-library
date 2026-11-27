import * as React from "react";
import { useApp } from "@/app/AppContext";
import { CategoryPicker, validateCategoryTarget } from "@/components/CategoryPicker";
import { renderEmojiSafeText } from "@/components/EmojiSafeText";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Spinner } from "@/components/ui/spinner";
import { tr } from "@/shared/language";
import type { CategoryTarget } from "@/shared/library";
import type { PackageProposal, SourceProgress } from "@/shared/online";
import { errorText } from "@/shared/ui";

const progressLabels: Record<SourceProgress, [string, string]> = {
  resolving: ["正在读取来源…", "Reading source…"],
  downloading: ["正在下载仓库…", "Downloading repository…"],
  readingMembers: ["正在读取包内 Skill…", "Reading package skills…"],
};

export function OnlineImportDialog(): React.ReactElement | null {
  const {
    desktop,
    snapshot,
    setSnapshot,
    activeDialog,
    closeDialog,
    setDialogBusy,
    updates,
    notify,
  } = useApp();

  const open = activeDialog?.type === "onlineImport";
  const initialTarget = open ? activeDialog.target : undefined;
  const online = desktop.online;

  const [step, setStep] = React.useState<"input" | "loading" | "preview">("input");
  const [sourceInput, setSourceInput] = React.useState("");
  const [progress, setProgress] = React.useState<SourceProgress>("resolving");
  const [proposal, setProposal] = React.useState<PackageProposal | null>(null);
  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(() => new Set());
  const [categoryTarget, setCategoryTarget] = React.useState<CategoryTarget>({
    kind: "uncategorized",
  });
  const [assignmentSummary, setAssignmentSummary] = React.useState("");
  const [conflicts, setConflicts] = React.useState<string[]>([]);
  const [checkingAssignments, setCheckingAssignments] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const previewIdRef = React.useRef<string | null>(null);
  const readGenRef = React.useRef(0);
  const assignRevRef = React.useRef(0);
  const draftsRef = React.useRef<
    Map<string, { members: Set<string>; category: CategoryTarget }>
  >(new Map());

  const releasePreview = React.useCallback(() => {
    const id = previewIdRef.current;
    previewIdRef.current = null;
    if (id && online) {
      void online.discard(id).catch((err) => {
        notify({
          text: tr(
            `无法清理在线安装预览。请重启应用。${errorText(err)}`,
            `Could not clear the install preview. Restart the app. ${errorText(err)}`,
          ),
          error: true,
        });
      });
    }
  }, [online, notify]);

  React.useEffect(() => {
    if (!open) {
      readGenRef.current += 1;
      releasePreview();
      return;
    }
    setStep("input");
    setSourceInput("");
    setProposal(null);
    setAssignmentSummary("");
    setConflicts([]);
    setCheckingAssignments(false);
    setError(null);
    setSaving(false);
    draftsRef.current.clear();
  }, [open, releasePreview]);

  React.useEffect(() => () => releasePreview(), [releasePreview]);

  const checkAssignments = React.useCallback(async () => {
    if (!proposal || step !== "preview" || !snapshot) return;
    const rev = ++assignRevRef.current;
    const pickedMembers = proposal.members.filter(
      (m) => m.status !== "duplicate" && selectedPaths.has(m.source.memberPath),
    );
    setConflicts([]);
    const agentList = snapshot.agents ?? [];
    if (!desktop.agents || !agentList.length || !pickedMembers.length) {
      setCheckingAssignments(false);
      setAssignmentSummary("");
      return;
    }

    let target: CategoryTarget;
    try {
      target = validateCategoryTarget(categoryTarget);
    } catch {
      setCheckingAssignments(false);
      setAssignmentSummary("");
      return;
    }

    const hasSyncedAgent =
      target.kind === "existing"
        ? agentList.some((a) => a.syncedCategories.includes(target.id))
        : target.kind === "uncategorized"
          ? agentList.some((a) => a.syncUncategorized)
          : false;
    if (!hasSyncedAgent) {
      setCheckingAssignments(false);
      setAssignmentSummary("");
      return;
    }

    setCheckingAssignments(true);
    setAssignmentSummary(tr("正在检查分类自动同步…", "Checking category auto-sync…"));
    try {
      const preview = await desktop.agents.previewInstall(
        pickedMembers.map((m) => m.folderName),
        target,
        [],
      );
      if (assignRevRef.current !== rev) return;
      const names = new Map(agentList.map((a) => [a.id, a.name]));
      const syncedNames = preview.targets
        .filter((item) => item.viaCategory)
        .map((item) => names.get(item.agentId))
        .filter((name): name is string => Boolean(name));
      setAssignmentSummary(
        syncedNames.length > 0
          ? tr(
              `安装后将随分类自动同步到 ${syncedNames.join("、")}`,
              `Will sync automatically with this category to ${syncedNames.join(", ")}`,
            )
          : "",
      );
      setConflicts(preview.conflicts.map((c) => c.message));
    } catch (err) {
      if (assignRevRef.current !== rev) return;
      setAssignmentSummary(tr("无法检查分类自动同步。", "Could not check category auto-sync."));
      setConflicts([errorText(err)]);
    } finally {
      if (assignRevRef.current === rev) setCheckingAssignments(false);
    }
  }, [proposal, step, snapshot, selectedPaths, categoryTarget, desktop]);

  React.useEffect(() => {
    void checkAssignments();
  }, [checkAssignments]);

  if (!open || !online || !snapshot) return null;

  async function handleRead(event?: React.FormEvent) {
    event?.preventDefault();
    if (!online || !snapshot || step === "loading") return;
    const trimmed = sourceInput.trim();
    if (!trimmed) {
      setError(
        tr(
          "请输入安装命令或 HTTPS 仓库链接。",
          "Enter an install command or an HTTPS repository URL.",
        ),
      );
      return;
    }

    const token = ++readGenRef.current;
    releasePreview();
    setError(null);
    setProgress("resolving");
    setStep("loading");

    try {
      const id = await online.reserve();
      if (readGenRef.current !== token) {
        void online.discard(id).catch(() => {});
        return;
      }
      previewIdRef.current = id;
      const result = await online.read(id, trimmed, (nextProgress) => {
        if (readGenRef.current === token) setProgress(nextProgress);
      });
      if (readGenRef.current !== token) {
        releasePreview();
        return;
      }
      const key = JSON.stringify([result.origin.repository, result.origin.reference]);
      const draft = draftsRef.current.get(key);
      const matchingCat = snapshot.categories.find(
        (c) => c.name.toLowerCase() === result.name.toLowerCase(),
      );
      const defaultTarget: CategoryTarget = matchingCat
        ? { kind: "existing", id: matchingCat.id }
        : { kind: "new", name: result.name };

      const initialSelected = new Set(
        result.members
          .filter(
            (m) =>
              m.status !== "duplicate" &&
              (draft ? draft.members.has(m.source.memberPath) : true),
          )
          .map((m) => m.source.memberPath),
      );

      setProposal(result);
      setSelectedPaths(initialSelected);
      setCategoryTarget(draft?.category ?? initialTarget ?? defaultTarget);
      setStep("preview");
    } catch (reason) {
      if (readGenRef.current !== token) return;
      releasePreview();
      setError(errorText(reason));
      setStep("input");
    }
  }

  function handleBack() {
    if (!proposal) return;
    const key = JSON.stringify([proposal.origin.repository, proposal.origin.reference]);
    draftsRef.current.set(key, {
      members: new Set(selectedPaths),
      category: categoryTarget,
    });
    releasePreview();
    setAssignmentSummary("");
    setConflicts([]);
    setCheckingAssignments(false);
    setStep("input");
  }

  async function handleInstall() {
    if (!proposal || !snapshot || saving || checkingAssignments || conflicts.length > 0) return;
    const picked = proposal.members.filter(
      (m) => m.status !== "duplicate" && selectedPaths.has(m.source.memberPath),
    );
    if (!picked.length) return;
    setError(null);
    let validated: CategoryTarget;
    try {
      validated = validateCategoryTarget(categoryTarget);
      if (validated.kind === "new") {
        const newName = validated.name.toLowerCase();
        if (snapshot.categories.some((c) => c.name.toLowerCase() === newName)) {
          throw new Error(
            tr(
              "分类名称已存在，请选择已有分类或更换名称。",
              "This category already exists. Select it or enter a different name.",
            ),
          );
        }
      }
    } catch (reason) {
      setError(errorText(reason));
      return;
    }

    setSaving(true);
    setDialogBusy(true);
    try {
      const picks = picked.map(({ path, source, fingerprint }) => ({ path, source, fingerprint }));
      const result = await desktop.library.commitImport(picks, validated);
      setSnapshot(result.library);
      if (result.added.length > 0) {
        updates.syncInstalled(result.library, result.added, proposal.revision);
      }
      releasePreview();
      setDialogBusy(false);
      closeDialog();
      const skipped = result.duplicates
        ? tr(`，已跳过 ${result.duplicates} 项重复内容`, `, skipped ${result.duplicates} duplicates`)
        : "";
      notify({
        text: tr(
          `已安装 ${result.added.length} 项${skipped}。`,
          `Installed ${result.added.length} skills${skipped}.`,
        ),
      });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
      setDialogBusy(false);
    }
  }

  const selectableMembers = proposal
    ? proposal.members.filter((m) => m.status !== "duplicate")
    : [];
  const pickedCount = selectableMembers.filter((m) =>
    selectedPaths.has(m.source.memberPath),
  ).length;
  const allSelectableSelected =
    selectableMembers.length > 0 && pickedCount === selectableMembers.length;
  const someSelectableSelected =
    pickedCount > 0 && pickedCount < selectableMembers.length;
  const lockOutsideDismiss = step !== "input" || saving;
  const [zhProgress, enProgress] = progressLabels[progress] ?? progressLabels.resolving;

  function cancelAndClose() {
    if (saving) return;
    readGenRef.current += 1;
    releasePreview();
    closeDialog();
  }

  return (
    <Dialog
      disablePointerDismissal={lockOutsideDismiss}
      open={open}
      onOpenChange={(next, eventDetails) => {
        if (next) return;
        if (saving) {
          eventDetails.cancel();
          return;
        }
        if (lockOutsideDismiss && eventDetails.reason === "outside-press") {
          eventDetails.cancel();
          return;
        }
        cancelAndClose();
      }}
    >
      <DialogPopup className="max-w-xl" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>
            {step === "preview" ? tr("安装预览", "Install preview") : tr("安装 Skill", "Install skill")}
          </DialogTitle>
        </DialogHeader>

        <DialogPanel>
          {step === "input" && (
            <form className="flex flex-col gap-3" id="online-source-form" onSubmit={(e) => void handleRead(e)}>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="online-source-input">
                  {tr("安装命令或 HTTPS 仓库链接", "Install command or HTTPS repository URL")}
                </Label>
                <Input
                  aria-invalid={Boolean(error) || undefined}
                  autoCapitalize="off"
                  autoFocus
                  id="online-source-input"
                  placeholder={tr("例如 npx skills add owner/repo", "e.g. npx skills add owner/repo")}
                  spellCheck={false}
                  value={sourceInput}
                  onChange={(e) => {
                    setSourceInput(e.target.value);
                    if (error) setError(null);
                  }}
                />
              </div>
              {error && (
                <p className="text-destructive-foreground text-xs" role="alert">
                  {error}
                </p>
              )}
            </form>
          )}

          {step === "loading" && (
            <div className="flex items-center gap-2.5 py-6 text-muted-foreground text-sm" role="status">
              <Spinner />
              <span>{tr(zhProgress, enProgress)}</span>
            </div>
          )}

          {step === "preview" && proposal && (
            <div className="flex flex-col gap-4">
              {proposal.problems.length > 0 && (
                <Alert variant="warning">
                  <AlertDescription>
                    <ul className="list-disc pl-4 text-xs">
                      {proposal.problems.map((p) => (
                        <li key={p.memberPath}>
                          {p.memberPath} · {p.message}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <strong className="block truncate font-semibold text-sm">{proposal.name}</strong>
                  <p className="break-all font-mono text-muted-foreground text-xs">
                    {proposal.origin.repository} · {proposal.origin.reference}
                  </p>
                  <p className="break-all font-mono text-muted-foreground text-[11px]">
                    {tr(`安装修订 ${proposal.revision}`, `Install revision ${proposal.revision}`)}
                  </p>
                </div>
                <Badge className="shrink-0" variant="secondary">
                  {tr(
                    `已选 ${pickedCount} / ${proposal.members.length}`,
                    `${pickedCount} of ${proposal.members.length} selected`,
                  )}
                </Badge>
              </div>

              {proposal.members.length > 0 && (
                <div className="divide-y rounded-xl border bg-card">
                  <div className="flex items-center justify-between gap-3 rounded-t-[calc(var(--radius-xl)-1px)] bg-muted/40 px-3.5 py-2.5">
                    <div className="flex items-center gap-3">
                      <Checkbox
                        aria-label={tr("全选", "Select all")}
                        checked={allSelectableSelected}
                        disabled={saving || selectableMembers.length === 0}
                        id="online-select-all-members"
                        indeterminate={someSelectableSelected}
                        onCheckedChange={(checked) => {
                          setSelectedPaths(
                            checked
                              ? new Set(selectableMembers.map((m) => m.source.memberPath))
                              : new Set(),
                          );
                        }}
                      />
                      <label
                        className={
                          saving || selectableMembers.length === 0
                            ? "select-none font-medium text-muted-foreground text-xs"
                            : "cursor-pointer select-none font-medium text-foreground text-xs"
                        }
                        htmlFor="online-select-all-members"
                      >
                        {tr("全选", "Select all")}
                      </label>
                    </div>
                    <span className="text-muted-foreground text-xs">
                      {selectableMembers.length < proposal.members.length
                        ? tr(
                            `可安装 ${selectableMembers.length} 项`,
                            `${selectableMembers.length} available`,
                          )
                        : tr(
                            `共 ${proposal.members.length} 项`,
                            `${proposal.members.length} total`,
                          )}
                    </span>
                  </div>
                  {proposal.members.map((member) => {
                    const unavailable =
                      member.status === "duplicate"
                        ? member.alreadyInstalled
                          ? tr("此来源成员已安装", "Already installed from this source")
                          : tr("内容重复", "Duplicate content")
                        : undefined;
                    const checked = !unavailable && selectedPaths.has(member.source.memberPath);

                    return (
                      <div
                        key={member.source.memberPath}
                        className="flex items-start gap-3 px-3.5 py-2.5 transition-colors hover:bg-accent/40"
                      >
                        <Checkbox
                          aria-label={member.name}
                          checked={checked}
                          className="mt-0.5"
                          disabled={Boolean(unavailable) || saving}
                          id={`online-member-${member.source.memberPath}`}
                          onCheckedChange={(c) => {
                            setSelectedPaths((prev) => {
                              const next = new Set(prev);
                              if (c) next.add(member.source.memberPath);
                              else next.delete(member.source.memberPath);
                              return next;
                            });
                          }}
                        />
                        <label
                          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5"
                          htmlFor={`online-member-${member.source.memberPath}`}
                        >
                          <strong className="truncate font-medium text-sm" title={member.name}>
                            {renderEmojiSafeText(member.name)}
                          </strong>
                          {member.description && (
                            <span className="break-words text-muted-foreground text-xs">
                              {renderEmojiSafeText(member.description)}
                            </span>
                          )}
                          <span className="truncate font-mono text-[11px] text-muted-foreground/80">
                            {member.source.memberPath}
                          </span>
                        </label>
                        <Badge className="shrink-0" size="sm" variant={unavailable ? "outline" : "secondary"}>
                          {unavailable ?? tr("可安装", "Ready to install")}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              )}

              <CategoryPicker
                addLabel={tr("＋ 添加目录", "+ Add category")}
                categories={snapshot.categories}
                disabled={saving}
                value={categoryTarget}
                onChange={(next) => {
                  setCategoryTarget(next);
                  if (error) setError(null);
                }}
              />

              {assignmentSummary && (
                <p className="text-muted-foreground text-xs" aria-live="polite">
                  {assignmentSummary}
                </p>
              )}

              {conflicts.length > 0 && (
                <Alert variant="error">
                  <AlertDescription>
                    <ul className="list-disc pl-4 text-xs">
                      {conflicts.map((msg, i) => (
                        <li key={i}>{msg}</li>
                      ))}
                    </ul>
                    <div>
                      <Button size="xs" variant="outline" onClick={() => void checkAssignments()}>
                        {tr("重新检查", "Check again")}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              {error && (
                <p className="text-destructive-foreground text-xs" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
        </DialogPanel>

        <DialogFooter>
          <Button
            disabled={saving}
            variant="outline"
            onClick={cancelAndClose}
          >
            {tr("取消", "Cancel")}
          </Button>
          {step === "input" && (
            <Button form="online-source-form" type="submit">
              {tr("预览来源", "Preview source")}
            </Button>
          )}
          {step === "preview" && (
            <>
              <Button disabled={saving} variant="outline" onClick={handleBack}>
                {tr("返回", "Back")}
              </Button>
              <Button
                disabled={saving || checkingAssignments || conflicts.length > 0 || pickedCount === 0}
                loading={saving}
                onClick={() => void handleInstall()}
              >
                {tr(`安装 ${pickedCount} 项`, `Install ${pickedCount}`)}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
