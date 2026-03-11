#!/bin/bash
set -e

VAULT="$HOME/code/non-engineering-engineering-leadership"
PLUGIN_DIR="$VAULT/.obsidian/plugins/manuscript-reviewer"

npm run build
mkdir -p "$PLUGIN_DIR"
cp main.js manifest.json styles.css "$PLUGIN_DIR/"
echo "Deployed to $PLUGIN_DIR"
