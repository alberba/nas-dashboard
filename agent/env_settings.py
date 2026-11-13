"""Write missing settings for one retained media-stack release.

Only the Instance exposes this operation. The agent accepts a name only when
the release asks for it, the media-stack catalog declares it for this role and
the current ``.env`` does not contain it. Values are never returned, logged or
stored in an operation; the response carries names only.

The ``.env`` lives in a dedicated writable directory (``MEDIA_STACK_ENV_PATH``)
so it can be replaced with ``rename`` while the checkout and the app data stay
read-only. Every write keeps the previous bytes in a new backup file, uses a
lock for concurrent requests, refuses symlinks and re-checks the inode and bytes
just before the atomic replacement.
"""
from __future__ import annotations

import contextlib
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import stat
import time

import deployments

MAX_REQUEST_BYTES = 64 * 1024
MAX_ENV_BYTES = 1024 * 1024
MAX_SETTINGS = 64
MAX_VALUE = 4096
MAX_NAME = 80

CATALOG_PATH = "env/catalog.json"
KEY = re.compile(r"^[A-Z_][A-Z0-9_]{0,%d}$" % (MAX_NAME - 1))
CONTROL = re.compile(r"[\x00-\x1f\x7f]")
SPECIAL = re.compile(r"[\s#'\"$\\]")
LOCK_NAME = ".env.lock"
TEMP_PREFIX = ".env.tmp-"
BACKUP_PREFIX = ".env.backup-"


class EnvSettingsError(ValueError):
    """A request that cannot be written; the message never contains values."""


def quote_value(value):
    """Write a literal value in Compose's .env syntax without shell evaluation."""
    if not SPECIAL.search(value):
        return value
    if "'" not in value:
        return f"'{value}'"
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$")
    return f'"{escaped}"'


def _env_text(data):
    return data.decode("utf-8", "surrogateescape")


def _parse_env_text(text):
    return deployments.parse_env(text)


def _release_env(role):
    return (
        "apps-server/.env.example"
        if role == "apps-server"
        else ".env.example"
    )


def _example_names(git, release, role):
    example = git.text_at(release, _release_env(role))
    if example is None:
        return None
    names = []
    for line in example.splitlines():
        match = deployments.ENV_ASSIGNMENT.match(line)
        if match and match.group(1) not in names:
            names.append(match.group(1))
    return names


def catalog_setting(document, name, role):
    """Kept as the public module seam; deployments owns the catalog shape."""
    return deployments.catalog_setting(document, name, role)


def _append_assignments(data, values, order):
    text = _env_text(data)
    if text and not text.endswith("\n"):
        text += "\n"
    for name in order:
        if name in values:
            text += f"{name}={quote_value(values[name])}\n"
    return text.encode("utf-8", "surrogateescape")


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError(errno.EIO, "No se pudo escribir el fichero")
        view = view[written:]


class EnvSettings:
    """Applies the missing settings of one retained release to the Instance."""

    def __init__(self, deploy, env_file=None):
        self.deployments = deploy
        self.env_file = Path(env_file or deploy.env_file)
        self.name = self.env_file.name
        if (
            not self.name
            or self.name in (".", "..")
            or "/" in self.name
            or "\\" in self.name
        ):
            raise EnvSettingsError("La ruta del .env no es válida")
        self.directory = self.env_file.parent

    @classmethod
    def from_env(cls):
        deploy = deployments.Deployments.from_env()
        return cls(deploy)

    def _entry(self, release):
        snapshot = self.deployments.snapshot()
        entry = next(
            (
                item
                for item in snapshot.get("retained", [])
                if item.get("release") == release
            ),
            None,
        )
        if entry is None:
            raise EnvSettingsError("La release no está retenida en este host")
        return entry

    def _request(self, body):
        if not isinstance(body, dict):
            raise EnvSettingsError("Solicitud no válida")
        if set(body) - {"release", "values", "acknowledgedManualSteps"}:
            raise EnvSettingsError("Solicitud no válida")
        release = body.get("release")
        values = body.get("values")
        acknowledged = body.get("acknowledgedManualSteps", False)
        if (
            not isinstance(release, str)
            or not deployments.RELEASE_TAG.fullmatch(release)
        ):
            raise EnvSettingsError("Release no válida")
        if not isinstance(acknowledged, bool):
            raise EnvSettingsError("Solicitud no válida")
        if not isinstance(values, dict) or not values or len(values) > MAX_SETTINGS:
            raise EnvSettingsError("Solicitud no válida")
        for name, value in values.items():
            if not isinstance(name, str) or not KEY.fullmatch(name):
                raise EnvSettingsError("Nombre de ajuste no válido")
            if not isinstance(value, str) or len(value) > MAX_VALUE:
                raise EnvSettingsError(f"El valor de {name} no es válido")
            if CONTROL.search(value):
                raise EnvSettingsError(f"El valor de {name} no es válido")
        return release, values, acknowledged

    def _catalog(self, release):
        document = self.deployments.git.json_at(release, CATALOG_PATH)
        if not isinstance(document, dict):
            raise EnvSettingsError(
                "La release no declara el catálogo de ajustes de media-stack"
            )
        return document

    def _validate(self, document, role, values, missing):
        unknown = [
            name
            for name in values
            if name not in missing or catalog_setting(document, name, role) is None
        ]
        if unknown:
            raise EnvSettingsError(
                f"El ajuste {unknown[0]} no está en el catálogo de la release"
            )
        for name in values:
            setting = catalog_setting(document, name, role)
            value = values[name]
            if setting.get("pattern") and value and not re.fullmatch(
                setting["pattern"], value
            ):
                detail = setting.get("pattern_description")
                suffix = f": {detail}" if isinstance(detail, str) and detail else ""
                raise EnvSettingsError(
                    f"El valor de {name} no tiene el formato esperado{suffix}"
                )
            choices = setting.get("choices")
            if isinstance(choices, list) and value and value not in choices:
                raise EnvSettingsError(
                    f"El valor de {name} no es una opción válida"
                )
            if setting.get("required") is True and not value:
                raise EnvSettingsError(f"El ajuste {name} es obligatorio")

    def _read_env(self, directory_fd):
        try:
            fd = os.open(
                self.name,
                os.O_RDONLY | os.O_NOFOLLOW,
                dir_fd=directory_fd,
            )
        except FileNotFoundError as error:
            raise EnvSettingsError(
                "El fichero .env de la Instancia no está disponible"
            ) from error
        except OSError as error:
            if error.errno in (errno.ELOOP, errno.ENOTDIR):
                raise EnvSettingsError(
                    "El fichero .env de la Instancia no es un fichero regular"
                ) from error
            raise
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise EnvSettingsError(
                    "El fichero .env de la Instancia no es un fichero regular"
                )
            if info.st_size > MAX_ENV_BYTES:
                raise EnvSettingsError(
                    "El fichero .env de la Instancia es demasiado grande"
                )
            chunks = []
            remaining = MAX_ENV_BYTES + 1
            while remaining:
                chunk = os.read(fd, min(65536, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
            if len(data) > MAX_ENV_BYTES:
                raise EnvSettingsError(
                    "El fichero .env de la Instancia es demasiado grande"
                )
            return data, info
        finally:
            os.close(fd)

    @contextlib.contextmanager
    def _locked(self, directory_fd):
        try:
            fd = os.open(
                LOCK_NAME,
                os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
                0o600,
                dir_fd=directory_fd,
            )
        except OSError as error:
            if error.errno in (errno.ELOOP, errno.ENOTDIR):
                raise EnvSettingsError(
                    "El bloqueo del .env no es un fichero regular"
                ) from error
            raise
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)

    def _write_backup(self, directory_fd, data):
        for _ in range(5):
            name = f"{self.name}{BACKUP_PREFIX[len('.env'):]}-{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}-{secrets.token_hex(6)}"
            try:
                fd = os.open(
                    name,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o600,
                    dir_fd=directory_fd,
                )
            except FileExistsError:
                continue
            try:
                _write_all(fd, data)
                os.fsync(fd)
            finally:
                os.close(fd)
            return name
        raise OSError(errno.EEXIST, "No se pudo crear la copia previa")

    def _write_temp(self, directory_fd, data, info):
        for _ in range(5):
            name = f"{self.name}.tmp-{os.getpid()}-{secrets.token_hex(6)}"
            try:
                fd = os.open(
                    name,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    stat.S_IMODE(info.st_mode),
                    dir_fd=directory_fd,
                )
            except FileExistsError:
                continue
            try:
                try:
                    os.fchmod(fd, stat.S_IMODE(info.st_mode))
                except OSError:
                    pass
                try:
                    os.fchown(fd, info.st_uid, info.st_gid)
                except OSError:
                    pass
                _write_all(fd, data)
                os.fsync(fd)
            finally:
                os.close(fd)
            return name
        raise OSError(errno.EEXIST, "No se pudo preparar el nuevo .env")

    def _same_file(self, directory_fd, name, info):
        try:
            current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except OSError:
            return False
        return (
            stat.S_ISREG(current.st_mode)
            and current.st_dev == info.st_dev
            and current.st_ino == info.st_ino
        )

    def _unchanged(self, directory_fd, info, data):
        """Re-read the file just before replacing it; detect an external edit."""
        if not self._same_file(directory_fd, self.name, info):
            return False
        try:
            fd = os.open(
                self.name,
                os.O_RDONLY | os.O_NOFOLLOW,
                dir_fd=directory_fd,
            )
        except OSError:
            return False
        try:
            current = os.fstat(fd)
            if current.st_size != len(data):
                return False
            chunks = []
            remaining = len(data) + 1
            while remaining:
                chunk = os.read(fd, min(65536, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            return b"".join(chunks) == data
        finally:
            os.close(fd)

    def save(self, body):
        release, values, acknowledged = self._request(body)
        if self.deployments.role != "instance":
            raise EnvSettingsError(
                "Los ajustes solo se escriben en la Instancia"
            )
        entry = self._entry(release)
        if entry.get("manualSteps") and acknowledged is not True:
            raise EnvSettingsError(
                "Marca que has leído los pasos manuales antes de guardar"
            )
        document = self._catalog(release)
        example = _example_names(self.deployments.git, release, self.deployments.role)
        if example is None:
            raise EnvSettingsError(
                "La release no declara los ajustes que necesita"
            )
        try:
            directory_fd = os.open(
                self.directory,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            )
        except OSError as error:
            raise EnvSettingsError(
                "El directorio del .env de la Instancia no está disponible"
            ) from error
        try:
            with self._locked(directory_fd):
                data, info = self._read_env(directory_fd)
                present = _parse_env_text(_env_text(data))
                missing = [name for name in example if name not in present]
                self._validate(
                    document,
                    self.deployments.role,
                    values,
                    missing,
                )
                saved = [name for name in missing if name in values]
                if not saved:
                    raise EnvSettingsError(
                        "Ninguno de los ajustes enviados falta en esta release"
                    )
                new_data = _append_assignments(data, values, missing)
                temp = self._write_temp(directory_fd, new_data, info)
                try:
                    self._write_backup(directory_fd, data)
                    if not self._unchanged(directory_fd, info, data):
                        raise EnvSettingsError(
                            "El fichero .env cambió durante la operación"
                        )
                    os.replace(
                        temp,
                        self.name,
                        src_dir_fd=directory_fd,
                        dst_dir_fd=directory_fd,
                    )
                    temp = None
                    os.fsync(directory_fd)
                finally:
                    if temp is not None:
                        try:
                            os.unlink(temp, dir_fd=directory_fd)
                        except OSError:
                            pass
                new_present = dict(present)
                for name in saved:
                    new_present[name] = ""
                remaining = [name for name in example if name not in new_present]
        finally:
            os.close(directory_fd)
        invalidate = getattr(self.deployments, "invalidate", None)
        if callable(invalidate):
            invalidate()
        return {
            "release": release,
            "saved": saved,
            "missingSettings": remaining,
        }
