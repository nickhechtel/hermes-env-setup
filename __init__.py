"""env-setup — guided credential setup for Hermes.

The agent can request environment variables by NAME (``env_setup_prompt``);
the user fills a masked desktop form; values are written directly to the
active profile's ``.env`` and never enter the chat or the model context.
``env_setup_status`` reports which variables are set/missing without values.

Entry point: ``register(ctx)`` — called by the Hermes plugin loader.
"""

from __future__ import annotations

import logging
import pathlib

from .tools import register_tools

logger = logging.getLogger("hermes.plugins.env-setup")

__all__ = ["register", "register_tools"]

_SKILL_NAME = "credential-setup-flow"
_SKILL_MD = pathlib.Path(__file__).resolve().parent / "skills" / _SKILL_NAME / "SKILL.md"


def _register_skill(ctx) -> None:
    """Register the bundled skill (read-only, plugin-namespaced).

    Shows up as '<plugin>:credential-setup-flow' in skills_list and in the
    system prompt's <available_skills> whenever the plugin is enabled — so
    the ask-flow behaviour ships with the package itself.
    """
    if not _SKILL_MD.is_file():
        logger.warning("env-setup: bundled skill missing: %s", _SKILL_MD)
        return
    frontmatter: dict = {}
    try:
        from hermes_cli.agent_plugins import _parse_skill_frontmatter
        frontmatter = _parse_skill_frontmatter(_SKILL_MD)
    except Exception:
        logger.debug("env-setup: skill frontmatter parse failed", exc_info=True)
    try:
        ctx.register_skill(
            name=_SKILL_NAME,
            path=_SKILL_MD,
            description=str(frontmatter.get("description", "")),
            frontmatter=frontmatter,
        )
        logger.info("env-setup: registered plugin skill %s", _SKILL_NAME)
    except Exception:
        logger.exception("env-setup: could not register skill %s", _SKILL_NAME)


def register(ctx) -> None:
    """Plugin entry point — called by the Hermes plugin loader."""
    register_tools(ctx)
    _register_skill(ctx)
    logger.info("env-setup: registered (tools env_setup_prompt/env_setup_status + skill %s)", _SKILL_NAME)