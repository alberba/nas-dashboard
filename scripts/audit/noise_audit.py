"""Aggregate the Telegram noise audit without copying message bodies.

Reads the pinned export through :mod:`telegram_export`, keeps the normalised
rows in a temporary NDJSON file and publishes aggregate counts only. The output
JSON never carries message bodies and never carries sender names: the sender
split is two buckets, ``bot`` and ``operator``.
"""
from __future__ import annotations

import argparse
import json
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

SIGNATURES = ()
EMITTERS = ()


def classify(text):
    raise NotImplementedError


def build_inventory(rows):
    raise NotImplementedError


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
    }


def aggregate(rows, source, alerts=None):
    """Build the aggregate document. ``alerts`` is reserved for the push adapter."""
    return {
        "schema_version": SCHEMA_VERSION,
        "source": {field: source.get(field) for field in PUBLISHED_SOURCE_FIELDS},
        "dataset": build_dataset_summary(rows, source),
        "sender_split": build_sender_split(rows),
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
        "--force", action="store_true", help="sobrescribe las salidas existentes"
    )
    args = parser.parse_args(argv)

    _refuse_overwrite((args.out_json, args.out_md, args.ndjson), args.force)
    rows, stats = telegram_export.parse_export_document(args.export)
    result = aggregate(rows, _source_metadata(args.export, stats))

    telegram_export.write_ndjson(rows, args.ndjson)
    out_json = Path(args.out_json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(canonical_json(result), encoding="utf-8")
    if args.print_summary:
        print(_summary_line(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
