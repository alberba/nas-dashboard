"""Aggregate the Telegram noise audit without copying message bodies.

Reads the pinned export through :mod:`telegram_export`, keeps the normalised
rows in a temporary NDJSON file and publishes aggregate counts only. The output
JSON never carries message bodies and never carries sender names: the sender
split is two buckets, ``bot`` and ``operator``.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import telegram_export

PHASE_DIR = (
    Path(__file__).resolve().parents[2] / ".planning" / "phases" / "01-auditor-a-del-ruido"
)
DEFAULT_OUT_JSON = PHASE_DIR / "01-AUDIT.json"
DEFAULT_NDJSON = Path("/tmp/noise-audit/messages.ndjson")
SCHEMA_VERSION = 1
BOT_SENDERS = frozenset({"NAS Monitor"})
PUBLISHED_SOURCE_FIELDS = ("path_hint", "sha256", "bytes", "exported_mtime_note")

WUD_PATTERN = re.compile(
    r"^New tag found for container (?P<container>\S+)\s*\n+\s*"
    r"Container (?P=container) running with tag (?P<from_tag>\S+) "
    r"can be updated to tag (?P<target_tag>\S+)"
)
SECURITY_UPDATE_LINE = re.compile(
    r"^(?P<container>\S+) → (?P<target_tag>[^:]+): (?P<detail>.+)$"
)
RELEASE_STOP_PATTERN = re.compile(r"actualización automática detenida:\s*(?P<reason>.+)")
RELEASE_APPLIED_PATTERN = re.compile(
    r"—\s*(?P<release>\S+)\s+aplicada y verificada;\s*servicios:\s*(?P<services>.+)"
)
RELEASE_FAILED_SUFFIX = " falló"
RELEASE_UPGRADE_PATTERN = re.compile(
    r"—\s*actualizado de\s+(?P<from>\S+)\s+a\s+(?P<to>\S+)\s+y verificado"
)
BACKUP_PATTERN = re.compile(r"^Backup of\s+(?P<host>\S+)\s+FAILED:")


def _first_line(text):
    return text.split("\n", 1)[0].strip()


def _match_wud(text):
    match = WUD_PATTERN.match(text)
    if not match:
        return None
    container = match.group("container")
    return {
        "key": f"wud:{container}",
        "container": container,
        "from_tag": match.group("from_tag"),
        "target_tag": match.group("target_tag"),
    }


def _match_security_digest(text):
    if "actualizaciones de seguridad verificadas" not in _first_line(text):
        return None
    return {"key": "security:digest"}


def _match_security_update(text):
    if "autoactualización de seguridad" not in _first_line(text):
        return None
    updates = []
    for line in text.split("\n")[1:]:
        match = SECURITY_UPDATE_LINE.match(line.strip())
        if not match:
            continue
        detail = match.group("detail").strip()
        updates.append(
            {
                "container": match.group("container"),
                "target_tag": match.group("target_tag").strip(),
                "outcome": "updated" if detail.startswith("actualizada") else "manual",
            }
        )
    return {"key": "security:update", "updates": updates}


def _match_release_stop(text):
    match = RELEASE_STOP_PATTERN.search(_first_line(text))
    if not match:
        return None
    return {"key": "release:stop", "reason": match.group("reason").strip()}


def _match_release_apply(text):
    match = RELEASE_APPLIED_PATTERN.search(text)
    if match:
        services = [
            service.strip() for service in match.group("services").split(",") if service.strip()
        ]
        return {
            "key": "release:apply",
            "release": match.group("release"),
            "services": services,
            "outcome": "applied",
        }
    if text.rstrip().endswith(RELEASE_FAILED_SUFFIX):
        return {"key": "release:apply", "outcome": "failed"}
    return None


def _match_release_upgrade(text):
    match = RELEASE_UPGRADE_PATTERN.search(text)
    if not match:
        return None
    return {
        "key": "release:upgrade",
        "from": match.group("from"),
        "to": match.group("to"),
    }


def _match_backup(text):
    match = BACKUP_PATTERN.match(text)
    if not match:
        return None
    host = match.group("host")
    return {"key": f"backup:{host}", "host": host}


def _match_issue_incident(text):
    if not text.startswith("🚨 Incidencia reportada en Seerr"):
        return None
    return {"key": "issue:seerr"}


def _match_issue_test(text):
    if not text.startswith("🧪"):
        return None
    return {"key": "issue:test"}


def _match_smart(text):
    if not text.startswith("🚨 Alerta SMART"):
        return None
    return {"key": "smart:unknown", "emitter": "unknown"}


SIGNATURES = (
    ("wud", _match_wud),
    ("security-digest", _match_security_digest),
    ("security-update", _match_security_update),
    ("release-stop", _match_release_stop),
    ("release-apply", _match_release_apply),
    ("release-upgrade", _match_release_upgrade),
    ("backup", _match_backup),
    ("issue-incident", _match_issue_incident),
    ("issue-test", _match_issue_test),
    ("smart", _match_smart),
)

# Evidence is read-only: file:line in the media-stack checkout or in this repo.
EMITTERS = (
    {
        "id": "wud",
        "job": "vigila etiquetas nuevas de contenedores",
        "evidence": "stacks/monitoring/compose.yaml:78-96",
        "families": ["wud"],
        "channel": "telegram",
        "can_emit_recovery": False,
        "in_cutover": True,
    },
    {
        "id": "security-monitor",
        "job": "resume las actualizaciones de seguridad verificadas",
        "evidence": "stacks/monitoring/security-monitor/main.py:168-206",
        "families": ["security-digest"],
        "channel": "telegram",
        "can_emit_recovery": True,
        "in_cutover": True,
    },
    {
        "id": "security-updater",
        "job": "aplica actualizaciones de seguridad y publica el desenlace",
        "evidence": "stacks/monitoring/security-monitor/updater.py:297-300,315,329,376",
        "families": ["security-update"],
        "channel": "telegram",
        "can_emit_recovery": True,
        "in_cutover": True,
    },
    {
        "id": "upgrade-script",
        "job": "detiene o completa una actualización de release",
        "evidence": "scripts/upgrade.sh:30,39-51",
        "families": ["release-stop", "release-upgrade"],
        "channel": "telegram",
        "can_emit_recovery": True,
        "in_cutover": True,
    },
    {
        "id": "merged-updates",
        "job": "aplica releases agrupados y publica el resultado por servicio",
        "evidence": "scripts/merged_updates.py:148-163,343,347",
        "families": ["release-apply"],
        "channel": "telegram",
        "can_emit_recovery": True,
        "in_cutover": True,
    },
    {
        "id": "backup",
        "job": "avisa de una copia fallida",
        "evidence": "stacks/backup/media-backup.sh:137-157",
        "families": ["backup"],
        "channel": "telegram",
        "can_emit_recovery": False,
        "in_cutover": True,
    },
    {
        "id": "issue-automator",
        "job": "reporta incidencias de Seerr y responde a sus pruebas",
        "evidence": "stacks/extras/issue-automator/main.py:134-150,405-411",
        "families": ["issue-incident", "issue-test"],
        "channel": "telegram",
        "can_emit_recovery": True,
        "in_cutover": True,
    },
    {
        "id": "unknown-smart",
        "job": "alerta SMART del host sin código en ninguno de los dos repos",
        "evidence": "sin código en ninguno de los dos repos",
        "families": ["smart"],
        "channel": "telegram",
        "can_emit_recovery": False,
        "in_cutover": True,
    },
    {
        "id": "hub",
        "job": "notifica por Web Push, no por Telegram",
        "evidence": "src/lib/push.ts:5-33",
        "families": [],
        "channel": "push",
        "can_emit_recovery": True,
        "in_cutover": True,
    },
)

EMITTER_BY_FAMILY = {
    family: emitter["id"]
    for emitter in EMITTERS
    for family in emitter["families"]
}

# Eras are closed calendar windows; the denominator is inclusive_days, never the
# number of days that happen to carry messages.
ERA_WINDOWS = {
    "E1": {"from": "2026-04-25", "to": "2026-09-27"},
    "E2": {"from": "2026-09-28", "to": "2026-11-02"},
    "E3": {"from": "2026-11-03", "to": "2026-11-12"},
    "E4": {"from": "2026-11-13", "to": "2026-11-24"},
}

# E3 is split so the effect of the 3 November commits is not confused with the
# WUD image update of 8 November.
E3_SPLIT = {
    "E3a": {"from": "2026-11-03", "to": "2026-11-07"},
    "E3b": {"from": "2026-11-08", "to": "2026-11-12"},
}

MADRID = ZoneInfo("Europe/Madrid")
ALERTS_HEADER = ("hostId", "key", "severity", "at", "resolvedAt")
BACKUP_PUSH_WINDOW = timedelta(minutes=10)
RELEASE_PUSH_WINDOW = timedelta(hours=2)
PUSH_KEYS_BY_REPORT = {
    "backup": (("backup-failed",), BACKUP_PUSH_WINDOW),
    "deploy": (
        ("deploy-failed", "release-retained"),
        RELEASE_PUSH_WINDOW,
    ),
}

OPENING_FAMILIES = (
    "wud",
    "release-stop",
    "backup",
    "issue-incident",
    "smart",
)
INFORMATIONAL_FAMILIES = (
    "security-digest",
    "release-apply",
    "release-upgrade",
    "issue-test",
)
SECURITY_UPDATE_OPENING_OUTCOMES = ("manual", "failed")
RECOVERY_TEMPLATE_MARKER = "— recuperación completada:"

# Recovery capability is a property of the message family, not of a count: the
# Telegram export cannot prove a recovery that the emitter does not publish.
RECOVERY_CAPABLE = {
    "wud": {
        "can_emit_recovery": False,
        "channel": "telegram",
        "reason": "WUD no anuncia el cese del tag pendiente",
    },
    "security-digest": {
        "can_emit_recovery": False,
        "channel": "telegram",
        "reason": "El digest no declara recuperaciones",
    },
    "security-update": {
        "can_emit_recovery": True,
        "channel": "telegram",
        "recovery_template": "— recuperación completada: <service>",
    },
    "release-stop": {
        "can_emit_recovery": False,
        "channel": "telegram",
        "reason": "upgrade.sh no anuncia la reanudación",
    },
    "release-apply": {
        "can_emit_recovery": False,
        "channel": "telegram",
        "reason": "merged_updates.py no emite un mensaje de cierre",
    },
    "release-upgrade": {
        "can_emit_recovery": False,
        "channel": "telegram",
        "reason": "El éxito del upgrade no cierra un aviso previo",
    },
    "backup": {
        "can_emit_recovery": False,
        "channel": "telegram",
        "reason": "La copia recuperada no se anuncia por Telegram",
    },
    "issue-incident": {
        "can_emit_recovery": False,
        "channel": "telegram",
        "reason": "issue-automator no anuncia el cierre de la incidencia",
    },
    "issue-test": {
        "can_emit_recovery": False,
        "channel": "telegram",
        "reason": "Una prueba manual no abre ni cierra un estado",
    },
    "smart": {
        "can_emit_recovery": False,
        "channel": "telegram",
        "reason": "El emisor SMART no está localizado y no tiene plantilla de recuperación",
    },
    "hub": {
        "can_emit_recovery": True,
        "channel": "push",
        "recovery_template": "Recuperado: <title>",
    },
}

# The decision catalogue: every hub key and every Telegram family gets exactly
# one disposition. D-10 (WUD silent) and D-11 (success to digest, manual and
# failure immediate) are already fixed by the context and are only cited here.
HUB_KEYS = (
    {
        "key": "connection",
        "source": "hub",
        "severity": "critical",
        "bucket": "immediate",
        "rationale": "Fallo crítico: el host no responde y exige acción inmediata.",
    },
    {
        "key": "temperature",
        "source": "hub",
        "severity": "critical",
        "bucket": "immediate",
        "rationale": "Fallo crítico de temperatura; puede dañar el hardware.",
    },
    {
        "key": "backup-failed",
        "source": "hub",
        "severity": "critical",
        "bucket": "immediate",
        "rationale": "La copia falló y exige revisión del operador.",
    },
    {
        "key": "disk-health",
        "source": "hub",
        "severity": "critical en fail, warning en watch",
        "bucket": "immediate",
        "rationale": "El fallo de disco exige acción; watch se vigila en el resumen.",
    },
    {
        "key": "stack-unit-failed",
        "source": "hub",
        "severity": "critical",
        "bucket": "immediate",
        "rationale": "Una unidad del stack cayó y exige acción.",
    },
    {
        "key": "deploy-failed",
        "source": "hub",
        "severity": "critical",
        "bucket": "immediate",
        "rationale": "El despliegue falló y exige acción.",
    },
    {
        "key": "cpu",
        "source": "hub",
        "severity": "warning",
        "bucket": "digest",
        "rationale": "Warning sostenido; se acumula en el resumen diario.",
    },
    {
        "key": "memory",
        "source": "hub",
        "severity": "warning",
        "bucket": "digest",
        "rationale": "Warning sostenido; se acumula en el resumen diario.",
    },
    {
        "key": "disk",
        "source": "hub",
        "severity": "warning",
        "bucket": "digest",
        "rationale": "Warning de espacio; se acumula en el resumen diario.",
    },
    {
        "key": "reboot-pending",
        "source": "hub",
        "severity": "warning",
        "bucket": "digest",
        "rationale": "Aviso informativo; se acumula en el resumen diario.",
    },
    {
        "key": "release-retained",
        "source": "hub",
        "severity": "warning",
        "bucket": "digest",
        "rationale": "Release retenida; se acumula en el resumen diario.",
    },
    {
        "key": "container:<name>",
        "source": "hub",
        "severity": "warning",
        "bucket": "silent",
        "rationale": "Ruido de servicios; se agrupa en services-down en la fase 3.",
        "grouped_in": "phase 3",
    },
)

TELEGRAM_FAMILIES = (
    {
        "family": "wud",
        "bucket": "silent",
        "rationale": "D-10: deja de notificar por Telegram; su UI se mantiene.",
    },
    {
        "family": "security-digest",
        "bucket": "digest",
        "rationale": "Resumen de CVEs; se acumula en el resumen diario.",
    },
    {
        "family": "security-update",
        "bucket": "digest",
        "split_by_outcome": {
            "updated": "digest",
            "manual": "immediate",
            "failed": "immediate",
        },
        "rationale": "D-11: el éxito va al digest; manual y failed exigen acción.",
    },
    {
        "family": "release-stop",
        "bucket": "immediate",
        "rationale": "Upgrade detenido; exige acción del operador.",
    },
    {
        "family": "release-apply",
        "bucket": "digest",
        "split_by_outcome": {"applied": "digest", "failed": "immediate"},
        "rationale": "El éxito va al digest; el fallo exige acción.",
    },
    {
        "family": "release-upgrade",
        "bucket": "digest",
        "rationale": "Upgrade completado; se acumula en el resumen diario.",
    },
    {
        "family": "backup",
        "bucket": "immediate",
        "rationale": "Solo falla; el éxito no emite y no hay recuperación por Telegram.",
    },
    {
        "family": "issue-incident",
        "bucket": "immediate",
        "rationale": "Incidencia de Seerr; fuera del cutover hasta la fase 8.",
    },
    {
        "family": "issue-test",
        "bucket": "silent",
        "rationale": "Prueba manual; no genera mensaje propio.",
    },
    {
        "family": "smart",
        "bucket": "silent",
        "rationale": "SMART desconocido; sustituido por disk-health y fuera del cutover.",
    },
)

POLICY_BUCKETS = ("immediate", "digest", "silent")

REPORT_SECTION_IDS = (
    "resumen",
    "ventana",
    "inventario",
    "eras",
    "eventos",
    "recuperaciones",
    "duplicados",
    "horario",
    "top_claves",
    "push",
    "politica",
    "apagado",
    "objetivo",
    "supuestos",
    "reproducibilidad",
)

# Read-only evidence: `path` is relative to the appdata root passed as --state-root.
EVIDENCE_SOURCES = (
    {
        "id": "export",
        "label": "Export del chat de Telegram",
        "access": "ruta de D-01, fuera del repositorio",
        "proves": "mensajes, fechas, remitentes y contenido de la ventana completa",
        "status": "available",
    },
    {
        "id": "backup-status",
        "label": "Último resultado de copia",
        "access": "lectura directa del appdata",
        "proves": "si la última copia terminó bien o mal",
        "status": "available",
        "path": "backup/last-status",
    },
    {
        "id": "security-status",
        "label": "Última pasada del monitor de seguridad",
        "access": "lectura directa del appdata",
        "proves": "imágenes revisadas y candidatas de la última pasada",
        "status": "available",
        "path": "security-monitor/last-status.json",
    },
    {
        "id": "security-notified",
        "label": "CVEs ya notificados por imagen",
        "access": "lectura directa del appdata",
        "proves": "qué hallazgos ya salieron por Telegram",
        "status": "available",
        "path": "security-monitor/notified-updates.json",
    },
    {
        "id": "update-outbox",
        "label": "Outbox del actualizador de seguridad",
        "access": "lectura directa del appdata",
        "proves": "mensajes pendientes del actualizador",
        "status": "denied",
        "path": "security-monitor/update-notifications.json",
    },
    {
        "id": "failed-release",
        "label": "Último release fallido",
        "access": "lectura directa del appdata",
        "proves": "configuración del último release que falló",
        "status": "denied",
        "path": "security-monitor/merged-releases/failed-release.json",
    },
    {
        "id": "docker-logs",
        "label": "Logs de Docker en el NAS",
        "access": "docker logs por contenedor",
        "proves": "corroborar envíos recientes",
        "status": "partial",
    },
    {
        "id": "journal",
        "label": "Journal del sistema",
        "access": "journalctl -u media-stack-*",
        "proves": "histórico de ejecuciones",
        "status": "unavailable",
    },
    {
        "id": "alerts",
        "label": "Tabla alerts del hub",
        "access": "PostgreSQL del hub vía SSH o UI autenticada",
        "proves": "aperturas y recuperaciones de push",
        "status": "unavailable",
    },
)


def classify(text):
    """Return the first matching family plus its join keys; never raise per message."""
    value = text if isinstance(text, str) else ""
    for family, matcher in SIGNATURES:
        fields = matcher(value)
        if fields is not None:
            return {"family": family, **fields}
    return {"family": "unknown", "key": "unknown"}


def build_inventory(rows):
    """Count the bot messages per family and per emitter, keeping ids and dates only."""
    families = Counter()
    per_emitter = Counter()
    unknown = []
    operator = 0
    for row in rows:
        if sender_kind(row.get("sender")) != "bot":
            operator += 1
            continue
        result = classify(row.get("text"))
        families[result["family"]] += 1
        if result["family"] == "unknown":
            unknown.append({"id": row.get("id"), "sent_at": row.get("sent_at")})
            continue
        per_emitter[(EMITTER_BY_FAMILY[result["family"]], result["family"])] += 1

    emitters = []
    for emitter in EMITTERS:
        by_family = {
            family: per_emitter[(emitter["id"], family)]
            for family in emitter["families"]
            if per_emitter[(emitter["id"], family)]
        }
        emitters.append(
            {
                **emitter,
                "messages": sum(by_family.values()),
                "by_family": by_family,
            }
        )

    shutdown = build_shutdown_order()
    cutover = {
        entry["emitter"]
        for key in ("order", "narrowed")
        for entry in shutdown[key]
    }
    capability = {
        family: spec["can_emit_recovery"] for family, spec in RECOVERY_CAPABLE.items()
    }
    for emitter in emitters:
        emitter_families = emitter["families"] or ["hub"]
        emitter["can_emit_recovery"] = any(
            capability.get(family, False) for family in emitter_families
        )
        emitter["in_cutover"] = emitter["id"] in cutover

    hub = next(entry for entry in emitters if entry["id"] == "hub")
    return {
        "emitters": emitters,
        "families": dict(families),
        "operator": operator,
        "unknown": unknown,
        "hub_telegram_messages": hub["messages"],
        "hub_channel": hub["channel"],
    }


def _as_day(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def build_family_counts(rows, start, end):
    """Count the bot families inside the closed window ``[start, end]``."""
    start_day, end_day = _as_day(start), _as_day(end)
    counts = Counter()
    for row in rows:
        if sender_kind(row.get("sender")) != "bot":
            continue
        day = _as_day(row["sent_at"])
        if start_day <= day <= end_day:
            counts[classify(row.get("text"))["family"]] += 1
    return dict(counts)


def build_rates(eras):
    """The only source of ``rate``: messages per inclusive calendar day."""
    return {
        name: (
            round(era["messages"] / era["inclusive_days"], 2)
            if era["inclusive_days"]
            else 0.0
        )
        for name, era in eras.items()
    }


def build_eras(rows):
    """Segment the dataset into the four closed eras with an explicit denominator."""
    eras = {}
    for name, window in ERA_WINDOWS.items():
        start = _as_day(window["from"])
        end = _as_day(window["to"])
        inclusive_days = (end - start).days + 1
        messages = sum(
            1
            for row in rows
            if start <= _as_day(row["sent_at"]) <= end
        )
        eras[name] = {
            "from": window["from"],
            "to": window["to"],
            "inclusive_days": inclusive_days,
            "span_days": inclusive_days - 1,
            "messages": messages,
            # Placeholder until 01-02 counts the WUD scan passes.
            "events": messages,
            "by_family": build_family_counts(rows, start, end),
        }
    for name, rate in build_rates(eras).items():
        eras[name]["rate"] = rate
    return eras


def _is_recovery(value, classified):
    """The updater's recovery template is the only one that can appear in Telegram."""
    return (
        classified["family"] == "security-update"
        and RECOVERY_TEMPLATE_MARKER in value
    )


def build_openings(rows):
    """Split the bot messages into openings, informational and recoveries.

    A message counts once, even when the updater lists several services in it.
    """
    counts = {"openings": 0, "informational": 0, "recovery_messages": 0}
    by_family = {}
    for row in rows:
        if sender_kind(row.get("sender")) != "bot":
            continue
        value = row.get("text") or ""
        classified = classify(value)
        family_name = classified["family"]
        entry = by_family.setdefault(
            family_name,
            {
                "messages": 0,
                "openings": 0,
                "informational": 0,
                "recovery_messages": 0,
            },
        )
        entry["messages"] += 1
        if _is_recovery(value, classified):
            bucket = "recovery_messages"
        elif family_name in OPENING_FAMILIES:
            bucket = "openings"
        elif family_name == "release-apply":
            bucket = (
                "openings"
                if classified.get("outcome") == "failed"
                else "informational"
            )
        elif family_name == "security-update":
            outcomes = {
                update["outcome"] for update in classified.get("updates", [])
            }
            bucket = (
                "openings"
                if outcomes & set(SECURITY_UPDATE_OPENING_OUTCOMES)
                else "informational"
            )
        else:
            # Known informational families, plus an unmatched bot message: it
            # never opens a state and it never proves a recovery.
            bucket = "informational"
        counts[bucket] += 1
        entry[bucket] += 1
    return {**counts, "by_family": by_family}


def _alert_rows(alerts):
    if alerts is None:
        return None
    if isinstance(alerts, dict):
        return alerts.get("rows", [])
    return list(alerts)


def _iso_utc(value):
    if value is None:
        return None
    moment = value
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _hub_push(alerts):
    rows = _alert_rows(alerts)
    if rows is None:
        return {
            "status": "unavailable",
            "source": "alerts.resolvedAt",
            "openings": None,
            "recovery_messages": None,
            "recovery_ratio": None,
            "push_decision_at": None,
            "push_resolved_at": None,
            "push_latency_s": None,
        }
    resolved = [entry for entry in rows if entry.get("resolvedAt") is not None]
    first = min(resolved, key=lambda entry: entry["at"]) if resolved else None
    return {
        "status": "measured",
        "source": "alerts.resolvedAt",
        "openings": len(rows),
        "recovery_messages": len(resolved),
        "recovery_ratio": round(len(resolved) / len(rows), 4) if rows else 0.0,
        "push_decision_at": _iso_utc(first["at"]) if first else None,
        "push_resolved_at": _iso_utc(first["resolvedAt"]) if first else None,
        "push_latency_s": (
            round((first["resolvedAt"] - first["at"]).total_seconds(), 2)
            if first
            else None
        ),
    }


def build_recoveries(rows, alerts=None):
    """Publish each channel separately; never add Telegram and hub into one figure."""
    split = build_openings(rows)
    openings = split["openings"]
    recovery_messages = split["recovery_messages"]
    capabilities = {}
    for family_name in [name for name, _matcher in SIGNATURES] + ["hub"]:
        capability = RECOVERY_CAPABLE[family_name]
        capabilities[family_name] = {
            "can_emit_recovery": capability["can_emit_recovery"],
            "channel": capability["channel"],
            "recovery_template": capability.get("recovery_template"),
            "reason": capability.get("reason"),
        }
    return {
        "telegram": {
            "messages": sum(entry["messages"] for entry in split["by_family"].values()),
            "openings": openings,
            "informational": split["informational"],
            "recovery_messages": recovery_messages,
            "recovery_ratio": (
                round(recovery_messages / openings, 4) if openings else 0.0
            ),
            "by_family": split["by_family"],
            "by_family_capability": capabilities,
        },
        "hub_push": _hub_push(alerts),
    }


def to_instant(sent_at):
    """Turn the export wall clock into a UTC instant, resolving the date's offset."""
    moment = datetime.fromisoformat(str(sent_at))
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=MADRID)
    return moment.astimezone(timezone.utc)


def _parse_utc(value):
    value = (value or "").strip()
    if not value:
        raise ValueError("instante vacío")
    moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def load_alerts_csv(path):
    """Read the optional alerts CSV; malformed rows are counted, never fatal."""
    with Path(path).open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if tuple(reader.fieldnames or ()) != ALERTS_HEADER:
            raise ValueError(
                "cabecera del CSV de alerts distinta de "
                + ",".join(ALERTS_HEADER)
            )
        rows = []
        skipped_rows = 0
        for raw in reader:
            try:
                host_id = (raw.get("hostId") or "").strip()
                key = (raw.get("key") or "").strip()
                severity = (raw.get("severity") or "").strip()
                if not host_id or not key or not severity:
                    raise ValueError("fila incompleta")
                at = _parse_utc(raw.get("at"))
                resolved_raw = (raw.get("resolvedAt") or "").strip()
                resolved_at = _parse_utc(resolved_raw) if resolved_raw else None
                if resolved_at is not None and resolved_at < at:
                    raise ValueError("resolvedAt anterior a at")
            except (AttributeError, TypeError, ValueError):
                skipped_rows += 1
                continue
            rows.append(
                {
                    "hostId": host_id,
                    "key": key,
                    "severity": severity,
                    "at": at,
                    "resolvedAt": resolved_at,
                    "push_status": "measured",
                }
            )
    return {"rows": rows, "skipped_rows": skipped_rows}


def _push_match(classified):
    key = classified.get("key") or ""
    if key.startswith("backup:"):
        return PUSH_KEYS_BY_REPORT["backup"]
    if (
        key.startswith("deploy:")
        or key.startswith("release:apply")
        or key.startswith("release:stop")
    ):
        return PUSH_KEYS_BY_REPORT["deploy"]
    return None, None


def join_push_windows(alerts, rows):
    """One alerts row per Telegram message, inside the declared channel window."""
    joined = []
    for row in rows:
        if sender_kind(row.get("sender")) != "bot" or row.get("time") is None:
            continue
        classified = classify(row.get("text"))
        alert_keys, window = _push_match(classified)
        if not alert_keys:
            continue
        moment = to_instant(row["sent_at"])
        candidates = [
            entry
            for entry in alerts
            if entry["key"] in alert_keys and abs(entry["at"] - moment) <= window
        ]
        if not candidates:
            continue
        entry = min(
            candidates, key=lambda candidate: (abs(candidate["at"] - moment), candidate["at"])
        )
        joined.append(
            {
                "message_id": row.get("id"),
                "alert_key": entry["key"],
                "push_decision_at": _iso_utc(entry["at"]),
                "push_resolved_at": _iso_utc(entry["resolvedAt"]),
                "push_latency_s": round(
                    (moment - entry["at"]).total_seconds(), 2
                ),
                "push_status": "measured",
            }
        )
    return joined


def _inter_system(rows):
    wud = sorted(
        (
            (row, classify(row.get("text")))
            for row in rows
            if sender_kind(row.get("sender")) == "bot"
            and classify(row.get("text"))["family"] == "wud"
        ),
        key=lambda pair: (pair[0]["sent_at"], pair[0].get("id") or ""),
    )
    security = [
        (row, classify(row.get("text")))
        for row in rows
        if sender_kind(row.get("sender")) == "bot"
        and classify(row.get("text"))["family"] == "security-update"
    ]
    window = timedelta(days=2)
    items = []
    for wud_row, wud_classified in wud:
        if wud_row.get("time") is None:
            continue
        wud_at = datetime.fromisoformat(wud_row["sent_at"])
        hits = []
        for security_row, security_classified in security:
            if security_row.get("time") is None:
                continue
            security_at = datetime.fromisoformat(security_row["sent_at"])
            if abs(security_at - wud_at) > window:
                continue
            for update in security_classified.get("updates", []):
                if update["container"] == wud_classified["container"]:
                    hits.append((update, security_at))
        if not hits:
            continue
        hits.sort(key=lambda pair: pair[1])
        best = next(
            (update for update, _at in hits if update["outcome"] == "updated"),
            hits[0][0],
        )
        items.append(
            {
                "container": wud_classified["container"],
                "wud_target": wud_classified["target_tag"],
                "same_target": any(
                    update["target_tag"] == wud_classified["target_tag"]
                    for update, _at in hits
                ),
                "outcome": best["outcome"],
                # A delay, not a lead: only updates at or after the notice count.
                "latency_min": min(
                    (
                        round((at - wud_at).total_seconds() / 60)
                        for _update, at in hits
                        if at >= wud_at
                    ),
                    default=None,
                ),
            }
        )
    real_update = sum(1 for item in items if item["outcome"] == "updated")
    return {
        "status": "measured",
        "pair": "wud-security-updater",
        "window_days": 2,
        "messages": len(items),
        "same_target": sum(1 for item in items if item["same_target"]),
        "real_update": real_update,
        "manual_only": len(items) - real_update,
        "latency_min": min(
            (
                item["latency_min"]
                for item in items
                if item["latency_min"] is not None
            ),
            default=None,
        ),
        "items": items,
    }


def _inter_channel(rows, alerts):
    if alerts is None:
        return {
            "status": "unavailable",
            "pair": "push-telegram",
            "candidates": ["backup-failed"],
            "duplicates": None,
            "latency_s": None,
            "reason": "sin CSV de alerts",
        }
    joined = join_push_windows(_alert_rows(alerts), rows)
    backup = [
        entry for entry in joined if entry["alert_key"] == "backup-failed"
    ]
    latencies = [
        entry["push_latency_s"]
        for entry in backup
        if entry["push_latency_s"] is not None
    ]
    return {
        "status": "measured",
        "pair": "push-telegram",
        "candidates": ["backup-failed"],
        "duplicates": len(backup),
        "latency_s": (
            round(sum(latencies) / len(latencies), 2) if latencies else None
        ),
        "reason": None,
        "items": joined,
    }


def build_duplicates(rows, alerts=None):
    """Publish the Telegram overlap and the push overlap as two separate blocks."""
    return {
        "inter_system": _inter_system(rows),
        "inter_channel": _inter_channel(rows, alerts),
    }


def _hour_buckets():
    return {str(hour): 0 for hour in range(24)}


def build_histogram(rows):
    """Hourly distribution in the export wall clock; never shift the hour."""
    buckets = _hour_buckets()
    by_era = {name: _hour_buckets() for name in ERA_WINDOWS}
    missing_time = 0
    for row in rows:
        if not row.get("time") or row.get("hour") is None:
            missing_time += 1
            continue
        hour = str(row["hour"])
        buckets[hour] += 1
        day = _as_day(row["sent_at"])
        for name, window in ERA_WINDOWS.items():
            if _as_day(window["from"]) <= day <= _as_day(window["to"]):
                by_era[name][hour] += 1
                break
    return {"buckets": buckets, "by_era": by_era, "missing_time": missing_time}


def key_for(row):
    """Normalised event key: the unit the next phase will route by channel."""
    return classify(row.get("text")).get("key", "unknown")


def build_top_keys(rows, limit=3):
    """Top event keys, deterministic by volume and then by key name."""
    counts = Counter()
    by_era = {name: Counter() for name in ERA_WINDOWS}
    total = 0
    for row in rows:
        if sender_kind(row.get("sender")) != "bot":
            continue
        total += 1
        key = key_for(row)
        counts[key] += 1
        day = _as_day(row["sent_at"])
        for name, window in ERA_WINDOWS.items():
            if _as_day(window["from"]) <= day <= _as_day(window["to"]):
                by_era[name][key] += 1
                break
    ranked = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))[:limit]
    return [
        {
            "key": key,
            "messages": messages,
            "by_era": {
                name: by_era[name].get(key, 0) for name in ERA_WINDOWS
            },
            "share": round(messages / total, 3) if total else 0.0,
        }
        for key, messages in ranked
    ]


def _wall_clock(value):
    return datetime.fromisoformat(str(value))


def build_wud_events(rows, gap_minutes=5):
    """Group WUD messages into scan passes; 95 messages are not 95 events."""
    gap = timedelta(minutes=gap_minutes)
    wud = sorted(
        (
            (row, classify(row.get("text")))
            for row in rows
            if sender_kind(row.get("sender")) == "bot"
            and classify(row.get("text"))["family"] == "wud"
        ),
        key=lambda pair: (pair[0]["sent_at"], pair[0].get("id") or ""),
    )
    passes = []
    current = None
    for row, classified in wud:
        moment = _wall_clock(row["sent_at"])
        if current is not None and moment - current["_last"] <= gap:
            current["end"] = row["sent_at"]
            current["_last"] = moment
        else:
            current = {
                "start": row["sent_at"],
                "end": row["sent_at"],
                "containers": [],
                "_last": moment,
            }
            passes.append(current)
        container = classified.get("container")
        if container and container not in current["containers"]:
            current["containers"].append(container)
    for entry in passes:
        entry.pop("_last", None)
        entry["containers"] = sorted(entry["containers"])
    messages = len(wud)
    return {
        "messages": messages,
        "scan_passes": len(passes),
        "messages_per_event": (
            round(messages / len(passes), 2) if passes else 0.0
        ),
        "passes": passes,
    }


def build_repetitions(rows):
    """Repeated (container, target_tag) WUD notices, independent of duplicates."""
    counts = Counter()
    for row in rows:
        if sender_kind(row.get("sender")) != "bot":
            continue
        classified = classify(row.get("text"))
        if classified["family"] != "wud":
            continue
        counts[(classified["container"], classified["target_tag"])] += 1
    groups = [
        {
            "container": container,
            "target_tag": target_tag,
            "messages": messages,
            "extra_messages": messages - 1,
        }
        for (container, target_tag), messages in sorted(counts.items())
        if messages > 1
    ]
    return {
        "groups": groups,
        "repeated_groups": len(groups),
        "extra_messages": sum(group["extra_messages"] for group in groups),
    }


def apply_wud_events(eras, wud_events, rows):
    """Publish the double figure: WUD scan passes plus other bot messages."""
    classified = [
        (row, classify(row.get("text"))["family"])
        for row in rows
        if sender_kind(row.get("sender")) == "bot"
    ]
    for name, era in eras.items():
        start = _as_day(era["from"])
        end = _as_day(era["to"])
        passes = sum(
            1
            for entry in wud_events["passes"]
            if start <= _as_day(entry["start"]) <= end
        )
        others = sum(
            1
            for row, family_name in classified
            if family_name != "wud"
            and start <= _as_day(row["sent_at"]) <= end
        )
        era["events"] = passes + others
    return eras


def _window_emitter(row):
    if sender_kind(row.get("sender")) != "bot":
        return "operator"
    family_name = classify(row.get("text"))["family"]
    if family_name == "unknown":
        return "unknown"
    return EMITTER_BY_FAMILY.get(family_name, "unknown")


def build_windows(rows, days=(30, 60, 90)):
    """Rolling windows anchored at the last message day, with per-emitter rates."""
    if not rows:
        raise ValueError("no hay filas para construir las ventanas")
    last_day = max(_as_day(row["sent_at"]) for row in rows)
    windows = {}
    for size in days:
        start = last_day - timedelta(days=size - 1)
        selected = [
            row
            for row in rows
            if start <= _as_day(row["sent_at"]) <= last_day
        ]
        by_family = Counter()
        by_emitter = {
            emitter["id"]: {"messages": 0, "rate": 0.0}
            for emitter in EMITTERS
        }
        for row in selected:
            emitter_id = _window_emitter(row)
            by_emitter.setdefault(emitter_id, {"messages": 0, "rate": 0.0})
            by_emitter[emitter_id]["messages"] += 1
            if sender_kind(row.get("sender")) == "bot":
                by_family[classify(row.get("text"))["family"]] += 1
        for entry in by_emitter.values():
            entry["rate"] = round(entry["messages"] / size, 2)
        messages = len(selected)
        windows[f"{size}d"] = {
            "from": start.isoformat(),
            "to": last_day.isoformat(),
            "messages": messages,
            "inclusive_days": size,
            "rate": round(messages / size, 2),
            "by_family": dict(by_family),
            "by_emitter": by_emitter,
        }
    return windows


def build_shutdown_order():
    """The five-step cutover: the copy is narrowed, never shut off, and two wait."""
    return {
        "order": [
            {
                "emitter": "upgrade-script",
                "families": ["release-stop", "release-upgrade"],
                "replacement": "deploy-failed en el hub y digest",
                "reversibility": "media",
                "reason": (
                    "Su fallo ya está cubierto por deploy-failed; su éxito "
                    "es el caso de D-11."
                ),
            },
            {
                "emitter": "merged-updates",
                "families": ["release-apply"],
                "replacement": "deploy-failed y digest",
                "reversibility": "media",
                "reason": (
                    "Despliega releases; el fallo ya se refleja en deploy-failed."
                ),
            },
            {
                "emitter": "security-updater",
                "families": ["security-update"],
                "replacement": "ingesta y digest (fases 4 y 8)",
                "reversibility": "media",
                "reason": "Necesita el digest para que el éxito no interrumpa.",
            },
            {
                "emitter": "security-monitor",
                "families": ["security-digest"],
                "replacement": "digest del hub disponible antes del apagado",
                "reversibility": "media",
                "reason": "Conserva el resumen de CVEs durante el traspaso.",
            },
            {
                "emitter": "wud",
                "families": ["wud"],
                "replacement": "UI de WUD y recuento en el digest",
                "reversibility": "alta",
                "reason": (
                    "Es el mayor volumen; su UI sigue siendo la fuente de "
                    "verdad y su API alimenta al monitor."
                ),
            },
        ],
        "narrowed": [
            {
                "emitter": "backup",
                "to": "backup-failed",
                "origin": "media-stack backup",
                "requirement": "SEC-06",
                "reason": "PITFALLS #24",
            }
        ],
        "out_of_scope": [
            {
                "emitter": "issue-automator",
                "families": ["issue-incident", "issue-test"],
                "revisit": "phase 8",
                "reason": "Es una función de Seerr, no del hub.",
            },
            {
                "emitter": "unknown-smart",
                "families": ["smart"],
                "revisit": "phase 8",
                "reason": "Sustituido por disk-health y sin código localizable.",
            },
        ],
        "never_shut_off": ["backup"],
    }


def build_temporal_markers():
    """The four milestones of D-06, each with its cutoff and its effect."""
    return [
        {
            "id": "16d824e",
            "date": "2026-10-16",
            "cutoff": "2026-10-16T16:35:20",
            "date_only": False,
            "effect": (
                "Arreglo de avisos de security-updates: cambia el formato, "
                "no el volumen."
            ),
        },
        {
            "id": "d6831af",
            "date": "2026-11-03",
            "cutoff": "2026-11-03T18:55:08",
            "date_only": False,
            "effect": (
                "Silencia los rebuilds de linuxserver en WUD con tag.transform."
            ),
        },
        {
            "id": "38061f0",
            "date": "2026-11-03",
            "cutoff": "2026-11-03T19:11:43",
            "date_only": False,
            "effect": (
                "Release y actualizaciones compatibles automáticas: nuevo "
                "flujo de releases."
            ),
        },
        {
            "id": "cc8d8a3",
            "date": "2026-11-08",
            "cutoff": "2026-11-08T00:23:11",
            "date_only": False,
            "effect": (
                "WUD 9.8.0: la actualización de imagen no reintroduce el "
                "ruido de rebuilds."
            ),
        },
    ]


def _era_metrics(rows, window):
    start = _as_day(window["from"])
    end = _as_day(window["to"])
    messages = sum(
        1 for row in rows if start <= _as_day(row["sent_at"]) <= end
    )
    return {
        "from": window["from"],
        "to": window["to"],
        "inclusive_days": (end - start).days + 1,
        "messages": messages,
        "by_family": build_family_counts(rows, start, end),
    }


def build_trend_table(rows):
    """Publish E1, E2, E3a, E3b and E4 with the markers around each window."""
    markers = build_temporal_markers()
    windows = {
        "E1": ERA_WINDOWS["E1"],
        "E2": ERA_WINDOWS["E2"],
        "E3a": E3_SPLIT["E3a"],
        "E3b": E3_SPLIT["E3b"],
        "E4": ERA_WINDOWS["E4"],
    }
    eras = {}
    for name, window in windows.items():
        entry = _era_metrics(rows, window)
        entry["markers_before"] = [
            marker["id"] for marker in markers if marker["date"] < window["from"]
        ]
        entry["markers_after"] = [
            marker["id"] for marker in markers if marker["date"] >= window["from"]
        ]
        eras[name] = entry
    return {"markers": markers, "eras": eras}


def _decimal(value):
    return f"{value:.2f}".replace(".", ",")


def build_footnotes(eras, push=None):
    """Three notes: the denominator, the push column and the missing ack."""
    e1 = eras["E1"]
    e4 = eras["E4"]
    measured_push = push is not None and push.get("status") == "measured"
    push_body = (
        (
            "La columna de push se mide con el CSV de alerts: "
            f"{push['rows']} filas y {push['skipped_rows']} omitidas; no se "
            "infiere del volumen de Telegram."
        )
        if measured_push
        else (
            "La columna de push se publica como —: no hay CSV de la tabla "
            "alerts, así que no se rellena con 0 ni se infiere del volumen "
            "de Telegram."
        )
    )
    return [
        {
            "id": "denominator",
            "title": "Denominador del ritmo",
            "body": (
                "La discusión usó un denominador no declarado (0,04/día en E1 "
                "y 1,15/día en E4). Este informe usa días inclusivos: "
                f"E1 {e1['messages']}/{e1['inclusive_days']} = "
                f"{_decimal(e1['messages'] / e1['inclusive_days'])} y "
                f"E4 {e4['messages']}/{e4['inclusive_days']} = "
                f"{_decimal(e4['messages'] / e4['inclusive_days'])}; "
                "los conteos no cambian."
            ),
        },
        {
            "id": "push_coverage",
            "title": "Cobertura de push",
            "body": push_body,
        },
        {
            "id": "ack_unavailable",
            "title": "Ack no medido",
            "body": (
                "El tiempo hasta reconocer se publica como —: no existe ackAt "
                "hasta la fase 6, así que no se inventa un 0."
            ),
        },
    ]


def _policy_entry(entry):
    item = {
        "key": entry.get("key") or entry.get("family"),
        "source": entry.get("source", "telegram"),
        "rationale": entry["rationale"],
    }
    if entry.get("split_by_outcome"):
        item["split_by_outcome"] = dict(entry["split_by_outcome"])
    if entry.get("grouped_in"):
        item["grouped_in"] = entry["grouped_in"]
    return item


def build_policy_map():
    """One disposition per key: the union is the 12 hub keys plus 10 families."""
    buckets = {name: [] for name in POLICY_BUCKETS}
    for entry in HUB_KEYS:
        buckets[entry["bucket"]].append(_policy_entry(entry))
    for entry in TELEGRAM_FAMILIES:
        buckets[entry["bucket"]].append(_policy_entry(entry))
    counts = {name: len(buckets[name]) for name in POLICY_BUCKETS}
    return {
        "buckets": buckets,
        "counts": counts,
        "total_keys": sum(counts.values()),
        "cutover": {
            "silent": ["wud"],
            "narrowed": ["backup"],
            "out_of_scope": ["issue-automator", "unknown-smart"],
            "revisit": "phase 8",
        },
    }


def build_success_target(eras):
    """The target is numeric, rests on E4's inclusive days and never invents an ack."""
    baseline = eras["E4"]
    return {
        "baseline_era": "E4",
        "baseline_inclusive_days": baseline["inclusive_days"],
        "baseline_messages_per_day": baseline["rate"],
        "proactive_messages_per_day": 1.0,
        "definition": (
            "Mediana diaria de mensajes proactivos fuera del digest, medida "
            "sobre una ventana de 14 días consecutivos."
        ),
        "window_days": 14,
        "ack": {
            "metric": "median(sentAt -> ackAt)",
            "guard": "p90",
            "per_severity": True,
            "immediate_median_target_minutes": 15,
            "p90_guard_minutes": 60,
            "current": None,
            "status": "not_measurable",
            "reason": (
                "No existe ackAt: los botones y el ack llegan en la fase 6, "
                "así que el valor se publica como — y no como 0."
            ),
        },
    }


def _section(section_id, title, source, tables=None, paragraphs=None):
    section = {"id": section_id, "title": title, "source": source}
    if tables:
        section["tables"] = tables
    if paragraphs:
        section["paragraphs"] = paragraphs
    return section


def _table(title, columns, rows):
    return {
        "title": title,
        "columns": list(columns),
        "rows": [list(values) for values in rows],
    }


def _split_label(split):
    return "; ".join(
        f"{outcome}→{split[outcome]}" for outcome in sorted(split)
    )


ASSUMPTIONS = (
    {
        "id": "A1",
        "claim": "La hora del export es hora de pared de Madrid.",
        "risk": "El histograma se desplaza 1 o 2 horas y los picos de las 06:00 se leen mal.",
    },
    {
        "id": "A2",
        "claim": "Las firmas de los mensajes son estables y únicas en toda la ventana.",
        "risk": "Un cambio de plantilla manda mensajes a unknown y subestima una familia.",
    },
    {
        "id": "A3",
        "claim": (
            "Los 14 mensajes WUD con coincidencia son el mismo pendiente avisado "
            "por dos sistemas."
        ),
        "risk": "Si son hechos distintos, se sobrecuenta el duplicado.",
    },
    {
        "id": "A4",
        "claim": "issue-automator y SMART quedan fuera del cutover.",
        "risk": "El mapa quedaría incompleto si el operador quiere apagar también Seerr.",
    },
    {
        "id": "A5",
        "claim": (
            "El export contiene todo el tráfico de Telegram relevante: un solo "
            "chat y un solo bot."
        ),
        "risk": "Si hubiera otro chat o bot, faltarían mensajes.",
    },
    {
        "id": "A6",
        "claim": "El acceso a alerts sigue sin estar disponible durante la fase.",
        "risk": "Si aparece, hay que rellenar la columna de push.",
    },
    {
        "id": "A7",
        "claim": "E4, con 12 días, es una línea base suficiente para el objetivo.",
        "risk": "Un objetivo calculado sobre 12 días puede ser demasiado estricto o laxo.",
    },
    {
        "id": "A8",
        "claim": (
            "Los dos mensajes SMART del 25 abr son el mismo hecho con dos "
            "codificaciones."
        ),
        "risk": "Contarlos como dos eventos sobrecuenta E1 en un evento.",
    },
)


def _counts_sentence(counts):
    return (
        f"{counts['immediate']} immediate, {counts['digest']} digest y "
        f"{counts['silent']} silent"
    )


def _peak_hour(buckets):
    ranked = sorted(
        ((count, int(hour)) for hour, count in buckets.items() if count),
        key=lambda pair: (-pair[0], pair[1]),
    )
    return ranked[0] if ranked else (0, 0)


def build_report_model(aggregate):
    """Render model built only from aggregates; it never sees a message body."""
    dataset = aggregate["dataset"]
    source = aggregate["source"]
    inventory = aggregate["inventory"]
    eras = aggregate["eras"]
    trend = aggregate["trend"]
    wud_events = aggregate["wud_events"]
    repetitions = aggregate["repetitions"]
    histogram = aggregate["histogram"]
    top_keys = aggregate["top_keys"]
    recoveries = aggregate["recoveries"]
    duplicates = aggregate["duplicates"]
    push = aggregate["push"]
    policy = aggregate["policy"]
    shutdown = aggregate["shutdown_order"]
    target = aggregate["success_target"]
    footnotes = {note["id"]: note for note in aggregate["footnotes"]}

    telegram = recoveries["telegram"]
    hub_push = recoveries["hub_push"]
    if hub_push["status"] == "measured":
        hub_paragraph = (
            f"El hub publica {hub_push['openings']} aperturas y "
            f"{hub_push['recovery_messages']} recuperaciones "
            f"(ratio {hub_push['recovery_ratio']}) desde alerts.resolvedAt."
        )
        hub_row = [
            "hub_push",
            hub_push["openings"],
            None,
            hub_push["recovery_messages"],
            hub_push["recovery_ratio"],
            hub_push["status"],
        ]
    else:
        hub_paragraph = (
            "El hub queda unavailable: sin CSV de alerts no hay cifra de push "
            "y se publica —, nunca 0."
        )
        hub_row = ["hub_push", None, None, None, None, hub_push["status"]]
    if push["status"] == "measured":
        push_source = "state"
        push_paragraph = (
            f"La tabla alerts está disponible: push queda {push['status']} con "
            f"{push['rows']} filas y {push['skipped_rows']} omitidas."
        )
    else:
        push_source = "no medido"
        push_paragraph = (
            f"La tabla alerts no está disponible: push queda {push['status']}. "
            "La columna se publica como — y no se infiere del volumen de Telegram."
        )
    inter_system = duplicates["inter_system"]
    inter_channel = duplicates["inter_channel"]
    ack = target["ack"]
    peak_messages, peak_hour = _peak_hour(histogram["by_era"]["E4"])
    policy_rows = [
        [
            entry["key"],
            entry["source"],
            bucket,
            _split_label(entry["split_by_outcome"]) if entry.get("split_by_outcome") else "—",
        ]
        for bucket in POLICY_BUCKETS
        for entry in policy["buckets"][bucket]
    ]
    eras_order = ("E1", "E2", "E3a", "E3b", "E4")
    sections = [
        _section(
            "resumen",
            "Resumen",
            "export",
            paragraphs=[
                (
                    f"El export contiene {dataset['messages']} mensajes "
                    f"({dataset['bot_messages']} del bot y {dataset['operator_messages']} "
                    f"del operador) entre {dataset['first_at'][:10]} y "
                    f"{dataset['last_at'][:10]}, en {dataset['inclusive_days']} días inclusivos."
                ),
                (
                    "El bot usa 10 familias y 9 emisores; el hub no envía Telegram y "
                    "sus 12 claves se mapean por separado."
                ),
                (
                    f"El mapa de política fija {_counts_sentence(policy['counts'])}; "
                    f"el orden de apagado tiene {len(shutdown['order'])} pasos y la "
                    "copia se estrecha en vez de apagarse."
                ),
                (
                    f"El objetivo propuesto es {target['proactive_messages_per_day']} "
                    f"mensajes proactivos/día frente a "
                    f"{target['baseline_messages_per_day']} de E4, con el ack "
                    "publicado como —."
                ),
            ],
            tables=[
                _table(
                    "Cifras de cabecera",
                    ["Cifra", "Valor", "Origen"],
                    [
                        ["Mensajes totales", dataset["messages"], "export"],
                        ["Mensajes del bot", dataset["bot_messages"], "export"],
                        ["Mensajes del operador", dataset["operator_messages"], "export"],
                        ["Claves con disposición", policy["total_keys"], "codigo"],
                        ["Pasos de apagado", len(shutdown["order"]), "codigo"],
                        ["Objetivo proactivo/día", target["proactive_messages_per_day"], "export"],
                    ],
                )
            ],
        ),
        _section(
            "ventana",
            "Ventana medida",
            "export",
            paragraphs=[
                (
                    "La ventana se cierra en el último mensaje, no en la fecha del "
                    "export; el denominador es inclusivo y se declara por era."
                )
            ],
            tables=[
                _table(
                    "Ventana y fuente",
                    ["Campo", "Valor"],
                    [
                        ["Primer mensaje", dataset["first_at"]],
                        ["Último mensaje", dataset["last_at"]],
                        ["Días inclusivos", dataset["inclusive_days"]],
                        ["Días con mensajes", dataset["days_with_messages"]],
                        ["Mensajes sin hora", dataset["missing_time"]],
                        ["Separadores de fecha", dataset["date_separators"]],
                        ["sha256 del export", source["sha256"]],
                        ["Bytes del export", source["bytes"]],
                    ],
                )
            ],
        ),
        _section(
            "inventario",
            "Inventario de emisores",
            "export",
            paragraphs=[
                (
                    f"Se identifican {len(inventory['emitters'])} emisores. El hub "
                    f"declara {inventory['hub_telegram_messages']} mensajes de Telegram "
                    f"porque su canal es {inventory['hub_channel']}."
                )
            ],
            tables=[
                _table(
                    "Emisores",
                    ["Emisor", "Canal", "Mensajes"],
                    [
                        [entry["id"], entry["channel"], entry["messages"]]
                        for entry in inventory["emitters"]
                    ],
                ),
                _table(
                    "Familias del bot",
                    ["Familia", "Mensajes"],
                    [
                        [family, messages]
                        for family, messages in sorted(inventory["families"].items())
                    ],
                ),
            ],
        ),
        _section(
            "eras",
            "Eras y tendencia",
            "export",
            paragraphs=[
                (
                    "Cada era publica mensajes y eventos con su denominador inclusivo. "
                    "E3 se parte en E3a (3–7 nov) y E3b (8–12 nov) para no confundir "
                    "el efecto del tag.transform con el de WUD 9.8.0."
                )
            ],
            tables=[
                _table(
                    "Eras",
                    ["Era", "Desde", "Hasta", "Días", "Mensajes", "Eventos", "Mensajes/día"],
                    [
                        [
                            name,
                            eras[name]["from"],
                            eras[name]["to"],
                            eras[name]["inclusive_days"],
                            eras[name]["messages"],
                            eras[name]["events"],
                            eras[name]["rate"],
                        ]
                        for name in ("E1", "E2", "E3", "E4")
                    ],
                ),
                _table(
                    "Tendencia con E3 partida",
                    [
                        "Ventana",
                        "Desde",
                        "Hasta",
                        "Días",
                        "Mensajes",
                        "Marcadores previos",
                        "Marcadores posteriores",
                    ],
                    [
                        [
                            name,
                            trend["eras"][name]["from"],
                            trend["eras"][name]["to"],
                            trend["eras"][name]["inclusive_days"],
                            trend["eras"][name]["messages"],
                            ", ".join(trend["eras"][name]["markers_before"]) or "—",
                            ", ".join(trend["eras"][name]["markers_after"]) or "—",
                        ]
                        for name in eras_order
                    ],
                ),
            ],
        ),
        _section(
            "eventos",
            "Eventos y repeticiones",
            "export",
            paragraphs=[
                (
                    f"WUD agrupa {wud_events['messages']} mensajes en "
                    f"{wud_events['scan_passes']} pasadas de escaneo "
                    f"({wud_events['messages_per_event']} mensajes por pasada)."
                ),
                (
                    f"Las repeticiones suman {repetitions['repeated_groups']} grupos y "
                    f"{repetitions['extra_messages']} mensajes extra."
                ),
            ],
            tables=[
                _table(
                    "Grupos repetidos",
                    ["Contenedor", "Tag destino", "Mensajes", "Extras"],
                    [
                        [
                            group["container"],
                            group["target_tag"],
                            group["messages"],
                            group["extra_messages"],
                        ]
                        for group in repetitions["groups"]
                    ],
                )
            ],
        ),
        _section(
            "recuperaciones",
            "Recuperaciones por canal",
            "state",
            paragraphs=[
                (
                    f"Telegram publica {telegram['openings']} aperturas, "
                    f"{telegram['informational']} informativos y "
                    f"{telegram['recovery_messages']} recuperaciones "
                    f"(ratio {telegram['recovery_ratio']})."
                ),
                hub_paragraph,
            ],
            tables=[
                _table(
                    "Recuperaciones por canal",
                    ["Canal", "Aperturas", "Informativos", "Recuperaciones", "Ratio", "Estado"],
                    [
                        [
                            "telegram",
                            telegram["openings"],
                            telegram["informational"],
                            telegram["recovery_messages"],
                            telegram["recovery_ratio"],
                            "measured",
                        ],
                        hub_row,
                    ],
                )
            ],
        ),
        _section(
            "duplicados",
            "Duplicados",
            "export",
            paragraphs=[
                (
                    "El duplicado entre sistemas y el duplicado entre canales se "
                    "publican en bloques separados y nunca se suman en una cifra."
                )
            ],
            tables=[
                _table(
                    "Duplicado entre sistemas",
                    ["Mensajes", "Mismo tag", "Actualización real", "Solo manual", "Latencia mínima (min)"],
                    [
                        [
                            inter_system["messages"],
                            inter_system["same_target"],
                            inter_system["real_update"],
                            inter_system["manual_only"],
                            inter_system["latency_min"],
                        ]
                    ],
                ),
                _table(
                    "Duplicado entre canales",
                    ["Estado", "Duplicados", "Latencia (s)"],
                    [[inter_channel["status"], inter_channel["duplicates"], inter_channel["latency_s"]]],
                ),
            ],
        ),
        _section(
            "horario",
            "Distribución horaria",
            "export",
            paragraphs=[
                "El histograma usa la hora de pared del export, sin convertirla.",
                (
                    f"El pico de E4 es de {peak_messages} mensajes a las "
                    f"{peak_hour:02d}:00."
                ),
            ],
            tables=[
                _table(
                    "Mensajes por hora",
                    ["Hora", "Mensajes"],
                    [
                        [f"{hour:02d}:00", histogram["buckets"][str(hour)]]
                        for hour in range(24)
                    ],
                )
            ],
        ),
        _section(
            "top_claves",
            "Top de claves",
            "export",
            paragraphs=[
                "El top se ordena por volumen y desempata alfabéticamente."
            ],
            tables=[
                _table(
                    "Top de claves",
                    ["Clave", "Mensajes", "Cuota", "E1", "E2", "E3", "E4"],
                    [
                        [
                            entry["key"],
                            entry["messages"],
                            entry["share"],
                            entry["by_era"]["E1"],
                            entry["by_era"]["E2"],
                            entry["by_era"]["E3"],
                            entry["by_era"]["E4"],
                        ]
                        for entry in top_keys
                    ],
                )
            ],
        ),
        _section(
            "push",
            "Columna de push",
            push_source,
            paragraphs=[push_paragraph],
            tables=[
                _table(
                    "Cobertura de push",
                    ["Campo", "Valor"],
                    [
                        ["Estado", push["status"]],
                        ["Origen", push["source"]],
                        ["Filas", push["rows"]],
                        ["Filas omitidas", push["skipped_rows"]],
                    ],
                )
            ],
        ),
        _section(
            "politica",
            "Política de avisos",
            "codigo",
            paragraphs=[
                (
                    "El mapa cubre las 22 claves del catálogo: "
                    f"{_counts_sentence(policy['counts'])}."
                ),
                (
                    "WUD queda en silent y la copia en immediate. El éxito de "
                    "security-update y de release-apply va al digest; manual y "
                    "failed exigen acción inmediata."
                ),
            ],
            tables=[
                _table(
                    "Mapa por clave",
                    ["Clave", "Origen", "Bucket", "Split por resultado"],
                    policy_rows,
                )
            ],
        ),
        _section(
            "apagado",
            "Orden de apagado",
            "codigo",
            paragraphs=[
                (
                    "La copia no se apaga: se estrecha a backup-failed con origen "
                    "propio (SEC-06, PITFALLS #24). issue-automator y SMART quedan "
                    "fuera del cutover y se revisan en la fase 8."
                )
            ],
            tables=[
                _table(
                    "Orden de apagado",
                    ["Paso", "Emisor", "Familias", "Sustituto", "Reversibilidad"],
                    [
                        [
                            index,
                            step["emitter"],
                            ", ".join(step["families"]),
                            step["replacement"],
                            step["reversibility"],
                        ]
                        for index, step in enumerate(shutdown["order"], 1)
                    ],
                ),
                _table(
                    "Copia estrechada",
                    ["Emisor", "Destino", "Origen", "Requisito", "Motivo"],
                    [
                        [
                            step["emitter"],
                            step["to"],
                            step["origin"],
                            step["requirement"],
                            step["reason"],
                        ]
                        for step in shutdown["narrowed"]
                    ],
                ),
                _table(
                    "Fuera de alcance",
                    ["Emisor", "Familias", "Revisión"],
                    [
                        [step["emitter"], ", ".join(step["families"]), step["revisit"]]
                        for step in shutdown["out_of_scope"]
                    ],
                ),
            ],
        ),
        _section(
            "objetivo",
            "Objetivo de éxito",
            "export",
            paragraphs=[
                (
                    "El objetivo se apoya en E4: "
                    f"{target['baseline_messages_per_day']} mensajes/día sobre "
                    f"{target['baseline_inclusive_days']} días inclusivos. Se "
                    f"propone {target['proactive_messages_per_day']} mensajes "
                    "proactivos/día fuera del digest, menor o igual que la línea base."
                ),
                (
                    "El ack se publica como — porque no existe ackAt: la métrica "
                    "queda definida y se medirá en la fase 6."
                ),
            ],
            tables=[
                _table(
                    "Línea base y propuesta",
                    ["Campo", "Valor"],
                    [
                        ["Era de referencia", target["baseline_era"]],
                        ["Días inclusivos", target["baseline_inclusive_days"]],
                        ["Mensajes/día de referencia", target["baseline_messages_per_day"]],
                        ["Objetivo proactivo/día", target["proactive_messages_per_day"]],
                        ["Ventana de medida (días)", target["window_days"]],
                        ["Definición", target["definition"]],
                    ],
                ),
                _table(
                    "Contrato del ack",
                    ["Campo", "Valor"],
                    [
                        ["Métrica", ack["metric"]],
                        ["Guardia", ack["guard"]],
                        ["Por severidad", ack["per_severity"]],
                        ["Objetivo de mediana inmediata (min)", ack["immediate_median_target_minutes"]],
                        ["Guardia p90 (min)", ack["p90_guard_minutes"]],
                        ["Valor actual", ack["current"]],
                        ["Estado", ack["status"]],
                    ],
                ),
            ],
        ),
        _section(
            "supuestos",
            "Supuestos",
            "codigo",
            paragraphs=[
                "Los ocho supuestos siguientes sostienen las cifras del informe."
            ],
            tables=[
                _table(
                    "Supuestos",
                    ["Id", "Supuesto", "Riesgo"],
                    [
                        [assumption["id"], assumption["claim"], assumption["risk"]]
                        for assumption in ASSUMPTIONS
                    ],
                )
            ],
        ),
        _section(
            "reproducibilidad",
            "Reproducibilidad",
            "export",
            paragraphs=[
                f"El sha256 del export es {source['sha256']}.",
                (
                    "Regenerar el informe: `python3 scripts/audit/noise_audit.py "
                    "--export <export> --out-json <json> --out-md <md> --force`."
                ),
                (
                    "Comprobar el informe: `python3 scripts/audit/noise_audit.py "
                    "--check-report --out-json <json> --out-md <md>`."
                ),
                (
                    "Comprobar la reproducibilidad: `python3 scripts/audit/noise_audit.py "
                    "--export <export> --check-repro`."
                ),
                (
                    "Notas de cobertura: "
                    + " ".join(
                        footnotes[note_id]["body"]
                        for note_id in ("denominator", "push_coverage", "ack_unavailable")
                    )
                ),
            ],
        ),
    ]
    return {"source_hash": source["sha256"], "sections": sections}


def _render_cell(value):
    if value is None:
        return "—"
    if isinstance(value, bool):
        return "sí" if value else "no"
    return str(value)


def render_report(model):
    """Render the Spanish Markdown report from the model, never from raw rows."""
    lines = [
        "# Auditoría del ruido de avisos — NAS Monitor",
        "",
        (
            "Informe generado desde `01-AUDIT.json`. El sha256 del export es "
            f"`{model['source_hash']}`."
        ),
        "",
    ]
    for section in model["sections"]:
        lines.append(f"<!-- id: {section['id']} -->")
        lines.append(f"## {section['title']}")
        lines.append("")
        lines.append(f"_Fuente: {section['source']}._")
        lines.append("")
        for paragraph in section.get("paragraphs", []):
            lines.append(paragraph)
            lines.append("")
        for table in section.get("tables", []):
            lines.append(f"**{table['title']}**")
            lines.append("")
            lines.append("| " + " | ".join(str(column) for column in table["columns"]) + " |")
            lines.append("|" + "|".join("---" for _ in table["columns"]) + "|")
            for table_row in table["rows"]:
                lines.append(
                    "| " + " | ".join(_render_cell(value) for value in table_row) + " |"
                )
            lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"


def check_report(json_path, md_path):
    """True when the JSON aggregate, the stored model and the Markdown all agree."""
    data = json.loads(Path(json_path).read_text(encoding="utf-8"))
    model = build_report_model(data)
    expected = render_report(model)
    actual = Path(md_path).read_text(encoding="utf-8")
    return data.get("report") == model and expected == actual


def check_repro(export_path):
    """Aggregate the same export twice and compare the canonical bytes."""
    serialised = []
    for _attempt in range(2):
        rows, stats = telegram_export.parse_export_document(str(export_path))
        serialised.append(
            canonical_json(aggregate(rows, _source_metadata(str(export_path), stats)))
        )
    return {"reproducible": serialised[0] == serialised[1]}


def build_evidence_sources(state_root=None):
    """Describe the nine evidence sources; probe them only when a root is given."""
    sources = []
    for source in EVIDENCE_SOURCES:
        entry = dict(source)
        if state_root is not None:
            relative = source.get("path")
            readable = None
            exists = None
            if relative:
                target = Path(state_root) / relative
                exists = target.exists()
                try:
                    with target.open("rb") as handle:
                        handle.read(1)
                    readable = True
                except OSError:
                    readable = False
            entry["exists"] = exists
            entry["readable"] = readable
        sources.append(entry)
    return sources


def sender_kind(sender):
    """Classify a sender as ``bot`` or ``operator``; the export names only the bot."""
    return "bot" if sender in BOT_SENDERS else "operator"


def build_sender_split(rows):
    """Return exactly the two buckets the export can prove."""
    counts = Counter(sender_kind(row.get("sender")) for row in rows)
    return {"bot": counts.get("bot", 0), "operator": counts.get("operator", 0)}


def build_dataset_summary(rows, source):
    """Describe the measured window: counts, wall-clock span and calendar coverage."""
    split = build_sender_split(rows)
    stamps = sorted(row["sent_at"] for row in rows)
    if not stamps:
        raise ValueError("el export no produjo ninguna fila")
    first_day = date.fromisoformat(stamps[0][:10])
    last_day = date.fromisoformat(stamps[-1][:10])
    span_days = (last_day - first_day).days
    days = Counter(stamp[:10] for stamp in stamps)
    return {
        "messages": len(rows),
        "bot_messages": split["bot"],
        "operator_messages": split["operator"],
        "date_separators": source["date_separators"],
        "first_at": stamps[0],
        "last_at": stamps[-1],
        "span_days": span_days,
        "inclusive_days": span_days + 1,
        "missing_time": sum(1 for row in rows if row.get("time") is None),
        "days_with_messages": len(days),
        "denominator_note": (
            "CONTEXT publicó 0,04/día en E1 y 1,15/día en E4 sin declarar el denominador. "
            "Aquí el rate usa días inclusivos: E1 8/156 = 0,05 y E4 15/12 = 1,25; "
            "los conteos no cambian."
        ),
    }


def aggregate(rows, source, alerts=None, state_root=None):
    """Build the aggregate document; ``alerts`` is the optional push adapter input."""
    eras = build_eras(rows)
    wud_events = build_wud_events(rows)
    apply_wud_events(eras, wud_events, rows)
    document = {
        "schema_version": SCHEMA_VERSION,
        "source": {field: source.get(field) for field in PUBLISHED_SOURCE_FIELDS},
        "dataset": build_dataset_summary(rows, source),
        "sender_split": build_sender_split(rows),
        "inventory": build_inventory(rows),
        "eras": eras,
        "recoveries": build_recoveries(rows, alerts),
        "duplicates": build_duplicates(rows, alerts),
        "histogram": build_histogram(rows),
        "wud_events": wud_events,
        "repetitions": build_repetitions(rows),
        "top_keys": build_top_keys(rows),
        "windows": build_windows(rows),
        "push": {
            "status": "unavailable" if alerts is None else "measured",
            "source": "alerts CSV",
            "rows": len(_alert_rows(alerts)) if alerts is not None else None,
            "skipped_rows": (
                alerts.get("skipped_rows", 0) if isinstance(alerts, dict) else 0
            ),
        },
        "evidence_sources": build_evidence_sources(state_root),
    }
    document["policy"] = build_policy_map()
    document["shutdown_order"] = build_shutdown_order()
    document["success_target"] = build_success_target(eras)
    document["trend"] = build_trend_table(rows)
    document["footnotes"] = build_footnotes(eras, document["push"])
    document["report"] = build_report_model(document)
    return document


def canonical_json(data):
    """Serialise deterministically so two runs of the same export compare equal."""
    return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def _refuse_overwrite(paths, force):
    if force:
        return
    existing = [str(path) for path in paths if path and Path(path).exists()]
    if existing:
        raise SystemExit(
            "ya existe " + ", ".join(existing) + "; usa --force para sobrescribir"
        )


def _source_metadata(export_path, stats):
    stamp = datetime.fromtimestamp(Path(export_path).stat().st_mtime).replace(microsecond=0)
    return {
        "path_hint": Path(export_path).name,
        "sha256": stats["sha256"],
        "bytes": stats["bytes"],
        "exported_mtime_note": (
            f"exportado {stamp.isoformat()}; la ventana termina en el último mensaje"
        ),
        "date_separators": stats["date_separators"],
    }


def _summary_line(result):
    dataset = result["dataset"]
    split = result["sender_split"]
    return (
        f"{dataset['messages']} mensajes ({split['bot']} bot, {split['operator']} operador)"
        f" · {dataset['first_at'][:10]} → {dataset['last_at'][:10]}"
        f" · {dataset['inclusive_days']} días inclusivos"
        f" · {dataset['days_with_messages']} días con mensajes"
    )


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Audita el ruido de Telegram a partir del export HTML del chat."
    )
    parser.add_argument(
        "--export",
        default=None,
        help="ruta al messages.html exportado (obligatoria salvo con --check-report)",
    )
    parser.add_argument(
        "--ndjson",
        default=str(DEFAULT_NDJSON),
        help="NDJSON temporal con las filas normalizadas (fuera del repositorio)",
    )
    parser.add_argument(
        "--out-json", default=str(DEFAULT_OUT_JSON), help="JSON de agregados"
    )
    parser.add_argument(
        "--alerts-csv",
        default=None,
        help="CSV opcional de alerts con cabecera hostId,key,severity,at,resolvedAt",
    )
    parser.add_argument(
        "--out-md",
        default=None,
        help="informe Markdown renderizado desde el JSON; sin esta opción no se toca",
    )
    parser.add_argument(
        "--check-repro",
        action="store_true",
        help="agrega dos veces y compara el JSON canónico sin escribir salidas",
    )
    parser.add_argument(
        "--check-report",
        action="store_true",
        help="compara el Markdown con el modelo guardado en el JSON y sale 1 si difiere",
    )
    parser.add_argument(
        "--print-summary", action="store_true", help="imprime una línea de resumen"
    )
    parser.add_argument(
        "--state-root",
        default=None,
        help="raíz del appdata para probar las fuentes de evidencia (solo lectura)",
    )
    parser.add_argument(
        "--force", action="store_true", help="sobrescribe las salidas existentes"
    )
    args = parser.parse_args(argv)

    if args.check_report:
        if not args.out_md:
            parser.error("--check-report necesita --out-md")
        result = {"report_matches": check_report(args.out_json, args.out_md)}
        print(canonical_json(result).strip())
        return 0 if result["report_matches"] else 1

    if not args.export:
        parser.error("--export es obligatorio salvo con --check-report")

    if args.check_repro:
        result = check_repro(args.export)
        print(canonical_json(result).strip())
        return 0 if result["reproducible"] else 1

    _refuse_overwrite((args.out_json, args.out_md, args.ndjson), args.force)
    alerts = load_alerts_csv(args.alerts_csv) if args.alerts_csv else None
    rows, stats = telegram_export.parse_export_document(args.export)
    result = aggregate(
        rows,
        _source_metadata(args.export, stats),
        alerts=alerts,
        state_root=args.state_root,
    )

    telegram_export.write_ndjson(rows, args.ndjson)
    out_json = Path(args.out_json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(canonical_json(result), encoding="utf-8")
    if args.out_md:
        out_md = Path(args.out_md)
        out_md.parent.mkdir(parents=True, exist_ok=True)
        out_md.write_text(render_report(result["report"]), encoding="utf-8")
    if args.print_summary:
        print(_summary_line(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
