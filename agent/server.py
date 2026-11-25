"""Private NAS agent. Only the Oracle server may call the authenticated API."""
import concurrent.futures
import contextlib
import hmac
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, urlencode

import deployments
import env_settings
import host_commands
import host_metrics
import lifecycle
import logs
import maintenance
import maintenance_actions
import updates


def configured_roots(enabled, media, torrents):
    if str(enabled).strip().lower() in ("0", "false", "no", "off"):
        return {}
    return {"media": Path(media), "torrents": Path(torrents)}


def allowed_networks(value):
    networks = []
    for entry in value.split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            continue
    return networks


def allowed(address):
    try:
        client = ipaddress.ip_address(address)
    except ValueError:
        return False
    return any(client in network for network in ALLOWED_NETWORKS)


ROOTS = configured_roots(
    os.getenv("FILES_ENABLED", "true"),
    os.getenv("MEDIA_ROOT", "/nas/media"),
    os.getenv("TORRENTS_ROOT", "/nas/torrents"),
)
PROC = Path(os.getenv("HOST_PROC", "/host/proc"))
SYS = Path(os.getenv("HOST_SYS", "/host/sys"))
HOST_ROOT = Path(os.getenv("HOST_ROOT", "/host/root"))
TOKEN = os.getenv("AGENT_TOKEN", "")
ALLOWED_NETWORKS = allowed_networks(os.getenv("ALLOWED_IPS", "127.0.0.1"))
PROTECTED = updates.protected_names(os.getenv("PROTECTED_CONTAINERS", ""))
ALLOW_REBOOT = os.getenv("ALLOW_REBOOT", "true").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
)
MAINTENANCE = maintenance.Maintenance.from_env(protected=PROTECTED)
COMMANDS = host_commands.HostCommands(
    role=MAINTENANCE.role,
    unit_names=MAINTENANCE.unit_names,
    executor=maintenance.HostExecutor(),
)
ACTIONS = maintenance_actions.MaintenanceActions.from_env()
DEPLOYMENTS = deployments.Deployments.from_env()
ENV_SETTINGS = env_settings.EnvSettings(DEPLOYMENTS)
LOCK = threading.RLock()
UPDATE_LOCK = threading.Lock()
UPDATE_DOCKER = maintenance.DockerSocket(timeout=15)
UPDATE_EXECUTOR = maintenance.HostExecutor()


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(8)
        self.sock.connect("/var/run/docker.sock")


def docker(method, path, body=None):
    with contextlib.closing(UnixHTTP("localhost", timeout=8)) as conn:
        conn.request(method, "/v1.45" + path, json.dumps(body) if body is not None else None,
                     {"Content-Type": "application/json"})
        response = conn.getresponse()
        data = response.read()
        if response.status >= 400:
            raise ValueError("Docker no pudo completar la operación (%s)" % response.status)
        return json.loads(data) if data else None


def docker_logs(ident, since, lines):
    """Read one bounded snapshot of a container's logs. Never follows."""
    query = [("stdout", "1"), ("stderr", "1"), ("timestamps", "1"), ("tail", str(lines))]
    if since:
        query.append(("since", since))
    with contextlib.closing(UnixHTTP("localhost", timeout=15)) as conn:
        conn.request("GET", "/v1.45/containers/" + ident + "/logs?" + urlencode(query))
        response = conn.getresponse()
        data = response.read(logs.MAX_PAYLOAD + 1)
        if response.status >= 400:
            raise ValueError("Docker no pudo leer los registros (%s)" % response.status)
        if len(data) > logs.MAX_PAYLOAD:
            raise ValueError("Los registros superan el tamaño permitido")
        return data


def container_logs(ident, lines, since):
    if not isinstance(ident, str) or not re.fullmatch(r"[a-f0-9]{64}", ident):
        raise ValueError("Contenedor no válido")
    limit = logs.parse_line_count(lines)
    mark = logs.parse_since(since)
    payload = docker_logs(ident, mark.raw if mark else "", limit)
    entries, truncated, cursor = logs.format_lines(payload, mark, limit)
    return {"id": ident, "lines": entries, "truncated": truncated,
            "cursor": cursor or (since or None)}


def checked_path(root, relative, allow_root=False):
    if root not in ROOTS or not isinstance(relative, str):
        raise ValueError("Carpeta no permitida")
    parts = Path(relative).parts
    if relative.startswith("/") or any(p in ("..", ".hub-trash") for p in parts) or "\x00" in relative:
        raise ValueError("Ruta no permitida")
    base = ROOTS[root].resolve(strict=True)
    current = base
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("No se permiten enlaces simbólicos")
    if not current.is_relative_to(base) or (current == base and not allow_root):
        raise ValueError("Ruta no permitida")
    return current


@contextlib.contextmanager
def parent_fd(path, base):
    """Walk with O_NOFOLLOW; directory swaps cannot redirect a mutation outside the root."""
    fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parent.relative_to(base).parts:
            new_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new_fd
        yield fd
    finally:
        os.close(fd)


def move_file(root, source, destination):
    src, dst = checked_path(root, source), checked_path(root, destination)
    base = ROOTS[root].resolve()
    if src == dst or src.is_dir() and dst.is_relative_to(src):
        raise ValueError("Destino no válido")
    with parent_fd(src, base) as sfd, parent_fd(dst, base) as dfd:
        # link/rename cannot overwrite an existing target, including dangling symlinks.
        if os.path.lexists(dst):
            raise ValueError("El destino ya existe")
        if src.is_symlink():
            raise ValueError("No se permiten enlaces")
        # Linux renameat2 gives atomic no-replace semantics for files and directories.
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.renameat2(sfd, os.fsencode(src.name), dfd, os.fsencode(dst.name), 1) != 0:
            err = ctypes.get_errno()
            raise OSError(err, os.strerror(err))


def trash_base(root):
    base = ROOTS[root] / ".hub-trash"
    if base.is_symlink():
        raise ValueError("Papelera no válida")
    base.mkdir(mode=0o700, exist_ok=True)
    return base


def trash_item(root, relative):
    source = checked_path(root, relative)
    ident = str(uuid.uuid4())
    box = trash_base(root) / ident
    box.mkdir(mode=0o700)
    record = {"id": ident, "root": root, "path": relative, "name": source.name,
              "deletedAt": time.time(), "expiresAt": time.time() + 7 * 86400}
    try:
        (box / "record.json").write_text(json.dumps(record))
        with parent_fd(source, ROOTS[root].resolve()) as fd:
            os.rename(source.name, box / "data", src_dir_fd=fd)
    except Exception:
        shutil.rmtree(box)
        raise
    return record


def trash_records():
    records = []
    for root in ROOTS:
        base = ROOTS[root] / ".hub-trash"
        if not base.exists():
            continue
        if base.is_symlink():
            continue
        for box in base.iterdir():
            if box.is_symlink() or not re.fullmatch(r"[a-f0-9-]{36}", box.name):
                continue
            try:
                record = json.loads((box / "record.json").read_text())
                if (box / "data").exists():
                    records.append(record)
            except (OSError, ValueError):
                continue
    return sorted(records, key=lambda x: x["deletedAt"], reverse=True)


def trash_action(root, ident, restore):
    if root not in ROOTS or not re.fullmatch(r"[a-f0-9-]{36}", ident):
        raise ValueError("Elemento de papelera no válido")
    box = trash_base(root) / ident
    if box.is_symlink():
        raise ValueError("Elemento no válido")
    record = json.loads((box / "record.json").read_text())
    if restore:
        target = checked_path(root, record["path"])
        if os.path.lexists(target):
            raise ValueError("Ya existe un archivo en el destino original")
        with parent_fd(target, ROOTS[root].resolve()) as fd:
            import ctypes
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.renameat2(-100, os.fsencode(box / "data"), fd, os.fsencode(target.name), 1) != 0:
                err = ctypes.get_errno()
                raise OSError(err, os.strerror(err))
    shutil.rmtree(box)


def files(root, relative):
    path = checked_path(root, relative, True)
    if not path.is_dir():
        raise ValueError("No es una carpeta")
    entries = []
    with parent_fd(path / "__list__", ROOTS[root].resolve()) as fd:
        for name in os.listdir(fd):
            if name == ".hub-trash":
                continue
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            import stat
            entries.append({"name": name, "path": str(Path(relative) / name),
                            "directory": stat.S_ISDIR(info.st_mode), "symlink": stat.S_ISLNK(info.st_mode),
                            "size": info.st_size, "modified": info.st_mtime})
    return sorted(entries, key=lambda x: (not x["directory"], x["name"].lower()))


HOST = host_metrics.HostSampler()
container_cache = (0, [])
container_previous = {}


def configured_extra_filesystems():
    entries = []
    appdata = os.getenv("APPDATA_ROOT")
    if appdata:
        entries.append(("Datos de apps", appdata))
    entries.extend(
        host_metrics.parse_extra_filesystems(os.getenv("EXTRA_FILESYSTEMS", ""))
    )
    return entries


EXTRA_FILESYSTEMS = configured_extra_filesystems()


unhealthy_observed_since = {}


def container_stat(item, active=None, protected=None, now=None):
    result = lifecycle.classify_one(
        item,
        active if active is not None else set(),
        protected if protected is not None else PROTECTED,
    )
    ident = result["id"]
    if result["state"] == "running" and "(unhealthy)" in item.get("Status", ""):
        unhealthy_observed_since.setdefault(ident, time.time())
    else:
        unhealthy_observed_since.pop(ident, None)
    result["healthObservedSince"] = unhealthy_observed_since.get(ident)
    project = result["composeProject"]
    service = result["composeService"]
    result.update({
        "image": item["Image"],
        "status": item["Status"],
        "cpu": None,
        "memory": None,
        "network": None,
        "compose": {"project": project, "service": service} if project and service else None,
    })
    if result["state"] != "running":
        container_previous.pop(ident, None)
        return result
    ident = result["id"]
    try:
        st = docker("GET", "/containers/" + ident + "/stats?stream=false&one-shot=true")
        cpu = st["cpu_stats"]
        total, system = cpu["cpu_usage"]["total_usage"], cpu.get("system_cpu_usage", 0)
        previous = container_previous.get(ident)
        if previous and system > previous[1]:
            result["cpu"] = round((total - previous[0]) / (system - previous[1]) * cpu.get("online_cpus", 1) * 100, 1)
        mem = st.get("memory_stats", {})
        result["memory"] = max(0, mem.get("usage", 0) - mem.get("stats", {}).get("inactive_file", 0))
        received = sent = 0
        for network in (st.get("networks") or {}).values():
            received += network.get("rx_bytes", 0)
            sent += network.get("tx_bytes", 0)
        timestamp = time.time() if now is None else now
        result["network"] = {"rx": None, "tx": None}
        if previous and timestamp > previous[4]:
            elapsed = timestamp - previous[4]
            if received >= previous[2]:
                result["network"]["rx"] = max(0.0, (received - previous[2]) / elapsed)
            if sent >= previous[3]:
                result["network"]["tx"] = max(0.0, (sent - previous[3]) / elapsed)
        container_previous[ident] = (total, system, received, sent, timestamp)
    except Exception:
        pass
    return result


def metrics():
    global container_cache
    sample = HOST.sample(PROC, SYS, ROOTS, EXTRA_FILESYSTEMS, HOST_ROOT)
    now = sample["timestamp"]
    if now - container_cache[0] > 10:
        items = docker("GET", "/containers/json?all=true")
        active = lifecycle.active_projects(items, PROTECTED)
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            container_cache = (
                now,
                list(
                    pool.map(
                        lambda item: container_stat(item, active, now=now), items
                    )
                ),
            )
    result = {
        **sample,
        "hostname": os.getenv("NAS_NAME", "NAS"),
        "containers": container_cache[1],
    }
    # The date comes from the cached Docker list, not from this sample. A
    # repeated cache keeps the same mark so the hub never treats a copy as new
    # evidence; agents before this field simply omit it.
    if container_cache[0]:
        result["containersObservedAt"] = container_cache[0]
    return result


def update_container(body):
    """One Compose pull+up, outside the short request lock, never in parallel."""
    global container_cache
    ident = body.get("id", "")
    if not lifecycle.valid_id(ident):
        raise ValueError("Contenedor no válido")
    if not UPDATE_LOCK.acquire(blocking=False):
        raise ValueError("Ya hay una actualización en curso en este host")
    try:
        result = updates.run_update(
            UPDATE_DOCKER,
            UPDATE_EXECUTOR,
            ident,
            role=MAINTENANCE.role,
            stack_path=os.getenv("MEDIA_STACK_CHECKOUT_PATH"),
            protected=PROTECTED,
        )
    finally:
        UPDATE_LOCK.release()
    container_cache = (0, [])
    MAINTENANCE.invalidate_container(result.get("image"))
    return result


def execute(body):
    global container_cache
    action = body.get("action")
    if action in ("start", "stop", "restart"):
        ident = body.get("id", "")
        if not re.fullmatch(r"[a-f0-9]{64}", ident):
            raise ValueError("Contenedor no válido")
        item = docker("GET", "/containers/" + ident + "/json")
        if item["Name"].lstrip("/") in PROTECTED:
            raise ValueError("Servicio de infraestructura protegido")
        docker("POST", "/containers/" + ident + "/" + action + "?t=15")
        container_cache = (0, [])
        state = docker("GET", "/containers/" + ident + "/json")["State"]["Status"]
        if (action == "stop" and state == "running") or (action != "stop" and state != "running"):
            raise ValueError("La operación no alcanzó el estado esperado")
        return {"state": state}
    if action == "remove-container":
        ident = body.get("id", "")
        if not lifecycle.valid_id(ident):
            raise ValueError("Contenedor no válido")
        item = docker("GET", "/containers/" + ident + "/json")
        name = lifecycle.require_removable(item, body.get("confirmation"), PROTECTED)
        items = docker("GET", "/containers/json?all=true")
        result = lifecycle.removal_result(item, items, PROTECTED, name)
        # Never pass v=1: named and anonymous volumes stay on the host.
        docker("DELETE", "/containers/" + ident + "?v=0")
        container_cache = (0, [])
        return result
    if action == "reboot":
        if not ALLOW_REBOOT:
            raise ValueError("Reinicio no permitido en este host")
        helper = docker("POST", "/containers/create", {
            "Image": "hub-agent:1", "Entrypoint": ["nsenter"],
            "Cmd": ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "/sbin/reboot"],
            "HostConfig": {"Privileged": True, "PidMode": "host", "AutoRemove": True}})
        docker("POST", "/containers/" + helper["Id"] + "/start")
        return {"state": "requested"}
    if action == "move":
        move_file(body["root"], body["path"], body["destination"])
    elif action == "trash":
        return trash_item(body["root"], body["path"])
    elif action in ("restore", "purge"):
        trash_action(body["root"], body["id"], action == "restore")
    elif action == "empty-trash":
        for record in trash_records():
            trash_action(record["root"], record["id"], False)
    else:
        raise ValueError("Acción no permitida")
    return {"ok": True}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Never log query strings containing file names or bearer credentials.
        pass

    def respond(self, status, data):
        raw = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def handle_request(self):
        if not allowed(self.client_address[0]) or not TOKEN or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN):
            self.respond(401, {"error": "No autorizado"})
            return
        route = urlparse(self.path)
        try:
            if self.command == "GET" and route.path == "/maintenance":
                # Snapshot reads run outside the global lock so metrics and actions
                # are not blocked by the slower host/Docker queries.
                self.respond(200, MAINTENANCE.snapshot())
                return
            if self.command == "GET" and route.path == "/deployments":
                query = parse_qs(route.query)
                lines = deployments.parse_line_count(
                    query.get(
                        "lines", [str(deployments.DEFAULT_JOURNAL_LINES)]
                    )[0]
                )
                self.respond(200, DEPLOYMENTS.snapshot(lines))
                return
            if self.command == "POST" and route.path == "/deployments/settings":
                size = int(self.headers.get("Content-Length", 0))
                if not 0 < size <= env_settings.MAX_REQUEST_BYTES:
                    raise ValueError("Solicitud no válida")
                body = json.loads(self.rfile.read(size))
                self.respond(200, ENV_SETTINGS.save(body))
                return
            if self.command == "POST" and route.path == "/action":
                size = int(self.headers.get("Content-Length", 0))
                if not 0 < size <= 8192:
                    raise ValueError("Solicitud no válida")
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict):
                    raise ValueError("Solicitud no válida")
                if body.get("action") == "update-container":
                    # Pulling can take minutes: keep /metrics and /logs free.
                    self.respond(200, update_container(body))
                    return
                with LOCK:
                    self.respond(200, execute(body))
                return
            with LOCK:
                if self.command == "GET" and route.path == "/metrics":
                    result = metrics()
                elif self.command == "GET" and route.path == "/files":
                    query = parse_qs(route.query)
                    result = files(query.get("root", ["media"])[0], query.get("path", [""])[0])
                elif self.command == "GET" and route.path == "/trash":
                    result = trash_records()
                elif self.command == "GET" and route.path == "/logs":
                    query = parse_qs(route.query)
                    result = container_logs(query.get("id", [""])[0],
                                            query.get("lines", [str(logs.DEFAULT_LINES)])[0],
                                            query.get("since", [""])[0])
                elif self.command == "POST" and route.path == "/command":
                    size = int(self.headers.get("Content-Length", 0))
                    if not 0 < size <= 2048:
                        raise ValueError("Solicitud no válida")
                    body = json.loads(self.rfile.read(size))
                    if not isinstance(body, dict) or set(body) != {"command"}:
                        raise ValueError("Solicitud no válida")
                    try:
                        command = body["command"]
                        if not isinstance(command, str):
                            raise ValueError("Comando de host no permitido")
                        if command in host_commands.COMMAND_NAMES:
                            result = COMMANDS.execute(command)
                        elif command in maintenance_actions.COMMAND_NAMES:
                            result = ACTIONS.execute(command)
                        else:
                            raise ValueError("Comando de host no permitido")
                    finally:
                        MAINTENANCE.invalidate()
                else:
                    self.respond(404, {"error": "No encontrado"})
                    return
            self.respond(200, result)
        except (ValueError, KeyError) as exc:
            self.respond(400, {"error": str(exc) if isinstance(exc, ValueError) else "Solicitud no válida"})
        except (OSError, http.client.HTTPException):
            status = 502 if self.command == "POST" else 503
            self.respond(status, {"error": "No se pudo confirmar el resultado; comprueba el estado antes de repetir la operación"})

    do_GET = do_POST = handle_request


def cleanup_loop():
    while True:
        try:
            with LOCK:
                for record in trash_records():
                    if record["expiresAt"] <= time.time():
                        trash_action(record["root"], record["id"], False)
        except Exception:
            print("No se pudo completar la limpieza de la papelera", flush=True)
        time.sleep(3600)


if __name__ == "__main__":
    if len(TOKEN) < 32:
        raise SystemExit("AGENT_TOKEN debe tener al menos 32 caracteres")
    threading.Thread(target=cleanup_loop, daemon=True).start()
    ThreadingHTTPServer((os.getenv("BIND_IP", "127.0.0.1"), 9450), Handler).serve_forever()
