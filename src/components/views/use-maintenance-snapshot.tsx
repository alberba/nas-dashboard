"use client";
import { createContext, useContext, useEffect, useState } from "react";
import {
  initialSnapshotState,
  startSnapshotPolling,
  type SnapshotState,
} from "@/lib/maintenance-polling";
import { useHostScope } from "../host-context";

/**
 * Maintenance snapshot of the host the view is scoped to, refreshed about once
 * a minute. Switching host drops the previous host's data at once (the held
 * answer carries its host key) and aborts its request in flight.
 */
const SnapshotContext = createContext<SnapshotState | null>(null);
export function useMaintenanceSnapshot(): SnapshotState {
  const state = useContext(SnapshotContext);
  if (!state) throw new Error("MaintenanceSnapshotProvider is required");
  return state;
}
export function MaintenanceSnapshotProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const state = useSnapshotPolling();
  return <SnapshotContext value={state}>{children}</SnapshotContext>;
}
function useSnapshotPolling(): SnapshotState {
  const { key, withHost } = useHostScope();
  const url = withHost("/api/maintenance");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = () => setRevision((n) => n + 1);
    window.addEventListener("maintenance-refresh", update);
    return () => window.removeEventListener("maintenance-refresh", update);
  }, []);
  const [held, setHeld] = useState<{ key: string; state: SnapshotState }>({
    key,
    state: initialSnapshotState,
  });
  useEffect(
    () =>
      startSnapshotPolling({
        url,
        onChange: (state) => setHeld({ key, state }),
      }),
    [key, url, revision],
  );
  return held.key === key ? held.state : initialSnapshotState;
}
