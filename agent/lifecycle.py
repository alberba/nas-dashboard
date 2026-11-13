"""Container lifecycle policy.

Docker reports Compose metadata as labels. A container is an orphan when it is
stopped, unprotected and does not belong to a Compose project that currently
has running services. The one-shot services that wire the media stack finish
with exit code 0 on every `compose up`; those runs are expected, not leftovers.
"""
import re

COMPOSE_PROJECT = "com.docker.compose.project"
COMPOSE_SERVICE = "com.docker.compose.service"
ONE_SHOT_SERVICES = frozenset({"wire", "wire-seed"})
CONTAINER_ID = re.compile(r"^[a-f0-9]{64}$")
EXIT_CODE = re.compile(r"Exited \((\d+)\)")
STOPPED_STATES = frozenset({"created", "exited", "dead"})

# States in which Docker would not accept a plain `docker rm`.
ACTIVE_STATES = frozenset({"running", "paused", "restarting", "removing"})


def valid_id(value):
    return isinstance(value, str) and CONTAINER_ID.fullmatch(value) is not None


def name_of(item):
    names = item.get("Names") or []
    if names:
        return names[0].lstrip("/")
    return (item.get("Name") or "").lstrip("/")


def labels_of(item):
    labels = item.get("Labels")
    if labels is None:
        labels = (item.get("Config") or {}).get("Labels") or {}
    return labels


def project_of(item):
    return labels_of(item).get(COMPOSE_PROJECT) or None


def service_of(item):
    return labels_of(item).get(COMPOSE_SERVICE) or None


def state_of(item):
    state = item.get("State")
    if isinstance(state, dict):
        return state.get("Status") or ""
    return state or ""


def exit_code_of(item):
    state = item.get("State")
    if isinstance(state, dict):
        code = state.get("ExitCode")
        return int(code) if isinstance(code, int) else None
    match = EXIT_CODE.search(item.get("Status") or "")
    return int(match.group(1)) if match else None


def one_shot_of(item):
    service = service_of(item)
    if service:
        return service in ONE_SHOT_SERVICES
    return name_of(item) in ONE_SHOT_SERVICES


def active_projects(items, protected=()):
    """Compose projects that currently run at least one unprotected service.

    The agent container itself belongs to its own Compose project; counting it
    as active would make stopped leftovers of that project look current.
    """
    active = set()
    for item in items:
        project = project_of(item)
        if project and state_of(item) == "running" and name_of(item) not in protected:
            active.add(project)
    return active


def classify_one(item, active, protected=()):
    name = name_of(item)
    state = state_of(item)
    project = project_of(item)
    service = service_of(item)
    exit_code = exit_code_of(item)
    one_shot = one_shot_of(item)
    protected = name in protected
    running = state == "running"
    stopped = state in STOPPED_STATES
    expected_one_shot = one_shot and state == "exited" and exit_code == 0
    in_active_project = project is not None and project in active
    return {
        "id": item.get("Id", ""),
        "name": name,
        "state": state,
        "protected": protected,
        "composeProject": project,
        "composeService": service,
        "oneShot": one_shot,
        "exitCode": exit_code,
        "orphan": stopped and not protected and not expected_one_shot and not in_active_project,
        "recreateOnCompose": stopped and in_active_project,
    }


def classify(items, protected=()):
    active = active_projects(items, protected)
    return [classify_one(item, active, protected) for item in items]


def require_removable(item, confirmation, protected=()):
    """Raise ValueError unless this is a stopped, unprotected container whose
    exact name the operator typed. The caller performs the Docker deletion."""
    name = name_of(item)
    if name in protected:
        raise ValueError("Servicio de infraestructura protegido")
    state = item.get("State")
    if isinstance(state, dict):
        unsafe = (
            state.get("Running")
            or state.get("Paused")
            or state.get("Restarting")
        )
        status = state.get("Status") or ""
    else:
        unsafe = False
        status = state or ""
    if unsafe or status in ACTIVE_STATES:
        raise ValueError("El contenedor debe estar detenido")
    if not isinstance(confirmation, str) or confirmation != name:
        raise ValueError("La confirmación debe escribir el nombre exacto del contenedor")
    return name


def removal_result(item, items, protected=(), name=None):
    record = classify_one(item, active_projects(items, protected), protected)
    return {
        "state": "removed",
        "name": name or record["name"],
        "composeProject": record["composeProject"],
        "composeService": record["composeService"],
        "recreateOnCompose": record["recreateOnCompose"],
        "volumesRemoved": False,
    }
