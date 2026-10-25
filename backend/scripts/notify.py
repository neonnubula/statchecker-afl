"""Tiny Resend HTTP wrapper for sending notification emails from scripts.

Used by auto_update_round.py to email NOTIFY_EMAIL on success or failure.
No SDK dependency — direct POST keeps the footprint small.
"""

import os

import requests


def send_notification(subject: str, body: str) -> bool:
    """Send a plain-text email to NOTIFY_EMAIL via Resend.

    Returns True on success, False on failure or if env vars are missing.
    Never raises — failure to notify must not crash the calling job.
    """
    api_key = os.getenv("RESEND_API_KEY")
    to = os.getenv("NOTIFY_EMAIL")
    if not api_key or not to:
        print("[notify] RESEND_API_KEY or NOTIFY_EMAIL missing — skipping email")
        return False
    try:
        r = requests.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "from": "StatChecker <onboarding@resend.dev>",
                "to": [to],
                "subject": subject,
                "text": body,
            },
            timeout=10,
        )
        if not r.ok:
            print(f"[notify] Resend returned {r.status_code}: {r.text[:300]}")
        return r.ok
    except Exception as e:
        print(f"[notify] failed: {e}")
        return False
