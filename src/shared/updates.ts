import type { CategoryTarget, LibrarySnapshot } from "./library";

export interface UpdatePackage {
  repository: string;
  reference: string | null;
}

export interface PackageUpdateCheck {
  package: UpdatePackage;
  memberIds: string[];
  outdatedMemberIds?: string[];
  status: "current" | "available" | "failed";
  revision: string | null;
  updatedAt?: number | null;
  error: string | null;
}

export interface OutdatedMember {
  id: string;
  name: string;
  skipReason: string | null;
  changedFiles?: string[];
}

export interface PackageUpdatePreview {
  outdated: OutdatedMember[];
  additions: { memberPath: string; name: string; description: string; unavailable: string | null }[];
  additionsConfirmed: boolean;
  updatedAt?: number | null;
  fromRevision?: string | null;
  repositoryUrl?: string | null;
  compareUrl?: string | null;
}

export interface PackageUpdateSelection {
  revision: string;
  backupMembers: string[];
  additions: string[];
  target: CategoryTarget | null;
  memberIds?: string[];
}

export interface PackageUpdateOutcome {
  library: LibrarySnapshot;
  updated: string[];
  added: string[];
  skipped: OutdatedMember[];
  backup: string | null;
}

export interface UpdateGateway {
  check(): Promise<PackageUpdateCheck[]>;
  checkOne(pkg: UpdatePackage): Promise<PackageUpdateCheck>;
  preview(pkg: UpdatePackage, revision: string): Promise<PackageUpdatePreview>;
  apply(pkg: UpdatePackage, selection: PackageUpdateSelection): Promise<PackageUpdateOutcome>;
  attach(id: string, previewId: string, memberPath: string): Promise<LibrarySnapshot>;
  openSourceUrl?(url: string): Promise<void>;
}
