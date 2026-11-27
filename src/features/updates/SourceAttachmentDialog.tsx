import * as React from "react";
import { useApp } from "@/app/AppContext";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { tr } from "@/shared/language";
import type { PackageProposal, SourceProgress } from "@/shared/online";
import { errorText } from "@/shared/ui";
import { formatReference, formatSourceOrigin, sourceTooltip } from "./format";

const progressLabels: Record<SourceProgress, [string, string]> = {
  resolving: ["正在读取来源…", "Reading source…"],
  downloading: ["正在下载仓库…", "Downloading repository…"],
  readingMembers: ["正在读取包内 Skill…", "Reading package skills…"],
};

export function SourceAttachmentDialog(): React.ReactElement | null {
  const {
    desktop,
    setSnapshot,
    activeDialog,
    closeDialog,
    setDialogBusy,
    updates,
  } = useApp();

  const open = activeDialog?.type === "attachSource";
  const skill = open ? activeDialog.skill : null;
  const online = desktop.online;
  const updatesGateway = desktop.updates;

  const [sourceInput, setSourceInput] = React.useState("");
  const [reading, setReading] = React.useState(false);
  const [progress, setProgress] = React.useState<SourceProgress>("resolving");
  const [proposal, setProposal] = React.useState<PackageProposal | null>(null);
  const [memberPath, setMemberPath] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const previewIdRef = React.useRef<string | null>(null);
  const genRef = React.useRef(0);

  const release = React.useCallback(() => {
    const id = previewIdRef.current;
    previewIdRef.current = null;
    if (id && online) void online.discard(id).catch(() => {});
  }, [online]);

  React.useEffect(() => {
    if (!open) {
      genRef.current += 1;
      release();
      return;
    }
    setSourceInput("");
    setReading(false);
    setProposal(null);
    setMemberPath("");
    setError(null);
    setSaving(false);
  }, [open, release]);

  React.useEffect(() => () => release(), [release]);

  if (!open || !skill || !online || !updatesGateway) return null;

  const available = proposal ? proposal.members.filter((m) => !m.alreadyInstalled) : [];
  const selectedMember = available.find((m) => m.source.memberPath === memberPath);
  const lockOutsideDismiss = reading || Boolean(proposal) || saving;
  const [zhProgress, enProgress] = progressLabels[progress] ?? progressLabels.resolving;

  async function handlePreview(e?: React.FormEvent) {
    e?.preventDefault();
    if (!online || !skill || reading) return;
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
    const token = ++genRef.current;
    release();
    setReading(true);
    setProposal(null);
    setMemberPath("");
    setError(null);
    setProgress("resolving");
    try {
      const id = await online.reserve();
      if (genRef.current !== token) {
        void online.discard(id).catch(() => {});
        return;
      }
      previewIdRef.current = id;
      const result = await online.read(id, trimmed, (step) => {
        if (genRef.current === token) setProgress(step);
      });
      if (genRef.current !== token) {
        release();
        return;
      }
      setProposal(result);
      const list = result.members.filter((m) => !m.alreadyInstalled);
      const match =
        list.find((m) => m.fingerprint === skill.fingerprint) ??
        list.find((m) => m.folderName === skill.folderName || m.name === skill.name);
      setMemberPath(match?.source.memberPath ?? "");
      if (!list.length) {
        setError(
          tr(
            "这个地址里没有找到可关联的 Skill。",
            "No linkable skills were found at this source.",
          ),
        );
      }
    } catch (reason) {
      if (genRef.current === token) {
        release();
        setError(errorText(reason));
      }
    } finally {
      if (genRef.current === token) setReading(false);
    }
  }

  async function handleAttach() {
    const previewId = previewIdRef.current;
    if (!updatesGateway || !skill || !previewId || !memberPath || saving) return;
    setSaving(true);
    setError(null);
    setDialogBusy(true);
    try {
      const next = await updatesGateway.attach(skill.id, previewId, memberPath);
      release();
      setSnapshot(next);
      setDialogBusy(false);
      closeDialog();
      void updates.check();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
      setDialogBusy(false);
    }
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
        genRef.current += 1;
        release();
        closeDialog();
      }}
    >
      <DialogPopup className="max-w-lg" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>
            {tr(`关联更新地址 · ${skill.name}`, `Link update URL · ${skill.name}`)}
          </DialogTitle>
        </DialogHeader>

        <DialogPanel>
          <div className="flex flex-col gap-4">
            <form className="flex flex-col gap-1.5" onSubmit={(e) => void handlePreview(e)}>
              <Label htmlFor="attach-source-input">
                {tr("安装命令或 HTTPS 仓库链接", "Install command or HTTPS repository URL")}
              </Label>
              <Input
                aria-invalid={Boolean(error) || undefined}
                autoCapitalize="off"
                autoFocus
                disabled={reading || saving}
                id="attach-source-input"
                placeholder={tr("例如 npx skills add owner/repo", "e.g. npx skills add owner/repo")}
                spellCheck={false}
                value={sourceInput}
                onChange={(e) => {
                  setSourceInput(e.target.value);
                  release();
                  setProposal(null);
                  setMemberPath("");
                  if (error) setError(null);
                }}
              />
            </form>

            {reading && (
              <div className="flex items-center gap-2 text-muted-foreground text-sm" role="status">
                <Spinner />
                <span>{tr(zhProgress, enProgress)}</span>
              </div>
            )}

            {proposal && (
              <div className="flex flex-col gap-3">
                <div className="rounded-lg border bg-muted/40 p-3 text-xs">
                  <p
                    className="font-medium text-foreground"
                    title={sourceTooltip(proposal.origin.repository, proposal.origin.reference)}
                  >
                    {[
                      tr(
                        `来自 ${formatSourceOrigin(proposal.origin.repository)}`,
                        `From ${formatSourceOrigin(proposal.origin.repository)}`,
                      ),
                      formatReference(proposal.origin.reference),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {tr(
                      "关联后不会修改你现有的本地文件。",
                      "Linking won't change your existing local files.",
                    )}
                  </p>
                </div>

                {available.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <Label>{tr("选择对应的 Skill", "Matching skill")}</Label>
                    <Select
                      disabled={saving}
                      value={memberPath}
                      onValueChange={(v) => setMemberPath(v ?? "")}
                    >
                      <SelectTrigger aria-label={tr("选择对应的 Skill", "Matching skill")}>
                        <SelectValue placeholder={tr("请选择对应的 Skill", "Select a skill")}>
                          {selectedMember
                            ? `${selectedMember.name} · ${selectedMember.source.memberPath}`
                            : tr("请选择对应的 Skill", "Select a skill")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {available.map((member) => (
                          <SelectItem
                            key={member.source.memberPath}
                            value={member.source.memberPath}
                          >
                            {member.name} · {member.source.memberPath}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                )}

                {selectedMember && selectedMember.fingerprint !== skill.fingerprint && (
                  <p className="text-muted-foreground text-xs">
                    {tr(
                      "你本地的内容与在线版本不同。在确认更新前，会继续保留你当前的本地版本。",
                      "Your local copy differs from the online version. Your local files will stay unchanged until you choose to update.",
                    )}
                  </p>
                )}

                {proposal.problems.map((p) => (
                  <p key={p.memberPath} className="font-mono text-muted-foreground text-xs">
                    {p.memberPath} · {p.message}
                  </p>
                ))}
              </div>
            )}

            {error && (
              <p className="text-destructive-foreground text-xs" role="alert">
                {error}
              </p>
            )}
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button
            disabled={saving}
            variant="outline"
            onClick={() => {
              genRef.current += 1;
              release();
              closeDialog();
            }}
          >
            {tr("取消", "Cancel")}
          </Button>
          <Button
            disabled={reading || saving}
            loading={reading}
            variant="outline"
            onClick={() => void handlePreview()}
          >
            {tr("读取来源", "Check source")}
          </Button>
          {available.length > 0 && (
            <Button
              disabled={!memberPath || saving}
              loading={saving}
              onClick={() => void handleAttach()}
            >
              {tr("保存关联", "Save link")}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
