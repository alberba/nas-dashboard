"use client";
import { createContext, use } from "react";
import { HardDrive, Server } from "lucide-react";
import type { HostStatus } from "@/lib/types";
import styles from "./host-context.module.css";

/**
 * The host a view works on. The dashboard provides it around every view, so a
 * component that reads from or acts on an agent (maintenance snapshot, logs,
 * deployments, host commands…) never has to know how the host was chosen.
 *
 * Contract for consumers:
 * - Build every hub API URL with `withHost(path)`; it adds `host=<id>` when a
 *   host is selected and leaves the path untouched for the primary host.
 * - Put `key` in the dependencies of any effect that fetches host data and
 *   drop a response whose key is no longer current, so a slow answer from the
 *   previous host never replaces the selected host's data.
 * - Disable every mutating control while `canMutate` is false.
 * - Offer rebooting only when `canReboot` is true.
 */
export type HostScope = {
  /** Every configured host with its own connection state. */
  hosts: HostStatus[];
  /** Host whose data the view shows; null until the hub has answered. */
  host: HostStatus | null;
  /** Changes whenever the scoped host changes. */
  key: string;
  /** The scoped host answers and its data is current. */
  connected: boolean;
  /** Connected and no other action is waiting for confirmation. */
  canMutate: boolean;
  /** Only `instance` hosts can be rebooted from the hub. */
  canReboot: boolean;
  withHost: (path: string) => string;
};

export const HostScopeContext = createContext<HostScope | null>(null);

export function useHostScope(): HostScope {
  const scope = use(HostScopeContext);
  if (!scope)
    throw new Error("useHostScope needs the dashboard's HostScopeContext");
  return scope;
}

/** Adds the `host` query parameter to a hub API path. */
export function withHost(path: string, host: string | null | undefined) {
  if (!host) return path;
  const [base, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set("host", host);
  return `${base}?${params}`;
}

function ConnectionText({ connected }: { connected: boolean }) {
  return (
    <span className={styles.state} data-tone={connected ? "gain" : "muted"}>
      <i className={styles.dot} aria-hidden="true" />
      {connected ? "Conectado" : "Sin conexión"}
    </span>
  );
}

/** Segmented host selector for the Mantenimiento heading. */
export function HostSwitcher({
  hosts,
  selected,
  onSelect,
}: {
  hosts: HostStatus[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className={`segmented ${styles.switcher}`} role="group" aria-label="Host">
      {hosts.map((host) => (
        <button
          key={host.id}
          type="button"
          data-host-option={host.id}
          data-connected={host.connected}
          aria-pressed={host.id === selected}
          onClick={() => onSelect(host.id)}
        >
          <i
            className={styles.dot}
            data-tone={host.connected ? "gain" : "muted"}
            aria-hidden="true"
          />
          {host.name}
          {!host.connected && (
            <span className={styles.offline}>sin conexión</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Hosts block at the bottom of the sidebar; each opens its Mantenimiento. */
export function SidebarHosts({
  hosts,
  current,
  href,
  onOpen,
}: {
  hosts: HostStatus[];
  current: string | null;
  href: (id: string) => string;
  onOpen: (id: string) => void;
}) {
  return (
    <section className={styles.hosts} aria-labelledby="sidebar-hosts">
      <h2 id="sidebar-hosts" className={styles.heading}>
        Hosts
      </h2>
      <ul>
        {hosts.map((host) => {
          const Icon = host.role === "apps-server" ? Server : HardDrive;
          return (
            <li key={host.id}>
              <a
                className={styles.host}
                href={href(host.id)}
                data-sidebar-host={host.id}
                data-connected={host.connected}
                aria-current={host.id === current ? "true" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  onOpen(host.id);
                }}
              >
                <Icon aria-hidden="true" />
                <span className={styles.name}>
                  <strong>{host.name}</strong>
                  <ConnectionText connected={host.connected} />
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
