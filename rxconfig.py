import reflex as rx
import os
from pathlib import Path

from reflex import constants
from reflex.plugins.sitemap import SitemapPlugin


PUBLIC_SITE_URL = "https://alexstudies.com"
PUBLIC_SITEMAP_PATHS = (
    "/",
    "/select",
    "/pricing",
    "/free",
    "/privacy-policy",
    "/terms",
    "/return-policy",
    "/support",
    "/ai-study-planner-for-university-students",
    "/uk-computer-science-study-plan",
    "/uk-software-engineering-study-plan",
    "/us-computer-science-study-plan",
    "/us-software-engineering-study-plan",
    "/sri-lanka-software-engineering-study-plan",
    "/sri-lanka-becs-study-plan",
    "/sri-lanka-physical-science-study-plan",
    "/sri-lanka-biological-science-study-plan",
    "/india-btech-computer-science-study-plan",
    "/india-btech-information-technology-study-plan",
    "/s/home",
    *(
        f"/s/y{year}s{semester}"
        for year in range(1, 5)
        for semester in range((year - 1) * 2 + 1, (year - 1) * 2 + 3)
    ),
    "/alex-live",
)

def _resolve_public_url() -> str:
    return os.getenv("APP_BASE_URL", PUBLIC_SITE_URL).rstrip("/")

def _resolve_api_url() -> str:
    # In production with Next.js proxy (Vercel → Render), the browser connects to
    # the frontend domain (alexstudies.com) for both WebSocket (/event) and API calls.
    # The Next.js middleware proxies these to the Reflex backend.
    # If REFLEX_API_URL is explicitly set, use it (for direct backend access).
    # Otherwise, default to the public frontend URL so the compiled frontend
    # connects to the correct origin.
    return (
        os.getenv("REFLEX_API_URL")
        or os.getenv("API_URL")
        or "https://backend.alexstudies.com"
        or "http://localhost:8000"
    ).rstrip("/")


def _canonical_url(path: str) -> str:
    return f"{PUBLIC_SITE_URL}{path if path.startswith('/') else '/' + path}"


def _generate_public_sitemap() -> str:
    urls = "\n".join(
        "  <url>\n"
        f"    <loc>{_canonical_url(path)}</loc>\n"
        "  </url>"
        for path in PUBLIC_SITEMAP_PATHS
    )
    return (
        "<?xml version='1.0' encoding='utf-8'?>\n"
        '<urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{urls}\n"
        "</urlset>\n"
    )


def _generate_robots_txt() -> str:
    return (
        "User-agent: *\n"
        "Allow: /\n"
        f"Sitemap: {PUBLIC_SITE_URL}/sitemap.xml\n"
    )


def _sitemap_task() -> tuple[str, str]:
    return str(Path(constants.Dirs.PUBLIC) / "sitemap.xml"), _generate_public_sitemap()


def _robots_task() -> tuple[str, str]:
    return str(Path(constants.Dirs.PUBLIC) / "robots.txt"), _generate_robots_txt()


class PublicSeoPlugin(rx.plugins.Plugin):
    """Write canonical public SEO files for Alex Studies."""

    def pre_compile(self, **context):
        add_save_task = context["add_save_task"]
        add_save_task(_sitemap_task)
        add_save_task(_robots_task)


config = rx.Config(
    app_name="uni_app",
    deploy_url=_resolve_public_url(),
    
    api_url=_resolve_api_url(),
    favicon="favicon-v2.ico",
    
    db_url=os.getenv("DATABASE_URL", "sqlite:///.data/reflex.db"),
    show_built_with_reflex=False,
    
    plugins=[
        PublicSeoPlugin(),
    ],
    disable_plugins=[SitemapPlugin],
)
