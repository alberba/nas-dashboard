"use client";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowUp,
  File,
  Folder,
  FolderInput,
  Link2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { FileEntry, TrashEntry } from "@/lib/types";
import { bytes } from "@/lib/format";
import { Panel, StatusDot } from "./ui";
import styles from "./files-apps.module.css";

export type ActionRequest = {
  body: Record<string, unknown>;
  title: string;
  detail: string;
  phrase?: string;
  destination?: string;
  after?: () => void;
};

type Root = "media" | "torrents";
const roots: { id: Root; label: string }[] = [
  { id: "media", label: "Biblioteca" },
  { id: "torrents", label: "Descargas" },
];
const page = 100;
const day = 86400;

function date(seconds: number) {
  return new Date(seconds * 1000).toLocaleDateString("es", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Tiempo hasta que la papelera elimina el elemento (7 días desde que entró). */
function expiry(expiresAt: number, now: number) {
  const left = expiresAt - now;
  if (left <= 0) return "se elimina en breve";
  if (left < day) return `caduca en ${Math.max(1, Math.floor(left / 3600))} h`;
  return `caduca en ${Math.floor(left / day)} d`;
}

export function FileBrowser({
  connected,
  request,
}: {
  connected: boolean;
  request: (action: ActionRequest) => void;
}) {
  const [root, setRoot] = useState<Root>("media");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [now, setNow] = useState(0);
  const [trashError, setTrashError] = useState("");
  const [trashRevision, setTrashRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(page);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);

  const load = useCallback(() => {
    setBusy(true);
    setRevision((v) => v + 1);
    setTrashRevision((v) => v + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/files?root=${root}&path=${encodeURIComponent(path)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        setEntries(result);
        setError("");
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setEntries([]);
        setError(
          err instanceof Error ? err.message : "No se pudo leer la carpeta",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [root, path, revision]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/trash", { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        setTrash(result);
        setNow(Date.now() / 1000);
        setTrashError("");
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setTrashError(
            err instanceof Error ? err.message : "No se pudo leer la papelera",
          );
      });
    return () => controller.abort();
  }, [trashRevision]);

  function open(next: string, nextRoot: Root = root) {
    setBusy(true);
    setRevision((v) => v + 1);
    setRoot(nextRoot);
    setPath(next);
    setLimit(page);
    setSearch("");
  }

  const query = search.trim().toLowerCase();
  const visible = entries.filter((item) =>
    item.name.toLowerCase().includes(query),
  );
  const parts = path.split("/").filter(Boolean);
  const rootLabel = roots.find((r) => r.id === root)?.label ?? root;
  const locked = !connected || busy;

  return (
    <div
      className="page-stack"
      data-file-browser=""
      data-active-root={root}
      data-path={path}
    >
      <div className="columns">
        <Panel
          id="folder-title"
          title={rootLabel}
          count={busy ? undefined : visible.length}
          className="main-column"
          tools={
            <div className="segmented" role="group" aria-label="Carpeta raíz">
              {roots.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  data-root={option.id}
                  aria-pressed={option.id === root}
                  onClick={() => option.id !== root && open("", option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          }
        >
          <div className={styles.bar}>
            <button
              type="button"
              className="row-button"
              aria-label="Subir a la carpeta superior"
              disabled={!path || busy}
              onClick={() => open(parts.slice(0, -1).join("/"))}
            >
              <ArrowUp />
            </button>
            <nav className={styles.crumbs} aria-label="Ruta">
              <ol>
                <li>
                  <button
                    type="button"
                    data-crumb=""
                    aria-current={path ? undefined : "location"}
                    onClick={() => open("")}
                  >
                    {root}
                  </button>
                </li>
                {parts.map((part, index) => {
                  const target = parts.slice(0, index + 1).join("/");
                  return (
                    <li key={target}>
                      <button
                        type="button"
                        data-crumb={target}
                        aria-current={
                          index === parts.length - 1 ? "location" : undefined
                        }
                        onClick={() => open(target)}
                      >
                        {part}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </nav>
            <label className={styles.search}>
              <Search aria-hidden="true" />
              <input
                aria-label="Buscar en esta carpeta"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setLimit(page);
                }}
                placeholder="Buscar en esta carpeta"
                type="search"
              />
            </label>
            <button
              type="button"
              className="row-button"
              aria-label="Actualizar la carpeta y la papelera"
              disabled={busy}
              onClick={load}
            >
              <RefreshCw />
            </button>
          </div>
          <div className="table-scroll" aria-busy={busy}>
            <table
              className={`data-table ${styles.filesTable}`}
              data-files-table=""
            >
              <thead>
                <tr>
                  <th scope="col">Nombre</th>
                  <th scope="col">Modificado</th>
                  <th scope="col" className="numeric">
                    Tamaño
                  </th>
                  <th scope="col">
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, limit).map((item) => {
                  const kind = item.symlink
                    ? "symlink"
                    : item.directory
                      ? "directory"
                      : "file";
                  const Icon = item.symlink
                    ? Link2
                    : item.directory
                      ? Folder
                      : File;
                  const size = item.directory ? "Carpeta" : bytes(item.size);
                  return (
                    <tr key={item.path} data-entry={item.path} data-kind={kind}>
                      <td className="name-cell">
                        <span className="row-title">
                          <Icon
                            className={styles.entryIcon}
                            data-kind={kind}
                            aria-hidden="true"
                          />
                          {kind === "directory" ? (
                            <button
                              type="button"
                              className={styles.entryOpen}
                              onClick={() => open(item.path)}
                            >
                              {item.name}
                            </button>
                          ) : (
                            <span className={styles.entryName}>
                              {item.name}
                            </span>
                          )}
                        </span>
                        <span className="row-meta muted">
                          {item.symlink
                            ? "Enlace · acceso desactivado"
                            : `${size} · ${date(item.modified)}`}
                        </span>
                      </td>
                      <td className="muted">
                        {item.symlink
                          ? "Enlace · acceso desactivado"
                          : date(item.modified)}
                      </td>
                      <td className="numeric soft">
                        {item.symlink ? "—" : size}
                      </td>
                      <td className="numeric actions-cell">
                        <div className="row-actions">
                          <button
                            type="button"
                            className="row-button"
                            aria-label={`Renombrar ${item.name}`}
                            disabled={locked || item.symlink}
                            onClick={() =>
                              request({
                                body: { action: "move", root, path: item.path },
                                title: `Renombrar ${item.name}`,
                                detail: `Cambia el nombre al final de la ruta, dentro de ${root}. Si ya existe un elemento con ese nombre, no se sobrescribe.`,
                                destination: item.path,
                                after: load,
                              })
                            }
                          >
                            <Pencil />
                          </button>
                          <button
                            type="button"
                            className="row-button"
                            aria-label={`Mover ${item.name}`}
                            disabled={locked || item.symlink}
                            onClick={() =>
                              request({
                                body: { action: "move", root, path: item.path },
                                title: `Mover ${item.name}`,
                                detail: `Escribe la ruta de destino dentro de ${root}. La carpeta de destino debe existir y no se sobrescribe nada.`,
                                destination: item.path,
                                after: load,
                              })
                            }
                          >
                            <FolderInput />
                          </button>
                          <button
                            type="button"
                            className="row-button danger-text"
                            aria-label={`Enviar ${item.name} a la papelera`}
                            disabled={locked || item.symlink}
                            onClick={() =>
                              request({
                                body: {
                                  action: "trash",
                                  root,
                                  path: item.path,
                                },
                                title: `Enviar ${item.name} a la papelera`,
                                detail:
                                  "Se podrá restaurar durante 7 días. Seguirá ocupando espacio hasta que se elimine definitivamente.",
                                after: load,
                              })
                            }
                          >
                            <Trash2 />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!busy && !error && !visible.length && (
                  <tr className="empty-row">
                    <td colSpan={4}>
                      {query
                        ? "Nada coincide con la búsqueda"
                        : "Esta carpeta está vacía"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {visible.length > limit && (
            <div className={styles.more}>
              <button
                type="button"
                className="secondary"
                onClick={() => setLimit((v) => v + page)}
              >
                Mostrar {Math.min(page, visible.length - limit)} más de{" "}
                {visible.length - limit}
              </button>
            </div>
          )}
          {(busy || error) && (
            <p
              className={`${styles.status} ${error ? "error" : "muted"}`}
              role={error ? "alert" : "status"}
            >
              {error || "Leyendo el NAS…"}
            </p>
          )}
        </Panel>
        <div className="side-column">
          <Panel
            id="trash-title"
            title="Papelera"
            count={trash.length}
            tools={
              <button
                type="button"
                className={`secondary danger-text ${styles.smallButton}`}
                aria-label="Vaciar la papelera"
                disabled={!connected || !trash.length}
                onClick={() =>
                  request({
                    body: {
                      action: "empty-trash",
                      confirmation: "VACIAR PAPELERA",
                    },
                    phrase: "VACIAR PAPELERA",
                    title: "Vaciar la papelera",
                    detail:
                      "Se eliminarán definitivamente todos sus elementos. No se puede deshacer.",
                    after: load,
                  })
                }
              >
                Vaciar
              </button>
            }
          >
            <ul className={styles.trashList} data-trash-list="">
              {trash.map((item) => {
                const expiring = item.expiresAt - now < day;
                return (
                  <li
                    key={item.id}
                    className={styles.trashRow}
                    data-trash-item={item.id}
                    data-expiring={expiring || undefined}
                  >
                    <div className={styles.trashText}>
                      <strong>{item.name}</strong>
                      <span className={`mono muted ${styles.trashOrigin}`}>
                        {item.root}/{item.path}
                      </span>
                      <span
                        className={`${styles.trashExpiry} ${expiring ? "peach" : "muted"}`}
                      >
                        <StatusDot tone={expiring ? "peach" : "muted"} />
                        {expiry(item.expiresAt, now)}
                      </span>
                    </div>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="row-button"
                        aria-label={`Restaurar ${item.name}`}
                        disabled={!connected}
                        onClick={() =>
                          request({
                            body: {
                              action: "restore",
                              root: item.root,
                              id: item.id,
                            },
                            title: `Restaurar ${item.name}`,
                            detail: `Volverá a ${item.root}/${item.path}. Si allí ya existe algo, no se sobrescribe.`,
                            after: load,
                          })
                        }
                      >
                        <RotateCcw />
                      </button>
                      <button
                        type="button"
                        className="row-button danger-text"
                        aria-label={`Eliminar definitivamente ${item.name}`}
                        disabled={!connected}
                        onClick={() =>
                          request({
                            body: {
                              action: "purge",
                              root: item.root,
                              id: item.id,
                            },
                            title: `Eliminar definitivamente ${item.name}`,
                            detail: "No se podrá recuperar.",
                            after: load,
                          })
                        }
                      >
                        <X />
                      </button>
                    </div>
                  </li>
                );
              })}
              {!trash.length && !trashError && (
                <li className={`muted ${styles.trashEmpty}`}>
                  La papelera está vacía
                </li>
              )}
            </ul>
            {trashError ? (
              <p className={`error ${styles.status}`} role="alert">
                {trashError}
              </p>
            ) : (
              <p className={`muted ${styles.trashNote}`}>
                Cada elemento se elimina solo a los 7 días. Restaurar nunca
                sobrescribe.
              </p>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
