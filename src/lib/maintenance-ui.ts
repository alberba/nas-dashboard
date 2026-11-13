import { bytes } from "./format";
import type { DeployProgressUpdate } from "./types";
export const stepLabels = {
  pr: "PR",
  merge: "Merge",
  ci: "CI en main",
  release: "Release",
  deploy: "Desplegando",
  health: "Sano",
};
export function progressLabel(
  update: Pick<DeployProgressUpdate, "currentStep" | "failed" | "restored">,
) {
  return update.failed
    ? update.restored
      ? "Fallida · restaurada"
      : "Fallida"
    : stepLabels[update.currentStep];
}
export function commandResult(data: {
  status?: string;
  result?: { cleanup?: { reclaimedBytes: number } };
}) {
  if (data.status === "pending")
    return { state: "pending", detail: "Pendiente de verificar" };
  if (data.status === "success")
    return {
      state: "success",
      detail: data.result?.cleanup
        ? `${bytes(data.result.cleanup.reclaimedBytes)} recuperados`
        : "Completada",
    };
  return { state: "failed", detail: "La operación no se ha completado" };
}
