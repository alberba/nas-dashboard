"use client";
import { useId, useState } from "react";
import type { SnapshotState } from "@/lib/maintenance-polling";
import { maintenanceDate, securityReviewReason, securityReviewRows } from "@/lib/security-review";
import { Panel } from "../ui";
import { useHostScope } from "../host-context";
import { useMaintenanceSnapshot } from "./use-maintenance-snapshot";
import styles from "./security-review.module.css";

export function SecurityReview() {
  const state = useMaintenanceSnapshot();
  const { key } = useHostScope();
  return <SecurityReviewContent key={key} state={state} />;
}

export function SecurityReviewContent({ state }: { state: SnapshotState }) {
  const { snapshot, stale, phase } = state;
  const [selected, select] = useState<string | null>(null);
  const detailId = useId();
  const rows = securityReviewRows(snapshot?.security.review ?? []);
  const active = rows.find((row) => row.id === selected) ?? rows[0];
  const reason = active ? securityReviewReason(active.review.reason) : null;
  const degraded = !!snapshot?.degraded.includes("security");
  return (
    <section className={styles.review} data-security-review-layout="list-detail" data-phase={phase} data-stale={stale || undefined} data-degraded={degraded || undefined} aria-labelledby="security-review-heading">
      <div className={styles.heading}>
        <h2 id="security-review-heading">Revisar candidatos de seguridad</h2>
        <p>Elige una comparación para entender el motivo y el siguiente paso.</p>
        {stale && <p role="status">No se pudo actualizar. Se muestran datos anteriores recibidos el {maintenanceDate(snapshot ? new Date(snapshot.timestamp * 1000).toISOString() : null)}.</p>}
        {degraded && <p role="status">No se han podido leer todos los datos de seguridad. La lista puede estar incompleta.</p>}
        {snapshot?.security.pending && <p role="status">Hay una operación de seguridad en curso para {snapshot.security.pending.service}. Revisa el registro antes de iniciar otra operación.</p>}
      </div>
      {!snapshot ? <Panel id="security-review-unavailable" title="Comparaciones de seguridad"><p className={styles.body} role="status">{phase === "loading" ? "Cargando comparaciones…" : "No se pudieron obtener las comparaciones de este host."}</p></Panel> : !rows.length ? (
        <Panel id="security-review-empty" title="Comparaciones de seguridad"><div className={styles.body} data-security-review-empty=""><p>No hay comparaciones disponibles en los datos recibidos.</p><p className={styles.note}>Esto no confirma que las aplicaciones estén actualizadas ni libres de vulnerabilidades.</p></div></Panel>
      ) : <div className={styles.split}>
        <Panel id="security-candidates" title="Comparaciones" count={rows.length} className={styles.candidates}>
          <ul className={styles.list}>
            {rows.map(({ id, review }) => <li key={id}>
              <button type="button" className={styles.candidate} aria-pressed={active.id === id} aria-controls={detailId} onClick={() => select(id)} data-security-review="" data-review-key={id}>
                <strong>{review.names.join(", ")}</strong>
                <span className="mono">{review.from ?? "Versión desconocida"} → {review.to ?? "Versión desconocida"}</span>
                <span className="peach">{securityReviewReason(review.reason).label}</span>
                <small>Comparado: {maintenanceDate(review.verifiedAt)}</small>
              </button>
            </li>)}
          </ul>
        </Panel>
        <Panel id="security-comparison-title" title="Detalle de la comparación" className={styles.detail}>
          {active && reason && <div id={detailId} className={styles.body} data-security-review-detail={active.id} data-reason={reason.code} aria-live="polite" aria-atomic="true">
            <h3>{active.review.names.join(", ")}</h3>
            <p className="mono">{active.review.from ?? "Versión desconocida"} → {active.review.to ?? "Versión desconocida"}</p>
            <dl className={styles.metrics}>
              <div><dt>Correcciones verificadas en la candidata</dt><dd data-cves-fixed={active.review.cves}>{active.review.cves} CVEs graves corregidas</dd></div>
              <div><dt>Riesgo del candidato</dt><dd className={active.review.newSevere ? "peach" : "soft"} data-cves-new={active.review.newSevere}>{active.review.newSevere} CVEs nuevas o agravadas HIGH/CRITICAL</dd></div>
            </dl>
            <p className={styles.note}>Son diferencias entre las imágenes analizadas, no el total de vulnerabilidades instaladas. Cero regresiones no significa ausencia de vulnerabilidades.</p>
            <h3 className="peach">{reason.label}</h3>
            <h3>Siguiente paso</h3>
            <p>{reason.next}</p>
            <p className={styles.note}>La revisión se realiza en el host o repositorio. El hub no permite aprobar ni forzar esta candidata.</p>
            <p className={styles.note}>Comparado: {maintenanceDate(active.review.verifiedAt)}.</p>
            <p className="peach" data-review-freshness="unconfirmed">Vigencia sin confirmar: no se ha cotejado la imagen analizada con la que está ejecutándose.</p>
            <p className={styles.note}>Se muestran hasta 20 comparaciones. Pueden existir varios candidatos o análisis antiguos del mismo servicio.</p>
            {active.review.reason && <details className={styles.technical}><summary>Motivo técnico registrado</summary><p>{active.review.reason}</p></details>}
          </div>}
        </Panel>
      </div>}
    </section>
  );
}

export function SecurityPins() {
  const { snapshot, stale, phase } = useMaintenanceSnapshot();
  return <details className={styles.disclosure} data-security-pins="">
    <summary>Versiones fijadas por seguridad · {snapshot ? snapshot.security.pins.length : "Sin datos"}</summary>
    <div className={styles.body}>
      {stale && <p role="status">Sin actualizar · datos anteriores.</p>}
      {!snapshot ? <p>{phase === "loading" ? "Cargando…" : "No se pudieron obtener las versiones fijadas."}</p> : <>
        <p>Estas imágenes sustituyen a las de la Plantilla. Su presencia no significa que haya una revisión pendiente ni confirma qué imagen está ejecutándose.</p>
        {snapshot.degraded.includes("security") && <p role="status">Datos de seguridad incompletos.</p>}
        <ul className={styles.list}>{snapshot.security.pins.map((pin) => <li className={styles.pin} key={pin.service} data-security-pin={pin.service}><strong>{pin.service}</strong><span className="mono">{pin.version ?? pin.image}</span><details className={styles.technical}><summary>Referencia de imagen</summary><p className="mono">{pin.image}</p></details></li>)}</ul>
        {!snapshot.security.pins.length && <p>No hay versiones fijadas en los datos recibidos.</p>}
      </>}
    </div>
  </details>;
}
