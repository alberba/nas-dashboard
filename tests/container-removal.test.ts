import { describe, expect, it } from "vitest";
import {
  canRemoveContainer,
  removalRequest,
} from "../src/lib/container-removal";
import type { Container } from "../src/lib/types";

function container(overrides: Partial<Container> = {}): Container {
  return {
    id: "a".repeat(64),
    name: "homarr-v2-native-preview",
    image: "image:1",
    state: "exited",
    status: "Exited (0) 3 days ago",
    protected: false,
    composeProject: null,
    composeService: null,
    oneShot: false,
    exitCode: 0,
    orphan: true,
    recreateOnCompose: false,
    cpu: null,
    memory: null,
    compose: null,
    ...overrides,
  };
}

describe("which containers can be removed", () => {
  it("offers removal only for stopped, unprotected containers", () => {
    expect(canRemoveContainer(container())).toBe(true);
    expect(canRemoveContainer(container({ state: "created" }))).toBe(true);
    expect(canRemoveContainer(container({ state: "dead" }))).toBe(true);
    expect(canRemoveContainer(container({ state: "running" }))).toBe(false);
    expect(canRemoveContainer(container({ state: "restarting" }))).toBe(false);
    expect(canRemoveContainer(container({ state: "paused" }))).toBe(false);
    expect(canRemoveContainer(container({ protected: true }))).toBe(false);
  });

  it("also offers it for a finished one-shot, which is not an orphan", () => {
    expect(
      canRemoveContainer(
        container({ name: "wire", oneShot: true, orphan: false }),
      ),
    ).toBe(true);
  });
});

describe("removal request", () => {
  const withHost = (path: string) => `${path}?host=nas-home`;

  it("targets the scoped host and carries the id and the exact name to type", () => {
    const request = removalRequest(container(), withHost);
    expect(request.endpoint).toBe("/api/containers/remove?host=nas-home");
    expect(request.method ?? "POST").toBe("POST");
    expect(request.destructive).toBe(true);
    expect(request.typedConfirmation?.value).toBe("homarr-v2-native-preview");
    expect(request.body).toEqual({
      id: "a".repeat(64),
      confirmation: "homarr-v2-native-preview",
    });
  });

  it("never asks for volumes to be removed", () => {
    const body = removalRequest(container(), withHost).body as object;
    expect(Object.keys(body).sort()).toEqual(["confirmation", "id"]);
  });

  it("warns that Compose recreates the container only when it belongs to the active project", () => {
    const warns = (c: Container) =>
      removalRequest(c, withHost).consequences.filter(
        (item) => item.tone === "warn",
      ).length;
    const plain = warns(container());
    const compose = warns(
      container({
        composeProject: "media-stack",
        composeService: "sonarr",
        orphan: false,
        recreateOnCompose: true,
      }),
    );
    expect(compose).toBe(plain + 1);
  });
});
