import type { DiscoveredSkill } from "../../shared/discovery";
import type { Skill } from "../../shared/library";

export function groupLocalSkills(rows: DiscoveredSkill[], library: Skill[]) {
  const byContent = new Map<string, DiscoveredSkill[]>();
  for (const row of rows) {
    if (!row.fingerprint) continue;
    const group = byContent.get(row.fingerprint) ?? [];
    group.push(row);
    byContent.set(row.fingerprint, group);
  }
  const knownNames = new Set(library.map((skill) => skill.name.trim().normalize().toLowerCase()));
  const seenNames = new Set<string>();
  const sameNames = new Set<string>();
  for (const [row] of byContent.values()) {
    const name = row.name.trim().normalize().toLowerCase();
    if (seenNames.has(name) || knownNames.has(name)) sameNames.add(name);
    seenNames.add(name);
  }
  return [...byContent]
    .map(([fingerprint, locations]) => {
      const row = locations.find((r) => r.source) ?? locations[0];
      const imported = locations.some(
        (location) =>
          location.status === "managedLink" ||
          location.status === "imported" ||
          location.copyImported,
      );
      const ambiguousSource = locations.some(
        (location) =>
          location.source &&
          row.source &&
          (location.source.repository !== row.source.repository ||
            location.source.memberPath !== row.source.memberPath ||
            location.source.reference !== row.source.reference ||
            location.source.revision !== row.source.revision),
      );
      const origins = [
        ...new Set(locations.map((location) => (location.agentKind ? location.sourceName : location.path))),
      ];
      return {
        name: row.name,
        description: row.description ?? "",
        path: row.target ?? row.path,
        source: ambiguousSource ? null : row.source ?? null,
        fingerprint,
        locations,
        origins,
        imported,
        sameName: sameNames.has(row.name.trim().normalize().toLowerCase()),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
