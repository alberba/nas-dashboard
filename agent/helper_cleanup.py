"""Ownership, reaping and accounting for the agent's Docker helpers.

The agent creates short-lived privileged containers (``nsenter`` for host
commands, ``smartctl`` for disks and the reboot helper). They are labelled at
creation time with this module's ownership labels. The registry in this module
is shared by every executor in the process, so a deletion failure in a
``finally`` block is visible to the next background sweep.

Safety rules, in order:

* only a container carrying our marker **and** this installation's owner label
  is ever a candidate;
* running containers are never deleted, whatever their age or owner;
* a helper of the current process is deleted only through its own executor
  (the registry knows it is active until the execution ends);
* a stopped helper from a previous process is deleted only after the grace
  period and after the ID is re-inspected and re-validated by Docker;
* the deletion always uses ``?v=0``: named and anonymous volumes stay on the
  host;
* a failed inventory or an incoherent inspection leaves the autonomous sweep
  indeterminate and preserves every candidate.

The module only uses the standard library. It never imports the Docker client;
the caller injects the object it already uses.
"""
from __future__ import annotations

import os
import re
import socket
import threading
import time
import uuid
from datetime import datetime, timezone

HELPER_LABEL = "hub.agent.helper"
OWNER_LABEL = "hub.agent.helper.owner"
FAMILY_LABEL = "hub.agent.helper.family"
INSTANCE_LABEL = "hub.agent.helper.instance"
CREATED_LABEL = "hub.agent.helper.created"

HELPER_LABEL_VALUE = "1"
FAMILIES = frozenset({"host", "disk", "reboot"})
# Docker states in which a plain delete is unsafe or the helper may be serving.
ACTIVE_STATES = frozenset({"running", "paused", "restarting", "removing"})
STOPPED_STATES = frozenset({"created", "exited", "dead"})

OWNER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$")
INSTANCE_PATTERN = re.compile(r"^[A-Za-z0-9-]{16,64}$")
CONTAINER_ID = re.compile(r"^[a-f0-9]{64}$")

SWEEP_SECONDS = 60
MIN_AGE_SECONDS = 600
MAX_CANDIDATES = 5
CALL_TIMEOUT = 8
COUNT_LIMIT = 100


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


def installation_id(role="instance"):
    """Stable identity of this installation, never a secret or a socket path."""
    configured = _text(os.getenv("AGENT_INSTALLATION_ID"), 120)
    if configured and OWNER_PATTERN.fullmatch(configured):
        return configured
    hostname = _text(os.getenv("NAS_NAME"), 80) or _text(socket.gethostname(), 80)
    hostname = re.sub(r"[^A-Za-z0-9_.-]", "-", hostname or "agent")[:80]
    safe_role = role if role in ("instance", "apps-server") else "instance"
    return ("hub-agent:%s:%s" % (hostname, safe_role))[:120]


def labels_of(item):
    labels = item.get("Labels")
    if labels is None:
        labels = (item.get("Config") or {}).get("Labels") or {}
    return labels if isinstance(labels, dict) else {}


def is_agent_helper(item):
    """True only for containers carrying this module's own marker."""
    return labels_of(item).get(HELPER_LABEL) == HELPER_LABEL_VALUE


def _created_of(item):
    labels = labels_of(item)
    value = labels.get(CREATED_LABEL)
    if value is None:
        value = item.get("Created")
    if isinstance(value, bool):
        return None
    try:
        created = float(value)
    except (TypeError, ValueError):
        return None
    return created if created > 0 else None


def _state_of(item):
    value = item.get("State")
    if isinstance(value, dict):
        status = value.get("Status")
        if isinstance(status, str) and status in STOPPED_STATES:
            if any(
                value.get(flag, False) is not False
                for flag in ("Running", "Paused", "Restarting")
            ):
                return None
            dead = status == "dead"
            if value.get("Dead", dead) is not dead:
                return None
        value = status
    return value if isinstance(value, str) else None


class HelperRegistry:
    """Process-wide accounting of the helpers this agent created or found."""

    def __init__(self, owner=None, instance=None, clock=time.time):
        candidate = _text(owner, 120)
        self.owner = (
            candidate
            if candidate and OWNER_PATTERN.fullmatch(candidate)
            else installation_id(os.getenv("HOST_ROLE", "instance"))
        )
        candidate = _text(instance, 64)
        self.instance = (
            candidate
            if candidate and INSTANCE_PATTERN.fullmatch(candidate)
            else uuid.uuid4().hex
        )
        self.clock = clock
        self._lock = threading.RLock()
        self._records = {}
        self._in_flight = set()
        self._failure_revision = 0
        self._swept_failure_revision = None
        self._last_check = None
        self._sweep_failed = False

    # -- lifecycle ---------------------------------------------------------

    def labels(self, family):
        if family not in FAMILIES:
            raise ValueError("Tipo de ayudante no válido")
        return {
            HELPER_LABEL: HELPER_LABEL_VALUE,
            OWNER_LABEL: self.owner,
            FAMILY_LABEL: family,
            INSTANCE_LABEL: self.instance,
            CREATED_LABEL: str(int(self.clock())),
        }

    def enrol(self, ident, family, created=None, now=None):
        """Records a helper this process is about to start or has just created."""
        if not isinstance(ident, str) or not CONTAINER_ID.fullmatch(ident):
            raise ValueError("Ayudante no válido")
        if family not in FAMILIES:
            raise ValueError("Tipo de ayudante no válido")
        with self._lock:
            record = self._records.get(ident)
            if record is None:
                record = {
                    "family": family,
                    "created": float(created if created is not None else (now or self.clock())),
                    "active": False,
                    "protected": False,
                    "attempts": 0,
                }
                self._records[ident] = record
            record["family"] = family
            record["active"] = True
            record["protected"] = False
            if created is not None:
                record["created"] = float(created)

    def discover(self, ident, family, created=None):
        """Records a historical helper so a failed retry can be counted."""
        with self._lock:
            record = self._records.get(ident)
            if record is None:
                self._records[ident] = {
                    "family": family,
                    "created": float(created or self.clock()),
                    "active": False,
                    "protected": False,
                    "attempts": 0,
                }

    def release(self, ident):
        with self._lock:
            record = self._records.get(ident)
            if record is not None:
                record["active"] = False

    def protect(self, ident):
        """Keeps the reboot helper out of the autonomous sweep."""
        with self._lock:
            record = self._records.get(ident)
            if record is not None:
                record["active"] = False
                record["protected"] = True

    def known(self, ident):
        with self._lock:
            return ident in self._records

    def is_active(self, ident):
        with self._lock:
            record = self._records.get(ident)
            return bool(record and record["active"])

    def is_protected(self, ident):
        with self._lock:
            record = self._records.get(ident)
            return bool(record and record["protected"])

    # -- attempts ----------------------------------------------------------

    def claim(self, ident):
        with self._lock:
            if ident in self._in_flight:
                return False
            self._in_flight.add(ident)
            return True

    def unclaim(self, ident):
        with self._lock:
            self._in_flight.discard(ident)

    def record_delete_failure(self, ident, family=None, now=None):
        with self._lock:
            record = self._records.get(ident)
            if record is None:
                record = {
                    "family": family if family in FAMILIES else "host",
                    "created": float(now or self.clock()),
                    "active": False,
                    "protected": False,
                    "attempts": 0,
                }
                self._records[ident] = record
            self._failure_revision += 1
            record["failure_revision"] = self._failure_revision
            record["attempts"] += 1
            record["active"] = False
            self._note_check(now)
        # Type and bounded id only: never commands, socket paths or raw errors.
        print(
            "helper-cleanup: fallo al retirar %s %s"
            % (record["family"], ident[:12]),
            flush=True,
        )

    def confirm_removed(self, ident, now=None):
        with self._lock:
            self._records.pop(ident, None)
            self._note_check(now)

    def confirm_absent(self, ident, now=None):
        with self._lock:
            self._records.pop(ident, None)
            self._note_check(now)

    def pending_ids(self):
        with self._lock:
            return [
                ident
                for ident, record in self._records.items()
                if record["attempts"] > 0
            ]

    def pending_count(self):
        with self._lock:
            return sum(
                1 for record in self._records.values() if record["attempts"] > 0
            )

    def persistent_count(self):
        with self._lock:
            return sum(
                1
                for record in self._records.values()
                if record["attempts"] >= 2
            )

    # -- sweep accounting --------------------------------------------------

    def _note_check(self, now=None):
        value = self.clock() if now is None else now
        if self._last_check is None or value > self._last_check:
            self._last_check = value

    def mark_indeterminate(self, now=None):
        with self._lock:
            self._sweep_failed = True
            self._note_check(now)

    def failure_revision(self):
        with self._lock:
            return self._failure_revision

    def finish_sweep(self, now, complete, *, inventory_revision=None, present=()):
        with self._lock:
            if inventory_revision is not None:
                # The list can only cover failures recorded before its request.
                for ident in self.pending_ids():
                    record = self._records[ident]
                    if (
                        ident not in present
                        and record["failure_revision"] <= inventory_revision
                    ):
                        self.confirm_absent(ident, now)
            if complete:
                self._swept_failure_revision = (
                    self._failure_revision
                    if inventory_revision is None
                    else inventory_revision
                )
            self._sweep_failed = not complete
            self._note_check(now)

    def section(self, now=None):
        with self._lock:
            pending = self.pending_count()
            persistent = self.persistent_count()
            if self._sweep_failed:
                status = "indeterminate"
            elif persistent:
                status = "persistent"
            elif pending:
                status = "failing"
            elif self._swept_failure_revision != self._failure_revision:
                status = "indeterminate"
            else:
                status = "clean"
            return {
                "available": True,
                "status": status,
                "checkedAt": _iso(self._last_check),
                "pending": min(pending, COUNT_LIMIT),
                "persistent": min(persistent, COUNT_LIMIT),
            }


_SHARED = None
_SHARED_LOCK = threading.Lock()


def shared_registry():
    """One registry per agent process, shared by every executor it creates."""
    global _SHARED
    with _SHARED_LOCK:
        if _SHARED is None:
            _SHARED = HelperRegistry()
        return _SHARED


class _InvalidList(Exception):
    """The Docker list cannot prove ownership or absence."""


class HelperReaper:
    """Bounded, serialized sweep over the agent's own stopped helpers."""

    def __init__(
        self,
        docker,
        registry=None,
        clock=time.time,
        min_age=MIN_AGE_SECONDS,
        max_candidates=MAX_CANDIDATES,
        timeout=CALL_TIMEOUT,
    ):
        self.docker = docker
        self.registry = registry or shared_registry()
        self.clock = clock
        self.min_age = max(0.0, float(min_age))
        self.max_candidates = max(1, int(max_candidates))
        self.timeout = timeout
        self._lock = threading.Lock()

    def sweep(self):
        if not self._lock.acquire(blocking=False):
            return {"status": "busy", "deleted": 0}
        deleted = 0
        attempted = 0
        complete = True
        try:
            now = self.clock()
            inventory_revision = self.registry.failure_revision()
            try:
                items = self.docker.call(
                    "GET", "/containers/json?all=true", timeout=self.timeout
                )
            except (OSError, ValueError):
                self.registry.mark_indeterminate(now)
                return {"status": "indeterminate", "deleted": 0}
            try:
                parsed = self._parse_list(items)
            except _InvalidList:
                self.registry.mark_indeterminate(now)
                return {"status": "indeterminate", "deleted": 0}

            present = {entry["id"] for entry in parsed}

            for entry in parsed:
                eligible = self._eligible(entry, now)
                if eligible == "indeterminate":
                    complete = False
                    continue
                if not eligible:
                    continue
                if attempted >= self.max_candidates:
                    complete = False
                    break
                attempted += 1
                outcome = self._delete(entry, now)
                if outcome == "deleted":
                    deleted += 1
                elif outcome == "indeterminate":
                    complete = False

            self.registry.finish_sweep(
                now, complete, inventory_revision=inventory_revision, present=present
            )
            return {
                "status": self.registry.section(now)["status"],
                "deleted": deleted,
            }
        finally:
            self._lock.release()

    def _parse_list(self, items):
        if not isinstance(items, list):
            raise _InvalidList()
        parsed = []
        for item in items:
            if not isinstance(item, dict):
                raise _InvalidList()
            ident = item.get("Id")
            if not isinstance(ident, str) or not CONTAINER_ID.fullmatch(ident):
                raise _InvalidList()
            labels = labels_of(item)
            owner = _text(labels.get(OWNER_LABEL), 121)
            family = _text(labels.get(FAMILY_LABEL), 20)
            instance = _text(labels.get(INSTANCE_LABEL), 64)
            parsed.append(
                {
                    "id": ident,
                    "item": item,
                    "labels": labels,
                    "owner": owner,
                    "family": family,
                    "instance": instance,
                    "created": _created_of(item),
                    "state": _state_of(item),
                }
            )
        return parsed

    def _eligible(self, entry, now):
        if entry["labels"].get(HELPER_LABEL) != HELPER_LABEL_VALUE:
            return False
        if entry["owner"] != self.registry.owner:
            return False
        if entry["family"] not in FAMILIES:
            return False
        if not entry["instance"] or not INSTANCE_PATTERN.fullmatch(entry["instance"]):
            # Ownership cannot be proved: leave the sweep indeterminate.
            self.registry.mark_indeterminate(now)
            return "indeterminate"
        if entry["created"] is None:
            self.registry.mark_indeterminate(now)
            return "indeterminate"
        if entry["state"] in ACTIVE_STATES:
            # Running helpers may still be serving; never delete them.
            return False
        if entry["state"] not in STOPPED_STATES:
            return "indeterminate"
        if self.registry.is_protected(entry["id"]):
            return False
        if entry["instance"] == self.registry.instance:
            # A helper of this process is owned by its executor until release.
            if self.registry.is_active(entry["id"]):
                return False
            if not self.registry.known(entry["id"]):
                return False
        self.registry.discover(entry["id"], entry["family"], entry["created"])
        if now - entry["created"] < self.min_age:
            return False
        return True

    def _revalidate(self, detail, entry):
        if not isinstance(detail, dict):
            return False
        if detail.get("Id") != entry["id"]:
            return False
        labels = labels_of(detail)
        if labels.get(HELPER_LABEL) != HELPER_LABEL_VALUE:
            return False
        if labels.get(OWNER_LABEL) != self.registry.owner:
            return False
        if labels.get(FAMILY_LABEL) != entry["family"]:
            return False
        if labels.get(INSTANCE_LABEL) != entry["instance"]:
            return False
        if not isinstance(detail.get("State"), dict):
            return False
        if _state_of(detail) not in STOPPED_STATES:
            return False
        return not self.registry.is_protected(entry["id"])

    def _delete(self, entry, now):
        ident = entry["id"]
        if not self.registry.claim(ident):
            return "busy"
        try:
            try:
                detail = self.docker.call(
                    "GET", "/containers/" + ident + "/json", timeout=self.timeout
                )
            except (OSError, ValueError) as error:
                if getattr(error, "status", None) == 404:
                    self.registry.confirm_absent(ident, now)
                    return "absent"
                self.registry.mark_indeterminate(now)
                return "indeterminate"
            if not self._revalidate(detail, entry):
                self.registry.mark_indeterminate(now)
                return "indeterminate"
            try:
                # Never v=1: volumes stay on the host.
                self.docker.call(
                    "DELETE",
                    "/containers/" + ident + "?v=0",
                    timeout=self.timeout,
                )
            except (OSError, ValueError) as error:
                if getattr(error, "status", None) == 404:
                    self.registry.confirm_absent(ident, now)
                    return "absent"
                self.registry.record_delete_failure(
                    ident, entry["family"], now
                )
                return "failed"
            self.registry.confirm_removed(ident, now)
            return "deleted"
        finally:
            self.registry.unclaim(ident)


def delete_helper(docker, registry, ident, timeout=CALL_TIMEOUT):
    """Best-effort, serialized deletion used by the executors' ``finally``."""
    if not isinstance(ident, str) or not CONTAINER_ID.fullmatch(ident):
        return False
    if not registry.claim(ident):
        return False
    try:
        try:
            docker.call(
                "DELETE", "/containers/" + ident + "?v=0", timeout=timeout
            )
        except (OSError, ValueError) as error:
            if getattr(error, "status", None) == 404:
                registry.confirm_absent(ident)
            else:
                registry.record_delete_failure(ident)
            return False
        registry.confirm_removed(ident)
        return True
    finally:
        registry.unclaim(ident)
