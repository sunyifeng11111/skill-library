import { ChevronDownIcon } from "lucide-react";
import * as React from "react";
import { useApp } from "@/app/AppContext";
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
import { tr } from "@/shared/language";
import { errorText } from "@/shared/ui";

export function RemoveAgentDialog(): React.ReactElement | null {
  const {
    desktop,
    snapshot,
    setSnapshot,
    reloadSnapshot,
    activeDialog,
    closeDialog,
    setDialogBusy,
    notify,
  } = useApp();

  const open = activeDialog?.type === "removeAgent";
  const agentId = open ? activeDialog.agentId : "";
  const gateway = desktop.agents;
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setSaving(false);
      setError(null);
    }
  }, [open, agentId]);

  if (!open || !gateway || !snapshot) return null;

  const agent = snapshot.agents?.find((item) => item.id === agentId);
  if (!agent) return null;

  const assigned = new Map(
    snapshot.assignments
      ?.filter((item) => item.agentId === agent.id && item.path)
      .map((item) => [item.skillId, item.path!]),
  );
  const members = snapshot.skills.filter((skill) => assigned.has(skill.id));

  const nameCounts = new Map<string, number>();
  for (const m of members) nameCounts.set(m.name, (nameCounts.get(m.name) ?? 0) + 1);

  async function handleConfirm() {
    if (!gateway || !agent || saving) return;
    setSaving(true);
    setError(null);
    setDialogBusy(true);
    try {
      const next = await gateway.remove(
        agent.id,
        members.map((m) => m.id),
      );
      setSnapshot(next);
      setDialogBusy(false);
      closeDialog();
      notify({
        text: tr(
          `已从「我的工具」移除 ${agent.name}。`,
          `Removed ${agent.name} from My tools.`,
        ),
      });
    } catch (reason) {
      await reloadSnapshot().catch(() => {});
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
          <DialogTitle>
            {tr(`移除 ${agent.name}？`, `Remove ${agent.name}?`)}
          </DialogTitle>
        </DialogHeader>

        <DialogPanel>
          <div className="flex flex-col gap-3 text-sm">
            <p>
              {tr(
                `将从「我的工具」中移除 ${agent.name}。你可以随时重新添加这个工具。`,
                `${agent.name} will be removed from My tools. You can add it again at any time.`,
              )}
            </p>

            {members.length > 0 && (
              <Collapsible>
                <CollapsibleTrigger className="inline-flex cursor-pointer items-center gap-1.5 font-medium text-sm text-foreground [&[data-panel-open]>svg]:rotate-180">
                  <ChevronDownIcon className="size-4 text-muted-foreground transition-transform" />
                  <span>
                    {tr(
                      `此工具将停止使用 Skill 库提供的 ${members.length} 个 Skill`,
                      `This tool will lose access to ${members.length} library ${members.length === 1 ? "skill" : "skills"}`,
                    )}
                  </span>
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg border bg-muted/40 p-2.5 text-xs">
                    {members.map((member) => (
                      <li key={member.id} className="flex flex-col">
                        <span className="font-medium text-foreground">{member.name}</span>
                        {(nameCounts.get(member.name) ?? 0) > 1 && (
                          <span className="truncate font-mono text-muted-foreground">
                            {assigned.get(member.id)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </CollapsiblePanel>
              </Collapsible>
            )}

            {(agent.syncUncategorized || agent.syncedCategories.length > 0) && (
              <p className="text-foreground">
                {tr(
                  "此工具的分类自动开启也会停止。",
                  "Category auto-enable will also stop for this tool.",
                )}
              </p>
            )}

            <p className="text-muted-foreground text-xs">
              {tr(
                "工具本身和 Skill 库里的 Skill 都会保留。其他工具可以继续使用各自的 Skill。",
                "The tool stays installed and your skills stay in the library. Other tools keep their skills.",
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
            {tr("移除工具", "Remove tool")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
