#!/bin/bash
#
# Test script for real dsh + fleet hub integration
#
# This script:
# 1. Builds the fleet-agent plugin
# 2. Links it for dsh to find
# 3. Starts the Fleet Hub
# 4. Starts a dsh instance with the plugin
#
# Usage:
#   ./test-real-dsh.sh
#
# Prerequisites:
#   - dsh installed: npm install -g @deepseek-ai/dsh
#   - Fleet Hub deps installed: cd fleet-hub && npm install

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Turma 2.0 Real dsh Integration Test ==="
echo

# Build the plugin
echo "Building fleet-agent plugin..."
cd fleet-agent-plugin
npm install
npm run build
cd ..
echo "Plugin built successfully"
echo

# Start Fleet Hub in background
echo "Starting Fleet Hub..."
cd fleet-hub
npm install >/dev/null 2>&1
npm run dev &
HUB_PID=$!
cd ..
echo "Fleet Hub started (PID: $HUB_PID)"
sleep 2
echo

# Test with dsh
echo "Starting dsh with fleet-agent plugin..."
echo "Open http://localhost:3000 to see the dashboard"
echo "Press Ctrl+C to stop"
echo

# Link the plugin locally and run dsh
cd fleet-agent-plugin
npm link 2>/dev/null || true
cd ..

# Run dsh web with the plugin patch
FLEET_DEVICE="test-host-1" npm exec -- dsh web --port 3080 --patch fleet-agent-plugin/cordis.patch.yml

# Cleanup on exit
trap 'kill $HUB_PID 2>/dev/null' EXIT
