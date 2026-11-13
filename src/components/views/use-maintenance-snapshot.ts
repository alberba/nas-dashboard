"use client";
import { useEffect, useState } from "react";
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
export function useMaintenanceSnapshot(): SnapshotState {
  const { key, withHost } = useHostScope();
  const url = withHost("/api/maintenance");
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
    [key, url],
  );
  return held.key === key ? held.state : initialSnapshotState;
}
