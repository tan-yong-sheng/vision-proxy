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
  version "0.1.1"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-darwin-arm64.tar.gz"
      sha256 "41f22d8a7ea91130ea1c09284458ff1168b82d95a75b198c8c01fe59a86703c6"
    end
    on_intel do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-darwin-x64.tar.gz"
      sha256 "2e1c3d29f73cd43b9d37c31289fffedc8b31b73dc591c78bd56db14156cd5749"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-linux-arm64.tar.gz"
      sha256 "76240de871985352a65c11f0ac6fab23c434f8b0ec4992ab4695c54bede0c21f"
    end
    on_intel do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-linux-x64.tar.gz"
      sha256 "e996c73e53b411534e7878fb3d34f583f9f84a212f47a378add491dd3a9e8a47"
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
