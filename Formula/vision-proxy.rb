# Homebrew formula for vision-proxy (Track A: JS dist + Node 22).
#
# Kept in this repo under Formula/ so users can tap it directly:
#   brew tap tan-yong-sheng/vision-proxy https://github.com/tan-yong-sheng/vision-proxy
#   brew install tan-yong-sheng/vision-proxy/vision-proxy
#
# The `sha256` values below are filled automatically by .github/workflows/release.yml
# at release time, read from the release's sha256sum.txt so the formula always
# matches the published artifacts. They are placeholders until the first release
# is cut with that workflow.
class VisionProxy < Formula
  desc "CLI that routes images to a vision model for agent UserPromptSubmit hooks"
  homepage "https://github.com/tan-yong-sheng/vision-proxy"
  version "0.1.2"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-darwin-arm64.tar.gz"
      sha256 "48a6279285f244dc658a7c5016ea35bfbe86a12378573c8038a0f4d32ae73a1f"
    end
    on_intel do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-darwin-x64.tar.gz"
      sha256 "bf0b28a06015ded1e216896460bec25f28c9939189795a5da78ec2ff28df0fe3"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-linux-arm64.tar.gz"
      sha256 "96e0ff43c850d6849b79721108d39048d80f415a60fab42e844ff58dc5406e3d"
    end
    on_intel do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-linux-x64.tar.gz"
      sha256 "8294811dd4f7b3c8d8ea59f4ea4bcf3cb4f162ceb334b5e5055022de981b32d6"
    end
  end

  depends_on "node@22"

  def install
    libexec.install Dir["*"]
    (bin/"vp").write_env_script libexec/"vp", PATH: "#{Formula["node@22"].opt_bin}:$PATH"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/vp --version")
  end
end
