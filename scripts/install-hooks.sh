#!/bin/sh
# Points git at the versioned hooks in .githooks/ (run by npm's "prepare").
# Outside a git checkout, or without git (CI images, source tarballs), it does
# nothing so that `npm install` still succeeds.

command -v git >/dev/null 2>&1 || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

current=$(git config --get core.hooksPath)
if [ -n "$current" ] && [ "$current" != ".githooks" ]; then
  echo "install-hooks: core.hooksPath was $current; now .githooks for this repository." >&2
  echo "  Hooks in $current no longer run here." >&2
fi
git config core.hooksPath .githooks
