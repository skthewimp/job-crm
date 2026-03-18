#!/bin/bash
set -e

NODE_PATH=$(which node)
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Project dir: $PROJECT_DIR"
echo "Node path: $NODE_PATH"

for plist in "$PROJECT_DIR"/launchd/*.plist; do
    sed -i '' "s|/usr/local/bin/node|$NODE_PATH|g" "$plist"
    sed -i '' "s|/Users/Karthik/Documents/work/vibes/job-crm|$PROJECT_DIR|g" "$plist"
done

cp "$PROJECT_DIR/launchd/com.jobcrm.whatsapp.plist" ~/Library/LaunchAgents/
cp "$PROJECT_DIR/launchd/com.jobcrm.daily-scan.plist" ~/Library/LaunchAgents/

launchctl load ~/Library/LaunchAgents/com.jobcrm.whatsapp.plist
launchctl load ~/Library/LaunchAgents/com.jobcrm.daily-scan.plist

echo "LaunchAgents installed and loaded."
echo "WhatsApp collector will run immediately and stay alive."
echo "Daily scan will run at 7:00 AM every day."
