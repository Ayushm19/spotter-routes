# Vercel entry point: serves the Django app as a Python serverless function.
from config.wsgi import application as app  # noqa: F401
