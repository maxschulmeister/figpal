#!/bin/sh
# Copies the built UI to the VPS. Run `pnpm deploy:web` from the repo root.
set -eu
cd "$(dirname "$0")/.."
# No -a: the files must belong to root on the VPS, not to the local user.
rsync -rlptz --delete web/dist/ root@maxschulmeister.dev:/srv/figpal/
