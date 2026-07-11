#!/bin/bash
# Double-click to launch Clipper Cowboy.
# This script:
#   1. cd's into the repo it lives in
#   2. installs npm deps if needed
#   3. builds the UI if dist/ is missing or stale
#   4. starts the server
#   5. opens http://localhost:$PORT in your default browser
#
# Note: filename kept as "Clip Cataloger.command" for backwards compatibility
# with existing Finder bookmarks. Rename it to "Clipper Cowboy.command" if
# you like — nothing else references it by name.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR/scripts/desktop-launch.sh"
