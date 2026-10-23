"""env-setup — guided credential setup for Hermes.

The agent can request environment variables by NAME (``env_setup_prompt``);
the user fills a masked desktop form; values are written directly to the
active profile's ``.env`` and never enter the chat or the model context.
``env_setup_status`` reports which variables are set/missing without values.

Entry point: ``register(ctx)`` — called by the Hermes plugin loader.
"""

from __future__ import annotations

import logging

from .tools import register_tools

logger = logging.getLogger("hermes.plugins.env-setup")

__all__ = ["register", "register_tools"]


def register(ctx) -> None:
    """Plugin entry point — called by the Hermes plugin loader."""
    register_tools(ctx)
    logger.info("env-setup: tools registered (env_setup_prompt, env_setup_status)")