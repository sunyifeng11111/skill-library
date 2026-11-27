import type { AppNotice } from "@/app/types";
import type { DiscoveryGateway } from "@/shared/discovery";
import { tr } from "@/shared/language";
import type { LibrarySnapshot } from "@/shared/library";
import { errorText } from "@/shared/ui";

export interface DiscoveryUndoOptions {
  batchId: string | null | undefined;
  discovery: Pick<DiscoveryGateway, "undoBatch">;
  setSnapshot: (next: LibrarySnapshot) => void;
  notify: (notice: AppNotice) => void;
  restoredText: string;
  beforeUndo?: () => Promise<unknown>;
  // Started before the success toast and awaited after it, so the toast is not delayed by a rescan.
  refresh?: (restored: LibrarySnapshot) => void | Promise<void>;
}

export function discoveryUndoAction(options: DiscoveryUndoOptions): AppNotice["action"] {
  const { batchId, discovery, setSnapshot, notify, restoredText, beforeUndo, refresh } = options;
  if (!batchId) return undefined;
  return {
    label: tr("撤销", "Undo"),
    run: async () => {
      try {
        if (beforeUndo) await beforeUndo();
        const restored = await discovery.undoBatch(batchId);
        setSnapshot(restored);
        const refreshing = refresh?.(restored);
        notify({ text: restoredText });
        await refreshing;
      } catch (err) {
        notify({ text: errorText(err), error: true });
      }
    },
  };
}
