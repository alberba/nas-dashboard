"""Read-only maintenance snapshot built from media-stack state and host reads."""
from __future__ import annotations

import concurrent.futures
import contextlib
import http.client
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import socket
import threading
import time

import smart

INSTANCE_UNITS = (
    "media-stack-merged-updates",
    "media-stack-security-updates",
    "media-stack-evidence",
    "media-stack-tdarr-hardlinks",
    "media-stack-backup",
)
APPS_UNITS = (
    "media-stack-apps-merged-updates",
    "media-stack-apps-security-updates",
)
DEFAULT_UNITS = {"instance": INSTANCE_UNITS, "apps-server": APPS_UNITS}
UNIT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,200}$")


def _text(value, limit=200):
    return value[:limit] if isinstance(value, str) else None


def _iso(epoch):
    if epoch is None:
        return None
    try:
        return (
            datetime.fromtimestamp(float(epoch), timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
    except (OverflowError, OSError, TypeError, ValueError):
        return None


def _file_time(path):
    try:
        return _iso(path.stat().st_mtime)
    except OSError:
        return None


def _read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def _iso_from_text(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _image_version(reference):
    if not isinstance(reference, str):
        return None
    name = reference.split("@", 1)[0]
    last = name.rsplit("/", 1)[-1]
    return _text(last.rsplit(":", 1)[1], 80) if ":" in last else None


def _image_digest(reference):
    if not isinstance(reference, str) or "@" not in reference:
        return None
    digest = reference.rsplit("@", 1)[1]
    return digest if re.fullmatch(r"sha256:[a-f0-9]{64}", digest) else None


def parse_unit_names(value, role):
    configured = [name.strip() for name in (value or "").split(",") if name.strip()]
    names = configured or list(DEFAULT_UNITS.get(role, INSTANCE_UNITS))
    result = []
    for name in names:
        for suffix in (".service", ".timer"):
            if name.endswith(suffix):
                name = name[: -len(suffix)]
        if UNIT_NAME.fullmatch(name) and name not in result:
            result.append(name)
    return result or list(DEFAULT_UNITS.get(role, INSTANCE_UNITS))


def follower_section(appdata):
    state = appdata / "security-monitor" / "merged-releases"
    installed = _read_json(state / "installed.json")
    pending = _read_json(state / "pending.json")
    failed = _read_json(state / "failed-release.json")
    installed = (
        {
            "release": _text(installed.get("release"), 80),
            "commit": _text(installed.get("commit"), 64),
            "bootstrap": bool(installed.get("bootstrap")),
            "installedAt": _file_time(state / "installed.json"),
        }
        if isinstance(installed, dict) and _text(installed.get("release"), 80)
        else None
    )
    changed = pending.get("changed") if isinstance(pending, dict) else None
    changed = changed if isinstance(changed, list) else []
    previous = pending.get("previous_installed") if isinstance(pending, dict) else None
    pending = (
        {
            "release": _text(pending.get("release"), 80),
            "status": _text(pending.get("status"), 40),
            "previousRelease": _text(previous.get("release"), 80)
            if isinstance(previous, dict)
            else None,
            "changed": [
                name for name in (_text(item, 100) for item in changed[:50]) if name
            ],
            "since": _file_time(state / "pending.json"),
        }
        if isinstance(pending, dict) and _text(pending.get("release"), 80)
        else None
    )
    failed = (
        {
            "release": _text(failed.get("release"), 80),
            "since": _file_time(state / "failed-release.json"),
        }
        if isinstance(failed, dict) and _text(failed.get("release"), 80)
        else None
    )
    if pending:
        state_name = "deploying"
    elif installed:
        state_name = "idle"
    elif failed:
        state_name = "failed"
    else:
        state_name = "unknown"
    return {
        "available": state.is_dir(),
        "state": state_name,
        "installed": installed,
        "pending": pending,
        "failed": failed,
    }


def security_section(appdata):
    state = appdata / "security-monitor"
    pins_raw = _read_json(state / "images.compose.json")
    pins = []
    services = pins_raw.get("services") if isinstance(pins_raw, dict) else None
    if isinstance(services, dict):
        for service, entry in sorted(services.items())[:100]:
            image = _text(entry.get("image"), 500) if isinstance(entry, dict) else None
            if not image:
                continue
            pins.append(
                {
                    "service": _text(service, 100),
                    "image": image,
                    "version": _image_version(image),
                    "digest": _image_digest(image),
                }
            )
    pending_raw = _read_json(state / "active-update.json")
    pending = None
    if isinstance(pending_raw, dict) and _text(pending_raw.get("service"), 100):
        candidate_ref = _text(pending_raw.get("candidate_ref"), 500)
        pending = {
            "service": _text(pending_raw.get("service"), 100),
            "status": _text(pending_raw.get("status"), 40),
            "candidate": _image_version(candidate_ref),
            "candidateRef": candidate_ref,
            "since": _file_time(state / "active-update.json"),
        }
    review = []
    attempted_raw = _read_json(state / "attempted-updates.json")
    attempts = (
        [entry for entry in attempted_raw.values() if isinstance(entry, dict)]
        if isinstance(attempted_raw, dict)
        else []
    )
    for path in (state / "comparisons").glob("*.json"):
        plan = _read_json(path)
        if not isinstance(plan, dict) or not isinstance(plan.get("fixed"), dict):
            continue
        if not plan["fixed"]:
            continue
        names = plan.get("names")
        names = names if isinstance(names, list) else []
        names = [
            name for name in (_text(item, 100) for item in names[:20]) if name
        ]
        if not names:
            continue
        pinned_ref = plan.get("pinned_ref")
        related = [
            entry for entry in attempts if entry.get("candidate") == pinned_ref
        ]
        if any(
            str(entry.get("result") or "").startswith("actualizada")
            for entry in related
        ):
            continue
        reason = None
        for entry in related:
            result = _text(entry.get("result"), 200)
            if result and result.startswith("manual:"):
                reason = result[len("manual:") :].strip() or None
                break
        review.append(
            {
                "names": names,
                "from": _image_version(plan.get("local_ref")),
                "to": _image_version(plan.get("remote_ref")),
                "semver": _text(plan.get("semver_diff"), 20),
                "cves": len(plan["fixed"]),
                "newSevere": len(plan["new_severe"])
                if isinstance(plan.get("new_severe"), list)
                else 0,
                "verifiedAt": _iso_from_text(plan.get("verified_at")),
                "reason": reason,
            }
        )
    review.sort(key=lambda item: item["verifiedAt"] or "", reverse=True)
    return {"pins": pins, "pending": pending, "review": review[:20]}


def backup_section(appdata):
    status_text = None
    try:
        status_text = (appdata / "backup" / "last-status").read_text()
    except OSError:
        pass
    if not status_text:
        return {"status": "unknown", "at": None}
    parts = status_text.strip().split(maxsplit=1)
    if len(parts) != 2 or parts[0] not in ("ok", "failed"):
        return {"status": "unknown", "at": None}
    at = _iso_from_text(parts[1])
    if at is None:
        return {"status": "unknown", "at": None}
    return {"status": parts[0], "at": at}


def _automation_kind(name):
    if "merged-updates" in name:
        return "follower"
    if "security-updates" in name:
        return "security"
    if "backup" in name:
        return "backup"
    return "automation"


def _automation_state(unit):
    result = unit.get("result")
    if (result and result != "success") or unit.get("activeState") == "failed":
        return "failed"
    if unit.get("timer"):
        if unit.get("activeState") == "active":
            return "active"
        if unit.get("unitFileState") == "disabled":
            return "paused"
        return "inactive"
    if unit.get("activeState") == "active":
        return "active"
    if unit.get("unitFileState") == "disabled":
        return "paused"
    return "inactive"


def units_section(host_reader, names):
    result = []
    for unit in host_reader.units_for(names):
        if not isinstance(unit, dict) or not _text(unit.get("name"), 200):
            continue
        state = _automation_state(unit)
        result.append(
            {
                "name": _text(unit.get("name"), 200),
                "kind": _automation_kind(unit["name"]),
                "service": _text(unit.get("service"), 200),
                "timer": _text(unit.get("timer"), 200),
                "activeState": _text(unit.get("activeState"), 40),
                "subState": _text(unit.get("subState"), 40),
                "unitFileState": _text(unit.get("unitFileState"), 40),
                "result": _text(unit.get("result"), 40),
                "state": state,
                "paused": state == "paused",
                "lastRun": _text(unit.get("lastRun"), 40),
                "nextRun": _text(unit.get("nextRun"), 40),
            }
        )
    return result


def failed_units_section(host_reader, prefix):
    stack, other = [], []
    for unit in host_reader.failed_units():
        name = _text(unit.get("name"), 200) if isinstance(unit, dict) else None
        if not name:
            continue
        entry = {
            "name": name,
            "description": _text(unit.get("description"), 200),
        }
        (stack if name.startswith(prefix) else other).append(entry)
    return {"stack": stack, "other": other}


def _epoch(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if value.startswith("@"):
        value = value[1:]
    if not value or value in ("n/a", "infinity", "0"):
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _duration_seconds(value):
    if not isinstance(value, str) or value.strip() in ("", "n/a", "infinity"):
        return None
    factors = {
        "us": 1e-6,
        "ms": 1e-3,
        "s": 1,
        "min": 60,
        "h": 3600,
        "d": 86400,
        "w": 604800,
        "month": 2629800,
        "y": 31557600,
    }
    matched = False
    total = 0.0
    for match in re.finditer(r"(\d+(?:\.\d+)?)(us|ms|s|min|h|d|w|month|y)", value):
        total += float(match.group(1)) * factors[match.group(2)]
        matched = True
    return total if matched else None


def parse_unit_show(text):
    records = {}
    current = {}
    for line in text.splitlines():
        if not line.strip():
            if current.get("Id"):
                records[current["Id"]] = current
            current = {}
            continue
        key, separator, value = line.partition("=")
        if separator:
            current[key] = value
    if current.get("Id"):
        records[current["Id"]] = current
    return records


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("localhost", timeout=timeout)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class DockerSocket:
    def __init__(self, path=None, timeout=8):
        self.path = path or os.getenv("DOCKER_SOCKET", "/var/run/docker.sock")
        self.timeout = timeout

    def call(self, method, path, body=None, *, timeout=None, raw=False):
        address = path if path.startswith("/v") else "/v1.45" + path
        payload = json.dumps(body) if body is not None else None
        with contextlib.closing(
            UnixHTTP(self.path, timeout or self.timeout)
        ) as connection:
            connection.request(
                method,
                address,
                payload,
                {"Content-Type": "application/json"},
            )
            response = connection.getresponse()
            data = response.read()
        if response.status >= 400:
            raise OSError("Docker no pudo completar la lectura (%s)" % response.status)
        if raw:
            return data
        if not data:
            return None
        try:
            return json.loads(data)
        except ValueError as error:
            raise OSError("Docker devolvió una respuesta no válida") from error


def demultiplex_logs(data):
    result = []
    index = 0
    while index + 8 <= len(data):
        stream = data[index]
        size = int.from_bytes(data[index + 4 : index + 8], "big")
        if stream not in (0, 1, 2) or index + 8 + size > len(data):
            return data.decode(errors="replace")
        result.append(data[index + 8 : index + 8 + size])
        index += 8 + size
    if index != len(data):
        return data.decode(errors="replace")
    return b"".join(result).decode(errors="replace")


class HostExecutor:
    """Runs one fixed command in a privileged nsenter helper container."""

    def __init__(self, docker=None, image=None):
        self.docker = docker or DockerSocket(timeout=8)
        self.image = image or os.getenv("HOST_HELPER_IMAGE", "hub-agent:1")

    def run(self, argv, timeout=8):
        return self.run_status(argv, timeout=timeout)[1]

    def run_status(self, argv, timeout=8):
        if not isinstance(argv, list) or not argv:
            raise ValueError("Comando de host no válido")
        created = self.docker.call(
            "POST",
            "/containers/create",
            {
                "Image": self.image,
                "Entrypoint": ["nsenter"],
                "Cmd": ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--", *argv],
                "HostConfig": {
                    "Privileged": True,
                    "PidMode": "host",
                    "AutoRemove": False,
                },
            },
            timeout=timeout,
        )
        ident = created["Id"]
        try:
            self.docker.call(
                "POST", "/containers/" + ident + "/start", timeout=timeout
            )
            waited = self.docker.call(
                "POST", "/containers/" + ident + "/wait", timeout=timeout
            )
            logs = self.docker.call(
                "GET",
                "/containers/" + ident + "/logs?stdout=true&stderr=true",
                timeout=timeout,
                raw=True,
            )
            status = waited.get("StatusCode") if isinstance(waited, dict) else None
            return (
                status if isinstance(status, int) else None,
                demultiplex_logs(logs),
            )
        finally:
            try:
                self.docker.call(
                    "DELETE", "/containers/" + ident + "?force=1", timeout=timeout
                )
            except (OSError, ValueError):
                pass


class DiskExecutor:
    """Runs smartctl inside the helper image with the host devices mounted read-only."""

    def __init__(self, docker=None, image=None):
        self.docker = docker or DockerSocket(timeout=15)
        self.image = image or os.getenv("HOST_HELPER_IMAGE", "hub-agent:1")

    def run(self, argv, timeout=15):
        if not isinstance(argv, list) or not argv:
            raise ValueError("Comando de disco no válido")
        created = self.docker.call(
            "POST",
            "/containers/create",
            {
                "Image": self.image,
                "Entrypoint": [argv[0]],
                "Cmd": argv[1:],
                "HostConfig": {
                    "Privileged": True,
                    "Binds": ["/dev:/dev:ro", "/sys:/sys:ro"],
                    "NetworkMode": "none",
                    "AutoRemove": False,
                },
            },
            timeout=timeout,
        )
        ident = created["Id"]
        try:
            self.docker.call(
                "POST", "/containers/" + ident + "/start", timeout=timeout
            )
            self.docker.call(
                "POST", "/containers/" + ident + "/wait", timeout=timeout
            )
            logs = self.docker.call(
                "GET",
                "/containers/" + ident + "/logs?stdout=true&stderr=false",
                timeout=timeout,
                raw=True,
            )
            return demultiplex_logs(logs)
        finally:
            try:
                self.docker.call(
                    "DELETE", "/containers/" + ident + "?force=1", timeout=timeout
                )
            except (OSError, ValueError):
                pass


class HostReader:
    UNIT_PROPERTIES = (
        "Id,LoadState,ActiveState,SubState,UnitFileState,LastTriggerUSec,"
        "NextElapseUSecRealtime,NextElapseUSecMonotonic,ExecMainStartTimestamp,Result"
    )

    def __init__(
        self,
        *,
        executor=None,
        clock=time.time,
        monotonic_clock=time.monotonic,
    ):
        self.executor = executor or HostExecutor()
        self.clock = clock
        self.monotonic_clock = monotonic_clock

    def units_for(self, names):
        names = [name for name in names if UNIT_NAME.fullmatch(name)]
        if not names:
            return []
        units = []
        for name in names:
            units.extend((name + ".service", name + ".timer"))
        raw = self.executor.run(
            [
                "systemctl",
                "--timestamp=unix",
                "show",
                "--no-pager",
                "--property=" + self.UNIT_PROPERTIES,
                *units,
            ],
            timeout=8,
        )
        records = parse_unit_show(raw)
        now = self.clock()
        boot_epoch = now - self.monotonic_clock()
        result = []
        for name in names:
            service = records.get(name + ".service")
            timer = records.get(name + ".timer")
            if service and service.get("LoadState") == "not-found":
                service = None
            if timer and timer.get("LoadState") == "not-found":
                timer = None
            if not service and not timer:
                continue
            active_state = (timer or service).get("ActiveState")
            sub_state = (timer or service).get("SubState")
            unit_file_state = (timer or service).get("UnitFileState")
            last_run = [_epoch((service or {}).get("ExecMainStartTimestamp"))]
            if timer:
                last_run.append(_epoch(timer.get("LastTriggerUSec")))
            last_run = [value for value in last_run if value is not None]
            next_run = None
            if timer:
                next_run = _epoch(timer.get("NextElapseUSecRealtime"))
                if next_run is None:
                    monotonic = _duration_seconds(
                        timer.get("NextElapseUSecMonotonic")
                    )
                    if monotonic is not None:
                        next_run = boot_epoch + monotonic
            result.append(
                {
                    "name": name,
                    "service": name + ".service" if service else None,
                    "timer": name + ".timer" if timer else None,
                    "activeState": active_state,
                    "subState": sub_state,
                    "unitFileState": unit_file_state,
                    "result": (service or timer).get("Result"),
                    "lastRun": _iso(max(last_run)) if last_run else None,
                    "nextRun": _iso(next_run),
                }
            )
        return result

    def failed_units(self):
        raw = self.executor.run(
            [
                "systemctl",
                "list-units",
                "--all",
                "--state=failed",
                "--plain",
                "--no-legend",
                "--no-pager",
            ],
            timeout=8,
        )
        result = []
        seen = set()
        for line in raw.splitlines():
            parts = line.split(None, 4)
            if len(parts) < 4 or parts[0] in seen:
                continue
            if not re.fullmatch(
                r"[A-Za-z0-9@_.:-]+\.(service|timer|socket|mount|path|target)",
                parts[0],
            ):
                continue
            seen.add(parts[0])
            result.append(
                {
                    "name": parts[0],
                    "description": parts[4] if len(parts) > 4 else None,
                }
            )
        return result

    def reboot(self):
        script = (
            "if [ -e /var/run/reboot-required ] || [ -e /run/reboot-required ]; "
            "then echo required; "
            "elif command -v dpkg-query >/dev/null 2>&1 && "
            "dpkg-query -W -f='${Status}' update-notifier-common 2>/dev/null "
            "| grep -q 'install ok installed'; "
            "then echo available; else echo unavailable; fi"
        )
        output = self.executor.run(["/bin/sh", "-c", script], timeout=8)
        marker = output.strip().splitlines()[0] if output.strip() else ""
        if marker == "required":
            return {"available": True, "required": True}
        if marker == "available":
            return {"available": True, "required": False}
        return {"available": False, "required": None}


class DockerUsage:
    def __init__(self, socket_client=None):
        self.socket = socket_client or DockerSocket()

    def usage(self):
        data = self.socket.call("GET", "/system/df", timeout=15)
        if not isinstance(data, dict):
            raise OSError("Docker devolvió un uso no válido")
        images = [item for item in (data.get("Images") or []) if isinstance(item, dict)]
        containers = [
            item for item in (data.get("Containers") or []) if isinstance(item, dict)
        ]
        volumes = [item for item in (data.get("Volumes") or []) if isinstance(item, dict)]
        cache = [
            item for item in (data.get("BuildCache") or []) if isinstance(item, dict)
        ]

        def number(item, key):
            value = item.get(key)
            return value if isinstance(value, (int, float)) and value > 0 else 0

        layers = number(data, "LayersSize")
        images_reclaimable = sum(
            number(image, "Size")
            for image in images
            if number(image, "Containers") == 0
        )
        containers_size = sum(number(container, "SizeRw") for container in containers)
        volumes_size = sum(
            number(volume.get("UsageData") or {}, "Size") for volume in volumes
        )
        cache_size = sum(number(item, "Size") for item in cache)
        cache_reclaimable = sum(
            number(item, "Size") for item in cache if not item.get("InUse")
        )
        return {
            "available": True,
            "images": {
                "count": len(images),
                "size": layers,
                "reclaimable": images_reclaimable,
            },
            "containers": {"count": len(containers), "size": containers_size},
            "volumes": {"count": len(volumes), "size": volumes_size},
            "buildCache": {"count": len(cache), "size": cache_size},
            "total": layers + containers_size + volumes_size + cache_size,
            "reclaimable": images_reclaimable + cache_reclaimable,
        }


class Maintenance:
    """Builds and caches the host snapshot. Every section is read-only."""

    def __init__(
        self,
        *,
        appdata,
        role="instance",
        unit_names=None,
        host_reader,
        docker_reader,
        smart_reader=None,
        clock=time.time,
        cache_seconds=60,
        stack_prefix="media-stack",
    ):
        self.appdata = Path(appdata)
        self.role = role if role in DEFAULT_UNITS else "instance"
        self.unit_names = unit_names or parse_unit_names(None, self.role)
        self.stack_prefix = stack_prefix or "media-stack"
        self.host_reader = host_reader
        self.docker_reader = docker_reader
        self.smart_reader = smart_reader
        self.clock = clock
        try:
            self.cache_seconds = max(0.0, float(cache_seconds))
        except (TypeError, ValueError):
            self.cache_seconds = 60.0
        self._cached = None
        self._expires = 0.0
        self._lock = threading.Lock()

    @classmethod
    def from_env(cls):
        executor = HostExecutor()
        return cls(
            appdata=os.getenv("APPDATA_ROOT", "/media-stack-appdata"),
            role=os.getenv("HOST_ROLE", "instance"),
            unit_names=parse_unit_names(
                os.getenv("MAINTENANCE_UNITS"), os.getenv("HOST_ROLE", "instance")
            ),
            host_reader=HostReader(executor=executor),
            docker_reader=DockerUsage(),
            smart_reader=smart.SmartMonitor(executor=DiskExecutor()),
            cache_seconds=os.getenv("MAINTENANCE_CACHE_SECONDS", "60"),
            stack_prefix=os.getenv("MAINTENANCE_STACK_PREFIX", "media-stack"),
        )

    def snapshot(self):
        now = self.clock()
        with self._lock:
            if self._cached is not None and now < self._expires:
                return self._cached
            value = self._build(now)
            self._cached = value
            self._expires = now + self.cache_seconds
            return value

    def invalidate(self):
        """Forces the next read to observe a just-executed host action."""
        with self._lock:
            self._cached = None
            self._expires = 0.0

    def _build(self, now):
        errors = []
        defaults = {
            "follower": {
                "available": False,
                "state": "unknown",
                "installed": None,
                "pending": None,
                "failed": None,
            },
            "security": {"pins": [], "pending": None, "review": []},
            "backup": {"status": "unknown", "at": None},
            "disks": {"available": False, "devices": []},
            "units": [],
            "failedUnits": {"stack": [], "other": []},
            "reboot": {"available": False, "required": None},
            "docker": {
                "available": False,
                "images": {"count": 0, "size": 0, "reclaimable": 0},
                "containers": {"count": 0, "size": 0},
                "volumes": {"count": 0, "size": 0},
                "buildCache": {"count": 0, "size": 0},
                "total": 0,
                "reclaimable": 0,
            },
        }
        readers = {
            "follower": lambda: follower_section(self.appdata),
            "security": lambda: security_section(self.appdata),
            "backup": lambda: backup_section(self.appdata),
            "disks": self.smart_reader.read
            if self.smart_reader
            else lambda: {"available": False, "devices": []},
            "units": lambda: units_section(self.host_reader, self.unit_names),
            "failedUnits": lambda: failed_units_section(
                self.host_reader, self.stack_prefix
            ),
            "reboot": self.host_reader.reboot,
            "docker": self.docker_reader.usage,
        }
        sections = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(readers)) as pool:
            futures = {name: pool.submit(reader) for name, reader in readers.items()}
            for name, future in futures.items():
                try:
                    sections[name] = future.result()
                except Exception:
                    errors.append(name)
                    sections[name] = defaults[name]
        return {
            "timestamp": now,
            "role": self.role,
            **sections,
            "degraded": errors,
        }
