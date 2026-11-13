"""Fixed maintenance actions for backups, image cleanup, health and Wiring.

The request only carries the action name. Every Docker exec, Docker request and
host argv is fixed here; nothing from the request becomes an argument.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re

import maintenance

COMMAND_NAMES = frozenset(
    {
        "backup-now",
        "clean-images",
        "check-health",
        "reconnect-apps",
    }
)
IMAGE_ID = re.compile(r"^[a-f0-9]{12,64}$")
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")
DEFAULT_PROJECTS = {"instance": "media-stack", "apps-server": "media-stack-apps"}
ONE_SHOT_SERVICES = {"wire", "wire-seed"}


class CommandFailed(OSError):
    """The action ran but the host reported a failure; state may have changed."""


def _container(all_containers, names):
    wanted = {"/" + name for name in names}
    for container in all_containers:
        listed = container.get("Names") if isinstance(container, dict) else None
        if isinstance(listed, list) and wanted.intersection(listed):
            return container
    return None


def _image_id(value):
    if not isinstance(value, str):
        return None
    if value.startswith("sha256:"):
        value = value[len("sha256:") :]
    return "sha256:" + value if IMAGE_ID.fullmatch(value) else None


def _read_state(path):
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        raise ValueError("No se pudo leer el estado de rollback") from None
    if not isinstance(value, dict):
        raise ValueError("No se pudo leer el estado de rollback")
    return value


def _reference(value, *, required=False):
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > 500:
        raise ValueError("No se pudo leer el estado de rollback")
    return value.strip()


def _pin_images(document):
    services = document.get("services")
    if not isinstance(services, dict):
        raise ValueError("No se pudo leer el estado de rollback")
    references = []
    for entry in services.values():
        if not isinstance(entry, dict):
            raise ValueError("No se pudo leer el estado de rollback")
        references.append(_reference(entry.get("image"), required=True))
    return references


def _preserve_reference(ids, references, value):
    reference = _reference(value, required=True)
    references.add(reference)
    ident = _image_id(reference)
    if ident:
        ids.add(ident)


def rollback_images(appdata):
    """Reads every image a pending rollback may need. A bad file fails closed."""
    appdata = Path(appdata)
    if not appdata.is_dir():
        raise ValueError("No se pudo leer el estado de rollback")
    monitor = appdata / "security-monitor"
    ids, references = set(), set()

    pins = monitor / "images.compose.json"
    if pins.exists():
        for reference in _pin_images(_read_state(pins)):
            _preserve_reference(ids, references, reference)

    active = monitor / "active-update.json"
    if active.exists():
        transaction = _read_state(active)
        old_id = _image_id(transaction.get("old_id"))
        if old_id is None:
            raise ValueError("No se pudo leer el estado de rollback")
        ids.add(old_id)
        _preserve_reference(ids, references, transaction.get("old_pin"))
        before = transaction.get("before_pins")
        if before is not None:
            for reference in _pin_images(before):
                _preserve_reference(ids, references, reference)

    pending = monitor / "merged-releases" / "pending.json"
    if pending.exists():
        transaction = _read_state(pending)
        images = transaction.get("images")
        if images is not None:
            if not isinstance(images, dict):
                raise ValueError("No se pudo leer el estado de rollback")
            for entry in images.values():
                if not isinstance(entry, dict):
                    raise ValueError("No se pudo leer el estado de rollback")
                old_id = _image_id(entry.get("id"))
                if old_id is None:
                    raise ValueError("No se pudo leer el estado de rollback")
                ids.add(old_id)
                reference = _reference(entry.get("reference"))
                if reference:
                    _preserve_reference(ids, references, reference)

    return ids, references


def _split_reference(value):
    body, _, digest = value.partition("@")
    slash, colon = body.rfind("/"), body.rfind(":")
    repository = body[:colon] if colon > slash else body
    tag = body[colon + 1 :] if colon > slash else None
    return repository, tag, digest or None


def _preserved(image, ids, references):
    ident = _image_id(image.get("Id"))
    if ident and ident in ids:
        return True
    tags = image.get("RepoTags")
    tags = tags if isinstance(tags, list) else []
    digests = image.get("RepoDigests")
    digests = digests if isinstance(digests, list) else []
    for value in tags + digests:
        if not isinstance(value, str):
            continue
        if value in references:
            return True
        repository, _, digest = _split_reference(value)
        for reference in references:
            other_repository, _, other_digest = _split_reference(reference)
            if (
                digest
                and other_digest == digest
                and repository == other_repository
                and DIGEST.fullmatch(digest)
            ):
                return True
    return False


class MaintenanceActions:
    """Runs the #20 maintenance actions with fixed commands."""

    def __init__(
        self,
        *,
        appdata,
        role="instance",
        checkout=None,
        docker=None,
        executor=None,
    ):
        self.appdata = Path(appdata)
        self.role = role if role in ("instance", "apps-server") else "instance"
        self.project = DEFAULT_PROJECTS[self.role]
        self.checkout = checkout
        self.docker = docker or maintenance.DockerSocket(timeout=8)
        self.executor = executor or maintenance.HostExecutor()

    @classmethod
    def from_env(cls):
        return cls(
            appdata=os.getenv("APPDATA_ROOT", "/media-stack-appdata"),
            role=os.getenv("HOST_ROLE", "instance"),
            checkout=os.getenv("MEDIA_STACK_CHECKOUT_PATH"),
        )

    def execute(self, command):
        handlers = {
            "backup-now": self.backup_now,
            "clean-images": self.clean_images,
            "check-health": self.check_health,
            "reconnect-apps": self.reconnect_apps,
        }
        handler = handlers.get(command)
        if handler is None:
            raise ValueError("Comando de host no permitido")
        return {"command": command, "status": "success", **handler()}

    def _containers(self):
        containers = self.docker.call("GET", "/containers/json?all=1")
        if not isinstance(containers, list):
            raise OSError("Docker devolvió una lista de contenedores no válida")
        return containers

    def backup_now(self):
        container = _container(self._containers(), ("backup",))
        if container is None:
            raise ValueError("El contenedor backup no está disponible")
        if container.get("State") != "running":
            raise ValueError("El contenedor backup no está en ejecución")
        created = self.docker.call(
            "POST",
            "/containers/backup/exec",
            {
                "AttachStdout": False,
                "AttachStderr": False,
                "Cmd": ["media-backup", "run"],
            },
        )
        ident = created.get("Id") if isinstance(created, dict) else None
        if not isinstance(ident, str) or not IMAGE_ID.fullmatch(ident):
            raise OSError("Docker no pudo crear la ejecución de la copia")
        self.docker.call("POST", "/exec/" + ident + "/start", {"Detach": True})
        return {
            "backup": {
                "started": True,
                "lastStatus": maintenance.backup_section(self.appdata),
            }
        }

    def clean_images(self):
        """Deletes unused, non-rollback images one by one; never runs a prune."""
        preserved_ids, preserved_refs = rollback_images(self.appdata)
        images = self.docker.call("GET", "/images/json")
        if not isinstance(images, list):
            raise OSError("Docker devolvió una lista de imágenes no válida")
        containers = self._containers()
        used = {
            _image_id(container.get("ImageID"))
            for container in containers
            if isinstance(container, dict)
        }
        used.discard(None)

        candidates = []
        preserved = 0
        for image in images:
            if not isinstance(image, dict):
                continue
            ident = _image_id(image.get("Id"))
            if ident is None or ident in used:
                continue
            count = image.get("Containers")
            if isinstance(count, (int, float)) and count > 0:
                continue
            if _preserved(image, preserved_ids, preserved_refs):
                preserved += 1
                continue
            candidates.append(image)

        def created(image):
            value = image.get("Created")
            return value if isinstance(value, (int, float)) else 0

        removed, failed, reclaimed = 0, 0, 0
        for image in sorted(candidates, key=created, reverse=True):
            ident = _image_id(image.get("Id"))
            if ident is None:
                failed += 1
                continue
            try:
                self.docker.call(
                    "DELETE", "/images/" + ident + "?force=0&noprune=1"
                )
            except OSError:
                failed += 1
                continue
            removed += 1
            size = image.get("Size")
            if isinstance(size, (int, float)) and size > 0:
                reclaimed += int(size)
        return {
            "cleanup": {
                "reclaimedBytes": reclaimed,
                "imagesRemoved": removed,
                "imagesPreserved": preserved,
                "imagesFailed": failed,
            }
        }

    def _inspect(self, container):
        ident = container.get("Id") if isinstance(container, dict) else None
        if not isinstance(ident, str) or not IMAGE_ID.fullmatch(ident):
            names = container.get("Names") if isinstance(container, dict) else None
            name = names[0].lstrip("/") if isinstance(names, list) and names else None
            ident = name
        if not isinstance(ident, str) or not ident:
            raise OSError("Docker devolvió un contenedor no válido")
        value = self.docker.call("GET", "/containers/" + ident + "/json")
        return value if isinstance(value, dict) else {}

    @staticmethod
    def _state(inspect):
        state = inspect.get("State")
        state = state if isinstance(state, dict) else {}
        running = bool(state.get("Running"))
        health = state.get("Health")
        health = health.get("Status") if isinstance(health, dict) else None
        return {
            "running": running,
            "state": state.get("Status"),
            "health": health,
            "healthy": running and health in (None, "healthy"),
        }

    def check_health(self):
        """Reports VPN and app health from Docker for this host's project."""
        containers = self._containers()
        media = []
        for container in containers:
            labels = container.get("Labels") if isinstance(container, dict) else None
            labels = labels if isinstance(labels, dict) else {}
            if labels.get("com.docker.compose.project") != self.project:
                continue
            media.append((container, labels))

        vpn = {
            "applicable": self.role == "instance",
            "connected": None,
            "state": None,
            "health": None,
        }
        vpn_found = False
        apps = []
        for container, labels in media:
            service = labels.get("com.docker.compose.service")
            try:
                inspected = self._inspect(container)
            except OSError:
                inspected = {}
            current = self._state(inspected)
            names = container.get("Names")
            name = (
                names[0].lstrip("/")
                if isinstance(names, list) and names and isinstance(names[0], str)
                else service
            )
            if service == "gluetun":
                if self.role == "instance":
                    vpn_found = True
                    vpn.update(
                        {
                            "connected": current["running"]
                            and current["health"] == "healthy",
                            "state": current["state"],
                            "health": current["health"],
                        }
                    )
                continue
            if service in ONE_SHOT_SERVICES:
                continue
            apps.append(
                {
                    "name": name,
                    "service": service,
                    "state": current["state"],
                    "health": current["health"],
                    "healthy": current["healthy"],
                }
            )
        if self.role == "instance" and not vpn_found:
            vpn["connected"] = False
        apps.sort(key=lambda app: app["name"] or "")
        healthy = all(app["healthy"] for app in apps) and vpn["connected"] is not False
        return {"health": {"vpn": vpn, "apps": apps, "healthy": healthy}}

    def reconnect_apps(self):
        """Runs media-stack's documented Wiring command for the instance role."""
        if self.role != "instance":
            raise ValueError("La Wiring no está disponible en este rol")
        checkout = self.checkout
        if (
            not isinstance(checkout, str)
            or not checkout.startswith("/")
            or "\n" in checkout
            or "\r" in checkout
        ):
            raise ValueError("La ruta del checkout de media-stack no está configurada")
        argv = [
            "docker",
            "compose",
            "--project-directory",
            checkout,
            "--env-file",
            checkout.rstrip("/") + "/.env",
            "up",
            "-d",
            "--no-deps",
            "wire",
        ]
        status, _ = self.executor.run_status(argv, timeout=60)
        if status != 0:
            raise CommandFailed("La Wiring no pudo completar la operación")
        return {"wiring": {"started": True}}
