#!/bin/bash
# Post-uninstall hook for claudeclaw-slack
# $1 = ClaudeClaw root directory
ROOT="${1:-.}"
rm -rf "$ROOT/skills/add-slack"
echo "claudeclaw-slack: removed skills"
