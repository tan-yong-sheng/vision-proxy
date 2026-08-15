# Homebrew formula for vision-proxy (Track A: JS dist + Node 22).
#
# Kept in this repo under Formula/ so users can tap it directly:
#   brew tap tan-yong-sheng/vision-proxy https://github.com/tan-yong-sheng/vision-proxy
#   brew install tan-yong-sheng/vision-proxy/vision-proxy
#
# Before tagging a release, replace each `sha256` with the real per-arch hash
# from the release's sha256sum.txt.
class VisionProxy < Formula
  desc "CLI that routes images to a vision model for agent UserPromptSubmit hooks"
  homepage "https://github.com/tan-yong-sheng/vision-proxy"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-darwin-arm64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
    on_intel do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-darwin-x64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-linux-arm64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
    on_intel do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-linux-x64.tar.gz"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
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
