import { applications, type Application } from "./apps";
import type { MaintenanceContainer, MaintenanceContainers } from "./maintenance";
import type { Container } from "./types";

/** The tag part of an image reference, without the registry or the digest. */
export function imageTag(image: string | null | undefined) {
  if (!image || image.startsWith("sha256:")) return null;
  const last = image.split("@")[0].split("/").at(-1) ?? "";
  const colon = last.lastIndexOf(":");
  return colon > 0 ? last.slice(colon + 1) || null : null;
}

export function containerVersion(
  container: Pick<Container, "image">,
  update?: MaintenanceContainer,
) {
  return update?.version ?? update?.tag ?? imageTag(container.image);
}

const domainPattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

/**
 * Public page for a container. The agent's own labels win; otherwise the
 * curated application catalog maps the container to its subdomain. A
 * container without either stays without a link instead of guessing one.
 */
export function containerUrl({
  container,
  update,
  appDomain,
  apps = applications,
}: {
  container: Pick<Container, "name" | "composeService" | "compose">;
  update?: MaintenanceContainer;
  appDomain: string;
  apps?: Application[];
}) {
  if (update?.url) return update.url;
  if (!domainPattern.test(appDomain)) return null;
  const names = new Set(
    [
      container.name,
      container.composeService,
      container.compose?.service,
    ].filter((name): name is string => Boolean(name)),
  );
  const app = apps.find(
    (entry) =>
      entry.container !== undefined &&
      entry.host !== undefined &&
      names.has(entry.container),
  );
  return app ? `https://${app.host}.${appDomain}` : null;
}

export type ContainerAccess = {
  url: string | null;
  version: string | null;
  updateAvailable: boolean | null;
  canUpdate: boolean;
};

export function containerAccess({
  container,
  update,
  appDomain,
  apps = applications,
}: {
  container: Pick<Container, "name" | "image" | "composeService" | "compose">;
  update?: MaintenanceContainer;
  appDomain: string;
  apps?: Application[];
}): ContainerAccess {
  return {
    url: containerUrl({ container, update, appDomain, apps }),
    version: containerVersion(container, update),
    updateAvailable: update?.updateAvailable ?? null,
    canUpdate: update?.canUpdate ?? false,
  };
}

/** Update state for one container, or undefined when the host has no data. */
export function containerUpdate(
  containers: MaintenanceContainers | undefined,
  id: string,
) {
  if (!containers?.available) return undefined;
  return containers.items.find((item) => item.id === id);
}
