"""Read-only container logs: Docker multiplex decoding and stable cursors.

Docker returns non-TTY logs as a stream of frames:

    [stream: 1 byte][padding: 3 bytes][size: 4 bytes big endian][payload]

stdout is stream 1 and stderr is stream 2. Frames do not respect line
boundaries, so each stream keeps its own buffer until a newline arrives.

A poll returns the requested tail and an opaque ``cursor``. Passing that cursor
back as ``since`` makes Docker's inclusive timestamp filter safe: lines already
delivered with the terminal timestamp are skipped, so a poll never repeats a
line even when several lines share the same timestamp.
"""
from datetime import datetime
import re
from typing import NamedTuple

MAX_LINES = 5000
DEFAULT_LINES = 200
MAX_PAYLOAD = 64 * 1024 * 1024

STREAM_NAMES = {1: "stdout", 2: "stderr"}
TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$"
)
UNIX_TIMESTAMP = re.compile(r"^\d{10}(?:\.\d{1,9})?$")
CURSOR = re.compile(r"^(?P<at>[^#]+)#(?P<skip>\d{1,9})$")


class Since(NamedTuple):
    """A validated incremental mark: timestamp plus already delivered lines."""

    ns: int
    skip: int
    raw: str


def parse_line_count(value):
    if isinstance(value, str):
        text = value.strip()
        if not re.fullmatch(r"\d{1,4}", text):
            raise ValueError("Número de líneas no válido")
        value = int(text)
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError("Número de líneas no válido")
    if not 1 <= value <= MAX_LINES:
        raise ValueError("Número de líneas no válido")
    return value


def timestamp_ns(value):
    """Return nanoseconds since the epoch, or None when the token is not ISO."""
    if not isinstance(value, str) or not TIMESTAMP.fullmatch(value):
        return None
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        moment = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if moment.tzinfo is None:
        return None
    fraction = re.search(r"\.(\d{1,9})", value)
    nanos = int(fraction.group(1).ljust(9, "0")) if fraction else 0
    seconds = int(moment.replace(microsecond=0).timestamp())
    return seconds * 1_000_000_000 + nanos


def parse_since(value):
    """Parse a timestamp or a previous cursor. Returns None when absent."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    skip = 0
    match = CURSOR.fullmatch(text)
    if match:
        text, skip = match.group("at"), int(match.group("skip"))
    nanos = timestamp_ns(text)
    if nanos is None and UNIX_TIMESTAMP.fullmatch(text):
        whole, _, fraction = text.partition(".")
        nanos = int(whole) * 1_000_000_000 + int((fraction or "").ljust(9, "0"))
    if nanos is None:
        raise ValueError("Marca de tiempo no válida")
    return Since(nanos, skip, text)


def split_timestamp(text):
    token, separator, message = text.partition(" ")
    if separator and timestamp_ns(token) is not None:
        return token, message
    return None, text


def frames(payload):
    """Yield (stream, payload bytes) from Docker's multiplexed response.

    A TTY container (or a non-multiplexed payload) is treated as stdout.
    """
    offset = 0
    while offset < len(payload):
        stream = payload[offset]
        if len(payload) - offset >= 8 and stream in STREAM_NAMES:
            size = int.from_bytes(payload[offset + 4 : offset + 8], "big")
            if payload[offset + 1 : offset + 4] == b"\x00\x00\x00" and (
                offset + 8 + size <= len(payload)
            ):
                yield stream, payload[offset + 8 : offset + 8 + size]
                offset += 8 + size
                continue
        # Without a valid header the payload is not multiplexed (TTY mode).
        yield 1, payload[offset:]
        return


def decode(payload):
    """Return (stream, line bytes) entries, buffering each stream separately."""
    buffers = {stream: bytearray() for stream in STREAM_NAMES}
    lines = []
    for stream, chunk in frames(payload):
        buffer = buffers[stream]
        buffer.extend(chunk)
        start = 0
        while True:
            end = buffer.find(b"\n", start)
            if end < 0:
                break
            lines.append((stream, bytes(buffer[start:end])))
            start = end + 1
        if start:
            del buffer[:start]
    for stream, buffer in buffers.items():
        if buffer:
            lines.append((stream, bytes(buffer)))
    return lines


def format_lines(payload, since, limit):
    result = []
    skip = since.skip if since else 0
    for stream, raw in decode(payload):
        text = raw.decode("utf-8", "replace").rstrip("\r")
        at, message = split_timestamp(text)
        nanos = timestamp_ns(at) if at else None
        if since and nanos is not None:
            if nanos < since.ns:
                continue
            if nanos == since.ns and skip:
                skip -= 1
                continue
        result.append({"stream": STREAM_NAMES[stream], "at": at, "message": message})
    truncated = len(result) > limit
    if truncated:
        # A first read keeps the most recent tail; an incremental read starts
        # at the mark and advances forward, so a later poll can continue it.
        shown = result[:limit] if since else result[-limit:]
    else:
        shown = result
    # Without a mark the whole parsed tail is already covered; with a mark the
    # cursor must not skip past lines that this response left for the next poll.
    return shown, truncated, cursor_for(shown if since else result, since)


def cursor_for(lines, since=None):
    if not lines or not lines[-1]["at"]:
        return None
    terminal = lines[-1]["at"]
    delivered = 0
    for entry in lines:
        if entry["at"] == terminal:
            delivered += 1
    if since and timestamp_ns(terminal) == since.ns:
        delivered += since.skip
    return "%s#%d" % (terminal, delivered)
