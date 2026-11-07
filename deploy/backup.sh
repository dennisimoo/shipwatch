#!/usr/bin/env bash
set -euo pipefail
backup_directory=$(mktemp -d)
trap 'rm -rf "$backup_directory"' EXIT
# Pin one WAL snapshot so concurrent observations cannot restart the backup repeatedly.
/usr/local/bin/sqlite3 -bail "$DATABASE_PATH" >/dev/null <<SQL
BEGIN;
SELECT count(*) FROM sqlite_schema;
.backup '$backup_directory/shipwatch.sqlite'
ROLLBACK;
SQL
integrity=$(/usr/local/bin/sqlite3 "$backup_directory/shipwatch.sqlite" 'PRAGMA integrity_check;')
test "$integrity" = ok
gzip -c "$backup_directory/shipwatch.sqlite" | aws s3 cp - "s3://$BACKUP_BUCKET/daily/$(date -u +%Y-%m-%dT%H-%M-%SZ).sqlite.gz" --only-show-errors --region us-west-1
