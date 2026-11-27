import { isUnmanagedRow, type DiscoveredSkill } from "@/shared/discovery";
import { tr } from "@/shared/language";
import type { LibrarySnapshot } from "@/shared/library";

export interface ReadyItem {
  key: string;
  name: string;
  description: string;
  fingerprint: string;
  rows: DiscoveredSkill[];
  sources: string[];
  copyImported: boolean;
}

export interface ConflictVersion {
  id: string;
  label: string;
  fingerprint: string;
  modifiedAt: number | null;
  path: string | null;
  librarySkillId: string | null;
  rows: DiscoveredSkill[];
}

export interface ConflictGroup {
  name: string;
  versions: ConflictVersion[];
  allRows: DiscoveredSkill[];
}

export interface ScanClassification {
  ready: ReadyItem[];
  conflicts: ConflictGroup[];
  invalid: DiscoveredSkill[];
  alreadyManagedCount: number;
  scannedSources: number;
  unmanagedByAgent: Map<string, number>;
}

export function classifyScanRows(rows: DiscoveredSkill[], snapshot: LibrarySnapshot | null): ScanClassification {
  const invalid: DiscoveredSkill[] = [];
  const validByName = new Map<string, DiscoveredSkill[]>();
  const sourceDirs = new Set<string>();
  const unmanagedByAgent = new Map<string, number>();

  for (const row of rows) {
    sourceDirs.add(row.sourceDirectory);
    if (
      row.status === "invalid" ||
      (isUnmanagedRow(row) && !row.fingerprint)
    ) {
      invalid.push(row);
      continue;
    }
    if (row.agentId && isUnmanagedRow(row)) {
      unmanagedByAgent.set(row.agentId, (unmanagedByAgent.get(row.agentId) ?? 0) + 1);
    }
    const list = validByName.get(row.name) ?? [];
    list.push(row);
    validByName.set(row.name, list);
  }

  const ready: ReadyItem[] = [];
  const conflicts: ConflictGroup[] = [];
  let alreadyManagedCount = 0;

  for (const [name, groupRows] of validByName) {
    const unmanaged = groupRows.filter(isUnmanagedRow);
    if (!unmanaged.length) {
      alreadyManagedCount += 1;
      continue;
    }

    const byFingerprint = new Map<string, DiscoveredSkill[]>();
    for (const r of groupRows) {
      const fp = r.fingerprint ?? r.path;
      const list = byFingerprint.get(fp) ?? [];
      list.push(r);
      byFingerprint.set(fp, list);
    }

    const libraryExtras = (snapshot?.skills ?? []).filter(
      (skill) => skill.name === name && !byFingerprint.has(skill.fingerprint),
    );

    if (byFingerprint.size + libraryExtras.length > 1) {
      const versions: ConflictVersion[] = [];
      for (const [fp, vRows] of byFingerprint) {
        const names = [...new Set(vRows.map((r) => r.sourceName))];
        const rep = vRows.find((r) => r.status === "directory") ?? vRows[0];
        const latest = vRows.reduce<number | null>(
          (best, r) => (r.modifiedAt && (!best || r.modifiedAt > best) ? r.modifiedAt : best),
          null,
        );
        versions.push({
          id: `path:${rep.path}`,
          label: names.join(" · "),
          fingerprint: fp,
          modifiedAt: latest,
          path: rep.target ?? rep.path,
          librarySkillId: null,
          rows: vRows,
        });
      }
      for (const skill of libraryExtras) {
        versions.push({
          id: `skill:${skill.id}`,
          label: tr("Skill 库已有版本", "Library version"),
          fingerprint: skill.fingerprint,
          modifiedAt: null,
          path: null,
          librarySkillId: skill.id,
          rows: [],
        });
      }
      versions.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
      conflicts.push({ name, versions, allRows: groupRows });
    } else {
      const [fp] = byFingerprint.keys();
      const sources = [...new Set(unmanaged.map((r) => r.sourceName))];
      const desc = unmanaged.find((r) => r.description)?.description ?? "";
      ready.push({
        key: `${name}::${fp}`,
        name,
        description: desc,
        fingerprint: fp,
        rows: unmanaged,
        sources,
        copyImported: unmanaged.every((r) => Boolean(r.copyImported)),
      });
    }
  }

  ready.sort((a, b) => a.name.localeCompare(b.name, document.documentElement.lang));
  conflicts.sort((a, b) => a.name.localeCompare(b.name, document.documentElement.lang));

  return {
    ready,
    conflicts,
    invalid,
    alreadyManagedCount,
    scannedSources: sourceDirs.size,
    unmanagedByAgent,
  };
}
