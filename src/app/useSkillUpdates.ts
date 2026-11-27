import * as React from "react";
import type { DesktopGateway, LibrarySnapshot } from "@/shared/library";
import type {
  PackageUpdateCheck,
  PackageUpdateOutcome,
  PackageUpdateSelection,
  UpdatePackage,
} from "@/shared/updates";
import { errorText } from "@/shared/ui";

export interface UpdateJob {
  selection: PackageUpdateSelection;
  error?: string;
  outcome?: PackageUpdateOutcome;
}

export interface UpdatesState {
  checks: PackageUpdateCheck[];
  jobs: Map<string, UpdateJob>;
  previewErrors: Map<string, string>;
  busy: boolean;
  activity: "check" | "batch" | "package" | undefined;
  checkError: string;
  checked: boolean;
  lastCheckedAt: Date | null;
  attentionCount: number;
  applying: boolean;
  check: (pkg?: UpdatePackage) => Promise<void>;
  applyAll: () => Promise<void>;
  applyOne: (entry: PackageUpdateCheck, selection: PackageUpdateSelection) => Promise<void>;
  setPreviewError: (key: string, message: string | null) => void;
  resetAfterReplacement: () => void;
  syncInstalled: (library: LibrarySnapshot, addedIds: string[], revision: string) => void;
}

export const packageKey = ({ repository, reference }: UpdatePackage) =>
  JSON.stringify([repository, reference]);

function buildTouchedPackageChecks(
  library: LibrarySnapshot,
  memberIds: Iterable<string>,
  revision: string,
  previousChecks?: Map<string, PackageUpdateCheck>,
  updatedIds?: Iterable<string>,
): Map<string, PackageUpdateCheck> {
  const ids = new Set(memberIds);
  const updatedSet = new Set(updatedIds);
  const sources = new Map<string, UpdatePackage>();
  for (const skill of library.skills) {
    if (!ids.has(skill.id) || !skill.source) continue;
    const pkg: UpdatePackage = {
      repository: skill.source.repository,
      reference: skill.source.reference ?? null,
    };
    sources.set(packageKey(pkg), pkg);
  }
  const touched = new Map<string, PackageUpdateCheck>();
  for (const [originKey, pkg] of sources) {
    const members = library.skills.filter(
      (skill) =>
        skill.source &&
        skill.source.repository === pkg.repository &&
        (skill.source.reference ?? null) === pkg.reference,
    );
    const previous = previousChecks?.get(originKey);
    const outdatedMemberIds = previous?.outdatedMemberIds
      ? members
          .filter(
            (skill) =>
              previous.outdatedMemberIds!.includes(skill.id) &&
              !updatedSet.has(skill.id) &&
              skill.source?.revision !== revision,
          )
          .map((skill) => skill.id)
      : members
          .filter((skill) => skill.source?.revision !== revision)
          .map((skill) => skill.id);
    touched.set(originKey, {
      package: pkg,
      memberIds: members.map((skill) => skill.id),
      outdatedMemberIds,
      revision,
      updatedAt: previous?.updatedAt ?? null,
      status: outdatedMemberIds.length > 0 ? "available" : "current",
      error: null,
    });
  }
  return touched;
}

export function useSkillUpdates({
  desktop,
  mountedRef,
  setSnapshot,
}: {
  desktop: DesktopGateway;
  mountedRef: React.RefObject<boolean>;
  setSnapshot: (next: LibrarySnapshot) => void;
}): UpdatesState {
  const [checks, setChecks] = React.useState<PackageUpdateCheck[]>([]);
  const [jobs, setJobs] = React.useState<Map<string, UpdateJob>>(() => new Map());
  const [previewErrors, setPreviewErrors] = React.useState<Map<string, string>>(() => new Map());
  const [updatesBusy, setUpdatesBusy] = React.useState(false);
  const [updatesActivity, setUpdatesActivity] = React.useState<
    "check" | "batch" | "package" | undefined
  >(undefined);
  const [updatesCheckError, setUpdatesCheckError] = React.useState("");
  const [updatesChecked, setUpdatesChecked] = React.useState(false);
  const [lastCheckedAt, setLastCheckedAt] = React.useState<Date | null>(null);
  const updatesBusyRef = React.useRef(false);
  const updatesActivityRef = React.useRef<"check" | "batch" | "package" | undefined>(undefined);
  const updatesRecheckRef = React.useRef(false);
  const updatesGenerationRef = React.useRef(0);
  const checkUpdatesRef = React.useRef<(pkg?: UpdatePackage) => Promise<void>>(async () => {});
  const checksRef = React.useRef<PackageUpdateCheck[]>([]);
  checksRef.current = checks;

  const finishUpdatesActivity = React.useCallback(() => {
    updatesBusyRef.current = false;
    updatesActivityRef.current = undefined;
    if (!mountedRef.current) return;
    if (updatesRecheckRef.current) {
      void checkUpdatesRef.current();
    } else {
      setUpdatesBusy(false);
      setUpdatesActivity(undefined);
    }
  }, []);

  const checkUpdates = React.useCallback(
    async (pkg?: UpdatePackage) => {
      if (!desktop.updates || !mountedRef.current) return;
      if (updatesBusyRef.current) {
        if (!pkg) updatesRecheckRef.current = true;
        return;
      }
      updatesRecheckRef.current = false;
      const generation = updatesGenerationRef.current;
      updatesBusyRef.current = true;
      updatesActivityRef.current = "check";
      setUpdatesBusy(true);
      setUpdatesActivity("check");
      setUpdatesCheckError("");

      try {
        const result = pkg ? [await desktop.updates.checkOne(pkg)] : await desktop.updates.check();
        if (!mountedRef.current || generation !== updatesGenerationRef.current) return;
        setChecks((prev) =>
          pkg
            ? prev.map((entry) =>
                packageKey(entry.package) === packageKey(pkg) ? result[0] : entry,
              )
            : result,
        );
        setPreviewErrors((prev) => {
          const next = new Map(prev);
          for (const entry of result) next.delete(packageKey(entry.package));
          return next;
        });
        setJobs((prev) => {
          const next = new Map(prev);
          for (const entry of result) {
            const key = packageKey(entry.package);
            const job = next.get(key);
            if (job?.error && entry.revision && job.selection.revision !== entry.revision) {
              next.delete(key);
            }
          }
          return next;
        });
        setUpdatesChecked(true);
        setLastCheckedAt(new Date());
      } catch (error) {
        if (mountedRef.current && generation === updatesGenerationRef.current) {
          setUpdatesCheckError(errorText(error));
        }
      } finally {
        finishUpdatesActivity();
      }
    },
    [desktop, finishUpdatesActivity],
  );
  checkUpdatesRef.current = checkUpdates;

  const runUpdate = React.useCallback(
    async (entry: PackageUpdateCheck, selection: PackageUpdateSelection) => {
      if (!desktop.updates) return;
      const key = packageKey(entry.package);
      setPreviewErrors((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
      try {
        const outcome = await desktop.updates.apply(entry.package, selection);
        if (!mountedRef.current) return;
        const previousChecks = new Map(
          checksRef.current.map((item) => [packageKey(item.package), item]),
        );
        const touched = buildTouchedPackageChecks(
          outcome.library,
          [...entry.memberIds, ...outcome.added],
          selection.revision,
          previousChecks,
          outcome.updated,
        );
        setJobs((prev) => {
          const next = new Map(prev);
          next.delete(key);
          const displayed = touched.has(key) ? key : touched.keys().next().value;
          if (displayed) next.set(displayed, { selection, outcome });
          return next;
        });
        setChecks((prev) => {
          const remaining = new Map(touched);
          const updated = prev.flatMap((item) => {
            const id = packageKey(item.package);
            const replacement = remaining.get(id);
            if (replacement) {
              remaining.delete(id);
              return [replacement];
            }
            return id === key ? [] : [item];
          });
          return updated.concat([...remaining.values()]);
        });
        setSnapshot(outcome.library);
      } catch (error) {
        if (mountedRef.current) {
          setJobs((prev) => {
            const next = new Map(prev);
            next.set(key, { selection, error: errorText(error) });
            return next;
          });
        }
      }
    },
    [desktop, setSnapshot],
  );

  const applyAllUpdates = React.useCallback(async () => {
    if (updatesBusyRef.current || !mountedRef.current) return;
    updatesBusyRef.current = true;
    updatesActivityRef.current = "batch";
    setUpdatesBusy(true);
    setUpdatesActivity("batch");
    try {
      const targets = checksRef.current.filter(
        (entry): entry is PackageUpdateCheck & { revision: string } =>
          entry.status === "available" && entry.revision !== null,
      );
      for (const entry of targets) {
        await runUpdate(entry, {
          revision: entry.revision,
          additions: [],
          backupMembers: [],
          target: null,
        });
        if (!mountedRef.current) return;
      }
    } finally {
      finishUpdatesActivity();
    }
  }, [runUpdate, finishUpdatesActivity]);

  const applyOneUpdate = React.useCallback(
    async (entry: PackageUpdateCheck, selection: PackageUpdateSelection) => {
      if (updatesBusyRef.current || !mountedRef.current) return;
      updatesBusyRef.current = true;
      updatesActivityRef.current = "package";
      setUpdatesBusy(true);
      setUpdatesActivity("package");
      try {
        await runUpdate(entry, selection);
      } finally {
        finishUpdatesActivity();
      }
    },
    [runUpdate, finishUpdatesActivity],
  );

  const setPreviewError = React.useCallback((key: string, message: string | null) => {
    setPreviewErrors((prev) => {
      const next = new Map(prev);
      if (message) next.set(key, message);
      else next.delete(key);
      return next;
    });
  }, []);

  const resetUpdatesAfterReplacement = React.useCallback(() => {
    updatesGenerationRef.current += 1;
    setUpdatesChecked(false);
    setLastCheckedAt(null);
    setChecks([]);
    setUpdatesCheckError("");
    setJobs(new Map());
    setPreviewErrors(new Map());
    void checkUpdates();
  }, [checkUpdates]);

  const syncInstalled = React.useCallback(
    (library: LibrarySnapshot, addedIds: string[], revision: string) => {
      if (!desktop.updates || !mountedRef.current || addedIds.length === 0) return;

      const touched = buildTouchedPackageChecks(library, addedIds, revision);
      if (touched.size > 0) {
        setChecks((prev) => {
          const remaining = new Map(touched);
          const updated = prev.map((item) => {
            const id = packageKey(item.package);
            const replacement = remaining.get(id);
            if (!replacement) return item;
            remaining.delete(id);
            return replacement;
          });
          return updated.concat([...remaining.values()]);
        });

        setPreviewErrors((prev) => {
          const next = new Map(prev);
          for (const key of touched.keys()) next.delete(key);
          return next;
        });

        setJobs((prev) => {
          const next = new Map(prev);
          for (const key of touched.keys()) {
            const job = next.get(key);
            if (job?.error) next.delete(key);
          }
          return next;
        });
      }

      if (updatesBusyRef.current && updatesActivityRef.current === "check") {
        updatesGenerationRef.current += 1;
      }
      void checkUpdates();
    },
    [desktop, checkUpdates],
  );

  const attentionCount = React.useMemo(
    () =>
      checks.reduce((count, entry) => {
        const hasJobError = Boolean(jobs.get(packageKey(entry.package))?.error);
        if (entry.status === "failed" || hasJobError) {
          return count + 1;
        }
        if (entry.status === "available") {
          return count + (entry.outdatedMemberIds ? entry.outdatedMemberIds.length : 1);
        }
        return count;
      }, 0),
    [checks, jobs],
  );

  const updates = React.useMemo<UpdatesState>(
    () => ({
      checks,
      jobs,
      previewErrors,
      busy: updatesBusy,
      activity: updatesActivity,
      checkError: updatesCheckError,
      checked: updatesChecked,
      lastCheckedAt,
      attentionCount,
      applying: updatesActivity === "batch" || updatesActivity === "package",
      check: checkUpdates,
      applyAll: applyAllUpdates,
      applyOne: applyOneUpdate,
      setPreviewError,
      resetAfterReplacement: resetUpdatesAfterReplacement,
      syncInstalled,
    }),
    [
      checks,
      jobs,
      previewErrors,
      updatesBusy,
      updatesActivity,
      updatesCheckError,
      updatesChecked,
      lastCheckedAt,
      attentionCount,
      checkUpdates,
      applyAllUpdates,
      applyOneUpdate,
      setPreviewError,
      resetUpdatesAfterReplacement,
      syncInstalled,
    ],
  );

  return updates;
}
