import { describe, expect, it } from "vitest";
import { commandResult, progressLabel } from "../src/lib/maintenance-ui";
describe("maintenance operation outcomes", () => {
  it("keeps an uncertain operation pending and reports reclaimed space on success", () => {
    expect(commandResult({ status: "pending" })).toEqual({
      state: "pending",
      detail: "Pendiente de verificar",
    });
    expect(
      commandResult({
        status: "success",
        result: { cleanup: { reclaimedBytes: 1073741824 } },
      }).state,
    ).toBe("success");
  });
  it("exposes the current step and a restored failure", () => {
    expect(
      progressLabel({ currentStep: "health", failed: true, restored: true }),
    ).toBe("Fallida · restaurada");
    expect(
      progressLabel({ currentStep: "deploy", failed: false, restored: false }),
    ).toBe("Desplegando");
  });
});
