#!/bin/bash
# Post-install hook for claudeclaw-slack
# $1 = ClaudeClaw root directory
ROOT="${1:-.}"
cp -r "$(dirname "$0")/../skills/add-slack" "$ROOT/skills/"
cd "$ROOT" && npm install @slack/bolt@^4.6.0
echo "claudeclaw-slack: installed skills and dependencies"
