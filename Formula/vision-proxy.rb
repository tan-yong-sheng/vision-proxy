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
      sha256 "96b9bddd47aecded5e6c830bbe4d1d552e1ba635d112210d720198b382c869ac"
    end
    on_intel do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-darwin-x64.tar.gz"
      sha256 "e0e3e1e8e05bdf14de103442f48a47c017f9e02b5b72f36306179864e000e3ff"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-linux-arm64.tar.gz"
      sha256 "5fc759cf586679843d82a172e696e0fc63db5aad3bbddbb98f6b401e2c954be0"
    end
    on_intel do
      url "https://github.com/tan-yong-sheng/vision-proxy/releases/download/v#{version}/vision-proxy-linux-x64.tar.gz"
      sha256 "6bb01e19daa971f40773339705c17e18a4bec20e3b09412eb8a4ce2eab049fcd"
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
