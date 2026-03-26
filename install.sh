#!/usr/bin/env bash
# Install the BehaviorTree Viewer VSCode extension from source.
# Usage: ./install.sh
set -euo pipefail

cd "$(dirname "$0")"

echo "Installing dependencies..."
npm install --ignore-scripts 2>/dev/null || npm install

echo "Compiling..."
npm run compile

echo "Packaging..."
npx @vscode/vsce package -o behaviortree-viewer.vsix

# Determine publisher.name-version for the directory name
VERSION=$(node -e "console.log(require('./package.json').version)")
PUBLISHER=$(node -e "console.log(require('./package.json').publisher)")
NAME=$(node -e "console.log(require('./package.json').name)")
EXT_DIR="${PUBLISHER}.${NAME}-${VERSION}"

echo "Installing to VSCode extensions..."

# Install to ~/.vscode/extensions (local VSCode)
VSCODE_EXT_DIR="$HOME/.vscode/extensions/${EXT_DIR}"
rm -rf "$VSCODE_EXT_DIR"
mkdir -p "$VSCODE_EXT_DIR"
unzip -oq behaviortree-viewer.vsix "extension/*" -d "$VSCODE_EXT_DIR"
mv "$VSCODE_EXT_DIR/extension/"* "$VSCODE_EXT_DIR/" 2>/dev/null
rmdir "$VSCODE_EXT_DIR/extension" 2>/dev/null || true

# Also install to vscode-server if it exists (SSH remote)
VSCODE_SERVER_EXT="$HOME/.vscode-server/extensions/${EXT_DIR}"
if [ -d "$HOME/.vscode-server/extensions" ]; then
  echo "Installing to vscode-server (SSH remote)..."
  rm -rf "$VSCODE_SERVER_EXT"
  cp -r "$VSCODE_EXT_DIR" "$VSCODE_SERVER_EXT"
fi

echo ""
echo "Done. Reload VSCode (Ctrl+Shift+P -> Developer: Reload Window)."
echo "Open any BT XML file and use:"
echo "  - Editor title bar tree icon"
echo "  - Right-click -> Open Behavior Tree Viewer"
echo "  - Ctrl+Shift+T"
echo "  - Command palette -> BehaviorTree: Open Behavior Tree Viewer"
