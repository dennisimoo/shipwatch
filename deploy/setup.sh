#!/usr/bin/env bash
set -euo pipefail
: "${SITE_HOST:?Set the public hostname}"
: "${BACKUP_BUCKET:?Set the private S3 backup bucket}"
test "$(uname -m)" = aarch64
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq caddy unzip curl build-essential pkg-config
installation_directory=$(mktemp -d)
trap 'rm -rf "$installation_directory"' EXIT
curl --fail --location https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-aarch64.zip -o "$installation_directory/bun.zip"
unzip -q "$installation_directory/bun.zip" -d "$installation_directory"
install "$installation_directory/bun-linux-aarch64/bun" /usr/local/bin/bun
curl --fail --location https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip -o "$installation_directory/aws.zip"
unzip -q "$installation_directory/aws.zip" -d "$installation_directory"
"$installation_directory/aws/install" --update
curl --fail --location https://www.sqlite.org/2026/sqlite-autoconf-3540100.tar.gz -o "$installation_directory/sqlite.tar.gz"
tar -xzf "$installation_directory/sqlite.tar.gz" -C "$installation_directory"
(cd "$installation_directory/sqlite-autoconf-3540100" && ./configure --disable-readline && make -j2 && make install)
id shipwatch >/dev/null 2>&1 || useradd --system --home-dir /var/lib/shipwatch --shell /usr/sbin/nologin shipwatch
install -d -o shipwatch -g shipwatch -m 700 /var/lib/shipwatch
cd /opt/shipwatch
bun install --frozen-lockfile --production
cat > /etc/shipwatch.env <<EOF
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=/var/lib/shipwatch/shipwatch.sqlite
POLL_CONCURRENCY=24
MONITOR_YEAR=2026
TRUST_PROXY=1
BACKUP_BUCKET=$BACKUP_BUCKET
EOF
chmod 600 /etc/shipwatch.env
chmod +x deploy/backup.sh
cp deploy/shipwatch.service deploy/shipwatch-backup.service deploy/shipwatch-backup.timer /etc/systemd/system/
cat > /etc/caddy/Caddyfile <<EOF
$SITE_HOST {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
EOF
systemctl daemon-reload
systemctl enable --now shipwatch shipwatch-backup.timer
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
systemctl is-active shipwatch
bun --version
/usr/local/bin/sqlite3 --version
