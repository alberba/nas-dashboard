import { describe, expect, it } from "vitest";
import { appFilters, applications, serviceStatus } from "../src/lib/apps";
import type { Container } from "../src/lib/types";

function container(overrides: Partial<Container>): Container {
  return {
    id: overrides.name ?? "id",
    name: "service",
    image: "image:1",
    state: "running",
    status: "Up 2 hours",
    protected: false,
    composeProject: "media-stack",
    composeService: overrides.name ?? "service",
    oneShot: false,
    exitCode: null,
    orphan: false,
    recreateOnCompose: false,
    cpu: 1,
    memory: 1,
    compose: null,
    ...overrides,
  };
}

const app = (name: string) => {
  const found = applications.find((a) => a.name === name);
  if (!found) throw new Error(`missing app ${name}`);
  return found;
};

describe("service status of an application", () => {
  const fleet = [
    container({ name: "jellyfin", status: "Up 2 hours (healthy)" }),
    container({ name: "bazarr", status: "Up 12 minutes (unhealthy)" }),
    container({ name: "radarr", status: "Up 3 seconds (health: starting)" }),
    container({ name: "radarr-vo", status: "Up 1 hour" }),
    container({
      name: "sonarr",
      state: "exited",
      status: "Exited (137) 1 hour ago",
    }),
    container({ name: "seerr", status: "Up 5 hours (healthy)" }),
  ];

  it("follows the container that serves each application", () => {
    expect(serviceStatus(app("Jellyfin"), fleet)).toBe("healthy");
    expect(serviceStatus(app("Peticiones"), fleet)).toBe("healthy");
    expect(serviceStatus(app("Bazarr"), fleet)).toBe("unhealthy");
    expect(serviceStatus(app("Radarr ES"), fleet)).toBe("starting");
    expect(serviceStatus(app("Radarr VO"), fleet)).toBe("running");
    expect(serviceStatus(app("Sonarr ES"), fleet)).toBe("stopped");
  });

  it("has no status when the container is not on this host or there is no data", () => {
    expect(serviceStatus(app("Sonarr VO"), fleet)).toBe("unknown");
    expect(serviceStatus(app("Finanzas"), fleet)).toBe("unknown");
    expect(serviceStatus(app("Jellyfin"), undefined)).toBe("unknown");
  });
});

describe("application category filters", () => {
  it("offers every application first and then one filter per category", () => {
    const filters = appFilters(applications);
    expect(filters[0]).toMatchObject({ id: "all" });
    expect(filters[0].items).toHaveLength(applications.length);
    const ids = filters.slice(1).map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
    const total = filters
      .slice(1)
      .reduce((sum, filter) => sum + filter.items.length, 0);
    expect(total).toBe(applications.length);
    const series = filters
      .slice(1)
      .find((f) => f.items.some((a) => a.name === "Sonarr ES"));
    expect(series?.id).toBe("series");
    expect(series?.items.map((a) => a.name)).toEqual([
      "Sonarr ES",
      "Sonarr VO",
    ]);
  });
});
