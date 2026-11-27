import { ChevronDownIcon, FolderOpenIcon, ScanSearchIcon, SearchIcon } from "lucide-react";
import * as React from "react";
import { useApp } from "@/app/AppContext";
import { renderEmojiSafeText } from "@/components/EmojiSafeText";
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
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import type { DiscoveredSkill } from "@/shared/discovery";
import { tr } from "@/shared/language";
import { localOriginLabel } from "@/shared/local-origins";
import { errorText } from "@/shared/ui";
import { groupLocalSkills } from "./local-members";

export function LocalImportDialog(): React.ReactElement | null {
  const { desktop, snapshot, setSnapshot, activeDialog, closeDialog, setDialogBusy, notify } =
    useApp();

  const open = activeDialog?.type === "localImport";
  const target = open ? activeDialog.target : { kind: "uncategorized" as const };
  const entry = open ? activeDialog.entry : { mode: "sources" as const };

  const [step, setStep] = React.useState<"start" | "loading" | "error" | "preview">("start");
  const [folders, setFolders] = React.useState<string[]>([]);
  const [withTools, setWithTools] = React.useState(false);
  const [rows, setRows] = React.useState<DiscoveredSkill[]>([]);
  const [omitted, setOmitted] = React.useState<Set<string>>(() => new Set());
  const [choosing, setChoosing] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const loadGenRef = React.useRef(0);

  const runLoad = React.useCallback(
    async (baseFolders: string[], add: string[], scanTools: boolean) => {
      const token = ++loadGenRef.current;
      const paths = [...new Set([...baseFolders, ...add])];
      setStep("loading");
      setError(null);
      try {
        const found = await desktop.library.previewFolders(paths, scanTools);
        if (loadGenRef.current !== token) return;
        setRows(found);
        setFolders(paths);
        setWithTools(scanTools);
        setStep("preview");
      } catch (reason) {
        if (loadGenRef.current !== token) return;
        setError(errorText(reason));
        setStep("error");
      }
    },
    [desktop],
  );

  React.useEffect(() => {
    if (!open) return;
    loadGenRef.current += 1;
    setFolders([]);
    setWithTools(false);
    setRows([]);
    setOmitted(new Set());
    setChoosing(false);
    setSearch("");
    setError(null);
    setSaving(false);

    if (entry.mode === "folders") {
      void runLoad([], entry.paths, false);
    } else if (entry.mode === "scan") {
      void runLoad([], [], true);
    } else {
      setStep("start");
    }
  }, [open, entry, runLoad]);

  if (!open || !snapshot) return null;

  const groups = groupLocalSkills(rows, snapshot.skills);
  const items = groups.filter((item) => !item.imported);
  const skipped = groups.length - items.length;
  const problems = rows.filter((row) => !row.fingerprint && row.reason);
  const tools = [...new Set(rows.filter((row) => row.agentKind).map((row) => row.sourceName))];
  const categoryName =
    target.kind === "existing"
      ? snapshot.categories.find((c) => c.id === target.id)?.name
      : undefined;
  const destinationLabel = categoryName
    ? tr(`Skill 库的「${categoryName}」分类`, `“${categoryName}” in your library`)
    : tr("Skill 库", "your library");

  const selectedItems = items.filter((item) => !omitted.has(item.fingerprint));
  const queryLower = search.trim().toLowerCase();
  const filteredItems = items.filter((item) =>
    [item.name, item.description, ...item.origins, ...item.locations.map((r) => r.path)].some(
      (text) => text.toLowerCase().includes(queryLower),
    ),
  );

  async function handleChooseFolders() {
    try {
      const picked = await desktop.chooseFolders();
      if (picked.length) await runLoad(folders, picked, withTools);
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  async function handleCommit() {
    if (saving || !selectedItems.length) return;
    setSaving(true);
    setError(null);
    setDialogBusy(true);
    try {
      const picks = selectedItems.map(({ path, fingerprint, source }) => ({
        path,
        fingerprint,
        source,
      }));
      const origins = Object.fromEntries(
        selectedItems.map((item) => [item.fingerprint, item.origins]),
      );
      const result = await desktop.library.commitImport(picks, target, true, origins);
      setSnapshot(result.library);
      setDialogBusy(false);
      closeDialog();
      const dup = result.duplicates
        ? tr(`，已跳过 ${result.duplicates} 个已有项`, `, skipped ${result.duplicates} already added`)
        : "";
      notify({
        text:
          tr(
            `已添加 ${result.added.length} 个 Skill 到${destinationLabel}`,
            `Added ${result.added.length} skills to ${destinationLabel}`,
          ) + dup,
      });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
      setDialogBusy(false);
    }
  }

  const title =
    step === "preview"
      ? items.length
        ? tr(`找到 ${items.length} 个可以添加的 Skill`, `Found ${items.length} skills to add`)
        : skipped
          ? tr("找到的 Skill 都已在 Skill 库中", "These skills are already in your library")
          : tr("没有找到可添加的 Skill", "No skills found to add")
      : tr("添加到 Skill 库", "Add to library");

  const lockOutsideDismiss = step !== "start" || saving;

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
        closeDialog();
      }}
    >
      <DialogPopup className="max-w-xl" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <DialogPanel>
          {step === "start" && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                {!withTools && (
                  <Button variant="outline" onClick={() => void runLoad(folders, [], true)}>
                    <ScanSearchIcon />
                    {tr("查找电脑里已有的 Skill", "Find skills on this computer")}
                  </Button>
                )}
                <Button variant="outline" onClick={() => void handleChooseFolders()}>
                  <FolderOpenIcon />
                  {tr("从文件夹添加", "Add from a folder")}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                {tr(
                  "也可以拖入文件夹，一次添加多个 Skill。",
                  "You can also drop a folder to add several skills at once.",
                )}
              </p>
              {error && (
                <p className="text-destructive-foreground text-xs" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}

          {step === "loading" && (
            <div className="flex items-center gap-2.5 py-6 text-muted-foreground text-sm" role="status">
              <Spinner />
              <span>{tr("正在查找 Skill…", "Finding skills…")}</span>
            </div>
          )}

          {step === "error" && (
            <p className="text-destructive-foreground text-sm" role="alert">
              {error}
            </p>
          )}

          {step === "preview" && (
            <div className="flex flex-col gap-4">
              {items.length > 0 && (
                <>
                  <p className="text-muted-foreground text-xs">
                    {(tools.length
                      ? tr(`在 ${tools.join("、")} 中找到。`, `Found in ${tools.join(", ")}. `)
                      : "") + tr("相同内容只保存一份。", "Identical copies are saved once.")}
                  </p>

                  {choosing && (
                    <div className="flex flex-wrap items-center gap-2">
                      <InputGroup className="min-w-44 flex-1">
                        <InputGroupAddon>
                          <SearchIcon />
                        </InputGroupAddon>
                        <InputGroupInput
                          aria-label={tr("搜索名称、用途或来源", "Search by name, description or source")}
                          autoFocus
                          placeholder={tr("搜索名称、用途或来源", "Search by name, description or source")}
                          size="sm"
                          type="search"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </InputGroup>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          setOmitted((prev) => {
                            const next = new Set(prev);
                            for (const item of filteredItems) next.delete(item.fingerprint);
                            return next;
                          });
                        }}
                      >
                        {tr("全选", "Select all")}
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          setOmitted((prev) => {
                            const next = new Set(prev);
                            for (const item of filteredItems) next.add(item.fingerprint);
                            return next;
                          });
                        }}
                      >
                        {tr("取消选择", "Clear selection")}
                      </Button>
                    </div>
                  )}

                  <div className="divide-y rounded-xl border bg-card">
                    {filteredItems.length > 0 ? (
                      filteredItems.map((item) => {
                        const sources = item.sameName
                          ? item.origins.map(localOriginLabel)
                          : [
                              ...new Set(
                                item.locations
                                  .filter((r) => r.agentKind)
                                  .map((r) => r.sourceName),
                              ),
                            ];
                        const checked = !omitted.has(item.fingerprint);
                        return (
                          <div key={item.fingerprint} className="flex flex-col gap-1.5 px-3.5 py-3">
                            <div className="flex items-center gap-2.5">
                              {choosing && (
                                <Checkbox
                                  checked={checked}
                                  disabled={saving}
                                  onCheckedChange={(c) => {
                                    setOmitted((prev) => {
                                      const next = new Set(prev);
                                      if (c) next.delete(item.fingerprint);
                                      else next.add(item.fingerprint);
                                      return next;
                                    });
                                  }}
                                />
                              )}
                              <strong className="min-w-0 truncate font-medium text-sm" title={item.name}>
                                {item.name}
                              </strong>
                              {sources.length > 0 && (
                                <Badge
                                  className="max-w-44 justify-start overflow-hidden"
                                  size="sm"
                                  title={sources.join(" · ")}
                                  variant="secondary"
                                >
                                  <span className="truncate">{sources.join(" · ")}</span>
                                </Badge>
                              )}
                            </div>
                            {item.description && (
                              <p className="break-words text-muted-foreground text-xs">
                                {renderEmojiSafeText(item.description)}
                              </p>
                            )}
                            <Collapsible>
                              <CollapsibleTrigger className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground text-xs hover:text-foreground [&[data-panel-open]>svg]:rotate-180">
                                <span>{tr("来源", "Source")}</span>
                                <ChevronDownIcon className="size-3 transition-transform" />
                              </CollapsibleTrigger>
                              <CollapsiblePanel>
                                <div className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] text-muted-foreground">
                                  {item.locations.map((loc) => (
                                    <span key={loc.path} className="break-all">
                                      {loc.path}
                                    </span>
                                  ))}
                                </div>
                              </CollapsiblePanel>
                            </Collapsible>
                          </div>
                        );
                      })
                    ) : (
                      <p className="p-4 text-center text-muted-foreground text-xs">
                        {tr("没有匹配的 Skill。", "No matching skills.")}
                      </p>
                    )}
                  </div>

                  {!choosing && items.length > 1 && (
                    <div>
                      <Button size="xs" variant="ghost" onClick={() => setChoosing(true)}>
                        {tr("选择要添加的 Skill…", "Choose skills to add…")}
                      </Button>
                    </div>
                  )}
                </>
              )}

              {skipped > 0 && (
                <p className="text-muted-foreground text-xs">
                  {tr(
                    `已跳过 ${skipped} 个 Skill 库里已有的 Skill。`,
                    `Skipped ${skipped} skills already in your library.`,
                  )}
                </p>
              )}

              {problems.length > 0 && (
                <Collapsible>
                  <CollapsibleTrigger className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground text-xs [&[data-panel-open]>svg]:rotate-180">
                    <span>
                      {tr(`${problems.length} 项无法读取`, `${problems.length} items could not be read`)}
                    </span>
                    <ChevronDownIcon className="size-3.5 transition-transform" />
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <div className="mt-1.5 space-y-1 rounded-lg border bg-muted/40 p-2.5 font-mono text-[11px] text-muted-foreground">
                      {problems.map((row) => (
                        <p key={row.path} className="break-all">
                          {row.path} · {row.reason}
                        </p>
                      ))}
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              )}

              {items.length > 0 ? (
                <Collapsible>
                  <CollapsibleTrigger className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground text-xs [&[data-panel-open]>svg]:rotate-180">
                    <span>{tr("添加其他来源", "Add another source")}</span>
                    <ChevronDownIcon className="size-3.5 transition-transform" />
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {!withTools && (
                        <Button
                          disabled={saving}
                          size="xs"
                          variant="outline"
                          onClick={() => void runLoad(folders, [], true)}
                        >
                          {tr("查找电脑里已有的 Skill", "Find skills on this computer")}
                        </Button>
                      )}
                      <Button
                        disabled={saving}
                        size="xs"
                        variant="outline"
                        onClick={() => void handleChooseFolders()}
                      >
                        {tr("从文件夹添加", "Add from a folder")}
                      </Button>
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {!withTools && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void runLoad(folders, [], true)}
                    >
                      {tr("查找电脑里已有的 Skill", "Find skills on this computer")}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => void handleChooseFolders()}>
                    {tr("从文件夹添加", "Add from a folder")}
                  </Button>
                </div>
              )}

              {error && (
                <p className="text-destructive-foreground text-xs" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
        </DialogPanel>

        <DialogFooter className="sm:items-center sm:justify-between">
          {step === "preview" && items.length > 0 ? (
            <p className="min-w-0 flex-1 text-muted-foreground text-xs">
              {tr(
                `将保存一份副本到${destinationLabel}。原来的工具继续使用原文件。`,
                `Copies will be saved to ${destinationLabel}. Your tools keep using the original files.`,
              )}
            </p>
          ) : (
            <span />
          )}

          <div className="flex shrink-0 items-center gap-2">
            {step === "error" && (
              <>
                <Button
                  variant="outline"
                  onClick={() => setStep(folders.length || withTools ? "preview" : "start")}
                >
                  {tr("返回", "Back")}
                </Button>
                <Button variant="outline" onClick={() => void runLoad(folders, [], withTools)}>
                  {tr("重试", "Retry")}
                </Button>
              </>
            )}

            {step === "preview" && items.length === 0 ? (
              <Button variant="outline" onClick={closeDialog}>
                {tr("完成", "Done")}
              </Button>
            ) : (
              <Button disabled={saving} variant="outline" onClick={closeDialog}>
                {tr("取消", "Cancel")}
              </Button>
            )}

            {step === "preview" && items.length > 0 && (
              <Button
                disabled={saving || selectedItems.length === 0}
                loading={saving}
                onClick={() => void handleCommit()}
              >
                {selectedItems.length === items.length
                  ? tr(`全部添加（${selectedItems.length}）`, `Add all (${selectedItems.length})`)
                  : tr(`添加所选（${selectedItems.length}）`, `Add selected (${selectedItems.length})`)}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
