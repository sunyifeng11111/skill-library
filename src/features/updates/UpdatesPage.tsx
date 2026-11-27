import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ExternalLinkIcon,
  Link2Icon,
  RefreshCwIcon,
} from "lucide-react";
import * as React from "react";
import { packageKey, useApp } from "@/app/AppContext";
import { CategoryPicker, validateCategoryTarget } from "@/components/CategoryPicker";
import { renderEmojiSafeText } from "@/components/EmojiSafeText";
import { PageToolbar, useScrolled } from "@/components/PageToolbar";
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
import { Spinner } from "@/components/ui/spinner";
import { tr } from "@/shared/language";
import type { CategoryTarget, Skill } from "@/shared/library";
import type { PackageUpdateCheck, PackageUpdatePreview } from "@/shared/updates";
import { errorText } from "@/shared/ui";
import {
  formatCategories,
  formatInstalledSkills,
  formatReference,
  formatRepositoryUrl,
  formatShortRevisionRange,
  formatSourceDiffUrl,
  formatSourceOrigin,
  formatUpdateTime,
  packageTitle,
  sourceTooltip,
} from "./format";

function updateReason(reason: string | null): string {
  if (reason === "有本地改动") return tr("本地有修改", "Local changes");
  if (reason === "Skill 库中已有相同内容" || reason === "资料库中已有相同内容") {
    return tr("Skill 库里已有相同内容", "Already in your library");
  }
  return reason ?? "";
}

function formatCheckedTime(date: Date | null): string {
  if (!date) return "";
  if (Date.now() - date.getTime() < 60_000) return tr("刚刚检查", "Checked just now");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return tr(`上次检查 ${hh}:${mm}`, `Last checked ${hh}:${mm}`);
}

function isAvailable(
  entry: PackageUpdateCheck,
): entry is PackageUpdateCheck & { revision: string } {
  return (
    entry.status === "available" &&
    entry.revision !== null &&
    (!entry.outdatedMemberIds || entry.outdatedMemberIds.length > 0)
  );
}

interface OutdatedSkillItem {
  entry: PackageUpdateCheck & { revision: string };
  skill?: Skill;
  label: string;
  description: string;
  category: string | null;
  isFirstInPackage: boolean;
}

export function UpdatesPage(): React.ReactElement {
  const { desktop, snapshot, updates, openAttachSource } = useApp();
  const { scrolled, scrollRef, onScroll, scrollStyle } = useScrolled();
  const [backupConsent, setBackupConsent] = React.useState<Map<string, boolean>>(() => new Map());
  const [reviewState, setReviewState] = React.useState<{
    entry: PackageUpdateCheck;
    revision: string;
    title: string;
    focusSkillId: string | null;
    loading: boolean;
    preview: PackageUpdatePreview | null;
    backups: Set<string>;
    additions: Set<string>;
    target: CategoryTarget;
    error: string | null;
  } | null>(null);

  const availableChecks = updates.checks.filter(isAvailable);
  const failedChecks = updates.checks.filter((entry) => entry.status === "failed");
  const localMembers = snapshot?.skills.filter((skill) => !skill.source) ?? [];
  const canAttach = Boolean(desktop.online && desktop.updates);

  const outdatedSkillsFor = (
    entry: PackageUpdateCheck & { revision: string },
  ): OutdatedSkillItem[] => {
    const members = snapshot?.skills.filter((skill) => entry.memberIds.includes(skill.id)) ?? [];
    const behind = entry.outdatedMemberIds
      ? members.filter((skill) => entry.outdatedMemberIds!.includes(skill.id))
      : members.filter((skill) => skill.source?.revision !== entry.revision);
    if (entry.outdatedMemberIds && behind.length === 0) {
      return [];
    }
    const targets = behind.length ? behind : members;
    if (!targets.length) {
      return [
        {
          entry,
          label: packageTitle(entry.package.repository),
          description: "",
          category: null,
          isFirstInPackage: true,
        },
      ];
    }
    const categories = new Map((snapshot?.categories ?? []).map((c) => [c.id, c.name]));
    return targets.map((skill, index) => ({
      entry,
      skill,
      label: skill.name,
      description: skill.description,
      category: skill.categoryId ? categories.get(skill.categoryId) ?? null : null,
      isFirstInPackage: index === 0,
    }));
  };

  async function openReview(
    entry: PackageUpdateCheck,
    revision: string,
    title: string,
    focusSkillId: string | null = null,
  ) {
    if (!desktop.updates || updates.busy) return;
    const key = packageKey(entry.package);
    updates.setPreviewError(key, null);
    const first =
      (focusSkillId ? snapshot?.skills.find((s) => s.id === focusSkillId) : undefined) ??
      snapshot?.skills.find((s) => entry.memberIds.includes(s.id));
    const defaultTarget: CategoryTarget = first?.categoryId
      ? { kind: "existing", id: first.categoryId }
      : { kind: "uncategorized" };

    setReviewState({
      entry,
      revision,
      title,
      focusSkillId,
      loading: true,
      preview: null,
      backups: new Set(),
      additions: new Set(),
      target: defaultTarget,
      error: null,
    });

    try {
      const preview = await desktop.updates.preview(entry.package, revision);
      setReviewState((prev) => (prev ? { ...prev, loading: false, preview } : null));
    } catch (error) {
      setReviewState(null);
      updates.setPreviewError(key, errorText(error));
    }
  }

  async function openExternalSource(url: string) {
    try {
      if (desktop.updates?.openSourceUrl) {
        await desktop.updates.openSourceUrl(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      setReviewState((prev) => (prev ? { ...prev, error: errorText(error) } : null));
    }
  }

  function submitReview() {
    if (!reviewState || !reviewState.preview) return;
    let target: CategoryTarget | null = null;
    if (reviewState.additions.size > 0) {
      try {
        target = validateCategoryTarget(reviewState.target);
      } catch (err) {
        setReviewState((prev) => (prev ? { ...prev, error: errorText(err) } : null));
        return;
      }
    }
    const { entry, revision, backups, additions, focusSkillId, preview } = reviewState;
    const targetMemberIds =
      focusSkillId && preview.outdated.some((member) => member.id === focusSkillId)
        ? [focusSkillId]
        : undefined;
    setReviewState(null);
    void updates.applyOne(entry, {
      revision,
      backupMembers: [...backups],
      additions: [...additions],
      target,
      ...(targetMemberIds ? { memberIds: targetMemberIds } : {}),
    });
  }

  const renderDisclosures = (entries: PackageUpdateCheck[], unlinked: Skill[]) => {
    const showSources = entries.length > 0;
    const showUnlinked = Boolean(canAttach && unlinked.length > 0);
    if (!showSources && !showUnlinked) return null;

    return (
      <div className="flex flex-col gap-3">
        {showSources && (
          <Frame>
            <Collapsible>
              <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left text-sm [&[data-panel-open]>svg]:rotate-180">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {tr("已追踪的在线来源", "Tracked online sources")}
                  </span>
                  <Badge size="sm" variant="secondary">
                    {entries.length}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    {tr("查看仓库或补装同源 Skill", "Inspect repos or browse other skills")}
                  </span>
                </div>
                <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform" />
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <FramePanel className="divide-y p-0">
                  {entries.map((entry) => {
                    const key = packageKey(entry.package);
                    const job = updates.jobs.get(key);
                    const members =
                      snapshot?.skills.filter((s) => entry.memberIds.includes(s.id)) ?? [];
                    const detailParts = [
                      formatSourceOrigin(entry.package.repository),
                      formatReference(entry.package.reference),
                      formatCategories(members, snapshot?.categories ?? []),
                      formatInstalledSkills(members, entry.memberIds.length).text,
                    ].filter((part): part is string => Boolean(part));

                    const stateText =
                      entry.status === "failed"
                        ? tr("检查失败", "Check failed")
                        : job?.error
                          ? tr("更新失败", "Update failed")
                          : entry.status === "available"
                            ? entry.outdatedMemberIds?.length
                              ? tr(
                                  `${entry.outdatedMemberIds.length} 个可更新`,
                                  `${entry.outdatedMemberIds.length} to update`,
                                )
                              : tr("可更新", "Update available")
                            : tr("已是最新", "Up to date");
                    const badgeVariant =
                      entry.status === "failed" || job?.error
                        ? "error"
                        : entry.status === "available"
                          ? "warning"
                          : "secondary";

                    return (
                      <div
                        key={key}
                        className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                      >
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <strong
                            className="truncate font-medium text-sm"
                            title={packageTitle(entry.package.repository)}
                          >
                            {packageTitle(entry.package.repository)}
                          </strong>
                          <span
                            className="truncate text-muted-foreground text-xs"
                            title={sourceTooltip(entry.package.repository, entry.package.reference)}
                          >
                            {detailParts.join(" · ")}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge size="sm" variant={badgeVariant}>
                            {stateText}
                          </Badge>
                          {entry.status === "failed" ? (
                            <Button
                              disabled={updates.busy}
                              size="xs"
                              variant="outline"
                              onClick={() => void updates.check(entry.package)}
                            >
                              {tr("重试检查", "Retry check")}
                            </Button>
                          ) : entry.revision ? (
                            <Button
                              disabled={updates.busy}
                              size="xs"
                              variant="ghost"
                              onClick={() =>
                                void openReview(
                                  entry,
                                  entry.revision!,
                                  tr("查看同源 Skill", "Browse other skills"),
                                )
                              }
                            >
                              {tr("查看同源 Skill", "Browse other skills")}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </FramePanel>
              </CollapsiblePanel>
            </Collapsible>
          </Frame>
        )}

        {showUnlinked && (
          <Frame>
            <Collapsible defaultOpen={!showSources}>
              <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left text-sm [&[data-panel-open]>svg]:rotate-180">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {tr("未关联更新地址的 Skill", "Skills without an update URL")}
                  </span>
                  <Badge size="sm" variant="secondary">
                    {unlinked.length}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    {showSources
                      ? tr(
                          "手动导入，关联后可自动检查更新",
                          "Imported locally · Link a URL to check for updates",
                        )
                      : tr("关联后立即开始检查更新", "Link a URL to start checking for updates")}
                  </span>
                </div>
                <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform" />
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <FramePanel className="divide-y p-0">
                  {unlinked.map((skill) => (
                    <div
                      key={skill.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <strong className="truncate font-medium text-sm" title={skill.name}>
                          {renderEmojiSafeText(skill.name)}
                        </strong>
                        {skill.description && (
                          <span className="truncate text-muted-foreground text-xs">
                            {renderEmojiSafeText(skill.description)}
                          </span>
                        )}
                      </div>
                      <Button
                        disabled={updates.busy}
                        size="xs"
                        variant="outline"
                        onClick={() => openAttachSource(skill)}
                      >
                        <Link2Icon />
                        {tr("关联更新地址", "Link update URL")}
                      </Button>
                    </div>
                  ))}
                </FramePanel>
              </CollapsiblePanel>
            </Collapsible>
          </Frame>
        )}
      </div>
    );
  };

  const renderBody = () => {
    // 1. Initial checking / error
    if (!updates.checked && !updates.checks.length) {
      if (updates.checkError && !updates.activity) {
        return (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AlertTriangleIcon className="text-destructive" />
              </EmptyMedia>
              <EmptyTitle>{tr("暂时无法检查更新", "Couldn't check for updates")}</EmptyTitle>
              <EmptyDescription className="text-destructive-foreground" role="alert">
                {updates.checkError}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                disabled={updates.busy}
                variant="outline"
                onClick={() => void updates.check()}
              >
                <RefreshCwIcon />
                {tr("重试检查", "Try again")}
              </Button>
            </EmptyContent>
          </Empty>
        );
      }

      const isChecking = updates.activity === "check";
      return (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {isChecking ? <Spinner /> : <RefreshCwIcon />}
            </EmptyMedia>
            <EmptyTitle>
              {isChecking ? tr("正在检查更新…", "Checking for updates…") : tr("更新中心", "Updates")}
            </EmptyTitle>
            <EmptyDescription role="status">
              {isChecking
                ? tr("正在核对在线来源的最新版本", "Checking online sources for new versions")
                : tr("点击下方按钮检查已安装 Skill 的更新", "Check for updates to your installed skills")}
            </EmptyDescription>
          </EmptyHeader>
          {!isChecking && (
            <EmptyContent>
              <Button disabled={updates.busy} onClick={() => void updates.check()}>
                <RefreshCwIcon />
                {tr("检查更新", "Check for updates")}
              </Button>
            </EmptyContent>
          )}
        </Empty>
      );
    }

    // 2. Zero online sources
    if (updates.checked && !updates.checks.length && !updates.checkError) {
      const hasAttachable = canAttach && localMembers.length > 0;
      const isChecking = updates.activity === "check";
      return (
        <div className="flex flex-col gap-5">
          <Empty className={hasAttachable ? "py-10" : undefined}>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {isChecking ? <Spinner /> : <RefreshCwIcon />}
              </EmptyMedia>
              <EmptyTitle>
                {hasAttachable
                  ? tr("暂无已追踪更新的 Skill", "No online skills tracked")
                  : tr("暂无可检查更新的 Skill", "No online skills to check")}
              </EmptyTitle>
              <EmptyDescription role="status">
                {isChecking
                  ? tr("正在检查更新…", "Checking for updates…")
                  : hasAttachable
                    ? tr(
                        "在线安装的 Skill 会自动检查更新；下方手动导入的 Skill 关联地址后也可以一起检查。",
                        "Skills installed online check automatically. Link update URLs for your manually imported skills below.",
                      )
                    : tr(
                        "在线安装的 Skill 会自动出现在这里检查更新。",
                        "Skills installed online will appear here for update checks.",
                      )}
              </EmptyDescription>
            </EmptyHeader>
            {!hasAttachable && (
              <EmptyContent>
                <Button
                  disabled={updates.busy}
                  variant="outline"
                  onClick={() => void updates.check()}
                >
                  <RefreshCwIcon />
                  {tr("检查更新", "Check for updates")}
                </Button>
              </EmptyContent>
            )}
          </Empty>
          {renderDisclosures([], localMembers)}
        </div>
      );
    }

    // 3. All up to date (Zen state)
    if (!availableChecks.length && !failedChecks.length) {
      const totalSkills = updates.checks.reduce((sum, entry) => sum + entry.memberIds.length, 0);
      const isChecking = updates.activity === "check";
      const backups = [...updates.jobs.values()]
        .map((job) => job.outcome?.backup)
        .filter((backup): backup is string => Boolean(backup));

      return (
        <div className="flex flex-col gap-5">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {isChecking ? (
                  <Spinner />
                ) : (
                  <CheckCircle2Icon className="text-success" />
                )}
              </EmptyMedia>
              <EmptyTitle>
                {tr(
                  `你的 ${totalSkills} 个在线 Skill 都是最新版本`,
                  totalSkills === 1
                    ? "Your online skill is up to date"
                    : `All ${totalSkills} online skills are up to date`,
                )}
              </EmptyTitle>
              <EmptyDescription
                className={updates.checkError && !isChecking ? "text-destructive-foreground" : undefined}
                role={updates.checkError && !isChecking ? "alert" : "status"}
              >
                {isChecking
                  ? tr("正在检查更新…", "Checking for updates…")
                  : updates.checkError
                    ? updates.checkError
                    : [formatCheckedTime(updates.lastCheckedAt), tr("无需任何操作", "Nothing to do")]
                        .filter(Boolean)
                        .join(" · ")}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                disabled={updates.busy}
                variant="outline"
                onClick={() => void updates.check()}
              >
                <RefreshCwIcon />
                {tr("检查更新", "Check for updates")}
              </Button>
              {backups.map((b) => (
                <p key={b} className="break-all font-mono text-muted-foreground text-xs">
                  {tr(`已保存原文件备份 · ${b}`, `Backup saved · ${b}`)}
                </p>
              ))}
            </EmptyContent>
          </Empty>
          {renderDisclosures(updates.checks, localMembers)}
        </div>
      );
    }

    // 4. Actionable feed
    const outdatedRows = availableChecks.flatMap(outdatedSkillsFor);
    const headingText =
      outdatedRows.length > 0
        ? tr(
            `有 ${outdatedRows.length} 个 Skill 可更新`,
            outdatedRows.length === 1
              ? "1 skill ready to update"
              : `${outdatedRows.length} skills ready to update`,
          )
        : tr(
            `${failedChecks.length} 个来源检查失败`,
            failedChecks.length === 1
              ? "1 source failed to check"
              : `${failedChecks.length} sources failed to check`,
          );

    const summaryText = updates.activity
      ? {
          check: tr("正在检查更新…", "Checking for updates…"),
          batch: tr("正在更新已安装的 Skill…", "Updating installed skills…"),
          package: tr("正在更新所选 Skill…", "Updating selected skill…"),
        }[updates.activity]
      : updates.checkError
        ? updates.checkError
        : outdatedRows.length > 0 && failedChecks.length > 0
          ? tr(
              `另有 ${failedChecks.length} 个来源检查失败，可在下方单独重试`,
              `${failedChecks.length} ${failedChecks.length === 1 ? "source" : "sources"} failed to check below`,
            )
          : outdatedRows.length > 0
            ? tr(
                "按 Skill 直接更新，原有分类和工具关联会自动保留",
                "Update skills directly while keeping your categories and tool links",
              )
            : tr(
                "请检查网络后重试，当前已安装版本仍可正常使用",
                "Check your connection and retry. Installed skills still work",
              );

    return (
      <div className="flex flex-col gap-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-semibold text-2xl tracking-tight">{headingText}</h1>
            <p
              className={
                updates.checkError && !updates.activity
                  ? "mt-1 text-destructive-foreground text-xs"
                  : "mt-1 text-muted-foreground text-xs"
              }
              role={updates.checkError && !updates.activity ? "alert" : "status"}
            >
              {summaryText}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              disabled={updates.busy}
              size="sm"
              variant="outline"
              onClick={() => void updates.check()}
            >
              <RefreshCwIcon />
              {tr("检查更新", "Check for updates")}
            </Button>
            {availableChecks.length > 0 && (
              <Button
                disabled={updates.busy}
                loading={updates.activity === "batch"}
                size="sm"
                onClick={() => void updates.applyAll()}
              >
                {tr("全部更新", "Update all")}
              </Button>
            )}
          </div>
        </header>

        {outdatedRows.length > 0 && (
          <Frame>
            <FramePanel className="divide-y p-0">
              {outdatedRows.map((item, index) => {
                const { entry } = item;
                const key = packageKey(entry.package);
                const job = updates.jobs.get(key);
                const originParts = [
                  item.skill
                    ? tr(`来自 ${packageTitle(entry.package.repository)}`, `From ${packageTitle(entry.package.repository)}`)
                    : tr(`来自 ${formatSourceOrigin(entry.package.repository)}`, `From ${formatSourceOrigin(entry.package.repository)}`),
                  formatReference(entry.package.reference),
                ].filter((part): part is string => Boolean(part));

                const skippedMember = item.skill
                  ? job?.outcome?.skipped.find((s) => s.id === item.skill!.id)
                  : job?.outcome?.skipped[0];
                const consent = skippedMember ? backupConsent.get(skippedMember.id) ?? true : true;
                const jobMatchesRow =
                  !job?.selection.memberIds?.length ||
                  (item.skill ? job.selection.memberIds.includes(item.skill.id) : item.isFirstInPackage);
                const rowError = jobMatchesRow ? job?.error : undefined;
                const errText =
                  rowError ?? (item.isFirstInPackage ? updates.previewErrors.get(key) : undefined);

                return (
                  <div
                    key={`${key}-${item.skill?.id ?? index}`}
                    className="flex flex-wrap items-start justify-between gap-4 px-4 py-3.5"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <strong className="max-w-full truncate font-medium text-sm" title={item.label}>
                          {item.label}
                        </strong>
                        {item.category && (
                          <Badge
                            className="max-w-40 justify-start overflow-hidden"
                            size="sm"
                            title={item.category}
                            variant="secondary"
                          >
                            <span className="truncate">{item.category}</span>
                          </Badge>
                        )}
                        <span
                          className="text-muted-foreground text-xs"
                          title={sourceTooltip(entry.package.repository, entry.package.reference)}
                        >
                          {originParts.join(" · ")}
                        </span>
                      </div>

                      {item.description && (
                        <p className="break-words text-muted-foreground text-xs">
                          {renderEmojiSafeText(item.description)}
                        </p>
                      )}

                      {skippedMember && (
                        <div className="mt-1 flex items-center gap-2 text-xs">
                          <Checkbox
                            checked={consent}
                            disabled={updates.busy}
                            id={`update-consent-${skippedMember.id}`}
                            onCheckedChange={(checked) => {
                              setBackupConsent((prev) =>
                                new Map(prev).set(skippedMember.id, Boolean(checked)),
                              );
                            }}
                          />
                          <label className="cursor-pointer" htmlFor={`update-consent-${skippedMember.id}`}>
                            {skippedMember.skipReason === "有本地改动"
                              ? tr(
                                  "你在本地修改过内容 · 更新前自动备份我的版本",
                                  "Modified locally · Back up my version before updating",
                                )
                              : updateReason(skippedMember.skipReason)}
                          </label>
                        </div>
                      )}

                      {errText && (
                        <p className="text-destructive-foreground text-xs" role="alert">
                          {rowError
                            ? tr(
                                `${errText}。当前已安装的版本仍可正常使用。`,
                                `${errText} The installed version is still available.`,
                              )
                            : errText}
                        </p>
                      )}

                      {(jobMatchesRow || item.isFirstInPackage) && job?.outcome?.backup && (
                        <p className="break-all font-mono text-muted-foreground text-xs">
                          {tr(
                            `已保存原文件备份 · ${job.outcome.backup}`,
                            `Backup saved · ${job.outcome.backup}`,
                          )}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <Badge size="sm" variant={rowError ? "error" : "warning"}>
                        {rowError
                          ? tr("更新失败", "Update failed")
                          : tr("可更新", "Update available")}
                      </Badge>
                      {rowError && job ? (
                        <Button
                          disabled={updates.busy}
                          size="xs"
                          variant="outline"
                          onClick={() => void updates.applyOne(entry, job.selection)}
                        >
                          {tr("重试更新", "Retry update")}
                        </Button>
                      ) : skippedMember ? (
                        <Button
                          disabled={updates.busy || !consent}
                          size="xs"
                          onClick={() =>
                            void updates.applyOne(entry, {
                              revision: entry.revision,
                              backupMembers: [skippedMember.id],
                              additions: [],
                              target: null,
                              memberIds: [skippedMember.id],
                            })
                          }
                        >
                          {tr("备份并更新", "Back up and update")}
                        </Button>
                      ) : (
                        <>
                          <Button
                            disabled={updates.busy}
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              void openReview(
                                entry,
                                entry.revision,
                                tr("查看更新", "Review update"),
                                item.skill?.id ?? null,
                              )
                            }
                          >
                            {tr("查看更新", "Review update")}
                          </Button>
                          <Button
                            disabled={updates.busy}
                            size="xs"
                            variant="outline"
                            onClick={() =>
                              void updates.applyOne(entry, {
                                revision: entry.revision,
                                backupMembers: [],
                                additions: [],
                                target: null,
                                ...(item.skill ? { memberIds: [item.skill.id] } : {}),
                              })
                            }
                          >
                            {tr("更新", "Update")}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </FramePanel>
          </Frame>
        )}

        {failedChecks.length > 0 && (
          <Frame>
            <div className="px-4 py-2.5 font-medium text-muted-foreground text-xs">
              {tr(`检查失败 ${failedChecks.length}`, `Failed checks ${failedChecks.length}`)}
            </div>
            <FramePanel className="divide-y p-0">
              {failedChecks.map((entry) => {
                const key = packageKey(entry.package);
                const members =
                  snapshot?.skills.filter((s) => entry.memberIds.includes(s.id)) ?? [];
                const metaParts = [
                  formatSourceOrigin(entry.package.repository),
                  formatReference(entry.package.reference),
                  formatCategories(members, snapshot?.categories ?? []),
                ].filter((part): part is string => Boolean(part));
                const installed = formatInstalledSkills(members, entry.memberIds.length);

                return (
                  <div
                    key={key}
                    className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <strong
                          className="max-w-full truncate font-medium text-sm"
                          title={packageTitle(entry.package.repository)}
                        >
                          {packageTitle(entry.package.repository)}
                        </strong>
                        <span
                          className="text-muted-foreground text-xs"
                          title={sourceTooltip(entry.package.repository, entry.package.reference)}
                        >
                          {metaParts.join(" · ")}
                        </span>
                      </div>
                      <span className="text-muted-foreground text-xs" title={installed.title}>
                        {installed.text}
                      </span>
                      {entry.error && (
                        <p className="break-words text-destructive-foreground text-xs" role="alert">
                          {entry.error}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge size="sm" variant="error">
                        {tr("检查失败", "Check failed")}
                      </Badge>
                      <Button
                        disabled={updates.busy}
                        size="xs"
                        variant="outline"
                        onClick={() => void updates.check(entry.package)}
                      >
                        {tr("重试检查", "Retry check")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </FramePanel>
          </Frame>
        )}

        {renderDisclosures(updates.checks, localMembers)}
      </div>
    );
  };

  const lockReviewOutsideDismiss = Boolean(reviewState?.loading || updates.applying);

  return (
    <section className="relative flex h-full flex-col overflow-hidden">
      <PageToolbar breadcrumb={tr("Skill 库 ／ 更新中心", "Library / Updates")} scrolled={scrolled} />

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6 pt-18 pb-6 scroll-pt-16 md:px-8"
        style={scrollStyle}
        onScroll={onScroll}
      >
        <div className="mx-auto max-w-4xl">{renderBody()}</div>
      </div>

      {/* Review update dialog */}
      <Dialog
        disablePointerDismissal={lockReviewOutsideDismiss}
        open={Boolean(reviewState)}
        onOpenChange={(next, eventDetails) => {
          if (next) return;
          if (updates.applying) {
            eventDetails.cancel();
            return;
          }
          if (reviewState?.loading && eventDetails.reason === "outside-press") {
            eventDetails.cancel();
            return;
          }
          setReviewState(null);
        }}
      >
        <DialogPopup className="max-w-lg" showCloseButton={!updates.applying}>
          {reviewState && (
            <>
              <DialogHeader>
                <DialogTitle>{reviewState.title}</DialogTitle>
              </DialogHeader>
              <DialogPanel>
                {reviewState.loading ? (
                  <div className="flex items-center gap-2.5 py-4 text-muted-foreground text-sm">
                    <Spinner />
                    <span>{tr("正在读取来源内容…", "Reading skills from source…")}</span>
                  </div>
                ) : reviewState.preview ? (
                  <div className="flex flex-col gap-4 text-sm">
                    {(() => {
                      const preview = reviewState.preview;
                      const focusedSkill = reviewState.focusSkillId
                        ? snapshot?.skills.find((skill) => skill.id === reviewState.focusSkillId)
                        : undefined;
                      const effectiveFromRevision =
                        focusedSkill?.source?.revision &&
                        focusedSkill.source.revision !== reviewState.revision
                          ? focusedSkill.source.revision
                          : (preview.fromRevision ?? null);
                      const updatedTimeLabel = formatUpdateTime(
                        preview.updatedAt ?? reviewState.entry.updatedAt,
                      );
                      const revRangeLabel = formatShortRevisionRange(
                        effectiveFromRevision,
                        reviewState.revision,
                      );
                      const repoUrl =
                        preview.repositoryUrl ??
                        formatRepositoryUrl(reviewState.entry.package.repository);
                      const diffUrl =
                        preview.outdated.length > 0
                          ? effectiveFromRevision && effectiveFromRevision !== preview.fromRevision
                            ? formatSourceDiffUrl(
                                reviewState.entry.package.repository,
                                effectiveFromRevision,
                                reviewState.revision,
                              ) ??
                              preview.compareUrl ??
                              repoUrl
                            : preview.compareUrl ??
                              formatSourceDiffUrl(
                                reviewState.entry.package.repository,
                                effectiveFromRevision,
                                reviewState.revision,
                              )
                          : null;
                      const targetUrl = diffUrl ?? repoUrl;
                      const sourceSummary = [
                        formatSourceOrigin(reviewState.entry.package.repository),
                        formatReference(reviewState.entry.package.reference),
                      ]
                        .filter(Boolean)
                        .join(" · ");

                      const displayedOutdated =
                        reviewState.focusSkillId &&
                        preview.outdated.some((member) => member.id === reviewState.focusSkillId)
                          ? preview.outdated.filter(
                              (member) => member.id === reviewState.focusSkillId,
                            )
                          : preview.outdated;
                      const otherOutdatedCount =
                        preview.outdated.length - displayedOutdated.length;
                      const ordinary = displayedOutdated.filter((m) => !m.skipReason);
                      const guarded = displayedOutdated.filter((m) => m.skipReason);
                      return (
                        <>
                          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 px-3.5 py-3">
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <strong className="truncate font-medium text-foreground text-sm">
                                {sourceSummary}
                              </strong>
                              {(updatedTimeLabel || revRangeLabel) && (
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground text-xs">
                                  {updatedTimeLabel && <span>{updatedTimeLabel}</span>}
                                  {revRangeLabel && <span className="font-mono">{revRangeLabel}</span>}
                                </div>
                              )}
                            </div>
                            {targetUrl && (
                              <Button
                                className="shrink-0"
                                size="xs"
                                title={targetUrl}
                                variant="outline"
                                onClick={() => void openExternalSource(targetUrl)}
                              >
                                <ExternalLinkIcon />
                                {diffUrl && diffUrl !== repoUrl
                                  ? tr("查看仓库对比", "View diff")
                                  : tr("打开仓库地址", "Open repository")}
                              </Button>
                            )}
                          </div>

                          {ordinary.length > 0 && (
                            <div className="flex flex-col gap-2">
                              <p>
                                {tr(
                                  `将更新以下 Skill：${ordinary.map((m) => m.name).join("、")}`,
                                  `Skills to update: ${ordinary.map((m) => m.name).join(", ")}`,
                                )}
                              </p>
                              {ordinary.some((m) => m.changedFiles?.length) && (
                                <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-muted/30 p-3">
                                  {ordinary.map((member) => {
                                    const files = member.changedFiles ?? [];
                                    if (!files.length) return null;
                                    const shown = files.slice(0, 5);
                                    const extra = files.length - shown.length;
                                    return (
                                      <div key={member.id} className="flex flex-col gap-0.5">
                                        {ordinary.length > 1 && (
                                          <span className="font-medium text-xs">{member.name}</span>
                                        )}
                                        <span className="text-muted-foreground text-xs">
                                          {tr("变更文件：", "Changed files: ")}
                                          <span className="font-mono">{shown.join("、")}</span>
                                          {extra > 0 &&
                                            tr(` 等 ${files.length} 个文件`, ` (+${extra} more)`)}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          )}

                          {guarded.map((member) => {
                            const files = member.changedFiles ?? [];
                            return (
                              <div
                                key={member.id}
                                className="flex items-start gap-2.5 rounded-lg bg-muted/50 p-3"
                              >
                                <Checkbox
                                  checked={reviewState.backups.has(member.id)}
                                  className="mt-0.5"
                                  id={`review-backup-${member.id}`}
                                  onCheckedChange={(checked) => {
                                    setReviewState((prev) => {
                                      if (!prev) return null;
                                      const next = new Set(prev.backups);
                                      if (checked) next.add(member.id);
                                      else next.delete(member.id);
                                      return { ...prev, backups: next };
                                    });
                                  }}
                                />
                                <label
                                  className="flex cursor-pointer flex-col gap-0.5"
                                  htmlFor={`review-backup-${member.id}`}
                                >
                                  <strong className="font-medium text-sm">
                                    {tr(
                                      `保留本地副本并更新 ${member.name}`,
                                      `Keep a backup and update ${member.name}`,
                                    )}
                                  </strong>
                                  <span className="text-muted-foreground text-xs">
                                    {updateReason(member.skipReason)}
                                  </span>
                                  {files.length > 0 && (
                                    <span className="text-muted-foreground text-xs">
                                      {tr("变更文件：", "Changed files: ")}
                                      <span className="font-mono">
                                        {files.slice(0, 5).join("、")}
                                      </span>
                                      {files.length > 5 &&
                                        tr(
                                          ` 等 ${files.length} 个文件`,
                                          ` (+${files.length - 5} more)`,
                                        )}
                                    </span>
                                  )}
                                </label>
                              </div>
                            );
                          })}

                          {otherOutdatedCount > 0 && (
                            <p className="text-muted-foreground text-xs">
                              {tr(
                                `同一来源还有另外 ${otherOutdatedCount} 个 Skill 可更新，本次仅更新当前项。`,
                                `${otherOutdatedCount} other ${otherOutdatedCount === 1 ? "skill" : "skills"} in this source also have updates; only this skill will be updated now.`,
                              )}
                            </p>
                          )}

                          {reviewState.preview.additions.length > 0 && (
                            <div className="flex flex-col gap-2">
                              <h3 className="font-semibold text-sm">
                                {reviewState.preview.additionsConfirmed
                                  ? tr("来源中新增的 Skill", "New skills in this source")
                                  : tr("同一来源里的其他 Skill", "Other skills in this source")}
                              </h3>
                              {!reviewState.preview.additionsConfirmed &&
                                reviewState.entry.status === "available" && (
                                  <p className="text-muted-foreground text-xs">
                                    {tr(
                                      "以下列出该来源中你尚未安装的 Skill，按需勾选即可。",
                                      "Select any additional skills from this source that you want to install.",
                                    )}
                                  </p>
                                )}
                              <div className="flex flex-col gap-1.5">
                                {reviewState.preview.additions.map((member) => (
                                  <div
                                    key={member.memberPath}
                                    className="flex items-start gap-2.5 rounded-lg bg-muted/40 p-2.5 transition-colors hover:bg-muted/70"
                                  >
                                    <Checkbox
                                      checked={reviewState.additions.has(member.memberPath)}
                                      className="mt-0.5"
                                      disabled={Boolean(member.unavailable)}
                                      id={`review-add-${member.memberPath}`}
                                      onCheckedChange={(checked) => {
                                        setReviewState((prev) => {
                                          if (!prev) return null;
                                          const next = new Set(prev.additions);
                                          if (checked) next.add(member.memberPath);
                                          else next.delete(member.memberPath);
                                          return { ...prev, additions: next };
                                        });
                                      }}
                                    />
                                    <label
                                      className="flex min-w-0 flex-1 cursor-pointer flex-col"
                                      htmlFor={`review-add-${member.memberPath}`}
                                    >
                                      <strong className="truncate font-medium text-sm" title={member.name}>
                                        {renderEmojiSafeText(member.name)}
                                      </strong>
                                      <span className="truncate text-muted-foreground text-xs">
                                        {renderEmojiSafeText(
                                          [
                                            member.description || member.memberPath,
                                            updateReason(member.unavailable),
                                          ]
                                            .filter(Boolean)
                                            .join(" · "),
                                        )}
                                      </span>
                                    </label>
                                  </div>
                                ))}
                              </div>

                              {reviewState.additions.size > 0 && (
                                <CategoryPicker
                                  categories={snapshot?.categories ?? []}
                                  value={reviewState.target}
                                  onChange={(target) =>
                                    setReviewState((prev) =>
                                      prev ? { ...prev, target, error: null } : null,
                                    )
                                  }
                                />
                              )}
                            </div>
                          )}

                          {!reviewState.preview.outdated.length &&
                            !reviewState.preview.additions.length && (
                              <p className="text-muted-foreground">
                                {tr(
                                  "这个来源里的 Skill 你都已经安装完了。",
                                  "You have already installed all skills from this source.",
                                )}
                              </p>
                            )}
                        </>
                      );
                    })()}
                    {reviewState.error && (
                      <p className="text-destructive-foreground text-xs" role="alert">
                        {reviewState.error}
                      </p>
                    )}
                  </div>
                ) : null}
              </DialogPanel>
              <DialogFooter>
                <Button variant="outline" onClick={() => setReviewState(null)}>
                  {tr("取消", "Cancel")}
                </Button>
                {reviewState.preview &&
                  (reviewState.preview.outdated.length > 0 ||
                    reviewState.preview.additions.length > 0) && (() => {
                    const displayedOutdated =
                      reviewState.focusSkillId &&
                      reviewState.preview.outdated.some((m) => m.id === reviewState.focusSkillId)
                        ? reviewState.preview.outdated.filter(
                            (m) => m.id === reviewState.focusSkillId,
                          )
                        : reviewState.preview.outdated;
                    const ordinary = displayedOutdated.filter((m) => !m.skipReason);
                    const disabled =
                      !ordinary.length &&
                      !reviewState.backups.size &&
                      !reviewState.additions.size;
                    const label = reviewState.backups.size
                      ? tr("备份并更新", "Back up and update")
                      : ordinary.length
                        ? tr("立即更新", "Update")
                        : reviewState.additions.size || !reviewState.preview.outdated.length
                          ? tr("安装所选 Skill", "Install selected skills")
                          : tr("备份并更新", "Back up and update");
                    return (
                      <Button disabled={disabled} onClick={submitReview}>
                        {label}
                      </Button>
                    );
                  })()}
              </DialogFooter>
            </>
          )}
        </DialogPopup>
      </Dialog>
    </section>
  );
}
