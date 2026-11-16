#!/usr/bin/env bash
# Copy this project to robin and rebuild the running container.
# The music folder and the library index volume stay where they are.

set -euo pipefail

host="${BERRYTONE_SSH:-pi@robin.local}"
dest="${BERRYTONE_DEST:-berrytone}"
root="$(cd "$(dirname "$0")/.." && pwd)"

echo "Updating ${host}:~/${dest}"
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude 'music/' \
  --exclude '.env' \
  --exclude '.DS_Store' \
  "${root}/" "${host}:${dest}/"

ssh "$host" "cd ~/${dest} && sudo docker compose up -d --build"
echo "Open http://robin.local:8083"
