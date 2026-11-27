import { vi } from "vitest";
import type { DiscoveryGateway } from "../../src/shared/discovery";

export function createDiscoveryGateway(overrides: Partial<DiscoveryGateway> = {}): DiscoveryGateway {
  return {
    scan: vi.fn().mockResolvedValue([]),
    commitBatch: vi.fn(),
    undoBatch: vi.fn(),
    compareManifests: vi.fn(),
    trashBrokenLink: vi.fn().mockResolvedValue(undefined),
    openInSystem: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
