#!/usr/bin/env python3
"""
Migrate messages in an app_key channel from the old flat format to the new nested format.

Old format: {"type": "pulse", "mm": 0.2, "timestamp": ...}
New format: {"pulse": {"type": "pulse", "mm": 0.2, "timestamp": ...}}

Usage:
    python scripts/migrate_message_format.py <agent_id> <channel_name> --profile dv2
    python scripts/migrate_message_format.py <agent_id> <channel_name> --profile dv2 --dry-run
"""

import argparse
import time
from urllib.parse import urlencode

from pydoover.cloud.api import Client
from pydoover.cloud.api.client import Route

DOOVER_EPOCH = 1735689600000
MESSAGE_TYPES = ("pulse", "daily", "event")


def snowflake_now():
    millis = int(time.time() * 1000 - DOOVER_EPOCH)
    return millis << 22


def parse_args():
    parser = argparse.ArgumentParser(
        description="Migrate channel messages to nested format"
    )
    parser.add_argument("agent_id", help="Doover agent ID")
    parser.add_argument("channel_name", help="Channel name (usually the app_key)")
    parser.add_argument("--profile", default="default", help="Doover CLI profile name")
    parser.add_argument(
        "--limit",
        type=int,
        default=500,
        help="Number of recent messages to fetch (default: 500)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be changed without modifying anything",
    )
    return parser.parse_args()


def make_client(profile_name: str) -> Client:
    client = Client(
        config_profile=profile_name,
        is_doover2=True,
        base_url="https://api.doover.com",
        login_callback=lambda: print("Logged in"),
    )
    client.client.do_refresh_token()
    return client


def get_messages(client, agent_id, channel_name, limit=500, before=None):
    """Fetch messages directly via the data API, mimicking the processor data_client."""
    params = {"limit": limit}
    if before:
        params["before"] = before
    else:
        params["before"] = snowflake_now()

    query = urlencode(params)
    url = f"/agents/{agent_id}/channels/{channel_name}/messages?{query}"

    data = client.client.request(
        Route("GET", url),
        data_url=True,
    )

    if not data:
        return []
    return data


def update_message(client, agent_id, channel_name, message_id, data):
    """Update a message in place via PUT."""
    client.client.request(
        Route(
            "PUT",
            "/agents/{}/channels/{}/messages/{}",
            agent_id,
            channel_name,
            message_id,
        ),
        json={"data": data},
        data_url=True,
    )


def is_old_format(payload: dict) -> bool:
    if not isinstance(payload, dict):
        return False
    msg_type = payload.get("type")
    if msg_type not in MESSAGE_TYPES:
        return False
    # Already in new format if the type key maps to a dict
    if isinstance(payload.get(msg_type), dict):
        return False
    return True


def convert_payload(payload: dict) -> dict:
    msg_type = payload["type"]
    inner = dict(payload)
    # Remove the old boolean marker (e.g. "pulse": True, "daily": True)
    if inner.get(msg_type) is True:
        del inner[msg_type]
    return {msg_type: inner}


def main():
    args = parse_args()
    client = make_client(args.profile)

    print(f"Fetching up to {args.limit} messages from {args.channel_name}...")
    raw_messages = get_messages(client, args.agent_id, args.channel_name, limit=args.limit)

    if not raw_messages:
        print("No messages found.")
        return

    print(f"Fetched {len(raw_messages)} messages.")

    to_migrate = []
    already_new = 0
    skipped = 0

    for msg in raw_messages:
        payload = msg.get("data")
        msg_id = msg.get("id")
        if payload is None or msg_id is None:
            skipped += 1
            continue

        if is_old_format(payload):
            to_migrate.append((msg_id, payload))
        else:
            already_new += 1

    print(
        f"  {len(to_migrate)} to migrate, {already_new} already in new format, {skipped} skipped"
    )

    if not to_migrate:
        print("Nothing to migrate.")
        return

    if args.dry_run:
        print("\nDry run - showing first 10 conversions:")
        for msg_id, payload in to_migrate[:10]:
            new_payload = convert_payload(payload)
            print(f"  {msg_id}: {payload}")
            print(f"       -> {new_payload}")
        if len(to_migrate) > 10:
            print(f"  ... and {len(to_migrate) - 10} more")
        return

    print(f"\nMigrating {len(to_migrate)} messages...")
    migrated = 0
    errors = 0

    for i, (msg_id, payload) in enumerate(to_migrate):
        new_payload = convert_payload(payload)

        try:
            update_message(
                client,
                args.agent_id,
                args.channel_name,
                msg_id,
                new_payload,
            )
            migrated += 1
        except Exception as e:
            print(f"  Error migrating message {msg_id}: {e}")
            errors += 1

        if (i + 1) % 50 == 0:
            print(f"  Progress: {i + 1}/{len(to_migrate)} ({migrated} migrated, {errors} errors)")

    print(f"Done. Migrated {migrated}, errors {errors}.")


if __name__ == "__main__":
    main()
