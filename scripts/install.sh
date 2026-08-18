#!/bin/sh
# vision-proxy curl installer.
#
# Downloads the requested GitHub Release tarball for the current OS/arch,
# verifies its SHA-256 against the published checksum manifest, extracts it
# into ~/.local/share/vision-proxy, and symlinks `vp` into ~/.local/bin.
#
# Requires only POSIX tools: curl, awk, a SHA-256 tool (sha256sum or
# shasum -a 256), and node >= 22 on PATH. jq is NOT required.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tan-yong-sheng/vision-proxy/main/scripts/install.sh | sh
#   ./scripts/install.sh                 # local copy
#   ./scripts/install.sh --version v0.1.0   # pin a release
#   ./scripts/install.sh --add-to-path      # append ~/.local/bin to shell profile

set -eu

REPO="tan-yong-sheng/vision-proxy"
RAW="https://raw.githubusercontent.com/${REPO}"
INSTALL_ROOT="${HOME}/.local/share/vision-proxy"
BIN_DIR="${HOME}/.local/bin"
ADD_TO_PATH=0

usage() {
	cat <<'EOF'
vision-proxy installer

Downloads the release tarball, verifies its checksum, and links `vp`.

Flags:
  --version <tag>    Install a specific release tag (e.g. v0.1.0). Default: latest.
  --root <dir>      Install prefix. Default: ~/.local/share/vision-proxy
  --bin-dir <dir>   Symlink target dir. Default: ~/.local/bin
  --add-to-path     Append the bin dir to your shell profile if not already on PATH.
  -h, --help        Show this help.

Requirements: curl, awk, a SHA-256 tool (sha256sum or shasum), and node >= 22.
EOF
}

VERSION=""
while [ $# -gt 0 ]; do
	case "$1" in
		--version) VERSION="$2"; shift 2 ;;
		--root) INSTALL_ROOT="$2"; shift 2 ;;
		--bin-dir) BIN_DIR="$2"; shift 2 ;;
		--add-to-path) ADD_TO_PATH=1; shift ;;
		-h|--help) usage; exit 0 ;;
		*) echo "error: unknown flag: $1" >&2; usage; exit 1 ;;
	esac
done

# --- dependency checks (fail fast with actionable guidance) -----------------
need() {
	if command -v "$1" >/dev/null 2>&1; then
		return 0
	fi
	echo "error: '$1' is required but not found on PATH." >&2
	case "$1" in
		curl)
			echo "Install curl, then re-run this installer:" >&2
			echo "  Debian/Ubuntu: sudo apt-get install -y curl" >&2
			echo "  macOS:         brew install curl" >&2
			;;
		awk)
			echo "Install gawk/coreutils (awk is part of base POSIX, but a minimal" >&2
			echo "container may lack it). On Debian/Ubuntu: sudo apt-get install -y gawk" >&2
			;;
		node)
			echo "vision-proxy requires Node >= 22. Install it, then re-run:" >&2
			echo "  https://nodejs.org  or  'brew install node@22'" >&2
			;;
	esac
	exit 1
}

need curl
need awk

# macOS does not ship sha256sum by default; fall back to shasum -a 256 so the
# checksum verification works on both Linux and macOS.
if command -v sha256sum >/dev/null 2>&1; then
	SHA256="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
	SHA256="shasum -a 256"
else
	echo "error: 'sha256sum' or 'shasum' is required but not found on PATH." >&2
	echo "Install coreutils (sha256sum) or the shasum utility, then re-run." >&2
	exit 1
fi

# Compute the SHA-256 of a file using whichever tool resolved above.
sha256_of() {
	$SHA256 "$1" | awk '{print $1}'
}

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
	*) echo "error: unsupported architecture: $arch (supported: x86_64, arm64)" >&2; exit 1 ;;
esac

asset="vision-proxy-${target}.tar.gz"

# --- resolve release ------------------------------------------------------
if [ -z "$VERSION" ]; then
	echo "Resolving latest release..."
	# GitHub redirects /releases/latest to /releases/tag/<tag>. Avoid the
	# GitHub API so this works even when the unauthenticated API rate limit
	# has been exhausted.
	location=""
	for attempt in 1 2 3; do
		location="$(curl -fsSL -I "https://github.com/${REPO}/releases/latest" 2>/dev/null | awk -F': ' 'tolower($1) == "location" {print $2}' | tr -d '\r')"
		[ -n "$location" ] && break
		sleep 2
	done
	if [ -z "$location" ]; then
		echo "error: could not resolve latest release from https://github.com/${REPO}/releases/latest" >&2
		echo "Check your network and that a release exists." >&2
		exit 1
	fi
	# location ends with /releases/tag/<tag>
	VERSION="${location##*/}"
else
	echo "Resolving release ${VERSION}..."
fi

if [ -z "$VERSION" ]; then
	echo "error: could not determine release tag" >&2
	exit 1
fi

echo "Found ${VERSION}"

base_url="https://github.com/${REPO}/releases/download/${VERSION}"
download_url="${base_url}/${asset}"
checksum_url="${base_url}/sha256sum.txt"

# --- download + verify ----------------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${asset}..."
if ! curl -fSL "$download_url" -o "$tmp/$asset" 2>/dev/null; then
	echo "error: failed to download ${asset} from ${download_url}" >&2
	echo "Check that release ${VERSION} exists and has assets for ${target}." >&2
	exit 1
fi
if ! curl -fSL "$checksum_url" -o "$tmp/sha256sum.txt" 2>/dev/null; then
	echo "error: failed to download sha256sum.txt from ${checksum_url}" >&2
	exit 1
fi

expected="$(grep " $asset\$" "$tmp/sha256sum.txt" | awk '{print $1}')"
if [ -z "$expected" ]; then
	echo "error: $asset missing from sha256sum.txt" >&2
	exit 1
fi

actual="$(sha256_of "$tmp/$asset")"
if [ "$expected" != "$actual" ]; then
	echo "error: checksum mismatch for $asset" >&2
	echo "  expected: $expected" >&2
	echo "  actual:   $actual" >&2
	echo "The download may be corrupted or tampered with. Re-run the installer." >&2
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
# remove any stale symlink or file
[ -L "$link" ] && rm -f "$link"
[ -e "$link" ] && rm -f "$link"
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

# --- PATH guidance --------------------------------------------------------
on_path=0
case ":$PATH:" in
	*":$BIN_DIR:") on_path=1 ;;
esac

if [ "$on_path" -eq 0 ]; then
	if [ "$ADD_TO_PATH" -eq 1 ]; then
		# Detect the shell profile to mutate.
		profile="${HOME}/.bashrc"
		if [ -n "${SHELL:-}" ]; then
			case "${SHELL##*/}" in
				zsh)  profile="${HOME}/.zshrc" ;;
				fish) profile="${HOME}/.config/fish/config.fish" ;;
				bash) profile="${HOME}/.bashrc" ;;
				*)    profile="${HOME}/.profile" ;;
			esac
		fi
		mkdir -p "$(dirname "$profile")"
		export_line="export PATH=\"$BIN_DIR:\$PATH\""
		if ! grep -Fq "$BIN_DIR" "$profile" 2>/dev/null; then
			echo "$export_line" >> "$profile"
			echo
			echo "Added $BIN_DIR to $profile."
			echo "Restart your shell or run: source $profile"
		else
			echo "$BIN_DIR already referenced in $profile; not modifying it."
		fi
	else
		echo
		echo "NOTE: $BIN_DIR is not on your PATH."
		echo "Add it to your shell profile, e.g.:"
		echo "  export PATH=\"$BIN_DIR:\$PATH\""
		echo "Or re-run with --add-to-path to append it automatically."
	fi
fi

echo
echo "vision-proxy ${VERSION} installed. Run 'vp --version' to verify."
