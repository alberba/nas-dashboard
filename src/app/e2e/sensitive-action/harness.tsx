"use client";
import { useState } from "react";
import { useSensitiveAction } from "@/components/sensitive-action/sensitive-action";

export function Harness() {
  const sensitive = useSensitiveAction();
  const [outcome, setOutcome] = useState("");
  return (
    <main>
      <button
        type="button"
        className="secondary"
        data-harness-trigger
        onClick={() => {
          const params = new URLSearchParams(window.location.search);
          const typed = params.get("typed");
          sensitive.request({
            title: "Eliminar homarr-preview",
            confirmLabel: "Eliminar",
            destructive: true,
            endpoint: "/api/containers/remove?host=nas",
            body: { id: "homarr-preview", confirmation: "homarr-preview" },
            consequences: [
              { tone: "ok", text: "Los volúmenes y los datos se conservan." },
              { tone: "warn", text: "El contenedor no se puede recuperar." },
            ],
            typedConfirmation: typed
              ? { label: `Escribe ${typed} para confirmar`, value: typed }
              : undefined,
            acknowledgement: params.has("acknowledge")
              ? "He leído los pasos manuales"
              : undefined,
            idempotencyKey: params.get("key") ?? undefined,
            onSettled: (result) => setOutcome(result.status),
          });
        }}
      >
        Eliminar homarr-preview
      </button>
      <output data-harness-outcome={outcome}>{outcome}</output>
      {sensitive.dialog}
    </main>
  );
}
