#!/bin/bash
set -e

NODE_PATH=$(which node)
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Project dir: $PROJECT_DIR"
echo "Node path: $NODE_PATH"

# Create data directory for logs
mkdir -p "$PROJECT_DIR/data"

# Replace placeholders in plist templates and install
for plist in "$PROJECT_DIR"/launchd/*.plist; do
    BASENAME=$(basename "$plist")
    DEST="$HOME/Library/LaunchAgents/$BASENAME"

    # Copy to LaunchAgents with placeholders replaced
    sed -e "s|__NODE_PATH__|$NODE_PATH|g" \
        -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
        "$plist" > "$DEST"

    echo "Installed $BASENAME"
done

launchctl load ~/Library/LaunchAgents/com.jobcrm.whatsapp.plist
launchctl load ~/Library/LaunchAgents/com.jobcrm.daily-scan.plist

echo ""
echo "LaunchAgents installed and loaded."
echo "WhatsApp collector runs at 6:50 AM daily."
echo "Daily scan runs at 7:00 AM daily."
echo ""
echo "To uninstall:"
echo "  launchctl unload ~/Library/LaunchAgents/com.jobcrm.whatsapp.plist"
echo "  launchctl unload ~/Library/LaunchAgents/com.jobcrm.daily-scan.plist"
echo "  rm ~/Library/LaunchAgents/com.jobcrm.*.plist"
