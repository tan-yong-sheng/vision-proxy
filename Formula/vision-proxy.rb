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
      sha256 "be4626f31f877fddb3e2da8f8617818b52993ad7c71e08900a5f42784ee5e975"
    end
    on_intel do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-darwin-x64.tar.gz"
      sha256 "06b198937b69e0c0f97ee3753045c18ad1e58bb2257bb83fc84189f4f3f32218"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-linux-arm64.tar.gz"
      sha256 "8cf4bb6dd6049ec61843e1861abbfa7307bd1aff2d6c61b1c7e583bdd596df30"
    end
    on_intel do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-linux-x64.tar.gz"
      sha256 "8c622b2a82e03f139dd74cd36789ab2965956c3bb095872320e10d1b589d3d52"
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
