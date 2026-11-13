"use client";
import { useEffect, useState } from "react";
import {
  initialRenovateState,
  startRenovatePolling,
  type RenovateState,
} from "@/lib/renovate-polling";
import { useHostScope } from "../host-context";

/**
 * Renovate pull requests related to the scoped host's containers, refreshed
 * about once a minute. Switching host drops the previous answer at once and
 * aborts its request in flight.
 */
export function useRenovate(): RenovateState & { hostId: string | null } {
  const { key, host, withHost } = useHostScope();
  const url = withHost("/api/renovate");
  const [held, setHeld] = useState<{ key: string; state: RenovateState }>({
    key,
    state: initialRenovateState,
  });
  useEffect(
    () =>
      startRenovatePolling({
        url,
        onChange: (state) => setHeld({ key, state }),
      }),
    [key, url],
  );
  const state = held.key === key ? held.state : initialRenovateState;
  return { ...state, hostId: host?.id ?? null };
}
