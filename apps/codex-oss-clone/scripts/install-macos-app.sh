#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="VibeCode"
EXECUTABLE_NAME="vibecode-desktop"
TARGET_DIR="${1:-$HOME/Applications}"
BUNDLE_DIR="$TARGET_DIR/$APP_NAME.app"

LAUNCH_AGENT_LABEL="local.codex.oss.clone.server"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCH_AGENT_PATH="$LAUNCH_AGENT_DIR/$LAUNCH_AGENT_LABEL.plist"
RUN_LOG="$HOME/Library/Logs/codex-oss-clone.log"
NPM_PATH="$(command -v npm)"
SWIFTC_PATH="$(command -v swiftc || true)"

if [ -z "$NPM_PATH" ]; then
  echo "npm is required to install the macOS app launcher" >&2
  exit 1
fi

if [ -z "$SWIFTC_PATH" ]; then
  echo "swiftc is required. Install Xcode Command Line Tools with: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR" "$LAUNCH_AGENT_DIR" "$HOME/Library/Logs"
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/Contents/MacOS"

cat > "$LAUNCH_AGENT_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCH_AGENT_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd '$ROOT_DIR' && PORT=4310 '$NPM_PATH' start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$RUN_LOG</string>
  <key>StandardErrorPath</key>
  <string>$RUN_LOG</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$UID/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID" "$LAUNCH_AGENT_PATH" >/dev/null 2>&1 || true

if [ -x "$ROOT_DIR/scripts/start-cli-backend.sh" ]; then
  "$ROOT_DIR/scripts/start-cli-backend.sh" >/dev/null 2>&1 || true
fi

cat > "$BUNDLE_DIR/Contents/Info.plist" <<INFO
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>$EXECUTABLE_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>local.codex.oss.clone.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key>
    <true/>
  </dict>
</dict>
</plist>
INFO

SWIFT_FILE="$(mktemp /tmp/vibecode-desktop.XXXXXX).swift"
cat > "$SWIFT_FILE" <<'SWIFT'
import AppKit
import Darwin
import Foundation
import WebKit

final class DesktopAppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private let appUrl = URL(string: "http://127.0.0.1:4310/")!
    private let serverLaunchAgentLabel = "local.codex.oss.clone.server"
    private let serverLaunchAgentPath = (NSHomeDirectory() as NSString).appendingPathComponent("Library/LaunchAgents/local.codex.oss.clone.server.plist")
    private let cliLaunchAgentLabel = "local.codex.oss.clone.cli-backend"
    private let cliLaunchAgentPath = (NSHomeDirectory() as NSString).appendingPathComponent("Library/LaunchAgents/local.codex.oss.clone.cli-backend.plist")
    private var attempts = 0
    private let maxAttempts = 120
    private var timer: Timer?

    private var window: NSWindow!
    private var webView: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupWindow()
        startBackendService()
        startPollingServer()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func setupWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1300, height: 860)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "VibeCode"
        window.center()
        window.makeKeyAndOrderFront(nil)

        let configuration = WKWebViewConfiguration()
        webView = WKWebView(frame: frame, configuration: configuration)
        webView.navigationDelegate = self
        window.contentView = webView

        let placeholderHtml = """
        <html><body style=\"background:#15181f;color:#e4e6eb;font-family:-apple-system;padding:24px\">
        <h2 style=\"margin-top:0\">Starting VibeCode…</h2>
        <p>Connecting to local service at <code>http://127.0.0.1:4310</code>.</p>
        </body></html>
        """
        webView.loadHTMLString(placeholderHtml, baseURL: nil)
    }

    private func startBackendService() {
        let uid = getuid()
        _ = runShell("launchctl bootstrap gui/\(uid) '\(cliLaunchAgentPath)' >/dev/null 2>&1 || true")
        _ = runShell("launchctl kickstart -k gui/\(uid)/\(cliLaunchAgentLabel) >/dev/null 2>&1 || true")
        _ = runShell("launchctl bootstrap gui/\(uid) '\(serverLaunchAgentPath)' >/dev/null 2>&1 || true")
        _ = runShell("launchctl kickstart -k gui/\(uid)/\(serverLaunchAgentLabel) >/dev/null 2>&1 || true")
    }

    private func startPollingServer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] timer in
            guard let self else {
                timer.invalidate()
                return
            }

            self.attempts += 1
            var request = URLRequest(url: self.appUrl)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = 2

            let task = URLSession.shared.dataTask(with: request) { _, response, _ in
                if let http = response as? HTTPURLResponse, (200...499).contains(http.statusCode) {
                    DispatchQueue.main.async {
                        timer.invalidate()
                        self.webView.load(URLRequest(url: self.appUrl))
                    }
                    return
                }

                if self.attempts >= self.maxAttempts {
                    DispatchQueue.main.async {
                        timer.invalidate()
                        let html = """
                        <html><body style=\"background:#15181f;color:#e4e6eb;font-family:-apple-system;padding:24px\">
                        <h2 style=\"margin-top:0\">VibeCode could not connect</h2>
                        <p>Check logs at <code>~/Library/Logs/codex-oss-clone.log</code>.</p>
                        </body></html>
                        """
                        self.webView.loadHTMLString(html, baseURL: nil)
                    }
                }
            }
            task.resume()
        }
    }

    @discardableResult
    private func runShell(_ command: String) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", command]
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus
        } catch {
            return -1
        }
    }
}

let app = NSApplication.shared
let delegate = DesktopAppDelegate()
app.delegate = delegate
app.run()
SWIFT

"$SWIFTC_PATH" -O -framework Cocoa -framework WebKit "$SWIFT_FILE" -o "$BUNDLE_DIR/Contents/MacOS/$EXECUTABLE_NAME"
chmod +x "$BUNDLE_DIR/Contents/MacOS/$EXECUTABLE_NAME"
rm -f "$SWIFT_FILE"

echo "Installed $APP_NAME to $BUNDLE_DIR"
echo "LaunchAgent configured at $LAUNCH_AGENT_PATH"
