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
import lifecycle
import logs
import maintenance


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
TOKEN = os.getenv("AGENT_TOKEN", "")
ALLOWED_NETWORKS = allowed_networks(os.getenv("ALLOWED_IPS", "127.0.0.1"))
PROTECTED = {"hub-agent", "hub-agent-apps", "npm", "tailscale"} | {
    name.strip()
    for name in os.getenv("PROTECTED_CONTAINERS", "").split(",")
    if name.strip()
}
ALLOW_REBOOT = os.getenv("ALLOW_REBOOT", "true").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
)
MAINTENANCE = maintenance.Maintenance.from_env()
COMMANDS = host_commands.HostCommands(
    role=MAINTENANCE.role,
    unit_names=MAINTENANCE.unit_names,
    executor=maintenance.HostExecutor(),
)
DEPLOYMENTS = deployments.Deployments.from_env()
ENV_SETTINGS = env_settings.EnvSettings(DEPLOYMENTS)
LOCK = threading.RLock()


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


previous = None
container_cache = (0, [])
container_previous = {}


def container_stat(item, active=None, protected=None):
    result = lifecycle.classify_one(
        item,
        active if active is not None else set(),
        protected if protected is not None else PROTECTED,
    )
    project = result["composeProject"]
    service = result["composeService"]
    result.update({
        "image": item["Image"],
        "status": item["Status"],
        "cpu": None,
        "memory": None,
        "compose": {"project": project, "service": service} if project and service else None,
    })
    if result["state"] != "running":
        return result
    ident = result["id"]
    try:
        st = docker("GET", "/containers/" + ident + "/stats?stream=false&one-shot=true")
        cpu = st["cpu_stats"]
        total, system = cpu["cpu_usage"]["total_usage"], cpu.get("system_cpu_usage", 0)
        prev = container_previous.get(ident)
        if prev and system > prev[1]:
            result["cpu"] = round((total - prev[0]) / (system - prev[1]) * cpu.get("online_cpus", 1) * 100, 1)
        container_previous[ident] = (total, system)
        mem = st.get("memory_stats", {})
        result["memory"] = max(0, mem.get("usage", 0) - mem.get("stats", {}).get("inactive_file", 0))
    except Exception:
        pass
    return result


def metrics():
    global previous, container_cache
    now = time.time()
    cpu = list(map(int, (PROC / "stat").read_text().splitlines()[0].split()[1:9]))
    mem = {line.split(":")[0]: int(line.split()[1]) * 1024 for line in (PROC / "meminfo").read_text().splitlines()}
    rx = tx = 0
    for line in (PROC / "net/dev").read_text().splitlines()[2:]:
        name, data = line.split(":")
        if not re.match(r"^(eth|en|bond|wlan)", name.strip()):
            continue
        values = list(map(int, data.split()))
        rx += values[0]
        tx += values[8]
    read_bytes = write_bytes = 0
    for line in (PROC / "diskstats").read_text().splitlines():
        bits = line.split()
        if re.fullmatch(r"sd[a-z]+|nvme\d+n\d+|mmcblk\d+", bits[2]):
            read_bytes += int(bits[5]) * 512
            write_bytes += int(bits[9]) * 512
    cpu_percent = net_rx = net_tx = disk_read = disk_write = None
    if previous:
        dt = now - previous[0]
        dc = sum(cpu) - sum(previous[1])
        idle = cpu[3] + cpu[4] - previous[1][3] - previous[1][4]
        cpu_percent = round(max(0, min(100, (1 - idle / dc) * 100)), 1) if dc > 0 else None
        net_rx, net_tx = max(0, (rx - previous[2]) / dt), max(0, (tx - previous[3]) / dt)
        disk_read, disk_write = max(0, (read_bytes - previous[4]) / dt), max(0, (write_bytes - previous[5]) / dt)
    previous = (now, cpu, rx, tx, read_bytes, write_bytes)
    disks = []
    seen = set()
    for root, path in ROOTS.items():
        st = os.stat(path)
        if st.st_dev in seen:
            continue
        seen.add(st.st_dev)
        usage = shutil.disk_usage(path)
        disks.append({"name": "Volumen de películas" if root == "media" else "Descargas", "root": root,
                      "total": usage.total, "used": usage.used, "free": usage.free})
    temperatures = []
    for sensor in SYS.glob("class/hwmon/hwmon*/temp*_input"):
        try:
            value = int(sensor.read_text()) / 1000
            label_path = sensor.with_name(sensor.name.replace("_input", "_label"))
            label = label_path.read_text().strip() if label_path.exists() else (sensor.parent / "name").read_text().strip()
            if 0 < value < 150:
                temperatures.append({"name": label, "value": value})
        except (OSError, ValueError):
            pass
    if now - container_cache[0] > 10:
        items = docker("GET", "/containers/json?all=true")
        active = lifecycle.active_projects(items, PROTECTED)
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            container_cache = (now, list(pool.map(lambda item: container_stat(item, active), items)))
    return {"timestamp": now, "hostname": os.getenv("NAS_NAME", "NAS"), "cpu": cpu_percent,
            "memory": {"total": mem["MemTotal"], "used": mem["MemTotal"] - mem["MemAvailable"]},
            "network": {"rx": net_rx, "tx": net_tx}, "io": {"read": disk_read, "write": disk_write},
            "uptime": float((PROC / "uptime").read_text().split()[0]), "disks": disks,
            "temperatures": temperatures, "containers": container_cache[1]}


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
                        result = COMMANDS.execute(body["command"])
                    finally:
                        MAINTENANCE.invalidate()
                elif self.command == "POST" and route.path == "/action":
                    size = int(self.headers.get("Content-Length", 0))
                    if not 0 < size <= 8192:
                        raise ValueError("Solicitud no válida")
                    result = execute(json.loads(self.rfile.read(size)))
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
