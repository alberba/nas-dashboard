import { describe, expect, it } from "vitest";
import { needsAttention } from "../src/lib/containers";
import { removalRequestSchema } from "../src/lib/lifecycle";
import type { Container } from "../src/lib/types";

const id = "a".repeat(64);

function container(overrides: Partial<Container> = {}): Container {
  return {
    id,
    name: "service",
    image: "image:1",
    state: "exited",
    status: "Exited (0) 3 days ago",
    protected: false,
    composeProject: "media-stack",
    composeService: "service",
    oneShot: false,
    exitCode: 0,
    orphan: false,
    recreateOnCompose: true,
    cpu: null,
    memory: null,
    compose: null,
    ...overrides,
  };
}

describe("container removal request", () => {
  it("accepts a stopped container identified by its id and exact name", () => {
    expect(
      removalRequestSchema.safeParse({
        id,
        confirmation: "homarr-v2-native-preview",
      }).success,
    ).toBe(true);
  });

  it("rejects malformed identifiers before an operation is recorded", () => {
    for (const value of ["", "A".repeat(64), "a".repeat(63), "bad;reboot"]) {
      expect(
        removalRequestSchema.safeParse({ id: value, confirmation: "container" })
          .success,
      ).toBe(false);
    }
  });

  it("rejects an empty or whitespace-only confirmation", () => {
    for (const confirmation of ["", " ", "  homarr"]) {
      expect(
        removalRequestSchema.safeParse({ id, confirmation }).success,
      ).toBe(false);
    }
  });

  it("rejects options that could remove volumes", () => {
    expect(
      removalRequestSchema.safeParse({
        id,
        confirmation: "homarr-v2-native-preview",
        volumes: true,
        removeVolumes: true,
      }).success,
    ).toBe(false);
  });
});

describe("container attention", () => {
  it("does not treat successful one-shot wiring as a problem", () => {
    expect(
      needsAttention(
        container({
          name: "wire",
          composeService: "wire",
          oneShot: true,
          exitCode: 0,
        }),
        [],
      ),
    ).toBe(false);
  });

  it("surfaces a one-shot wiring run that failed", () => {
    expect(
      needsAttention(
        container({
          name: "wire-seed",
          composeService: "wire-seed",
          oneShot: true,
          exitCode: 1,
        }),
        [],
      ),
    ).toBe(true);
  });

  it("still reports an expected service that stopped", () => {
    expect(needsAttention(container({ name: "sonarr" }), ["sonarr"])).toBe(
      true,
    );
  });
});
