#!/usr/bin/env python3
"""
Upload historical BOM rainfall data to a doover channel as daily summary messages.

Usage:
    python scripts/upload_bom_rainfall.py <csv_path> <agent_id> <channel_name> --profile <profile>

Example:
    python scripts/upload_bom_rainfall.py \
        ~/Downloads/IDCJAC0009_070063_1800/IDCJAC0009_070063_1800_Data.csv \
        146005200488925453 \
        analog_rain_gauge_1 \
        --profile dv2
"""

import argparse
import csv
import sys
from datetime import datetime, timezone, timedelta

from pydoover.cloud.api import Client


def parse_args():
    parser = argparse.ArgumentParser(description="Upload BOM rainfall CSV to doover")
    parser.add_argument("csv_path", help="Path to BOM rainfall CSV file")
    parser.add_argument("agent_id", help="Doover agent ID")
    parser.add_argument("channel_name", help="Channel name (usually the app_key)")
    parser.add_argument("--profile", default="default", help="Doover CLI profile name")
    parser.add_argument(
        "--years",
        type=int,
        default=10,
        help="Only upload the last N years of data (default: 10)",
    )
    parser.add_argument(
        "--from-date",
        help="Only upload from this date onwards (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--to-date",
        help="Only upload up to this date (YYYY-MM-DD, inclusive)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be uploaded without sending",
    )
    return parser.parse_args()


def make_client(profile_name: str) -> Client:
    client = Client(
        config_profile="dv2",
        is_doover2=True,
        base_url="https://api.doover.com",
        login_callback=lambda: print("Logged in"),
    )
    client.client.do_refresh_token()
    return client


def load_csv(csv_path: str, min_year: int):
    rows = []
    with open(csv_path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            year = int(row["Year"])
            if year < min_year:
                continue

            rainfall_str = row["Rainfall amount (millimetres)"].strip()
            if not rainfall_str:
                continue

            rainfall = float(rainfall_str)
            month = int(row["Month"])
            day = int(row["Day"])
            date_str = f"{year}-{month:02d}-{day:02d}"

            # BOM daily rainfall is measured at 9am, so timestamp is 9am local
            dt = datetime(year, month, day, 9, 0, 0)
            # Assume AEST (UTC+10) for Marulan
            dt_utc = dt - timedelta(hours=10)
            dt_utc = dt_utc.replace(tzinfo=timezone.utc)

            rows.append({
                "date": date_str,
                "total_mm": round(rainfall, 2),
                "timestamp_dt": dt_utc,
            })

    return rows


def main():
    args = parse_args()
    now = datetime.now()
    min_year = now.year - args.years

    rows = load_csv(args.csv_path, min_year)

    if args.from_date:
        rows = [r for r in rows if r["date"] >= args.from_date]
    if args.to_date:
        rows = [r for r in rows if r["date"] <= args.to_date]

    print(f"Loaded {len(rows)} days with rainfall data")

    if not rows:
        print("No data to upload.")
        return

    if args.dry_run:
        for row in rows[:5]:
            msg = {
                "daily": {
                    "type": "daily",
                    "date": row["date"],
                    "total_mm": row["total_mm"],
                    "timestamp": int(row["timestamp_dt"].timestamp() * 1000),
                },
            }
            print(f"  {msg}")
        if len(rows) > 5:
            print(f"  ... and {len(rows) - 5} more")
        return

    client = make_client(args.profile)
    agent_id = args.agent_id
    channel_name = args.channel_name

    uploaded = 0
    skipped = 0
    for i, row in enumerate(rows):
        if row["total_mm"] == 0:
            skipped += 1
            continue

        msg = {
            "daily": {
                "date": row["date"],
                "total_mm": row["total_mm"],
                "timestamp": int(row["timestamp_dt"].timestamp() * 1000),
            },
        }

        try:
            client.publish_to_channel_name(
                agent_id=agent_id,
                channel_name=channel_name,
                data=msg,
                save_log=True,
                timestamp=row["timestamp_dt"],
            )
            uploaded += 1
        except Exception as e:
            print(f"  Error uploading {row['date']}: {e}")

        if (i + 1) % 100 == 0:
            print(f"  Progress: {i + 1}/{len(rows)} ({uploaded} uploaded, {skipped} skipped)")

    print(f"Done. Uploaded {uploaded} daily summaries, skipped {skipped} zero-rainfall days.")


if __name__ == "__main__":
    main()
