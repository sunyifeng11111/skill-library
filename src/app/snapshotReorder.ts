import type { LibrarySnapshot } from "@/shared/library";

export type ReorderField = "categories" | "agents";

interface ReorderLane {
  seq: number;
  pending: number;
  queue: Promise<void>;
  confirmed: LibrarySnapshot[ReorderField];
}

export interface SnapshotReorderDeps {
  getSnapshot: () => LibrarySnapshot | null;
  updateSnapshot: (update: (prev: LibrarySnapshot | null) => LibrarySnapshot | null) => void;
  commitSnapshot: (next: LibrarySnapshot) => void;
  isMounted: () => boolean;
  onError: (error: unknown) => void;
}

const otherField = (field: ReorderField): ReorderField =>
  field === "categories" ? "agents" : "categories";

/**
 * Optimistic drag-reorder for categories and agents. Saves for one field run one at a time and only
 * the latest one may touch the snapshot; while the other field still has a save in flight, its
 * optimistic order is kept instead of the server copy.
 */
export class SnapshotReorderer {
  private readonly lanes: Record<ReorderField, ReorderLane> = {
    categories: { seq: 0, pending: 0, queue: Promise.resolve(), confirmed: undefined },
    agents: { seq: 0, pending: 0, queue: Promise.resolve(), confirmed: undefined },
  };

  /** Records the server-confirmed order to roll back to when a later save fails. */
  confirm(next: LibrarySnapshot): void {
    this.lanes.categories.confirmed = next.categories;
    this.lanes.agents.confirmed = next.agents;
  }

  async reorder(
    field: ReorderField,
    ids: string[],
    save: (ids: string[]) => Promise<LibrarySnapshot>,
    deps: SnapshotReorderDeps,
  ): Promise<void> {
    const current = deps.getSnapshot();
    const list = current?.[field];
    if (!current || !list) return;
    const currentIds = list.map((item) => item.id);
    if (ids.length !== currentIds.length || ids.every((id, index) => id === currentIds[index])) {
      return;
    }
    const idSet = new Set(ids);
    if (idSet.size !== currentIds.length || !currentIds.every((id) => idSet.has(id))) {
      return;
    }

    deps.updateSnapshot((prev) => {
      const prevList = prev?.[field];
      if (!prev || !prevList) return prev;
      const byId = new Map<string, (typeof prevList)[number]>(
        prevList.map((item) => [item.id, item]),
      );
      const reordered = ids
        .map((id) => byId.get(id))
        .filter((item): item is (typeof prevList)[number] => Boolean(item));
      if (reordered.length !== prevList.length) return prev;
      return { ...prev, [field]: reordered };
    });

    const lane = this.lanes[field];
    const other = this.lanes[otherField(field)];
    const seq = ++lane.seq;
    lane.pending += 1;
    const nextIds = [...ids];
    const task = lane.queue.then(async () => {
      try {
        const updated = await save(nextIds);
        lane.confirmed = updated[field];
        if (deps.isMounted() && seq === lane.seq) {
          if (other.pending > 0) {
            const keep = otherField(field);
            deps.updateSnapshot((prev) => (prev ? { ...updated, [keep]: prev[keep] } : updated));
          } else {
            deps.commitSnapshot(updated);
          }
        }
      } catch (error) {
        if (deps.isMounted() && seq === lane.seq) {
          const confirmed = lane.confirmed;
          if (confirmed) {
            deps.updateSnapshot((prev) => (prev ? { ...prev, [field]: confirmed } : prev));
          }
          deps.onError(error);
        }
      } finally {
        lane.pending = Math.max(0, lane.pending - 1);
      }
    });
    lane.queue = task;
    await task;
  }
}
