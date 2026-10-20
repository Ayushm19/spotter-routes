import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# Minimal .env support for local secrets (backend/.env is git-ignored). Real env vars win.
_env_file = BASE_DIR / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        if "=" in _line and not _line.lstrip().startswith("#"):
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

# Tried in order; a key that is rejected or out of quota hands over to the next one.
TOMTOM_API_KEYS = [k for k in (os.environ.get("TOMTOM_API_KEY"), os.environ.get("TOMTOM_API_KEY_FALLBACK")) if k]

# The API signs nothing (no sessions, cookies or CSRF), so a per-process random key is fine when unset.
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY") or secrets.token_urlsafe(50)
# Debug only for local runs; Vercel sets VERCEL=1.
DEBUG = os.environ.get("DJANGO_DEBUG", "0" if os.environ.get("VERCEL") else "1") == "1"
ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "*").split(",")

INSTALLED_APPS = [
    "corsheaders",
    "routing",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

# No models: analyses live in the cache for an hour, nothing is persisted.
DATABASES = {}

# ponytail: per-process memory cache, run a single gunicorn worker (or switch to Redis) when scaling out
CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}

_cors = os.environ.get("CORS_ALLOWED_ORIGINS", "")
CORS_ALLOWED_ORIGINS = [o for o in _cors.split(",") if o]
CORS_ALLOW_ALL_ORIGINS = not CORS_ALLOWED_ORIGINS

USE_TZ = True
TIME_ZONE = "UTC"
