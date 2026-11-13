import { expect, it } from "vitest";
import { needsAttention } from "../src/lib/containers";
import type { Container } from "../src/lib/types";
it("does not report a successful Compose one-shot as a failed expected service", () => {
  const wire = {
    id: "a".repeat(64),
    name: "wire",
    image: "wire",
    state: "exited",
    status: "Exited (0)",
    protected: false,
    cpu: null,
    memory: null,
    oneShot: true,
    exitCode: 0,
  } as Container;
  expect(needsAttention(wire, ["wire"])).toBe(false);
});
