#!/bin/sh
# Copies the built UI to the VPS. Run `pnpm deploy:web` from the repo root.
set -eu
cd "$(dirname "$0")/.."
# No -a: the files must belong to root on the VPS, not to the local user.
# Old files in /assets stay: an open FigPal window loads parts of its build later (for example the ChatGPT provider),
# and the file names change with each build. The server would send index.html for a deleted file.
rsync -rlptz --delete --filter='protect /assets/**' web/dist/ root@maxschulmeister.dev:/srv/figpal/
# Files of builds older than 30 days go. rsync sets the time of each current file to its build time.
ssh root@maxschulmeister.dev 'find /srv/figpal/assets -type f -mtime +30 -delete'
