#!/usr/bin/env bash
set -euo pipefail
backup_directory=$(mktemp -d)
trap 'rm -rf "$backup_directory"' EXIT
/usr/local/bin/sqlite3 "$DATABASE_PATH" ".backup '$backup_directory/shipwatch.sqlite'"
integrity=$(/usr/local/bin/sqlite3 "$backup_directory/shipwatch.sqlite" 'PRAGMA integrity_check;')
test "$integrity" = ok
gzip "$backup_directory/shipwatch.sqlite"
aws s3 cp "$backup_directory/shipwatch.sqlite.gz" "s3://$BACKUP_BUCKET/daily/$(date -u +%Y-%m-%dT%H-%M-%SZ).sqlite.gz" --only-show-errors --region us-west-1
