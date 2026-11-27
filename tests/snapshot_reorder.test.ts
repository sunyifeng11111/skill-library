import { describe, expect, it, vi } from "vitest";
import { SnapshotReorderer } from "@/app/snapshotReorder";
import type { LibrarySnapshot } from "@/shared/library";

function snapshotWith(categoryIds: string[], agentIds: string[]): LibrarySnapshot {
  return {
    categories: categoryIds.map((id) => ({ id, name: id })),
    agents: agentIds.map((id) => ({ id, name: id })),
    skills: [],
  } as unknown as LibrarySnapshot;
}

const ids = (list: { id: string }[] | undefined) => (list ?? []).map((item) => item.id);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(initial: LibrarySnapshot) {
  let state: LibrarySnapshot | null = initial;
  const onError = vi.fn();
  const reorderer = new SnapshotReorderer();
  reorderer.confirm(initial);
  const deps = {
    getSnapshot: () => state,
    updateSnapshot: (update: (prev: LibrarySnapshot | null) => LibrarySnapshot | null) => {
      state = update(state);
    },
    commitSnapshot: (next: LibrarySnapshot) => {
      reorderer.confirm(next);
      state = next;
    },
    isMounted: () => true,
    onError,
  };
  return { reorderer, deps, onError, current: () => state };
}

describe("SnapshotReorderer", () => {
  it("keeps the other field's optimistic order while its save is still in flight", async () => {
    const h = harness(snapshotWith(["a", "b"], ["x", "y"]));
    const agentSave = deferred<LibrarySnapshot>();
    const agentTask = h.reorderer.reorder("agents", ["y", "x"], () => agentSave.promise, h.deps);
    await h.reorderer.reorder(
      "categories",
      ["b", "a"],
      async () => snapshotWith(["b", "a"], ["x", "y"]),
      h.deps,
    );
    expect(ids(h.current()?.categories)).toEqual(["b", "a"]);
    expect(ids(h.current()?.agents)).toEqual(["y", "x"]);

    agentSave.resolve(snapshotWith(["b", "a"], ["y", "x"]));
    await agentTask;
    expect(ids(h.current()?.agents)).toEqual(["y", "x"]);
  });

  it("rolls back to the last confirmed order and reports the failure", async () => {
    const h = harness(snapshotWith(["a", "b", "c"], []));
    await h.reorderer.reorder(
      "categories",
      ["c", "b", "a"],
      async () => {
        throw new Error("disk full");
      },
      h.deps,
    );
    expect(ids(h.current()?.categories)).toEqual(["a", "b", "c"]);
    expect(h.onError).toHaveBeenCalledTimes(1);
  });

  it("ignores a no-op or mismatched order without saving", async () => {
    const h = harness(snapshotWith(["a", "b"], []));
    const save = vi.fn();
    await h.reorderer.reorder("categories", ["a", "b"], save, h.deps);
    await h.reorderer.reorder("categories", ["a", "z"], save, h.deps);
    expect(save).not.toHaveBeenCalled();
  });

  it("only lets the latest save update the snapshot", async () => {
    const h = harness(snapshotWith(["a", "b", "c"], []));
    const first = deferred<LibrarySnapshot>();
    const firstTask = h.reorderer.reorder("categories", ["b", "a", "c"], () => first.promise, h.deps);
    const secondTask = h.reorderer.reorder(
      "categories",
      ["c", "a", "b"],
      async () => snapshotWith(["c", "a", "b"], []),
      h.deps,
    );
    first.resolve(snapshotWith(["b", "a", "c"], []));
    await Promise.all([firstTask, secondTask]);
    expect(ids(h.current()?.categories)).toEqual(["c", "a", "b"]);
  });
});
