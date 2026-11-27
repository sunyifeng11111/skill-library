import type { PackageSource, PreviewMember } from "./library";

export type SourceProgress = "resolving" | "downloading" | "readingMembers";

export interface PackageProposal {
  name: string;
  origin: { repository: string; reference: string };
  revision: string;
  members: (PreviewMember & { source: PackageSource; alreadyInstalled: boolean })[];
  problems: { memberPath: string; message: string }[];
}

export interface OnlineGateway {
  reserve(): Promise<string>;
  read(id: string, input: string, onProgress: (progress: SourceProgress) => void): Promise<PackageProposal>;
  discard(id: string): Promise<void>;
}
