import type { AgentKind, LibrarySnapshot, PackageSource } from "./library";

export interface DiscoveredSkill {
  path: string;
  name: string;
  description: string | null;
  source?: PackageSource | null;
  sourceDirectory: string;
  sourceName: string;
  agentId: string | null;
  agentKind: AgentKind | null;
  status: "directory" | "externalLink" | "managedLink" | "imported" | "invalid";
  target: string | null;
  copyImported?: boolean;
  modifiedAt?: number | null;
  brokenLink?: boolean;
  fingerprint: string | null;
  identity: string | null;
  reason: string | null;
}

/** A real folder or an outside link in a tool folder that the library does not manage yet. */
export function isUnmanagedRow(row: DiscoveredSkill): boolean {
  return row.status === "directory" || row.status === "externalLink";
}

/** An unmanaged row the library can take over: it must be identified and fingerprinted. */
export function isAdoptableUnmanagedRow(row: DiscoveredSkill): boolean {
  return Boolean(row.identity && row.fingerprint && isUnmanagedRow(row));
}

export interface AdoptionResult {
  path: string;
  skipped: boolean;
  error: string | null;
}

export interface DiffLine {
  kind: "context" | "removed" | "added";
  text: string;
}

export interface SkillManifestDiff {
  leftPath: string;
  rightPath: string;
  lines: DiffLine[];
  sameManifest: boolean;
}

export type UnifiedConflictDecision =
  | { action: "keepBoth"; rows: DiscoveredSkill[] }
  | { action: "useCanonical"; canonicalPath: string; canonicalSkillId?: string | null; rows: DiscoveredSkill[] }
  | { action: "skip" };

export interface UnifiedAdoptionRequest {
  readyRows: DiscoveredSkill[];
  conflicts?: UnifiedConflictDecision[];
  copyOnly?: boolean;
  summary?: string;
}

export interface UnifiedAdoptionOutcome {
  snapshot: LibrarySnapshot;
  results: AdoptionResult[];
  managedCount: number;
  importedCount: number;
  backedUpCount: number;
  skippedCount: number;
  batchId?: string | null;
}

export interface DiscoveryGateway {
  scan(
    collections: string[],
    agentId: string | null,
    includeAgents: boolean,
    registeredOnly?: boolean,
  ): Promise<DiscoveredSkill[]>;
  commitBatch(request: UnifiedAdoptionRequest): Promise<UnifiedAdoptionOutcome>;
  undoBatch(id: string): Promise<LibrarySnapshot>;
  compareManifests(left: string, right: string): Promise<SkillManifestDiff>;
  trashBrokenLink(path: string): Promise<void>;
  openInSystem(path: string): Promise<void>;
}
