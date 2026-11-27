import * as React from "react";
import type { AppNotice } from "@/app/types";
import { isAdoptableUnmanagedRow, type DiscoveredSkill } from "@/shared/discovery";
import type { DesktopGateway, LibrarySnapshot } from "@/shared/library";
import { errorText } from "@/shared/ui";

export interface AgentInventory {
  agentInventoryById: Map<string, DiscoveredSkill[]>;
  unmanagedByAgent: Map<string, number>;
  scanningAllAgents: boolean;
  scanningAgentIds: Set<string>;
  ensureAgentInventoryLoaded: (agentId: string) => void;
  refreshAgentInventory: (
    agentId: string,
    options?: { clearBeforeScan?: boolean; notifyOnError?: boolean },
  ) => Promise<void>;
  refreshAgentInventories: (options?: {
    force?: boolean;
    snapshotOverride?: LibrarySnapshot;
  }) => Promise<void>;
  syncAgentInventoriesFromScan: (rows: DiscoveredSkill[], snap?: LibrarySnapshot | null) => void;
  /** Drops inventories and scan sequence numbers of agents that are no longer registered. */
  pruneToAgents: (next: LibrarySnapshot) => void;
}

export function useAgentInventory({
  desktop,
  mountedRef,
  snapshotRef,
  notify,
}: {
  desktop: DesktopGateway;
  mountedRef: React.RefObject<boolean>;
  snapshotRef: React.RefObject<LibrarySnapshot | null>;
  notify: (notice: AppNotice) => void;
}): AgentInventory {
  const [agentInventoryById, setAgentInventoryById] = React.useState<
    Map<string, DiscoveredSkill[]>
  >(() => new Map());
  const [scanningAllAgents, setScanningAllAgents] = React.useState(false);
  const [scanningAgentIds, setScanningAgentIds] = React.useState<Set<string>>(() => new Set());

  const agentInventoryByIdRef = React.useRef(agentInventoryById);
  agentInventoryByIdRef.current = agentInventoryById;
  const inventorySeqRef = React.useRef(0);
  const agentAppliedSeqRef = React.useRef<Map<string, number>>(new Map());
  const fullScanInFlightCountRef = React.useRef(0);
  const agentScanCountRef = React.useRef<Map<string, number>>(new Map());
  const lastFullScanAtRef = React.useRef(0);

  const pruneToAgents = React.useCallback((next: LibrarySnapshot) => {
    const nextAgentIds = new Set((next.agents ?? []).map((agent) => agent.id));
    for (const id of agentAppliedSeqRef.current.keys()) {
      if (!nextAgentIds.has(id)) {
        agentAppliedSeqRef.current.delete(id);
      }
    }
    const prevInv = agentInventoryByIdRef.current;
    let invChanged = false;
    const prunedInv = new Map<string, DiscoveredSkill[]>();
    for (const [id, rows] of prevInv) {
      if (nextAgentIds.has(id)) prunedInv.set(id, rows);
      else invChanged = true;
    }
    if (invChanged) {
      agentInventoryByIdRef.current = prunedInv;
      setAgentInventoryById(prunedInv);
    }
  }, []);

  const refreshAgentInventories = React.useCallback(
    async (options?: { force?: boolean; snapshotOverride?: LibrarySnapshot }) => {
      const snap = options?.snapshotOverride ?? snapshotRef.current;
      const agents = snap?.agents;
      if (!agents?.length) {
        agentAppliedSeqRef.current.clear();
        agentInventoryByIdRef.current = new Map();
        if (mountedRef.current) setAgentInventoryById(new Map());
        return;
      }
      if (!desktop.scanUnmanagedIndicators) {
        if (options?.force) {
          agentAppliedSeqRef.current.clear();
          agentInventoryByIdRef.current = new Map();
          if (mountedRef.current) setAgentInventoryById(new Map());
        }
        return;
      }
      if (
        !options?.force &&
        (fullScanInFlightCountRef.current > 0 || Date.now() - lastFullScanAtRef.current < 5000)
      ) {
        return;
      }

      const seq = ++inventorySeqRef.current;
      fullScanInFlightCountRef.current += 1;
      if (mountedRef.current) setScanningAllAgents(true);
      try {
        const rows = await desktop.scanUnmanagedIndicators();
        if (!Array.isArray(rows) || !mountedRef.current) return;
        lastFullScanAtRef.current = Date.now();
        const targetAgents = snapshotRef.current?.agents ?? agents;
        const grouped = new Map<string, DiscoveredSkill[]>();
        for (const agent of targetAgents) {
          grouped.set(agent.id, []);
        }
        for (const row of rows) {
          if (row.agentId && isAdoptableUnmanagedRow(row) && grouped.has(row.agentId)) {
            grouped.get(row.agentId)!.push(row);
          }
        }
        const next = new Map(agentInventoryByIdRef.current);
        for (const [id, list] of grouped) {
          if ((agentAppliedSeqRef.current.get(id) ?? 0) <= seq) {
            agentAppliedSeqRef.current.set(id, seq);
            next.set(id, list);
          }
        }
        for (const id of next.keys()) {
          if (!grouped.has(id)) {
            next.delete(id);
          }
        }
        agentInventoryByIdRef.current = next;
        setAgentInventoryById(next);
      } catch {
        // Non-blocking background preload; AgentPage can still scan on demand.
      } finally {
        fullScanInFlightCountRef.current = Math.max(0, fullScanInFlightCountRef.current - 1);
        if (mountedRef.current) {
          setScanningAllAgents(fullScanInFlightCountRef.current > 0);
        }
      }
    },
    [desktop],
  );

  const refreshAgentInventory = React.useCallback(
    async (
      agentId: string,
      options?: { clearBeforeScan?: boolean; notifyOnError?: boolean },
    ) => {
      const seq = ++inventorySeqRef.current;
      if (options?.clearBeforeScan) {
        agentAppliedSeqRef.current.set(agentId, seq);
        const cleared = new Map(agentInventoryByIdRef.current);
        if (cleared.delete(agentId)) {
          agentInventoryByIdRef.current = cleared;
          if (mountedRef.current) setAgentInventoryById(cleared);
        }
      }

      const nextCount = (agentScanCountRef.current.get(agentId) ?? 0) + 1;
      agentScanCountRef.current.set(agentId, nextCount);
      if (mountedRef.current) {
        setScanningAgentIds((prev) => {
          if (prev.has(agentId)) return prev;
          const next = new Set(prev);
          next.add(agentId);
          return next;
        });
      }

      try {
        const rows = await desktop.discovery.scan([], agentId, true, true);
        if (!mountedRef.current) return;
        const stillRegistered = Boolean(
          snapshotRef.current?.agents?.some((agent) => agent.id === agentId),
        );
        if (!stillRegistered) return;
        if ((agentAppliedSeqRef.current.get(agentId) ?? 0) <= seq) {
          agentAppliedSeqRef.current.set(agentId, seq);
          const filtered = rows.filter(isAdoptableUnmanagedRow);
          const next = new Map(agentInventoryByIdRef.current);
          next.set(agentId, filtered);
          agentInventoryByIdRef.current = next;
          setAgentInventoryById(next);
        }
      } catch (error) {
        if (options?.notifyOnError && mountedRef.current) {
          notify({ text: errorText(error), error: true });
        }
      } finally {
        const remaining = Math.max(0, (agentScanCountRef.current.get(agentId) ?? 1) - 1);
        if (remaining === 0) {
          agentScanCountRef.current.delete(agentId);
          if (mountedRef.current) {
            setScanningAgentIds((prev) => {
              if (!prev.has(agentId)) return prev;
              const next = new Set(prev);
              next.delete(agentId);
              return next;
            });
          }
        } else {
          agentScanCountRef.current.set(agentId, remaining);
        }
      }
    },
    [desktop, notify],
  );

  const ensureAgentInventoryLoaded = React.useCallback(
    (agentId: string) => {
      if (
        agentInventoryByIdRef.current.has(agentId) ||
        fullScanInFlightCountRef.current > 0 ||
        (agentScanCountRef.current.get(agentId) ?? 0) > 0
      ) {
        return;
      }
      void refreshAgentInventory(agentId, { notifyOnError: true });
    },
    [refreshAgentInventory],
  );

  const syncAgentInventoriesFromScan = React.useCallback(
    (rows: DiscoveredSkill[], snap?: LibrarySnapshot | null) => {
      const targetSnap = snap ?? snapshotRef.current;
      const agents = targetSnap?.agents;
      const seq = ++inventorySeqRef.current;
      lastFullScanAtRef.current = Date.now();
      if (!agents?.length) {
        agentAppliedSeqRef.current.clear();
        agentInventoryByIdRef.current = new Map();
        setAgentInventoryById(new Map());
        return;
      }
      const grouped = new Map<string, DiscoveredSkill[]>();
      for (const agent of agents) {
        grouped.set(agent.id, []);
      }
      for (const row of rows) {
        if (row.agentId && isAdoptableUnmanagedRow(row) && grouped.has(row.agentId)) {
          grouped.get(row.agentId)!.push(row);
        }
      }
      const next = new Map<string, DiscoveredSkill[]>();
      for (const [id, list] of grouped) {
        agentAppliedSeqRef.current.set(id, seq);
        next.set(id, list);
      }
      agentInventoryByIdRef.current = next;
      setAgentInventoryById(next);
    },
    [],
  );

  React.useEffect(() => {
    if (!desktop.scanUnmanagedIndicators) return;
    const onFocus = () => {
      if (snapshotRef.current?.agents?.length) {
        void refreshAgentInventories();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [desktop, refreshAgentInventories]);

  const unmanagedByAgent = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const [agentId, rows] of agentInventoryById) {
      if (rows.length > 0) counts.set(agentId, rows.length);
    }
    return counts;
  }, [agentInventoryById]);

  return {
    agentInventoryById,
    unmanagedByAgent,
    scanningAllAgents,
    scanningAgentIds,
    ensureAgentInventoryLoaded,
    refreshAgentInventory,
    refreshAgentInventories,
    syncAgentInventoriesFromScan,
    pruneToAgents,
  };
}
