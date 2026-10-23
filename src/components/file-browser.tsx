"use client";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowUp,
  Folder,
  File,
  Trash2,
  Pencil,
  RotateCcw,
  Search,
  Link2,
} from "lucide-react";
import type { FileEntry, TrashEntry } from "@/lib/types";
import { bytes } from "@/lib/format";
export type ActionRequest = {
  body: Record<string, unknown>;
  title: string;
  detail: string;
  phrase?: string;
  destination?: string;
  after?: () => void;
};

export function FileBrowser({
  connected,
  request,
}: {
  connected: boolean;
  request: (action: ActionRequest) => void;
}) {
  const [root, setRoot] = useState<"media" | "torrents">("media");
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [tab, setTab] = useState<"files" | "trash">("files");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(100);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  const load = useCallback(() => {
    setBusy(true);
    setError("");
    setRevision((v) => v + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const url =
      tab === "trash"
        ? "/api/trash"
        : `/api/files?root=${root}&path=${encodeURIComponent(path)}`;
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        if (tab === "trash") setTrash(result);
        else setEntries(result);
        setError("");
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setError(
            err instanceof Error
              ? err.message
              : "No se pudieron leer los archivos",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [root, path, tab, revision]);
  const filtered = entries.filter((item) =>
    item.name.toLowerCase().includes(search.toLowerCase()),
  );
  function open(relative: string) {
    setBusy(true);
    setRevision((v) => v + 1);
    setPath(relative);
    setLimit(100);
    setSearch("");
  }
  return (
    <div className="stack section-gap">
      <div className="toolbar wrap">
        <div className="segmented">
          <button
            aria-pressed={tab === "files"}
            onClick={() => {
              setBusy(true);
              setTab("files");
              load();
            }}
          >
            <Folder />
            Archivos
          </button>
          <button
            aria-pressed={tab === "trash"}
            onClick={() => {
              setBusy(true);
              setTab("trash");
              load();
            }}
          >
            <Trash2 />
            Papelera
          </button>
        </div>
        <button className="secondary push-end" onClick={load} disabled={busy}>
          <RotateCcw />
          Actualizar
        </button>
      </div>
      {tab === "files" ? (
        <>
          <div className="toolbar wrap">
            <label className="inline-label">
              Carpeta
              <select
                value={root}
                onChange={(event) => {
                  setRoot(event.target.value as typeof root);
                  open("");
                }}
              >
                <option value="media">Biblioteca · media</option>
                <option value="torrents">Descargas · torrents</option>
              </select>
            </label>
            <label className="search-field push-end">
              <Search />
              <input
                aria-label="Buscar archivos"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar en esta carpeta"
                type="search"
              />
            </label>
          </div>
          <div className="breadcrumb">
            <button
              className="icon-button"
              aria-label="Subir una carpeta"
              disabled={!path || busy}
              onClick={() => open(path.split("/").slice(0, -1).join("/"))}
            >
              <ArrowUp />
            </button>
            <button onClick={() => open("")}>{root}</button>
            {path
              .split("/")
              .filter(Boolean)
              .map((part, index, all) => (
                <button
                  key={index}
                  onClick={() => open(all.slice(0, index + 1).join("/"))}
                >
                  / {part}
                </button>
              ))}
          </div>
          <section className="panel file-list" aria-busy={busy}>
            <div className="file-heading">
              <span>Nombre</span>
              <span>Tamaño / acciones</span>
            </div>
            {!busy && !error && filtered.length === 0 && (
              <div className="empty-state">
                <Folder />
                <h3>
                  {search ? "Sin coincidencias" : "Esta carpeta está vacía"}
                </h3>
                <p className="subtle">
                  {search
                    ? "Prueba con otro nombre."
                    : "Los archivos aparecerán aquí cuando los añadas a tu NAS."}
                </p>
              </div>
            )}
            {filtered.slice(0, limit).map((item) => (
              <div className="file-row" key={item.path}>
                <span className="file-icon">
                  {item.symlink ? (
                    <Link2 />
                  ) : item.directory ? (
                    <Folder />
                  ) : (
                    <File />
                  )}
                </span>
                <div className="file-name">
                  {item.directory && !item.symlink ? (
                    <button
                      className="text-button"
                      onClick={() => open(item.path)}
                    >
                      {item.name}
                    </button>
                  ) : (
                    <span>{item.name}</span>
                  )}
                  <small className="subtle">
                    {item.symlink
                      ? "Enlace · acceso desactivado"
                      : new Date(item.modified * 1000).toLocaleDateString("es")}
                  </small>
                </div>
                <span className="file-size">
                  {item.directory ? "Carpeta" : bytes(item.size)}
                </span>
                <div className="row-actions">
                  <button
                    className="icon-button"
                    aria-label={`Mover o renombrar ${item.name}`}
                    disabled={!connected || item.symlink || busy}
                    onClick={() =>
                      request({
                        body: { action: "move", root, path: item.path },
                        title: "Mover o renombrar",
                        detail:
                          "Escribe la ruta de destino dentro de " +
                          root +
                          ". La carpeta de destino debe existir.",
                        destination: item.path,
                        after: load,
                      })
                    }
                  >
                    <Pencil />
                  </button>
                  <button
                    className="icon-button danger-text"
                    aria-label={`Enviar ${item.name} a la papelera`}
                    disabled={!connected || item.symlink || busy}
                    onClick={() =>
                      request({
                        body: { action: "trash", root, path: item.path },
                        title: "Enviar a la papelera",
                        detail: `«${item.name}» se podrá restaurar durante 7 días. Seguirá ocupando espacio hasta su eliminación definitiva.`,
                        after: load,
                      })
                    }
                  >
                    <Trash2 />
                  </button>
                </div>
              </div>
            ))}
            {filtered.length > limit && (
              <button
                className="secondary"
                onClick={() => setLimit((v) => v + 100)}
              >
                Mostrar más ({filtered.length - limit})
              </button>
            )}
          </section>
        </>
      ) : (
        <>
          <div className="toolbar wrap">
            <p className="subtle">
              Los archivos se conservan 7 días y siguen ocupando espacio.
            </p>
            <button
              className="secondary danger-text push-end"
              disabled={!connected || !trash.length || busy}
              onClick={() =>
                request({
                  body: {
                    action: "empty-trash",
                    confirmation: "VACIAR PAPELERA",
                  },
                  phrase: "VACIAR PAPELERA",
                  title: "Vaciar la papelera",
                  detail:
                    "Se eliminarán definitivamente todos sus archivos. Esta acción no se puede deshacer.",
                  after: load,
                })
              }
            >
              <Trash2 />
              Vaciar papelera
            </button>
          </div>
          <section className="panel">
            {!busy && !trash.length && !error && (
              <div className="empty-state">
                <Trash2 />
                <h3>La papelera está vacía</h3>
                <p className="subtle">
                  Aquí podrás recuperar los archivos que elimines desde hub.
                </p>
              </div>
            )}
            {trash.map((item) => (
              <div className="file-row" key={item.id}>
                <Trash2 />
                <div className="file-name">
                  <strong>{item.name}</strong>
                  <small className="subtle">
                    {item.root}/{item.path} · caduca{" "}
                    {new Date(item.expiresAt * 1000).toLocaleDateString("es")}
                  </small>
                </div>
                <div className="row-actions">
                  <button
                    className="secondary"
                    disabled={!connected || busy}
                    onClick={() =>
                      request({
                        body: {
                          action: "restore",
                          root: item.root,
                          id: item.id,
                        },
                        title: "Restaurar archivo",
                        detail: `Volverá a ${item.root}/${item.path}. No se sobrescribirá ningún archivo existente.`,
                        after: load,
                      })
                    }
                  >
                    <RotateCcw />
                    Restaurar
                  </button>
                  <button
                    className="icon-button danger-text"
                    aria-label={`Eliminar definitivamente ${item.name}`}
                    disabled={!connected || busy}
                    onClick={() =>
                      request({
                        body: { action: "purge", root: item.root, id: item.id },
                        title: "Eliminar definitivamente",
                        detail: `«${item.name}» no se podrá recuperar.`,
                        after: load,
                      })
                    }
                  >
                    <Trash2 />
                  </button>
                </div>
              </div>
            ))}
          </section>
        </>
      )}
      {busy && (
        <p className="subtle" role="status">
          Leyendo el NAS…
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
