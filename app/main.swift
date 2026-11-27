// Glue.app: the panel in a window of its own, with a Dock badge for requests waiting on you.
// It reuses a panel server that is already running and leaves that one alone; otherwise it starts one and stops it on
// quit. Closing the window keeps the panel connected (and the badge live); quitting ends it. build.sh bakes the repo,
// node, PATH and port into Info.plist, since an app opened from the Dock gets no shell environment.
import Cocoa
import WebKit
import UserNotifications

let info = Bundle.main.infoDictionary ?? [:]
func setting(_ key: String) -> String { info[key] as? String ?? "" }
let repo = setting("ACPRepo"), nodePath = setting("ACPNode"), shellPath = setting("ACPPath")
let port = setting("ACPPort").isEmpty ? "4747" : setting("ACPPort")
let home = URL(string: "http://127.0.0.1:\(port)/")!
let logURL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/Glue/server-\(port).log")
// The background service (daemon.mjs): with it installed, it is the one server. The app waits for it, and starts it if
// launchd hasn't yet (at login that can be a minute late), instead of starting a second server that takes the port
// first and leaves the service waiting behind it.
let serviceLabel = port == "4747" ? "local.glue" : "local.glue.\(port)"
let servicePlist = NSHomeDirectory() + "/Library/LaunchAgents/\(serviceLabel).plist"
var serviceInstalled: Bool { FileManager.default.fileExists(atPath: servicePlist) }
/// How long the app waits for the service before it starts a server of its own after all.
let serviceWait: TimeInterval = 30

/// A line in the app's server log, with the time: what the app did about the server.
func logLine(_ text: String) {
  let fm = FileManager.default
  try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
  if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil) }
  guard let h = try? FileHandle(forWritingTo: logURL) else { return }
  h.seekToEndOfFile()
  h.write("--- \(Date()) \(text)\n".data(using: .utf8)!)
  try? h.close()
}

/// Start the service now, if it isn't running: `launchctl kickstart` (never -k, which would restart a running one), or
/// load it first when launchd doesn't have it loaded. Off the main queue; never waits on the page.
func startService() {
  DispatchQueue.global().async {
    func launchctl(_ args: [String]) -> Int32 {
      let p = Process()
      p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
      p.arguments = args
      p.standardOutput = FileHandle.nullDevice
      p.standardError = FileHandle.nullDevice
      do { try p.run() } catch { return -1 }
      p.waitUntilExit()
      return p.terminationStatus
    }
    let domain = "gui/\(getuid())"
    if launchctl(["kickstart", "\(domain)/\(serviceLabel)"]) != 0 {
      let loaded = launchctl(["bootstrap", domain, servicePlist])
      logLine("the background service wasn't loaded; loading it \(loaded == 0 ? "worked" : "failed (status \(loaded))")")
    }
  }
}

// The page asks for Notification, which WKWebView doesn't have. This stands in for it with the Mac's own.
func notificationShim(_ permission: String) -> String { """
(() => {
  let permission = '\(permission)';
  const shown = new Map();
  class AppNotification {
    static get permission() { return permission; }
    static async requestPermission() { permission = await webkit.messageHandlers.notifyPermission.postMessage(null); return permission; }
    constructor(title, options = {}) {
      this.title = String(title); this.body = String(options.body ?? ''); this.onclick = null;
      this.id = String(options.tag || `${Date.now()}-${Math.random()}`);
      shown.set(this.id, this);
      webkit.messageHandlers.notify.postMessage({ kind: 'show', id: this.id, title: this.title, body: this.body });
    }
    close() { shown.delete(this.id); webkit.messageHandlers.notify.postMessage({ kind: 'close', id: this.id }); }
  }
  window.Notification = AppNotification;
  window.__appNotificationClicked = (id) => { const n = shown.get(id); n?.onclick?.({ target: n }); };
})();
""" }

func permissionName(_ s: UNAuthorizationStatus) -> String {
  switch s { case .authorized, .provisional, .ephemeral: return "granted"; case .denied: return "denied"; default: return "default" }
}

final class Panel: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler,
                   WKScriptMessageHandlerWithReply, UNUserNotificationCenterDelegate {
  var window: NSWindow!
  var web: WKWebView!
  var server: Process?          // set only when this app started the server
  var serverStarted = Date.distantPast
  var waitingForServer = false
  var gen = 0                   // bumped to call off a wait in flight
  var quitting = false
  var titleWatch: NSKeyValueObservation?
  var waiting = 0
  var heartbeat: Timer?
  var onTerm: DispatchSourceSignal?
  let notes = UNUserNotificationCenter.current()

  func applicationDidFinishLaunching(_ n: Notification) {
    buildMenu()
    notes.delegate = self
    // kill / logout: quit properly, so a server this app started stops with it. Not from a main-queue block: quitting
    // waits for the server on the main queue, which can't run while one of its own blocks is still running.
    signal(SIGTERM, SIG_IGN)
    onTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    onTerm?.setEventHandler { NSApp.performSelector(onMainThread: #selector(NSApplication.terminate(_:)), with: nil, waitUntilDone: false) }
    onTerm?.resume()
    notes.getNotificationSettings { s in
      let permission = permissionName(s.authorizationStatus)
      DispatchQueue.main.async { self.makeWindow(permission); self.connect() }
    }
    heartbeat = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in self?.watch() }
  }

  func makeWindow(_ permission: String) {
    let config = WKWebViewConfiguration()
    config.preferences.isElementFullscreenEnabled = true      // Space view's full screen
    config.preferences.inactiveSchedulingPolicy = .none       // keep the live feed and the badge going while hidden
    config.userContentController.addUserScript(
      WKUserScript(source: notificationShim(permission), injectionTime: .atDocumentStart, forMainFrameOnly: true))
    // Tells the page it runs in the app, whose menu has shortcuts a browser keeps for itself (⌘T opens a tab there).
    config.userContentController.addUserScript(
      WKUserScript(source: "window.glueApp = { newAgent: '⌘T', settings: '⌘,' };", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    config.userContentController.add(self, name: "notify")
    config.userContentController.add(self, name: "theme")
    config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "notifyPermission")
    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.setValue(false, forKey: "drawsBackground")            // no white flash before the page paints
    let zoom = UserDefaults.standard.double(forKey: "zoom")
    web.pageZoom = zoom > 0 ? zoom : 1
    titleWatch = web.observe(\.title, options: [.new]) { [weak self] w, _ in self?.titled(w.title ?? "") }

    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    window = NSWindow(contentRect: screen.insetBy(dx: min(80, screen.width * 0.05), dy: min(60, screen.height * 0.05)),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "Glue"
    window.appearance = NSAppearance(named: .darkAqua)   // the page's default theme, until it says otherwise
    window.titleVisibility = .hidden    // the page shows its own; macOS 26 would put this one beside the window buttons
    // The page sits in a box rather than being the window's content view: Space view's full screen swaps it out of its
    // superview and back, and inside the box it can't come back under the title bar.
    let box = NSView(frame: window.contentLayoutRect)
    window.contentView = box
    web.frame = box.bounds
    web.autoresizingMask = [.width, .height]
    box.addSubview(web)
    window.minSize = NSSize(width: 880, height: 560)
    window.isReleasedWhenClosed = false
    window.setFrameAutosaveName("Glue")
    window.makeKeyAndOrderFront(nil)
  }

  // ---------------------------------------------------------------- the server

  /// Is the panel up on its port? Something else answering there doesn't count.
  func probe(_ done: @escaping (Bool) -> Void) {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.connectionProxyDictionary = [:]
    let req = URLRequest(url: home, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1.5)
    URLSession(configuration: cfg).dataTask(with: req) { data, resp, _ in
      // A server still on the code from before the rename answers to its old title.
      let page = String(decoding: data ?? Data(), as: UTF8.self)
      let ok = (resp as? HTTPURLResponse)?.statusCode == 200
        && (page.contains("<title>Glue</title>") || page.contains("<title>Agent panel</title>"))
      DispatchQueue.main.async { done(ok) }
    }.resume()
  }

  /// Show the panel once a server answers on its port, starting one if none does: the background service when it is
  /// installed, else a server of this app's own.
  func connect() {
    probe { up in
      if up { return self.show() }
      if self.server == nil && !serviceInstalled { return self.startServer() }
      if self.server == nil { self.status("Starting Glue's background service…") }
      self.reconnect()
    }
  }

  func show() {
    gen += 1
    waitingForServer = false
    web.load(URLRequest(url: home))
  }

  func startServer() {
    let fm = FileManager.default
    guard fm.isExecutableFile(atPath: nodePath), fm.fileExists(atPath: repo + "/server.mjs") else {
      return fail("Can't find node (\(nodePath)) or the panel (\(repo)/server.mjs). Run app/build.sh again from the repo.")
    }
    try? fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil) }
    guard let log = try? FileHandle(forWritingTo: logURL) else { return fail("Can't write the log at \(logURL.path).") }
    log.seekToEndOfFile()
    log.write("\n--- \(Date()) Glue started the server\n".data(using: .utf8)!)

    let p = Process()
    p.executableURL = URL(fileURLWithPath: nodePath)
    p.arguments = [repo + "/server.mjs"]
    p.currentDirectoryURL = URL(fileURLWithPath: repo)
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = shellPath
    env["ACP_PORT"] = port
    p.environment = env
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = log
    p.standardError = log
    p.terminationHandler = { [weak self] done in DispatchQueue.main.async { self?.serverExited(done) } }
    do { try p.run() } catch { return fail("Couldn't start the panel server: \(error.localizedDescription)") }
    server = p
    serverStarted = Date()
    status("Starting the panel server…")
    reconnect()
  }

  /// Wait for the server to answer, then show the panel. A restart takes a moment; after 8 s with no server of this
  /// app's own (the one it was reusing went away), start one. One it started that doesn't answer in 20 s is reported.
  /// With the background service installed, the app starts the service and waits for it instead; only if it hasn't
  /// answered in 30 s does the app start a server of its own, so there is still a panel.
  func reconnect() {
    gen += 1
    waitingForServer = true
    let mine = gen, since = Date(), service = server == nil && serviceInstalled
    if service { startService() }
    func step() {
      probe { up in
        guard mine == self.gen else { return }
        if up { return self.show() }
        let waited = Date().timeIntervalSince(since)
        if service && self.server == nil && waited >= serviceWait {
          logLine("the background service didn't answer in \(Int(serviceWait)) s; the app starts a server of its own")
          return self.startServer()
        }
        if !service && self.server == nil && waited >= 8 { return self.startServer() }
        if self.server != nil && waited >= 20 { return self.fail("The panel server didn't answer within 20 seconds.") }
        DispatchQueue.main.asyncAfter(deadline: .now() + (waited < 3 ? 0.3 : 1)) { if mine == self.gen { step() } }
      }
    }
    step()
  }

  /// While the panel shows, notice its server going away: the page alone would wait for it forever.
  func watch() {
    guard !quitting, !waitingForServer, let url = web?.url, isPanel(url) else { return }
    probe { up in if !up && !self.waitingForServer { self.reconnect() } }
  }

  func serverExited(_ p: Process) {
    guard p === server else { return }
    server = nil
    guard !quitting else { return }
    logLine("the server this app started stopped (exit status \(p.terminationStatus), after \(Int(Date().timeIntervalSince(serverStarted))) s)")
    if serviceInstalled { return reconnect() }   // the service takes the port: wait for it, as at the start
    if Date().timeIntervalSince(serverStarted) > 30 { return startServer() }   // it ran a while, then stopped: start it again
    let log = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
    fail(log.suffix(4000).contains("EADDRINUSE") ? "Something other than the panel is using port \(port)."
         : "The panel server stopped (exit status \(p.terminationStatus)).")
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard let p = server, p.isRunning else { return .terminateNow }
    quitting = true
    p.terminate()     // SIGTERM. Requests it was holding go back to their terminals.
    DispatchQueue.global().async {
      let until = Date().addingTimeInterval(3)
      while p.isRunning && Date() < until { usleep(50_000) }
      if p.isRunning { kill(p.processIdentifier, SIGKILL) }
      DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
    }
    return .terminateLater
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    if !hasVisibleWindows { window?.makeKeyAndOrderFront(nil) }
    return true
  }

  // ---------------------------------------------------------------- status pages

  func status(_ text: String, detail: String = "") {
    let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
    web.loadHTMLString("""
      <!doctype html><meta charset="utf-8"><title></title>
      <style>
        :root { color-scheme: light dark; --bg: #f3f4f6; --fg: #111418; --dim: #59616d; --code: #ffffff; --line: #dfe2e7; }
        @media (prefers-color-scheme: dark) { :root { --bg: #0d0f12; --fg: #e3e7ed; --dim: #8c96a4; --code: #0a0c0f; --line: #252b33; } }
        body { margin: 0; min-height: 100vh; display: grid; place-content: center; gap: 12px; padding: 32px; box-sizing: border-box;
               background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, system-ui, sans-serif; }
        p { margin: 0; max-width: 64ch; } .dim { color: var(--dim); }
        pre { margin: 0; max-width: 90vw; max-height: 50vh; overflow: auto; padding: 10px 12px; border: 1px solid var(--line);
              border-radius: 4px; background: var(--code); font: 12px/1.45 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
      </style>
      <p>\(esc(text))</p>\(detail.isEmpty ? "" : "<pre>\(esc(detail))</pre>")
      """, baseURL: nil)
  }

  func fail(_ text: String) {
    gen += 1
    waitingForServer = false
    let tail = (try? String(contentsOf: logURL, encoding: .utf8))?.split(separator: "\n", omittingEmptySubsequences: false)
      .suffix(14).joined(separator: "\n") ?? ""
    status(text + " Press ⌘R to try again. The server's log: " + logURL.path, detail: tail)
  }

  // ---------------------------------------------------------------- page ↔ app

  /// "(3) Glue" → a 3 on the Dock icon, and a bounce when a new request arrives while you're elsewhere.
  func titled(_ title: String) {
    window?.title = title.isEmpty ? "Glue" : title
    var n = 0
    if title.hasPrefix("("), let close = title.firstIndex(of: ")") { n = Int(title[title.index(after: title.startIndex)..<close]) ?? 0 }
    NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
    if n > waiting && !NSApp.isActive { NSApp.requestUserAttention(.informationalRequest) }
    waiting = n
  }

  func isPanel(_ url: URL) -> Bool { url.scheme == "http" && ["127.0.0.1", "localhost"].contains(url.host ?? "") && url.port == Int(port) }

  // Only the panel loads in here. Any other link opens in the default browser.
  func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url else { return decisionHandler(.cancel) }
    if url.scheme == "about" || isPanel(url) { return decisionHandler(.allow) }
    if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
    decisionHandler(.cancel)
  }

  func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction,
               windowFeatures: WKWindowFeatures) -> WKWebView? {
    guard let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") else { return nil }
    // A file attached to an issue: fetched here and opened in its own app (Preview for a picture or a PDF), so its
    // address, which carries the page's token, never goes to the browser.
    if isPanel(url) && url.path == "/issue-file" { openAttached(url); return nil }
    NSWorkspace.shared.open(url)
    return nil
  }

  // A page's <input type="file"> (Issues' 📎): WebKit opens no chooser of its own and asks the app; without this, a
  // click on it does nothing. The Mac's open panel, as a sheet on the window.
  func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo,
               completionHandler done: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = p.allowsDirectories
    panel.allowsMultipleSelection = p.allowsMultipleSelection
    panel.beginSheetModal(for: window) { r in done(r == .OK ? panel.urls : nil) }
  }

  /// Fetch an attached file from the panel and open it with the app the Mac picks for it, from a folder of the app's own.
  func openAttached(_ url: URL) {
    URLSession.shared.dataTask(with: url) { data, response, _ in
      guard let data, (response as? HTTPURLResponse)?.statusCode == 200 else { return }
      // Its name, as the panel gives it (Content-Disposition: …; filename*=UTF-8''<name>), else the file's id.
      let disposition = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
      let given = disposition.components(separatedBy: "filename*=UTF-8''").dropFirst().first?.removingPercentEncoding ?? ""
      let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "file" }?.value ?? "file"
      let name = (given.isEmpty ? id : given).replacingOccurrences(of: "/", with: "_")
      let dir = FileManager.default.temporaryDirectory.appendingPathComponent("glue-files/\(id)", isDirectory: true)
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let file = dir.appendingPathComponent(name)
      guard (try? data.write(to: file)) != nil else { return }
      DispatchQueue.main.async { NSWorkspace.shared.open(file) }
    }.resume()
  }

  // The server went away mid-load (a restart): wait for it, then load again.
  func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
    guard (error as NSError).code != NSURLErrorCancelled else { return }
    status("Waiting for the panel server on port \(port)…")
    reconnect()
  }

  func webViewWebContentProcessDidTerminate(_ w: WKWebView) { connect() }

  func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) {
    // The page's theme (dark unless picked otherwise): the title bar follows it rather than the Mac's appearance.
    if m.name == "theme" { window.appearance = NSAppearance(named: m.body as? String == "light" ? .aqua : .darkAqua); return }
    guard m.name == "notify", let b = m.body as? [String: Any], let id = b["id"] as? String else { return }
    if b["kind"] as? String == "close" { return notes.removeDeliveredNotifications(withIdentifiers: [id]) }
    let c = UNMutableNotificationContent()
    c.title = b["title"] as? String ?? ""
    c.body = b["body"] as? String ?? ""
    c.sound = .default
    notes.add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
  }

  func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage,
                             replyHandler: @escaping (Any?, String?) -> Void) {
    notes.requestAuthorization(options: [.alert, .sound]) { _, _ in
      self.notes.getNotificationSettings { s in
        let p = permissionName(s.authorizationStatus)
        DispatchQueue.main.async { replyHandler(p, nil) }
      }
    }
  }

  func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse,
                              withCompletionHandler done: @escaping () -> Void) {
    let id = r.notification.request.identifier
    DispatchQueue.main.async {
      NSApp.activate()
      self.window.makeKeyAndOrderFront(nil)
      self.web.callAsyncJavaScript("window.__appNotificationClicked?.(id)", arguments: ["id": id], in: nil, in: .page)
      done()
    }
  }

  func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                              withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .sound])
  }

  // ---------------------------------------------------------------- menu

  @objc func reloadPanel(_ sender: Any?) { connect() }
  @objc func newAgent(_ sender: Any?) {
    window.makeKeyAndOrderFront(nil)
    web.evaluateJavaScript("document.dispatchEvent(new CustomEvent('glue:new-agent'))")
  }
  @objc func openSettings(_ sender: Any?) {
    window.makeKeyAndOrderFront(nil)
    web.evaluateJavaScript("document.dispatchEvent(new CustomEvent('glue:settings'))")
  }
  @objc func showPanel(_ sender: Any?) { window.makeKeyAndOrderFront(nil) }
  @objc func zoomIn(_ sender: Any?) { setZoom(web.pageZoom + 0.1) }
  @objc func zoomOut(_ sender: Any?) { setZoom(web.pageZoom - 0.1) }
  @objc func actualSize(_ sender: Any?) { setZoom(1) }
  func setZoom(_ z: Double) {
    web.pageZoom = min(2, max(0.5, (z * 10).rounded() / 10))
    UserDefaults.standard.set(web.pageZoom, forKey: "zoom")
  }

  func buildMenu() {
    let bar = NSMenu()
    func menu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
      let m = NSMenu(title: title), holder = NSMenuItem()
      items.forEach(m.addItem)
      holder.submenu = m
      bar.addItem(holder)
      return m
    }
    func item(_ title: String, _ action: Selector, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      return i
    }
    _ = menu("Glue", [
      item("About Glue", #selector(NSApplication.orderFrontStandardAboutPanel(_:))), .separator(),
      item("Settings…", #selector(openSettings(_:)), ","), .separator(),
      item("Hide Glue", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Show All", #selector(NSApplication.unhideAllApplications(_:))), .separator(),
      item("Quit Glue", #selector(NSApplication.terminate(_:)), "q"),
    ])
    _ = menu("File", [item("New Agent", #selector(newAgent(_:)), "t")])
    _ = menu("Edit", [
      item("Undo", Selector(("undo:")), "z"), item("Redo", Selector(("redo:")), "z", [.command, .shift]), .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"), item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"), item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    _ = menu("View", [
      item("Reload", #selector(reloadPanel(_:)), "r"), .separator(),
      item("Actual Size", #selector(actualSize(_:)), "0"), item("Zoom In", #selector(zoomIn(_:)), "="),
      item("Zoom Out", #selector(zoomOut(_:)), "-"), .separator(),
      item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    NSApp.windowsMenu = menu("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"), item("Zoom", #selector(NSWindow.performZoom(_:))),
      .separator(), item("Glue", #selector(showPanel(_:)), "1"),
    ])
    NSApp.mainMenu = bar
  }
}

let app = NSApplication.shared
let panel = Panel()
app.delegate = panel
app.setActivationPolicy(.regular)
app.run()
