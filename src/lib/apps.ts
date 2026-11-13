import { containerHealth } from "./containers";
import type { Container } from "./types";

export type Application = {
  name: string;
  category: string;
  host: string;
  /** Contenedor de media-stack que sirve la app; sin él no hay estado. */
  container?: string;
  description: string;
  letter: string;
  tone: "accent" | "gain" | "lilac" | "peach";
};

export const applications: Application[] = [
  {
    name: "Jellyfin",
    category: "Tu biblioteca",
    host: "jellyfin",
    container: "jellyfin",
    description: "Películas, series y sesiones de reproducción.",
    letter: "J",
    tone: "lilac",
  },
  {
    name: "Peticiones",
    category: "Tu biblioteca",
    host: "request",
    container: "seerr",
    description: "Descubre contenido y pide lo que te apetezca ver.",
    letter: "P",
    tone: "peach",
  },
  {
    name: "Radarr ES",
    category: "Películas",
    host: "radares",
    container: "radarr",
    description: "Biblioteca y descargas de películas en español.",
    letter: "R",
    tone: "accent",
  },
  {
    name: "Radarr VO",
    category: "Películas",
    host: "radarvo",
    container: "radarr-vo",
    description: "Películas en versión original.",
    letter: "R",
    tone: "accent",
  },
  {
    name: "Sonarr ES",
    category: "Series",
    host: "sonares",
    container: "sonarr",
    description: "Series, temporadas y próximos episodios.",
    letter: "S",
    tone: "gain",
  },
  {
    name: "Sonarr VO",
    category: "Series",
    host: "sonarvo",
    container: "sonarr-vo",
    description: "Series en versión original.",
    letter: "S",
    tone: "gain",
  },
  {
    name: "qBittorrent",
    category: "Descargas",
    host: "qbittorrent",
    container: "qbittorrent",
    description: "Transferencias, colas y actividad de torrents.",
    letter: "q",
    tone: "lilac",
  },
  {
    name: "Qui",
    category: "Descargas",
    host: "qui",
    container: "qui",
    description: "Otra vista de tus descargas.",
    letter: "Q",
    tone: "lilac",
  },
  {
    name: "Bazarr",
    category: "Tu biblioteca",
    host: "bazarr",
    container: "bazarr",
    description: "Subtítulos para películas y series.",
    letter: "B",
    tone: "peach",
  },
  {
    name: "Prowlarr",
    category: "Herramientas",
    host: "prowlarr",
    container: "prowlarr",
    description: "Indexadores y búsquedas.",
    letter: "P",
    tone: "accent",
  },
  {
    name: "Jackett",
    category: "Herramientas",
    host: "jackett",
    container: "jackett",
    description: "Conexiones con indexadores.",
    letter: "J",
    tone: "gain",
  },
  {
    name: "Filebrowser",
    category: "Herramientas",
    host: "file",
    container: "filebrowser",
    description: "Tu explorador de archivos existente.",
    letter: "F",
    tone: "peach",
  },
  {
    name: "Beszel",
    category: "Herramientas",
    host: "beszel",
    container: "beszel",
    description: "Tu monitorización existente.",
    letter: "B",
    tone: "gain",
  },
  {
    name: "Finanzas",
    category: "Personal",
    host: "finance",
    description: "Tu espacio de finanzas personales.",
    letter: "f",
    tone: "accent",
  },
  {
    name: "Balance",
    category: "Personal",
    host: "balance",
    description: "Tu aplicación de balance.",
    letter: "b",
    tone: "peach",
  },
];

export type ServiceStatus =
  | "healthy"
  | "running"
  | "starting"
  | "unhealthy"
  | "stopped"
  | "unknown";

export function serviceStatus(
  app: Application,
  containers: Container[] | undefined,
): ServiceStatus {
  const container = app.container
    ? containers?.find((c) => c.name === app.container)
    : undefined;
  if (!container) return "unknown";
  if (container.state !== "running") return "stopped";
  const health = containerHealth(container);
  return health === "none" ? "running" : health;
}


/** «Todas» primero y después un filtro por categoría, con id estable para la URL y los tests. */
export function appFilters(apps: Application[]) {
  const categories = [...new Set(apps.map((a) => a.category))];
  return [
    { id: "all", label: "Todas", items: apps },
    ...categories.map((category) => ({
      id: category
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-"),
      label: category,
      items: apps.filter((a) => a.category === category),
    })),
  ];
}
