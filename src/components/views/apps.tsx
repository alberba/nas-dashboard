"use client";
import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import {
  appFilters,
  applications,
  serviceStatus,
  type ServiceStatus,
} from "@/lib/apps";
import type { Container } from "@/lib/types";
import { FilterChips, Panel, StatusDot, type Tone } from "../ui";
import styles from "../files-apps.module.css";

const statusLabels: Record<ServiceStatus, string> = {
  healthy: "Activo · sana",
  running: "Activo",
  starting: "arrancando",
  unhealthy: "falla",
  stopped: "Detenido",
  unknown: "sin dato",
};
const statusTones: Record<ServiceStatus, Tone> = {
  healthy: "gain",
  running: "gain",
  starting: "peach",
  unhealthy: "loss",
  stopped: "muted",
  unknown: "muted",
};
const filters = appFilters(applications);

export function AppsView({
  appDomain,
  containers,
}: {
  appDomain: string;
  /**
   * Contenedores conocidos de los hosts conectados (se buscan por nombre).
   * Sin ellos, cada app muestra «sin dato».
   */
  containers?: Container[];
}) {
  const [filter, setFilter] = useState("all");
  const visible = filters.find((f) => f.id === filter)?.items ?? applications;

  return (
    <div className="page-stack" data-apps="">
      <Panel
        id="apps-title"
        title="Accesos"
        count={visible.length}
        tools={
          <FilterChips
            label="Filtrar aplicaciones por categoría"
            options={filters.map((f) => ({
              id: f.id,
              label: f.label,
              count: f.items.length,
            }))}
            value={filter}
            onSelect={setFilter}
          />
        }
      >
        <div className="table-scroll">
          <table
            className={`data-table ${styles.appsTable}`}
            data-apps-table=""
          >
            <thead>
              <tr>
                <th scope="col">Aplicación</th>
                <th scope="col">Categoría</th>
                <th scope="col">Dirección</th>
                <th scope="col">Servicio</th>
                <th scope="col">
                  <span className="sr-only">Abrir</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((app) => {
                const status = serviceStatus(app, containers);
                const tone = statusTones[status];
                const url = `https://${app.host}.${appDomain}`;
                return (
                  <tr key={app.host} data-app={app.host} data-service={status}>
                    <td className="name-cell">
                      <span className="row-title">
                        <span
                          className={`${styles.mark} ${app.tone}`}
                          aria-hidden="true"
                        >
                          {app.letter}
                        </span>
                        <span className={styles.appText}>
                          <a
                            className={styles.appLink}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {app.name}
                          </a>
                          <span className={`muted ${styles.description}`}>
                            {app.description}
                          </span>
                        </span>
                      </span>
                      <span className={`row-meta ${tone}`}>
                        <StatusDot tone={tone} />
                        {statusLabels[status]}
                        <span className="muted">· {app.category}</span>
                      </span>
                    </td>
                    <td className="soft">{app.category}</td>
                    <td className="mono muted">
                      {app.host}.{appDomain}
                    </td>
                    <td>
                      <span className={`${styles.service} ${tone}`}>
                        <StatusDot tone={tone} />
                        {statusLabels[status]}
                      </span>
                    </td>
                    <td className="numeric actions-cell">
                      <ArrowUpRight className={styles.go} aria-hidden="true" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
