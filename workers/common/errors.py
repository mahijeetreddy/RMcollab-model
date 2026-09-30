"""Error tracking (Sentry) for the worker pools.

Off unless SENTRY_DSN is set, and then errors only: a task that raises, and
anything logged at ERROR. The rule is the gateway's (shared/src/scrub.ts): a
report says where it broke and how, never what anyone wrote. That matters more
here than anywhere, because a task's arguments *are* the content - the text to
rewrite, the notes to answer from - and the Celery integration attaches them to
every report by default. So they, local variables, and log breadcrumbs (whose
messages can quote a model's output) are all removed before anything is sent.
"""

from __future__ import annotations

import os
import re
from typing import Any

# A session code, with or without its dash (see SESSION_CODE_ALPHABET in shared/src/domain.ts).
_CODE = re.compile(r"\b[A-HJ-NP-Z2-9]{5}-?[A-HJ-NP-Z2-9]{5}\b")


def redact_codes(text: str) -> str:
    return _CODE.sub("[code]", text)


def scrub_event(event: dict[str, Any], _hint: Any = None) -> dict[str, Any]:
    for key in ("user", "request", "server_name", "breadcrumbs"):
        event.pop(key, None)

    # The Celery integration's "celery-job": keep which task, drop what it was given.
    extra = event.get("extra") or {}
    job = extra.get("celery-job") if isinstance(extra, dict) else None
    event["extra"] = {"task": job.get("task_name")} if isinstance(job, dict) else {}

    if isinstance(event.get("message"), str):
        event["message"] = redact_codes(event["message"])
    logentry = event.get("logentry")
    if isinstance(logentry, dict):
        # Formatting arguments are values from the task; the template is enough.
        logentry.pop("params", None)
        if isinstance(logentry.get("message"), str):
            logentry["message"] = redact_codes(logentry["message"])
        logentry.pop("formatted", None)

    for value in (event.get("exception") or {}).get("values") or []:
        if isinstance(value.get("value"), str):
            value["value"] = redact_codes(value["value"])
        for frame in (value.get("stacktrace") or {}).get("frames") or []:
            frame.pop("vars", None)
    for thread in (event.get("threads") or {}).get("values") or []:
        for frame in (thread.get("stacktrace") or {}).get("frames") or []:
            frame.pop("vars", None)
    return event


def start_error_tracking() -> bool:
    dsn = os.environ.get("SENTRY_DSN", "").strip()
    if not dsn:
        return False
    import sentry_sdk
    from sentry_sdk.integrations.celery import CeleryIntegration

    sentry_sdk.init(
        dsn=dsn,
        environment=os.environ.get("SENTRY_ENVIRONMENT", "development"),
        release=os.environ.get("SENTRY_RELEASE") or None,
        send_default_pii=False,
        include_local_variables=False,
        max_request_body_size="never",
        # No traces_sample_rate, not even 0: any number turns the tracing instrumentation on.
        integrations=[CeleryIntegration(monitor_beat_tasks=False)],
        before_send=scrub_event,
        before_breadcrumb=lambda _crumb, _hint: None,
    )
    return True
