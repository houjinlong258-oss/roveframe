"""xAI (Grok) provider profile."""

from roveagent.clisupport import __version__ as _ROVEAGENT_VERSION
from roveagent.providers import register_provider
from roveagent.providers.base import ProviderProfile

xai = ProviderProfile(
    name="xai",
    aliases=("grok", "x-ai", "x.ai"),
    api_mode="codex_responses",
    env_vars=("XAI_API_KEY",),
    base_url="https://api.x.ai/v1",
    auth_type="api_key",
    default_headers={"User-Agent": f"RoveAgent-Agent/{_ROVEAGENT_VERSION}"},
)

register_provider(xai)
