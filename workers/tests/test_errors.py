"""What an error report may carry: where it broke, never what anyone wrote."""

from workers.common.errors import redact_codes, scrub_event


def test_codes_are_blanked_with_or_without_the_dash():
    assert redact_codes("no session ABCDE-23456 or ABCDE23456") == "no session [code] or [code]"
    # Ordinary words and ids are left alone.
    assert redact_codes("rewrite failed for job_abc123") == "rewrite failed for job_abc123"


def test_task_arguments_locals_and_breadcrumbs_are_removed():
    event = {
        "user": {"username": "Alice"},
        "breadcrumbs": {"values": [{"message": "summary: the mitochondria is..."}]},
        "extra": {"celery-job": {"task_name": "rmcollab.enhance", "args": ["secret notes"], "kwargs": {"text": "x"}}},
        "logentry": {"message": "failed on %s", "params": ["secret notes"], "formatted": "failed on secret notes"},
        "exception": {
            "values": [
                {
                    "value": "session ABCDE23456 gone",
                    "stacktrace": {"frames": [{"function": "run", "vars": {"text": "secret notes"}}]},
                }
            ]
        },
    }
    out = scrub_event(event)
    assert "user" not in out and "breadcrumbs" not in out
    assert out["extra"] == {"task": "rmcollab.enhance"}
    assert out["logentry"] == {"message": "failed on %s"}
    value = out["exception"]["values"][0]
    assert value["value"] == "session [code] gone"
    assert "vars" not in value["stacktrace"]["frames"][0]
    assert "secret notes" not in repr(out)
