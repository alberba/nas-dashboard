"""Native host metrics read from /proc and /sys.

Every optional source is best-effort: a missing mdstat, loadavg or hwmon file
degrades that section to an empty value instead of failing the whole sample.
The core counters (stat, meminfo, net/dev, diskstats) are still read from the
host mounts that the agent already has.
"""
from __future__ import annotations

import os
import platform
import re
import shutil
import time
from pathlib import Path

AGGREGATE_INTERFACE = re.compile(r"^(eth|en|bond|wlan)")
INTERFACE = re.compile(r"^(eth|en|bond|wlan|tailscale|tun|tap|wg)")
DISK = re.compile(r"^(sd[a-z]+|nvme\d+n\d+|mmcblk\d+)$")
MD = re.compile(r"^md\d+$")
MDSTAT = re.compile(r"^(md\d+)\s*:\s*(.*)$")

CPU_BREAKDOWN = (
    ("user", 0),
    ("system", 2),
    ("iowait", 4),
    ("steal", 7),
    ("idle", 3),
    ("irq", 5),
    ("softirq", 6),
    ("nice", 1),
)


def parse_extra_filesystems(value):
    """Parse ``Nombre=/ruta,Nombre=/ruta`` into a list of pairs."""
    result = []
    for item in (value or "").split(","):
        item = item.strip()
        if not item or "=" not in item:
            continue
        name, path = item.split("=", 1)
        name, path = name.strip(), path.strip()
        if name and path:
            result.append((name, path))
    return result


def _read_optional(path):
    try:
        return path.read_text()
    except OSError:
        return ""


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _text(value):
    value = value.strip()
    return value or None


class HostSampler:
    def __init__(self, clock=time.time):
        self.clock = clock
        self._cpu = None
        self._network = None
        self._disk = None

    def sample(
        self, proc: Path, sys: Path, roots, extra_filesystems=(), root=None
    ):
        now = self.clock()
        cpu_total, cpu_cores = _parse_cpu(proc / "stat")
        cpu, cores, breakdown = self._cpu_values(now, cpu_total, cpu_cores)
        self._cpu = (now, cpu_total, cpu_cores)

        memory = _memory(proc / "meminfo")
        load = _load(proc / "loadavg")
        network = self._network_values(
            now, proc / "net" / "dev"
        )
        io = self._disk_values(now, proc / "diskstats")
        filesystems, disks = _filesystems(roots, extra_filesystems)

        return {
            "timestamp": now,
            "system": _system_details(proc, root, memory["total"]),
            "cpu": cpu,
            "cpuCores": cores,
            "cpuBreakdown": breakdown,
            "load": load,
            "memory": memory,
            "network": network,
            "io": io,
            "uptime": _uptime(proc / "uptime"),
            "disks": disks,
            "filesystems": filesystems,
            "raid": _raid(proc / "mdstat", sys / "block"),
            "temperatures": _temperatures(sys / "class" / "hwmon"),
        }

    def _cpu_values(self, now, total, cores):
        previous = self._cpu
        if (
            not previous
            or now <= previous[0]
            or len(total) < 8
            or len(previous[1]) < 8
        ):
            return None, None, None
        delta = sum(total) - sum(previous[1])
        if delta <= 0:
            return None, None, None
        idle = (total[3] + total[4]) - (previous[1][3] + previous[1][4])
        value = round(max(0.0, min(100.0, (1 - idle / delta) * 100)), 1)

        core_values = []
        for index in sorted(cores):
            before = previous[2].get(index)
            if before is None or len(cores[index]) < 8 or len(before) < 8:
                core_values.append(None)
                continue
            core_delta = sum(cores[index]) - sum(before)
            if core_delta <= 0:
                core_values.append(None)
                continue
            core_idle = (cores[index][3] + cores[index][4]) - (
                before[3] + before[4]
            )
            core_values.append(
                round(max(0.0, min(100.0, (1 - core_idle / core_delta) * 100)), 1)
            )
        if not core_values:
            core_values = None

        breakdown = {
            name: round(
                max(0.0, (total[position] - previous[1][position]) / delta * 100), 1
            )
            for name, position in CPU_BREAKDOWN
        }
        return value, core_values, breakdown

    def _network_values(self, now, path):
        rx = tx = 0
        interfaces = {}
        for line in path.read_text().splitlines()[2:]:
            if ":" not in line:
                continue
            name, data = line.split(":", 1)
            name = name.strip()
            values = data.split()
            if len(values) < 9:
                continue
            received, sent = _int(values[0]), _int(values[8])
            interfaces[name] = (received, sent)
            if AGGREGATE_INTERFACE.match(name):
                rx += received
                tx += sent

        previous = self._network
        rx_rate = tx_rate = None
        if previous and now > previous[0] and rx >= previous[1] and tx >= previous[2]:
            elapsed = now - previous[0]
            rx_rate = max(0.0, (rx - previous[1]) / elapsed)
            tx_rate = max(0.0, (tx - previous[2]) / elapsed)

        result = []
        for name in sorted(interfaces):
            if not INTERFACE.match(name):
                continue
            received, sent = interfaces[name]
            before = previous[3].get(name) if previous else None
            if (
                before
                and now > previous[0]
                and received >= before[0]
                and sent >= before[1]
            ):
                elapsed = now - previous[0]
                received_rate = max(0.0, (received - before[0]) / elapsed)
                sent_rate = max(0.0, (sent - before[1]) / elapsed)
            else:
                received_rate = sent_rate = None
            result.append(
                {
                    "name": name,
                    "rx": received_rate,
                    "tx": sent_rate,
                    "rxTotal": received,
                    "txTotal": sent,
                }
            )

        self._network = (now, rx, tx, interfaces)
        return {"rx": rx_rate, "tx": tx_rate, "interfaces": result}

    def _disk_values(self, now, path):
        read_bytes = write_bytes = 0
        devices = {}
        for line in path.read_text().splitlines():
            values = line.split()
            if len(values) < 14:
                continue
            name = values[2]
            if not DISK.match(name):
                continue
            reads = _int(values[3])
            sectors_read = _int(values[5])
            ms_reading = _int(values[6])
            writes = _int(values[7])
            sectors_written = _int(values[9])
            ms_writing = _int(values[10])
            ms_io = _int(values[12])
            weighted = _int(values[13])
            devices[name] = (
                reads,
                ms_reading,
                writes,
                ms_writing,
                ms_io,
                weighted,
            )
            read_bytes += sectors_read * 512
            write_bytes += sectors_written * 512

        previous = self._disk
        read_rate = write_rate = None
        if (
            previous
            and now > previous[0]
            and read_bytes >= previous[1]
            and write_bytes >= previous[2]
        ):
            elapsed = now - previous[0]
            read_rate = max(0.0, (read_bytes - previous[1]) / elapsed)
            write_rate = max(0.0, (write_bytes - previous[2]) / elapsed)

        latency = None
        if previous and now > previous[0]:
            elapsed_ms = (now - previous[0]) * 1000
            per_device = []
            total_reads = total_writes = 0
            total_read_ms = total_write_ms = 0
            total_weighted = 0.0
            busiest = None
            for name in sorted(devices):
                before = previous[3].get(name)
                if before is None:
                    continue
                reads, ms_reading, writes, ms_writing, ms_io, weighted = (
                    devices[name]
                )
                read_delta = reads - before[0]
                write_delta = writes - before[2]
                io_delta = ms_io - before[4]
                weighted_delta = weighted - before[5]
                if read_delta < 0 or write_delta < 0 or io_delta < 0:
                    continue
                read_ms = (
                    round((ms_reading - before[1]) / read_delta, 2)
                    if read_delta > 0
                    else None
                )
                write_ms = (
                    round((ms_writing - before[3]) / write_delta, 2)
                    if write_delta > 0
                    else None
                )
                utilization = (
                    round(min(100.0, io_delta / elapsed_ms * 100), 2)
                    if elapsed_ms > 0
                    else None
                )
                weighted_ms = (
                    round(weighted_delta / (read_delta + write_delta), 2)
                    if read_delta + write_delta > 0
                    else None
                )
                per_device.append(
                    {
                        "name": name,
                        "readMs": read_ms,
                        "writeMs": write_ms,
                        "utilization": utilization,
                        "weightedMs": weighted_ms,
                    }
                )
                total_reads += read_delta
                total_writes += write_delta
                total_read_ms += ms_reading - before[1]
                total_write_ms += ms_writing - before[3]
                if weighted_ms is not None:
                    total_weighted += weighted_delta
                if utilization is not None:
                    busiest = (
                        utilization
                        if busiest is None
                        else max(busiest, utilization)
                    )

            if per_device:
                latency = {
                    "readMs": (
                        round(total_read_ms / total_reads, 2)
                        if total_reads
                        else None
                    ),
                    "writeMs": (
                        round(total_write_ms / total_writes, 2)
                        if total_writes
                        else None
                    ),
                    "utilization": busiest,
                    "weightedMs": (
                        round(total_weighted / (total_reads + total_writes), 2)
                        if total_reads + total_writes
                        else None
                    ),
                    "devices": per_device,
                }

        self._disk = (now, read_bytes, write_bytes, devices)
        return {"read": read_rate, "write": write_rate, "latency": latency}


def _system_details(proc, root, memory_total):
    cpu_model = None
    cores = None
    threads = None
    sockets = set()
    for line in _read_optional(proc / "cpuinfo").splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key, value = key.strip(), value.strip()
        if key == "model name" and cpu_model is None:
            cpu_model = value
        elif key == "siblings" and threads is None:
            threads = _int(value, None)
        elif key == "cpu cores" and cores is None:
            cores = _int(value, None)
        elif key == "physical id":
            sockets.add(value)

    kernel = os.uname().release if hasattr(os, "uname") else None
    return {
        "hostname": _text(_read_optional(proc / "sys" / "kernel" / "hostname")),
        "cpuModel": cpu_model,
        "cores": cores,
        "threads": threads or os.cpu_count(),
        "sockets": len(sockets) if sockets else None,
        "arch": platform.machine() or None,
        "kernel": kernel,
        "osName": _os_name(root),
        "memoryTotal": memory_total,
    }


def _os_name(root):
    candidates = []
    if root:
        candidates.append(Path(root) / "etc" / "os-release")
    candidates.append(Path("/etc/os-release"))
    for path in candidates:
        for line in _read_optional(path).splitlines():
            if line.startswith("PRETTY_NAME="):
                return line.split("=", 1)[1].strip().strip('"') or None
    return None


def _parse_cpu(path):
    total = []
    cores = {}
    for line in path.read_text().splitlines():
        values = line.split()
        if not values or not values[0].startswith("cpu"):
            continue
        if len(values) < 9:
            continue
        if values[0] == "cpu":
            total = [_int(value) for value in values[1:9]]
            continue
        suffix = values[0][3:]
        if suffix.isdigit():
            cores[int(suffix)] = [_int(value) for value in values[1:9]]
    return total, cores


def _memory(path):
    fields = {}
    for line in path.read_text().splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key] = _int(value.split()[0] if value.split() else 0)
    total = fields.get("MemTotal", 0) * 1024
    available = fields.get("MemAvailable")
    if available is None:
        available = (
            fields.get("MemFree", 0)
            + fields.get("Buffers", 0)
            + fields.get("Cached", 0)
        )
    used = max(0, total - available * 1024)
    cache = (
        fields.get("Buffers", 0)
        + fields.get("Cached", 0)
        + fields.get("SReclaimable", 0)
    ) * 1024
    swap_total = fields.get("SwapTotal", 0) * 1024
    swap_used = max(0, fields.get("SwapTotal", 0) - fields.get("SwapFree", 0)) * 1024
    return {
        "total": total,
        "used": used,
        "cache": cache,
        "swap": {"total": swap_total, "used": swap_used},
    }


def _load(path):
    values = _read_optional(path).split()
    if len(values) < 3:
        return None
    try:
        return [float(value) for value in values[:3]]
    except ValueError:
        return None


def _uptime(path):
    values = _read_optional(path).split()
    if not values:
        return 0.0
    try:
        return float(values[0])
    except ValueError:
        return 0.0


def _volume(name, path):
    """Return a device id and a path-free filesystem summary."""
    try:
        stat = os.stat(path)
        usage = shutil.disk_usage(path)
    except (OSError, TypeError):
        return None, None
    return stat.st_dev, {
        "name": str(name),
        "total": usage.total,
        "used": usage.used,
        "free": usage.free,
    }


def _filesystems(roots, extra_filesystems):
    disks = []
    filesystems = []
    seen = set()
    root_names = {"media": "Volumen de películas", "torrents": "Descargas"}
    for root, path in roots.items():
        device, volume = _volume(root_names.get(root, root), path)
        if volume is None or device in seen:
            continue
        seen.add(device)
        filesystems.append(volume)
        disks.append({**volume, "root": root})

    for name, path in extra_filesystems:
        device, volume = _volume(name, path)
        if volume is None or device in seen:
            continue
        seen.add(device)
        filesystems.append(volume)
    return filesystems, disks


def _raid(mdstat_path, block_path):
    parsed = {}
    for line in _read_optional(mdstat_path).splitlines():
        match = MDSTAT.match(line)
        if not match:
            continue
        name, rest = match.groups()
        parts = rest.split()
        level = next((part for part in parts if part.startswith("raid")), None)
        parsed[name] = {
            "name": name,
            "level": level,
            "state": "active" if "active" in parts else "inactive",
        }

    for path in sorted(block_path.glob("md*")):
        if not MD.match(path.name):
            continue
        parsed.setdefault(
            path.name, {"name": path.name, "level": None, "state": None}
        )

    result = []
    for name in sorted(parsed):
        entry = dict(parsed[name])
        md = block_path / name / "md"
        size = _read_optional(block_path / name / "size").strip()
        entry["level"] = _text(_read_optional(md / "level")) or entry.get("level")
        entry["state"] = _text(_read_optional(md / "array_state")) or entry.get(
            "state"
        )
        raid_disks = _read_optional(md / "raid_disks").strip()
        degraded = _read_optional(md / "degraded").strip()
        entry["disks"] = _int(raid_disks, None) if raid_disks else None
        entry["capacity"] = _int(size) * 512 if size.isdigit() else None
        entry["degraded"] = _int(degraded, None) if degraded else None
        entry["syncAction"] = _text(_read_optional(md / "sync_action"))
        entry["syncCompleted"] = _text(_read_optional(md / "sync_completed"))
        entry["syncSpeed"] = _text(_read_optional(md / "sync_speed"))
        result.append(entry)
    return result


def _temperatures(hwmon_path):
    result = []
    for path in sorted(hwmon_path.glob("hwmon*/temp*_input")):
        try:
            value = int(path.read_text().strip()) / 1000
        except (OSError, ValueError):
            continue
        if not 0 < value < 150:
            continue
        label_path = path.with_name(path.name.replace("_input", "_label"))
        label = _text(_read_optional(label_path)) or _text(
            _read_optional(path.parent / "name")
        )
        result.append({"name": label or "sensor", "value": value})
    return result
