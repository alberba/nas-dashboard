import { describe, expect, it } from "vitest";
import {
  containerAccess,
  containerUpdate,
  containerUrl,
  containerVersion,
  imageTag,
} from "../src/lib/container-access";
import type { Application } from "../src/lib/apps";
import type { MaintenanceContainer } from "../src/lib/maintenance";
import type { Container } from "../src/lib/types";

function container(overrides: Partial<Container> = {}): Container {
  return {
    id: "a".repeat(64),
    name: "jellyfin",
    image: "lscr.io/linuxserver/jellyfin:latest",
    state: "running",
    status: "Up 2 hours (healthy)",
    protected: false,
    composeProject: "media-stack",
    composeService: "jellyfin",
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

const apps: Application[] = [
  {
    name: "Jellyfin",
    category: "Tu biblioteca",
    host: "jellyfin",
    container: "jellyfin",
    description: "",
    letter: "J",
    tone: "lilac",
  },
  {
    name: "Peticiones",
    category: "Tu biblioteca",
    host: "request",
    container: "seerr",
    description: "",
    letter: "P",
    tone: "peach",
  },
];

const update: MaintenanceContainer = {
  id: "a".repeat(64),
  name: "jellyfin",
  image: "lscr.io/linuxserver/jellyfin:latest",
  version: "10.10.7",
  tag: "latest",
  url: null,
  canUpdate: true,
  updateAvailable: true,
  checkedAt: 1_800_000_000,
};

describe("container link", () => {
  it("maps a curated container to its subdomain", () => {
    expect(
      containerUrl({
        container: container(),
        appDomain: "alberba.es",
        apps,
      }),
    ).toBe("https://jellyfin.alberba.es");
  });

  it("matches the compose service when the container name differs", () => {
    expect(
      containerUrl({
        container: container({ name: "media-stack-seerr-1", composeService: "seerr" }),
        appDomain: "alberba.es",
        apps,
      }),
    ).toBe("https://request.alberba.es");
  });

  it("prefers the url the agent read from the container labels", () => {
    expect(
      containerUrl({
        container: container(),
        update: { ...update, url: "https://media.alberba.es" },
        appDomain: "alberba.es",
        apps,
      }),
    ).toBe("https://media.alberba.es");
  });

  it("leaves a container without a page or a curated host unlinked", () => {
    expect(
      containerUrl({
        container: container({ name: "gluetun", composeService: "gluetun" }),
        appDomain: "alberba.es",
        apps,
      }),
    ).toBeNull();
    expect(
      containerUrl({
        container: container(),
        appDomain: "not a domain",
        apps,
      }),
    ).toBeNull();
  });
});

describe("container version", () => {
  it("uses the image label the agent read", () => {
    expect(containerVersion(container(), update)).toBe("10.10.7");
  });

  it("falls back to the update tag and then to the image reference", () => {
    expect(
      containerVersion(container(), { ...update, version: null }),
    ).toBe("latest");
    expect(containerVersion(container())).toBe("latest");
    expect(
      containerVersion(
        container({ image: "ghcr.io/alberba/hub:3.2.1" }),
      ),
    ).toBe("3.2.1");
  });

  it("reads a tag but not a registry port", () => {
    expect(imageTag("registry:5000/app")).toBeNull();
    expect(imageTag("registry:5000/app:2.0")).toBe("2.0");
    expect(imageTag("sha256:" + "a".repeat(64))).toBeNull();
    expect(imageTag(null)).toBeNull();
  });
});

describe("container access", () => {
  it("merges the link, the version and the update state", () => {
    expect(
      containerAccess({
        container: container(),
        update,
        appDomain: "alberba.es",
        apps,
      }),
    ).toEqual({
      url: "https://jellyfin.alberba.es",
      version: "10.10.7",
      updateAvailable: true,
      canUpdate: true,
    });
  });

  it("never enables updates without agent data", () => {
    expect(
      containerAccess({
        container: container(),
        appDomain: "alberba.es",
        apps,
      }),
    ).toMatchObject({ updateAvailable: null, canUpdate: false });
  });

  it("finds the per-container update by id only when the section is available", () => {
    const containers = { available: true, items: [update] };
    expect(containerUpdate(containers, update.id)).toEqual(update);
    expect(containerUpdate(containers, "b".repeat(64))).toBeUndefined();
    expect(
      containerUpdate({ available: false, items: [update] }, update.id),
    ).toBeUndefined();
    expect(containerUpdate(undefined, update.id)).toBeUndefined();
  });
});
