#!/bin/sh
# vision-proxy curl installer.
#
# Downloads the latest GitHub Release tarball for the current OS/arch, verifies
# its SHA-256 against the published checksum manifest, extracts it into
# ~/.local/share/vision-proxy, and symlinks `vp` into ~/.local/bin.
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
API="https://api.github.com/repos/${REPO}/releases"
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
	release_url="${API}/latest"
else
	echo "Resolving release ${VERSION}..."
	release_url="${API}/tags/${VERSION}"
fi

# Retry the GitHub API a couple of times; it occasionally rate-limits.
release_json=""
for attempt in 1 2 3; do
	if release_json="$(curl -fsSL "$release_url" 2>/dev/null)"; then
		break
	fi
	echo "warning: failed to fetch release metadata (attempt ${attempt}/3)" >&2
	sleep 2
done
if [ -z "$release_json" ]; then
	echo "error: could not fetch release metadata from ${release_url}" >&2
	echo "Check your network, the repo name, and that a release exists:" >&2
	echo "  https://github.com/${REPO}/releases" >&2
	exit 1
fi

# Parse a JSON string value for a given key. Works for both pretty-printed and
# compact (single-line) JSON using POSIX awk. No jq required.
json_value() {
	key="$1"
	printf '%s\n' "$release_json" | awk -v k="\"$key\"" '
		function clean(s,   i, ch, prev, run, started, len) {
			# strip surrounding whitespace and the quotes
			gsub(/^[ \t]+/, "", s); gsub(/[ \t\r]+$/, "", s)
			gsub(/^"/, "", s); gsub(/"$/, "", s)
			# unescape common sequences (order matters: backslash first)
			gsub(/\\"/, "\"", s); gsub(/\\\\/, "\\", s)
			return s
		}
		{
			line = $0
			# find the key followed by a colon anywhere on the line
			idx = index(line, k)
			while (idx > 0) {
				rest = substr(line, idx + length(k))
				if (substr(rest, 1, 1) == ":" || substr(rest, 1, 1) ~ /[ \t]/) {
					# move to the first quote after the colon
					c = index(rest, "\"")
					if (c > 0) {
						start = idx + length(k) + c
						val = substr(line, start)
						# find the closing quote (not preceded by backslash)
						end = 0; len = length(val)
						for (j = 1; j <= len; j++) {
							ch = substr(val, j, 1)
							prev = (j > 1) ? substr(val, j - 1, 1) : ""
							if (ch == "\"" && prev != "\\") { end = j; break }
						}
						if (end > 0) { print clean(substr(val, 1, end - 1)); exit }
					}
				}
				idx = index(substr(line, idx + 1), k)
			}
		}
	'
}

VERSION="$(json_value tag_name)"
if [ -z "$VERSION" ]; then
	echo "error: could not parse tag_name from release metadata" >&2
	exit 1
fi
echo "Found ${VERSION}"

# Extract the browser_download_url for a given asset name from the JSON.
# Walks the payload as a single logical string (compact or pretty) and pairs
# each "name" with the "browser_download_url" that follows it in the assets
# array. No jq required.
asset_url() {
	want="$1"
	printf '%s\n' "$release_json" | awk -v want="$want" '
		function unq(s,   c, v, out, len, q, ch, prev) {
			# extract the string value starting at the first quote
			c = index(s, "\"")
			if (c == 0) return ""
			v = substr(s, c + 1)
			out = ""; len = length(v)
			for (q = 1; q <= len; q++) {
				ch = substr(v, q, 1)
				prev = (q > 1) ? substr(v, q - 1, 1) : ""
				if (ch == "\"" && prev != "\\") break
				out = out ch
			}
			return out
		}
		{
			buf = buf $0
		}
		END {
			# scan for "name" tokens, then find the following "browser_download_url"
			i = 1; n = length(buf)
			while (i <= n) {
				if (substr(buf, i, 6) == "\"name\"") {
					# advance to the next quote pair after the colon
					j = index(substr(buf, i + 6), "\"")
					name = unq(substr(buf, i + 6 + j - 1))
					# search forward for the next browser_download_url
					k = index(substr(buf, i + 6), "\"browser_download_url\"")
					if (k > 0) {
						base = i + 6 + k - 1
						m = index(substr(buf, base + 23), "\"")
						url = unq(substr(buf, base + 23 + m - 1))
						if (name == want) { print url; exit }
					}
					i = i + 6
				} else {
					i++
				}
			}
		}
	'
}

download_url="$(asset_url "$asset")"
checksum_url="$(asset_url "sha256sum.txt")"

if [ -z "$download_url" ]; then
	echo "error: no asset '$asset' for ${VERSION}" >&2
	echo "This platform may be unsupported, or the release is still building." >&2
	echo "Supported platforms: linux-x64, linux-arm64, darwin-x64, darwin-arm64." >&2
	echo "See: https://github.com/${REPO}/releases" >&2
	exit 1
fi
if [ -z "$checksum_url" ]; then
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
	*":$BIN_DIR:"*) on_path=1 ;;
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
