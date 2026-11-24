"""Aggregate the Telegram noise audit without copying message bodies.

Reads the pinned export through :mod:`telegram_export`, keeps the normalised
rows in a temporary NDJSON file and publishes aggregate counts only. The output
JSON never carries message bodies and never carries sender names: the sender
split is two buckets, ``bot`` and ``operator``.
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import date, datetime
from pathlib import Path

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
    """Build the aggregate document. ``alerts`` is reserved for the push adapter."""
    return {
        "schema_version": SCHEMA_VERSION,
        "source": {field: source.get(field) for field in PUBLISHED_SOURCE_FIELDS},
        "dataset": build_dataset_summary(rows, source),
        "sender_split": build_sender_split(rows),
        "inventory": build_inventory(rows),
        "eras": build_eras(rows),
        "evidence_sources": build_evidence_sources(state_root),
    }


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
    parser.add_argument("--export", required=True, help="ruta al messages.html exportado")
    parser.add_argument(
        "--ndjson",
        default=str(DEFAULT_NDJSON),
        help="NDJSON temporal con las filas normalizadas (fuera del repositorio)",
    )
    parser.add_argument(
        "--out-json", default=str(DEFAULT_OUT_JSON), help="JSON de agregados"
    )
    parser.add_argument(
        "--out-md",
        default=None,
        help="informe Markdown; lo genera el paso de informe, no este",
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

    _refuse_overwrite((args.out_json, args.out_md, args.ndjson), args.force)
    rows, stats = telegram_export.parse_export_document(args.export)
    result = aggregate(
        rows, _source_metadata(args.export, stats), state_root=args.state_root
    )

    telegram_export.write_ndjson(rows, args.ndjson)
    out_json = Path(args.out_json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(canonical_json(result), encoding="utf-8")
    if args.print_summary:
        print(_summary_line(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
