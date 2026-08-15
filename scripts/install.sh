#!/bin/sh
# vision-proxy curl installer.
#
# Downloads the latest GitHub Release tarball for the current OS/arch, verifies
# its SHA-256 against the published checksum manifest, extracts it into
# ~/.local/share/vision-proxy, and symlinks `vp` into ~/.local/bin.
#
# Requires: curl, jq, sha256sum, and node >= 22 on PATH.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tan-yong-sheng/vision-proxy/main/scripts/install.sh | sh
#   ./scripts/install.sh            # local copy
#   ./scripts/install.sh --version v0.1.0   # pin a release

set -eu

REPO="tan-yong-sheng/vision-proxy"
API="https://api.github.com/repos/${REPO}/releases"
RAW="https://raw.githubusercontent.com/${REPO}"
INSTALL_ROOT="${HOME}/.local/share/vision-proxy"
BIN_DIR="${HOME}/.local/bin"

usage() {
	cat <<'EOF'
vision-proxy installer

Flags:
  --version <tag>   Install a specific release tag (e.g. v0.1.0). Default: latest.
  --root <dir>     Install prefix. Default: ~/.local/share/vision-proxy
  --bin-dir <dir>  Symlink target dir. Default: ~/.local/bin
  -h, --help       Show this help.
EOF
}

VERSION=""
while [ $# -gt 0 ]; do
	case "$1" in
		--version) VERSION="$2"; shift 2 ;;
		--root) INSTALL_ROOT="$2"; shift 2 ;;
		--bin-dir) BIN_DIR="$2"; shift 2 ;;
		-h|--help) usage; exit 0 ;;
		*) echo "unknown flag: $1" >&2; usage; exit 1 ;;
	esac
done

need() {
	command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' is required but not found on PATH" >&2; exit 1; }
}
need curl
need jq
need sha256sum

# --- detect OS/arch -------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
	Linux)  target="linux" ;;
	Darwin) target="darwin" ;;
	*) echo "error: unsupported OS: $os (this installer supports Linux and macOS)" >&2; exit 1 ;;
esac

case "$arch" in
	x86_64|amd64) target="${target}-x64" ;;
	arm64|aarch64) target="${target}-arm64" ;;
	*) echo "error: unsupported architecture: $arch" >&2; exit 1 ;;
esac

asset="vision-proxy-${target}.tar.gz"

# --- resolve release ------------------------------------------------------
if [ -z "$VERSION" ]; then
	echo "Resolving latest release..."
	release_url="${API}/latest"
else
	echo "Resolving release ${VERSION}..."
	release_url="${API}/tags/${VERSION}"
fi

release_json="$(curl -fsSL "$release_url")"
VERSION="$(printf '%s' "$release_json" | jq -r .tag_name)"
echo "Found ${VERSION}"

download_url="$(printf '%s' "$release_json" | jq -r --arg a "$asset" '.assets[] | select(.name == $a) | .browser_download_url')"
checksum_url="$(printf '%s' "$release_json" | jq -r '.assets[] | select(.name == "sha256sum.txt") | .browser_download_url')"

if [ -z "$download_url" ] || [ "$download_url" = "null" ]; then
	echo "error: no asset '$asset' for ${VERSION}" >&2
	echo "This platform may not be supported yet, or the release is still building." >&2
	exit 1
fi
if [ -z "$checksum_url" ] || [ "$checksum_url" = "null" ]; then
	echo "error: no sha256sum.txt for ${VERSION}" >&2
	exit 1
fi

# --- download + verify ----------------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${asset}..."
curl -fSL "$download_url" -o "$tmp/$asset"
curl -fSL "$checksum_url" -o "$tmp/sha256sum.txt"

expected="$(grep " $asset\$" "$tmp/sha256sum.txt" | awk '{print $1}')"
if [ -z "$expected" ]; then
	echo "error: $asset missing from sha256sum.txt" >&2
	exit 1
fi

actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
if [ "$expected" != "$actual" ]; then
	echo "error: checksum mismatch for $asset" >&2
	echo "  expected: $expected" >&2
	echo "  actual:   $actual" >&2
	exit 1
fi
echo "Checksum verified: $actual"

# --- extract --------------------------------------------------------------
dest="${INSTALL_ROOT}/${VERSION}"
echo "Installing to ${dest}..."
rm -rf "$dest"
mkdir -p "$dest"
tar -xzf "$tmp/$asset" -C "$dest" --strip-components=1
chmod +x "$dest/vp"

# --- symlink --------------------------------------------------------------
mkdir -p "$BIN_DIR"
link="${BIN_DIR}/vp"
# remove any stale symlink
[ -L "$link" ] && rm -f "$link"
ln -s "$dest/vp" "$link"
echo "Linked $link -> $dest/vp"

# --- node check -----------------------------------------------------------
if command -v node >/dev/null 2>&1; then
	node_major="$(node -p 'process.versions.node.split(".")[0]')"
	if [ "$node_major" -lt 22 ]; then
		echo "warning: node $node_major detected; vision-proxy requires node >= 22." >&2
		echo "Install Node 22+ (e.g. 'brew install node@22') and re-run, or the 'vp' command will fail." >&2
	fi
else
	echo "warning: node not found on PATH; vision-proxy requires node >= 22." >&2
fi

# --- report ---------------------------------------------------------------
case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*)
		echo
		echo "NOTE: $BIN_DIR is not on your PATH."
		echo "Add it to your shell profile, e.g.:"
		echo "  export PATH=\"$BIN_DIR:\$PATH\""
		;;
esac

echo
echo "vision-proxy ${VERSION} installed. Run 'vp --version' to verify."
