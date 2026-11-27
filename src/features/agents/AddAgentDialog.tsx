import { ChevronDownIcon, SearchIcon } from "lucide-react";
import * as React from "react";
import { useApp } from "@/app/AppContext";
import { AgentMark } from "@/components/AgentMark";
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { tr } from "@/shared/language";
import type { Agent, AgentDraft } from "@/shared/library";
import { errorText } from "@/shared/ui";
import { AgentDirectoryField, type AgentDirectoryState } from "./AgentDirectoryField";

const FEATURED_KINDS = [
  "claudeCode",
  "codex",
  "cursor",
  "githubCopilot",
  "antigravity",
  "opencode",
  "sharedSkills",
];
const CUSTOM_PRESET: AgentDraft = { kind: "custom", name: "", directory: "" };

export function AddAgentDialog(): React.ReactElement | null {
  const {
    desktop,
    snapshot,
    setSnapshot,
    setPage,
    refreshAgentInventory,
    activeDialog,
    closeDialog,
    setDialogBusy,
  } = useApp();

  const open = activeDialog?.type === "addAgent";
  const gateway = desktop.agents;

  const [featured, setFeatured] = React.useState<AgentDraft[]>([]);
  const [extras, setExtras] = React.useState<AgentDraft[]>([]);
  const [selected, setSelected] = React.useState<AgentDraft>(CUSTOM_PRESET);
  const [lastPreset, setLastPreset] = React.useState<AgentDraft | null>(null);
  const [draftPaths, setDraftPaths] = React.useState<Map<string, string>>(() => new Map());
  const [path, setPath] = React.useState("");
  const [customName, setCustomName] = React.useState("");
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [presetSearch, setPresetSearch] = React.useState("");
  const [dirState, setDirState] = React.useState<AgentDirectoryState>({
    path: "",
    preview: null,
    checking: false,
    choosing: false,
    error: null,
  });
  const [formError, setFormError] = React.useState<string | null>(null);
  const [dirExternalError, setDirExternalError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const nameInputRef = React.useRef<HTMLInputElement>(null);
  const dirInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open || !gateway || !snapshot) return;
    let active = true;
    setFeatured([]);
    setExtras([]);
    setSelected(CUSTOM_PRESET);
    setLastPreset(null);
    setDraftPaths(new Map());
    setPath("");
    setCustomName("");
    setMoreOpen(false);
    setPresetSearch("");
    setFormError(null);
    setDirExternalError(null);
    setSaving(false);

    void gateway
      .presets()
      .then((found) => {
        if (!active) return;
        const localized = found.map((preset) =>
          preset.kind === "sharedSkills"
            ? { ...preset, name: tr("共享 Skills", "Shared Skills") }
            : preset,
        );
        const feat = FEATURED_KINDS.flatMap((kind) =>
          localized.filter((p) => p.kind === kind),
        );
        const ext = localized
          .filter((p) => !FEATURED_KINDS.includes(p.kind))
          .sort((a, b) => a.name.localeCompare(b.name));
        setFeatured(feat);
        setExtras(ext);
        const usedKinds = new Set(snapshot.agents?.map((a) => a.kind) ?? []);
        const ordered = [...feat, ...ext];
        const available = ordered.find((p) => !usedKinds.has(p.kind));
        const initialPreset = available ?? ordered[0] ?? null;
        setLastPreset(initialPreset);
        if (available) {
          setSelected(available);
          setPath(available.directory);
        }
      })
      .catch((reason) => {
        if (active) setFormError(errorText(reason));
      });

    return () => {
      active = false;
    };
  }, [open, gateway, snapshot]);

  if (!open || !gateway || !snapshot) return null;

  const existingShared: Agent | undefined =
    selected.kind === "sharedSkills"
      ? snapshot.agents?.find((a) => a.directory === selected.directory) ??
        snapshot.agents?.find((a) => a.kind === "sharedSkills")
      : undefined;

  const selectPreset = (preset: AgentDraft) => {
    if (selected.kind === preset.kind) return;
    setDraftPaths((prev) => {
      const next = new Map(prev);
      next.set(selected.kind, path);
      return next;
    });
    if (preset.kind !== "custom") setLastPreset(preset);
    setSelected(preset);
    const savedDraft = draftPaths.get(preset.kind);
    const isSharedDuplicate =
      preset.kind === "sharedSkills" &&
      Boolean(
        snapshot.agents?.some(
          (a) => a.directory === preset.directory || a.kind === "sharedSkills",
        ),
      );
    setPath(isSharedDuplicate ? "" : savedDraft ?? preset.directory);
    setFormError(null);
    setDirExternalError(null);
    if (preset.kind === "custom") setMoreOpen(false);
  };

  const isCustom = selected.kind === "custom";
  const otherSelected = extras.some((p) => p.kind === selected.kind);
  const filteredExtras = extras.filter((p) =>
    p.name.toLocaleLowerCase().includes(presetSearch.trim().toLocaleLowerCase()),
  );

  const hintText = isCustom
    ? tr("填写工具名称，并指定它读取 Skill 的目录。", "Enter a name and the folder this tool reads skills from.")
    : selected.kind === "sharedSkills"
      ? tr("勾选的 Skill 会共享给所有读取此目录的工具。", "Selected skills are available to every tool that reads this folder.")
      : tr("选好工具后会自动填入它的 Skill 文件夹。", "Choose a tool to fill in its default folder. You can edit the path.");

  async function handleSave() {
    if (!gateway || !snapshot) return;
    if (existingShared) {
      closeDialog();
      setPage({ kind: "agent", id: existingShared.id });
      return;
    }

    const displayName = selected.name || customName.trim();
    const duplicateName =
      selected.kind === "custom" &&
      snapshot.agents?.some((a) => a.name.toLowerCase() === displayName.toLowerCase());

    if (!displayName || duplicateName) {
      setFormError(
        duplicateName
          ? tr("该工具名称已存在，请输入其他名称。", "This tool name is already in use. Enter another name.")
          : tr("请输入工具名称。", "Enter a tool name."),
      );
      nameInputRef.current?.focus();
      return;
    }

    if (!dirState.preview || saving || dirState.choosing) return;
    setFormError(null);
    setDirExternalError(null);
    setSaving(true);
    setDialogBusy(true);
    try {
      const nextSnapshot = await gateway.add(
        { kind: selected.kind, name: displayName, directory: dirState.preview.directory },
        !dirState.preview.exists,
      );
      const saved = nextSnapshot.agents?.find((a) => a.name === displayName);
      setSnapshot(nextSnapshot);
      if (saved) void refreshAgentInventory(saved.id);
      setDialogBusy(false);
      closeDialog();
      if (saved) setPage({ kind: "agent", id: saved.id });
    } catch (reason) {
      setDirExternalError(errorText(reason));
      dirInputRef.current?.focus();
    } finally {
      setSaving(false);
      setDialogBusy(false);
    }
  }

  const saveLabel = existingShared
    ? tr("打开已有分配", "Open assignments")
    : dirState.preview && !dirState.preview.exists
      ? tr("创建目录并添加", "Create folder and add")
      : tr("添加工具", "Add tool");

  const saveDisabled = existingShared
    ? saving
    : saving || dirState.choosing || !dirState.preview;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) closeDialog();
      }}
    >
      <DialogPopup className="max-w-xl" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{tr("添加工具", "Add tool")}</DialogTitle>
        </DialogHeader>

        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>{tr("添加方式", "Setup method")}</Label>
              <Tabs
                value={isCustom ? "custom" : "preset"}
                onValueChange={(val) => {
                  if (val === "custom") selectPreset(CUSTOM_PRESET);
                  else if (lastPreset) selectPreset(lastPreset);
                }}
              >
                <TabsList>
                  <TabsTab disabled={!lastPreset} value="preset">
                    {tr("常用工具", "Common tools")}
                  </TabsTab>
                  <TabsTab value="custom">{tr("自定义工具", "Custom tool")}</TabsTab>
                </TabsList>
              </Tabs>
              <p className="text-muted-foreground text-xs">{hintText}</p>
            </div>

            {!isCustom && (
              <div className="flex flex-col gap-2.5">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {featured.map((preset) => {
                    const active = selected.kind === preset.kind;
                    return (
                      <button
                        key={preset.kind}
                        aria-pressed={active}
                        className={cn(
                          "flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "border-primary bg-accent font-medium text-foreground shadow-xs/5"
                            : "border-border bg-background text-foreground hover:bg-accent/60",
                        )}
                        type="button"
                        onClick={() => selectPreset(preset)}
                      >
                        <AgentMark agent={preset} />
                        <span className="truncate">{preset.name}</span>
                      </button>
                    );
                  })}
                </div>

                {otherSelected && (
                  <div className="flex min-w-0 items-center gap-2 rounded-lg border border-primary bg-accent px-3 py-2 text-sm font-medium">
                    <AgentMark agent={selected} />
                    <span className="truncate">{selected.name}</span>
                  </div>
                )}

                {extras.length > 0 && (
                  <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
                    <CollapsibleTrigger
                      className="inline-flex cursor-pointer items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground [&[data-panel-open]>svg]:rotate-180"
                    >
                      <span>{tr("查找其他工具", "Find other tools")}</span>
                      <ChevronDownIcon className="size-3.5 transition-transform" />
                    </CollapsibleTrigger>
                    <CollapsiblePanel>
                      <div className="mt-2 flex flex-col gap-2 rounded-xl border bg-muted/40 p-2.5">
                        <InputGroup>
                          <InputGroupAddon>
                            <SearchIcon />
                          </InputGroupAddon>
                          <InputGroupInput
                            aria-label={tr("搜索工具名称", "Search tool names")}
                            placeholder={tr("搜索工具名称…", "Search tool names…")}
                            type="search"
                            value={presetSearch}
                            onChange={(e) => setPresetSearch(e.target.value)}
                          />
                        </InputGroup>
                        <div className="grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto">
                          {filteredExtras.length > 0 ? (
                            filteredExtras.map((preset) => (
                              <button
                                key={preset.kind}
                                aria-pressed={selected.kind === preset.kind}
                                className={cn(
                                  "flex min-w-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                                  selected.kind === preset.kind
                                    ? "border-primary bg-accent font-medium"
                                    : "border-transparent bg-background",
                                )}
                                type="button"
                                onClick={() => {
                                  selectPreset(preset);
                                  setMoreOpen(false);
                                }}
                              >
                                <AgentMark agent={preset} />
                                <span className="truncate">{preset.name}</span>
                              </button>
                            ))
                          ) : (
                            <p className="col-span-2 py-2 text-center text-muted-foreground text-xs" role="status">
                              {tr("没有匹配的工具", "No matching tools")}
                            </p>
                          )}
                        </div>
                      </div>
                    </CollapsiblePanel>
                  </Collapsible>
                )}
              </div>
            )}

            {isCustom && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="custom-agent-name">{tr("显示名称", "Display name")}</Label>
                <Input
                  ref={nameInputRef}
                  aria-invalid={Boolean(formError) || undefined}
                  disabled={saving}
                  id="custom-agent-name"
                  placeholder={tr("例如：Antigravity", "e.g. Antigravity")}
                  value={customName}
                  onChange={(e) => {
                    setCustomName(e.target.value);
                    if (formError) setFormError(null);
                  }}
                />
              </div>
            )}

            {existingShared ? (
              <div className="rounded-lg border bg-muted/40 p-3 text-muted-foreground text-sm">
                {tr(
                  `「${existingShared.name}」已管理此目录：`,
                  `${existingShared.name} already manages this folder: `,
                )}
                <code className="mt-1 block break-all font-mono text-foreground text-xs">
                  {existingShared.directory}
                </code>
              </div>
            ) : (
              <AgentDirectoryField
                disabled={saving}
                externalError={dirExternalError}
                gateway={gateway}
                inputRef={dirInputRef}
                path={path}
                onPathChange={(next) => {
                  setPath(next);
                  setDirExternalError(null);
                }}
                onStateChange={setDirState}
              />
            )}

            {formError && (
              <p className="text-destructive-foreground text-xs" role="alert">
                {formError}
              </p>
            )}
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button disabled={saving} variant="outline" onClick={closeDialog}>
            {tr("取消", "Cancel")}
          </Button>
          <Button disabled={saveDisabled} loading={saving} onClick={() => void handleSave()}>
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
