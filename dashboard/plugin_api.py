"""Dashboard/backend routes for the env-setup plugin.

Mounted by the gateway at /api/plugins/env-setup/ when the plugin is in
``plugins.enabled``. Runs inside the gateway process, so it shares the
process-global request registry with the agent tools (core.py is imported by
file location here — the dashboard loader mounts this file without package
context — and the singleton key in core guarantees shared state anyway).

Every route returns field metadata and set/unset flags only. Values arrive
via POST bodies and are written straight to .env; they are never echoed back.
"""

from __future__ import annotations

import importlib.util
import logging
import pathlib

from fastapi import APIRouter

logger = logging.getLogger("hermes.plugins.env-setup.api")

router = APIRouter()


def _load_core():
    """Import ../core.py by location (no package context here)."""
    core_path = pathlib.Path(__file__).resolve().parents[1] / "core.py"
    spec = importlib.util.spec_from_file_location("hermes_env_setup_core", core_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_core = _load_core()


# ---------------------------------------------------------------------------
# catalog & status (read-only, value-free)
# ---------------------------------------------------------------------------

@router.get("/catalog")
async def get_catalog():
    """All known integrations with set/unset flags — never values."""
    return _core.catalog()


@router.get("/requests")
async def get_requests():
    """Open setup requests plus recently resolved ones the agent may not have seen."""
    reg = _core.get_registry()
    return {"requests": reg.snapshot()}


# ---------------------------------------------------------------------------
# agent-request flow
# ---------------------------------------------------------------------------

@router.post("/requests/{rid}/resolve")
async def resolve_request(rid: str, body: dict):
    """User submitted the masked form: write values to .env, never echo them."""
    reg = _core.get_registry()
    result = reg.resolve(rid, (body or {}).get("values") or {}, (body or {}).get("skipped") or [])
    if "error" in result:
        return {"ok": False, "error": result["error"]}
    return {"ok": True, **result}


@router.post("/requests/{rid}/cancel")
async def cancel_request(rid: str):
    reg = _core.get_registry()
    result = reg.cancel(rid)
    if "error" in result:
        return {"ok": False, "error": result["error"]}
    return {"ok": True, **result}


# ---------------------------------------------------------------------------
# direct configure flow (user-driven, no agent request)
# ---------------------------------------------------------------------------

@router.post("/configure")
async def configure_integration(body: dict):
    """Set values for a catalog integration directly (Setups page in the app)."""
    body = body or {}
    integration_id = body.get("integration_id")
    values = body.get("values") or {}
    if not isinstance(integration_id, str) or not isinstance(values, dict) or not values:
        return {"ok": False, "error": "integration_id and non-empty values object required"}

    catalog = _core.catalog()["integrations"]
    integration = next((i for i in catalog if i.get("id") == integration_id), None)
    if integration is None:
        return {"ok": False, "error": f"unknown integration {integration_id!r}"}
    allowed = {f["name"] for f in integration.get("fields", [])}
    for key in values:
        if key not in allowed:
            return {"ok": False, "error": f"field {key!r} does not belong to {integration_id!r}"}

    written = _core.write_values(values)
    skipped_explicit = [n for n in (body.get("skipped") or []) if n in allowed]
    skipped = written["skipped"] + [n for n in skipped_explicit
                                    if n not in written["skipped"] and n not in written["configured"]]
    out = {"ok": True, "configured": written["configured"], "skipped": skipped}
    if written["errors"]:
        out["ok"] = False
        out["errors"] = written["errors"]
    return out