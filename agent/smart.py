"""Read-only SMART health for the host's physical disks through smartctl."""
from __future__ import annotations

import json
import re

SCAN_TIMEOUT = 15
READ_TIMEOUT = 15
SATA_WARN_TEMPERATURE = 50
SATA_FAIL_TEMPERATURE = 65
NVME_WARN_TEMPERATURE = 75
NVME_FAIL_TEMPERATURE = 85
WEAR_WARN_PERCENT = 90
WEAR_FAIL_PERCENT = 100
DEFAULT_REALLOCATED_THRESHOLD = 0

DEVICE_PATH = re.compile(r"^/dev/(sd[a-z]+|nvme\d+(?:n\d+)?)$")
DEVICE_TYPES = {"ata", "sat", "scsi", "nvme"}


def _int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _text(value, limit):
    return value[:limit] if isinstance(value, str) and value.strip() else None


def _kind(scan_device, payload=None):
    protocol = ""
    device_type = scan_device.get("type") or ""
    if isinstance(payload, dict):
        device = payload.get("device")
        if isinstance(device, dict):
            protocol = str(device.get("protocol") or "").upper()
            device_type = str(device.get("type") or device_type).lower()
    if protocol == "NVME" or device_type == "nvme":
        return "nvme"
    if protocol in ("ATA", "SATA") or device_type in ("ata", "sat", "scsi"):
        return "sata"
    return "other"


def _short_device(path):
    matched = DEVICE_PATH.fullmatch(path) if isinstance(path, str) else None
    return matched.group(1) if matched else None


def parse_scan(output):
    data = json.loads(output)
    devices = data.get("devices") if isinstance(data, dict) else None
    if not isinstance(devices, list):
        raise ValueError("smartctl no devolvió una lista de discos")
    result = []
    seen = set()
    for item in devices:
        if not isinstance(item, dict):
            continue
        path = item.get("name")
        if path in seen or _short_device(path) is None:
            continue
        seen.add(path)
        device_type = str(item.get("type") or "").lower()
        result.append(
            {
                "name": path,
                "type": device_type if device_type in DEVICE_TYPES else None,
                "kind": _kind(item),
            }
        )
    return result


def read_command(scan_device):
    argv = ["smartctl", "--json", "--all"]
    if scan_device.get("type"):
        argv.extend(["-d", scan_device["type"]])
    argv.append(scan_device["name"])
    return argv


def _attributes(payload):
    attributes = payload.get("ata_smart_attributes")
    table = attributes.get("table") if isinstance(attributes, dict) else None
    return [item for item in table if isinstance(item, dict)] if isinstance(table, list) else []


def _raw_attribute(table, ident):
    for item in table:
        if item.get("id") == ident:
            raw = item.get("raw")
            return _int(raw.get("value")) if isinstance(raw, dict) else None
    return None


def _temperature(payload):
    current = payload.get("temperature")
    value = _int(current.get("current")) if isinstance(current, dict) else None
    if value is not None:
        return value
    log = payload.get("nvme_smart_health_information_log")
    value = _int(log.get("temperature")) if isinstance(log, dict) else None
    if value is not None:
        return value
    return _raw_attribute(_attributes(payload), 194)


def _has_smart_data(payload):
    return (
        isinstance(payload.get("smart_status"), dict)
        or bool(_attributes(payload))
        or isinstance(payload.get("nvme_smart_health_information_log"), dict)
    )


def describe(payload, scan_device):
    device = payload.get("device")
    path = device.get("name") if isinstance(device, dict) else None
    path = path or scan_device["name"]
    capacity = payload.get("user_capacity")
    size = _int(capacity.get("bytes")) if isinstance(capacity, dict) else None
    table = _attributes(payload)
    log = payload.get("nvme_smart_health_information_log")
    log = log if isinstance(log, dict) else {}
    return {
        "device": _short_device(path) or _short_device(scan_device["name"]),
        "model": _text(payload.get("model_name"), 120),
        "serial": _text(payload.get("serial_number"), 80),
        "kind": _kind(scan_device, payload),
        "size": size,
        "temperature": _temperature(payload),
        "reallocatedSectors": _raw_attribute(table, 5),
        "wear": _int(log.get("percentage_used")),
    }


def _temperature_limits(kind):
    if kind == "nvme":
        return NVME_WARN_TEMPERATURE, NVME_FAIL_TEMPERATURE
    return SATA_WARN_TEMPERATURE, SATA_FAIL_TEMPERATURE


def classify(entry, payload, previous, reallocated_threshold):
    if not _has_smart_data(payload):
        entry.update({"status": "unknown", "issues": ["smart_unavailable"]})
        return entry

    issues = []
    status = "ok"

    def note(level, issue):
        nonlocal status
        issues.append(issue)
        if level == "fail":
            status = "fail"
        elif status == "ok":
            status = "watch"

    smart_status = payload.get("smart_status")
    if isinstance(smart_status, dict) and smart_status.get("passed") is False:
        note("fail", "smart_failed")

    log = payload.get("nvme_smart_health_information_log")
    critical = _int(log.get("critical_warning")) if isinstance(log, dict) else None
    if critical is not None and critical != 0:
        note("fail", "critical_warning")

    temperature = entry["temperature"]
    if temperature is not None:
        warn, fail = _temperature_limits(entry["kind"])
        if temperature >= fail:
            note("fail", "temperature")
        elif temperature >= warn:
            note("watch", "temperature")

    wear = entry["wear"]
    if wear is not None:
        if wear >= WEAR_FAIL_PERCENT:
            note("fail", "wear")
        elif wear >= WEAR_WARN_PERCENT:
            note("watch", "wear")

    reallocated = entry["reallocatedSectors"]
    if reallocated is not None:
        if previous is not None and reallocated > previous:
            note("watch", "reallocated_increase")
        if reallocated > reallocated_threshold:
            note("watch", "reallocated_threshold")

    entry.update({"status": status, "issues": issues})
    return entry


def unknown(scan_device, issue):
    return {
        "device": _short_device(scan_device["name"]),
        "model": None,
        "serial": None,
        "kind": scan_device["kind"],
        "size": None,
        "temperature": None,
        "reallocatedSectors": None,
        "wear": None,
        "status": "unknown",
        "issues": [issue],
    }


class SmartMonitor:
    """Reads SMART data with fixed, read-only commands and remembers the previous count."""

    def __init__(self, *, executor, reallocated_threshold=DEFAULT_REALLOCATED_THRESHOLD):
        self.executor = executor
        self.reallocated_threshold = reallocated_threshold
        self._previous = {}

    def read(self):
        raw = self.executor.run(
            ["smartctl", "--scan-open", "--json"], timeout=SCAN_TIMEOUT
        )
        devices = parse_scan(raw)
        result = []
        previous = {}
        for scan_device in devices:
            try:
                payload = json.loads(
                    self.executor.run(
                        read_command(scan_device), timeout=READ_TIMEOUT
                    )
                )
                if not isinstance(payload, dict):
                    raise ValueError("smartctl no devolvió un objeto JSON")
                entry = describe(payload, scan_device)
                key = entry["serial"] or scan_device["name"]
                entry = classify(
                    entry,
                    payload,
                    self._previous.get(key),
                    self.reallocated_threshold,
                )
                if entry["reallocatedSectors"] is not None:
                    previous[key] = entry["reallocatedSectors"]
                result.append(entry)
            except (OSError, TypeError, ValueError):
                result.append(unknown(scan_device, "read_failed"))
        self._previous = previous
        return {"available": True, "devices": result}
