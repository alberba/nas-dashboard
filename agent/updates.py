"""Container access links, image versions and Compose image updates.

The snapshot only reads Docker. The update action runs exactly one fixed
Compose invocation built from the container's own Compose labels; nothing in
the request becomes an argument except the validated container id.
"""
from __future__ import annotations

import concurrent.futures
import http.client
import re
import threading
import time

import lifecycle

COMPOSE_PROJECT = "com.docker.compose.project"
COMPOSE_SERVICE = "com.docker.compose.service"
COMPOSE_WORKING_DIR = "com.docker.compose.project.working_dir"
COMPOSE_CONFIG_FILES = "com.docker.compose.project.config_files"
COMPOSE_ENVIRONMENT_FILE = "com.docker.compose.project.environment_file"
DEFAULT_PROJECTS = {"instance": "media-stack", "apps-server": "media-stack-apps"}
DEFAULT_PROTECTED = ("hub-agent", "hub-agent-apps", "npm", "tailscale")

PROJECT_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
SERVICE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
IMAGE_ID = re.compile(r"^[a-f0-9]{12,64}$")
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
REFERENCE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,499}$")
HOST = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])$")
HOST_RULE = re.compile(
    r"Host\(\s*(?:`([^`]+)`|\"([^\"]+)\"|([A-Za-z0-9.*_-]+))\s*\)"
)
VERSION_LABELS = (
    "org.opencontainers.image.version",
    "org.label-schema.version",
    "version",
)
BUILD_VERSION = re.compile(r"version\s*:?-?\s*([0-9][0-9A-Za-z.+_-]{0,79})", re.I)
FLOATING_TAGS = frozenset(
    {
        "latest",
        "edge",
        "stable",
        "main",
        "master",
        "develop",
        "nightly",
        "unstable",
        "rolling",
        "current",
        "dev",
        "prod",
        "production",
    }
)


class CommandFailed(OSError):
    """The update ran but Compose failed; the service may be down."""


def protected_names(value=""):
    """Applicative names that are never updated from the hub."""
    names = set(DEFAULT_PROTECTED)
    for name in (value or "").split(","):
        name = name.strip()
        if name:
            names.add(name)
    return names


def split_reference(reference):
    """Returns ``(repository, tag, digest)`` for an image reference."""
    if not isinstance(reference, str):
        return None, None, None
    if re.fullmatch(r"sha256:[a-f0-9]{12,64}", reference):
        return None, None, None
    body, _, digest = reference.partition("@")
    if digest and not DIGEST.fullmatch(digest):
        digest = None
    slash, colon = body.rfind("/"), body.rfind(":")
    if colon > slash:
        return body[:colon], body[colon + 1 :] or None, digest or None
    return body or None, None, digest or None


def image_url(labels):
    """Public page for a container, from its own labels; never invented."""
    explicit = labels.get("hub.url") if isinstance(labels, dict) else None
    if isinstance(explicit, str):
        value = explicit.strip()
        if (
            len(value) <= 500
            and value.startswith(("http://", "https://"))
            and not any(ord(char) < 32 for char in value)
        ):
            return value
    if not isinstance(labels, dict):
        return None
    for key in sorted(labels):
        if not key.startswith("traefik.http.routers.") or not key.endswith(".rule"):
            continue
        rule = labels.get(key)
        if not isinstance(rule, str):
            continue
        for match in HOST_RULE.finditer(rule):
            host = next((group for group in match.groups() if group), "")
            host = host.strip().lower()
            if "*" in host or "." not in host or not HOST.fullmatch(host):
                continue
            return "https://" + host
    return None


def clean_version(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > 80:
        return None
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        return None
    return value


def version_from_labels(labels):
    if not isinstance(labels, dict):
        return None
    for key in VERSION_LABELS:
        value = clean_version(labels.get(key))
        if value:
            return value
    match = BUILD_VERSION.search(labels.get("build_version") or "")
    return clean_version(match.group(1)) if match else None


def image_version(reference, labels):
    """A readable version: image label first, then a non-floating tag."""
    labeled = version_from_labels(labels)
    if labeled:
        return labeled
    _, tag, digest = split_reference(reference)
    if digest:
        return digest.split(":", 1)[1][:12]
    if tag and tag.lower() not in FLOATING_TAGS:
        return clean_version(tag)
    return None


def _path(value):
    if not isinstance(value, str) or not value:
        return None
    value = value.strip()
    if (
        len(value) > 500
        or not value.startswith("/")
        or any(ord(char) < 32 for char in value)
    ):
        return None
    return value


def compose_argv(item, *, role="instance", stack_path=None):
    """Fixed Compose argv for one container, or ``ValueError`` when unsafe."""
    labels = lifecycle.labels_of(item)
    project = labels.get(COMPOSE_PROJECT)
    service = labels.get(COMPOSE_SERVICE)
    if not isinstance(project, str) or not PROJECT_NAME.fullmatch(project):
        raise ValueError("El contenedor no pertenece a un proyecto de Compose")
    if not isinstance(service, str) or not SERVICE_NAME.fullmatch(service):
        raise ValueError("El contenedor no declara un servicio de Compose")
    files = [
        path
        for path in (
            _path(entry)
            for entry in (labels.get(COMPOSE_CONFIG_FILES) or "").split(",")
        )
        if path
    ]
    working = _path(labels.get(COMPOSE_WORKING_DIR))
    if not files and not working:
        default = stack_path if project == DEFAULT_PROJECTS.get(role) else None
        working = _path(default)
    if not files and not working:
        raise ValueError("El contenedor no declara dónde está su Compose")
    argv = ["docker", "compose", "-p", project]
    if working:
        argv += ["--project-directory", working]
    for path in files:
        argv += ["-f", path]
    environment = _path(labels.get(COMPOSE_ENVIRONMENT_FILE))
    if environment:
        argv += ["--env-file", environment]
    return argv, service


def can_update(item, *, role="instance", stack_path=None, protected=()):
    if lifecycle.name_of(item) in protected:
        return False
    if lifecycle.state_of(item) != "running":
        return False
    if lifecycle.one_shot_of(item):
        return False
    try:
        compose_argv(item, role=role, stack_path=stack_path)
    except ValueError:
        return False
    return True


def update_plan(item, *, role="instance", stack_path=None, protected=()):
    """Validates one update and returns ``(base_argv, service, name)``."""
    name = lifecycle.name_of(item)
    if name in protected:
        raise ValueError("Servicio de infraestructura protegido")
    if lifecycle.state_of(item) != "running":
        raise ValueError("El contenedor debe estar en ejecución para actualizarse")
    if lifecycle.one_shot_of(item):
        raise ValueError("Los contenedores de un solo uso no se actualizan")
    argv, service = compose_argv(item, role=role, stack_path=stack_path)
    return argv, service, name


def run_update(
    docker,
    executor,
    ident,
    *,
    role="instance",
    stack_path=None,
    protected=None,
    pull_timeout=240,
    up_timeout=180,
):
    """Pulls the service image and recreates it. Never retried by the caller."""
    if not lifecycle.valid_id(ident):
        raise ValueError("Contenedor no válido")
    if protected is None:
        protected = protected_names()
    item = docker.call("GET", "/containers/" + ident + "/json")
    if not isinstance(item, dict):
        raise ValueError("Docker devolvió un contenedor no válido")
    argv, service, name = update_plan(
        item, role=role, stack_path=stack_path, protected=protected
    )
    status, _ = executor.run_status(
        argv + ["pull", service], timeout=pull_timeout
    )
    if status != 0:
        raise ValueError("No se pudo descargar la imagen nueva del registro")
    status, _ = executor.run_status(
        argv + ["up", "-d", "--no-deps", service], timeout=up_timeout
    )
    if status != 0:
        raise CommandFailed(
            "La imagen se descargó, pero el contenedor no se pudo recrear"
        )
    return {
        "state": "updated",
        "name": name,
        "service": service,
        "image": item.get("Image") if isinstance(item.get("Image"), str) else None,
    }


class RegistryChecker:
    """Compares the local image digest with the registry manifest, with a TTL."""

    def __init__(self, docker, clock=time.time, ttl=3 * 3600, timeout=3):
        self.docker = docker
        self.clock = clock
        try:
            self.ttl = max(0.0, float(ttl))
        except (TypeError, ValueError):
            self.ttl = 3600.0
        self.timeout = timeout
        self._cache = {}
        self._lock = threading.Lock()

    def invalidate(self, reference=None):
        with self._lock:
            if reference is None:
                self._cache.clear()
            else:
                self._cache.pop(reference, None)

    def _local_digest(self, reference, digests):
        _, _, pinned = split_reference(reference)
        if pinned:
            return pinned
        repository, _, _ = split_reference(reference)
        if not repository:
            return None
        for value in digests if isinstance(digests, list) else []:
            if not isinstance(value, str):
                continue
            name, _, digest = value.partition("@")
            if name == repository and DIGEST.fullmatch(digest):
                return digest
        return None

    def check(self, reference, digests):
        """``{"available": bool|None, "checkedAt": float|None}``; never raises."""
        if not isinstance(reference, str) or not REFERENCE.fullmatch(reference):
            return {"available": None, "checkedAt": None}
        _, _, pinned = split_reference(reference)
        if pinned:
            return {"available": False, "checkedAt": self.clock()}
        now = self.clock()
        with self._lock:
            cached = self._cache.get(reference)
        if cached and now - cached["at"] < self.ttl:
            return {"available": cached["available"], "checkedAt": cached["at"]}
        local = self._local_digest(reference, digests)
        available = None
        try:
            manifest = self.docker.call(
                "GET", "/distribution/" + reference + "/json", timeout=self.timeout
            )
            descriptor = manifest.get("Descriptor") if isinstance(manifest, dict) else None
            remote = descriptor.get("digest") if isinstance(descriptor, dict) else None
            if local and isinstance(remote, str) and DIGEST.fullmatch(remote):
                available = remote != local
        except (OSError, ValueError, http.client.HTTPException):
            available = None
        with self._lock:
            self._cache[reference] = {"available": available, "at": now}
        return {"available": available, "checkedAt": now}


class ContainerUpdates:
    """Read-only per-container access, version and update availability."""

    def __init__(
        self,
        docker,
        *,
        role="instance",
        stack_path=None,
        protected=(),
        clock=time.time,
        registry_ttl=3 * 3600,
        registry_timeout=3,
        max_images=500,
    ):
        self.docker = docker
        self.role = role if role in DEFAULT_PROJECTS else "instance"
        self.stack_path = stack_path
        self.protected = set(protected)
        self.clock = clock
        self.max_images = max_images
        self.registry = RegistryChecker(
            docker, clock=clock, ttl=registry_ttl, timeout=registry_timeout
        )
        self._images = {}
        self._lock = threading.Lock()

    def invalidate(self, reference=None):
        self.registry.invalidate(reference)

    def _image(self, image_id):
        if not isinstance(image_id, str):
            return {}
        ident = image_id[len("sha256:") :] if image_id.startswith("sha256:") else image_id
        if not IMAGE_ID.fullmatch(ident):
            return {}
        key = "sha256:" + ident
        with self._lock:
            if key in self._images:
                return self._images[key]
        try:
            value = self.docker.call("GET", "/images/" + key + "/json", timeout=5)
        except (OSError, ValueError, http.client.HTTPException):
            return {}
        value = value if isinstance(value, dict) else {}
        config = value.get("Config") if isinstance(value.get("Config"), dict) else {}
        labels = config.get("Labels") if isinstance(config.get("Labels"), dict) else {}
        digests = value.get("RepoDigests") if isinstance(value.get("RepoDigests"), list) else []
        info = {
            "labels": labels,
            "digests": [item for item in digests if isinstance(item, str)],
        }
        with self._lock:
            if len(self._images) >= self.max_images:
                self._images.clear()
            self._images[key] = info
        return info

    def _entry(self, item):
        ident = item.get("Id")
        if not isinstance(ident, str) or not ident:
            return None
        name = lifecycle.name_of(item)
        reference = item.get("Image") if isinstance(item.get("Image"), str) else None
        info = self._image(item.get("ImageID"))
        labels = info.get("labels") or {}
        version = image_version(reference, labels)
        updatable = can_update(
            item,
            role=self.role,
            stack_path=self.stack_path,
            protected=self.protected,
        ) and bool(info.get("digests"))
        check = (
            self.registry.check(reference, info.get("digests") or [])
            if updatable
            else {"available": None, "checkedAt": None}
        )
        return {
            "id": ident,
            "name": name,
            "image": reference,
            "version": version,
            "tag": split_reference(reference)[1],
            "url": image_url(lifecycle.labels_of(item)),
            "canUpdate": updatable,
            "updateAvailable": check["available"],
            "checkedAt": check["checkedAt"],
        }

    def read(self):
        items = self.docker.call("GET", "/containers/json?all=1")
        if not isinstance(items, list):
            raise OSError("Docker devolvió una lista de contenedores no válida")
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            entries = list(pool.map(self._entry, items))
        return {
            "available": True,
            "items": sorted(
                (entry for entry in entries if entry), key=lambda entry: entry["name"]
            ),
        }
