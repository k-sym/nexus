import SwiftUI
import NexusCore

/// Drives one chat's lifecycle: rehydrates history, streams turns into a
/// `TranscriptReducer`, and handles the 409 busy → `X-Confirm-Cancel` retry and
/// background/foreground reconciliation.
///
/// Backend-agnostic: it depends on a `ChatEndpoint`, so the same view model
/// serves both project threads (`ThreadChatEndpoint`) and assistant sessions
/// (`AssistantChatEndpoint`). Capability flags let the composer hide the model
/// picker / Supervise toggle where an endpoint doesn't support them; the busy
/// takeover branch simply never fires on endpoints that don't gate turns.
@MainActor
@Observable
final class ChatViewModel {
    enum HistoryState: Equatable {
        case loading, ready
        case failed(String)
    }

    private let endpoint: ChatEndpoint

    /// Live title: seeded at construction, refreshed from `loadDetail`, and
    /// updated when the stream carries a `thread_title`/`session_title` (the
    /// backend names an untitled session from its opening prompt).
    private(set) var title: String

    private(set) var reducer = TranscriptReducer()
    private(set) var historyState: HistoryState = .loading
    private(set) var isSending = false
    /// Per-thread Supervise: when on, every gateable tool call parks for approval.
    private(set) var supervised = false
    /// Curated models for the picker; `selectedModelKey` is `provider/id`
    /// (nil ⇒ backend default).
    private(set) var availableModels: [Model] = []
    var selectedModelKey: String?

    var input: String = ""
    /// Non-nil drives the "cancel the running turn?" confirmation.
    var busyInfo: BusyInfo?
    var errorBanner: String?

    /// The session's latest background run (assistant only). Seeded from
    /// `loadDetail`, set by `startBackgroundRun`, and refreshed by the sync loop.
    /// A background turn runs server-side and outlives the app, so its progress is
    /// polled rather than streamed.
    private(set) var backgroundRun: AssistantRun?
    /// True while the handoff POST is in flight (before a run id exists).
    private(set) var isStartingBackgroundRun = false

    private var pendingBusyContent: String?
    private var streamTask: Task<Void, Never>?
    private var syncTask: Task<Void, Never>?

    var supportsModelPicker: Bool { endpoint.supportsModelPicker }
    var supportsSupervise: Bool { endpoint.supportsSupervise }
    var supportsBackgroundHandoff: Bool { endpoint.supportsBackgroundHandoff }

    /// Whether a handed-off run is currently executing on the server.
    var isBackgroundRunning: Bool { backgroundRun?.isRunning ?? false }
    /// Any background activity — the in-flight handoff POST or a running run.
    var isBackgroundActive: Bool { isBackgroundRunning || isStartingBackgroundRun }

    init(endpoint: ChatEndpoint, title: String) {
        self.endpoint = endpoint
        self.title = title
    }

    /// A cheap value that changes whenever the transcript grows, for auto-scroll.
    var scrollTrigger: String {
        "\(reducer.messages.count)-\(reducer.streaming?.content.count ?? 0)-\(reducer.streaming?.thinking.count ?? 0)-\(reducer.streaming?.toolCalls.count ?? 0)-\(reducer.streaming?.toolCalls.last?.result.count ?? 0)"
    }

    /// Display name for the selected model, or "Default".
    var selectedModelLabel: String {
        guard let key = selectedModelKey else { return "Default" }
        return availableModels.first { $0.modelKey == key }?.name ?? key
    }

    func loadHistory() async {
        do {
            let detail = try await endpoint.loadDetail()
            reducer.loadPersisted(detail.messages)
            supervised = detail.supervised ?? false
            if let loadedTitle = detail.title, !loadedTitle.isEmpty { title = loadedTitle }
            if selectedModelKey == nil { selectedModelKey = detail.lastModelKey }
            backgroundRun = detail.latestRun
            historyState = .ready
            // Reopening a session with a handoff still in flight resumes polling.
            if isBackgroundRunning { startSyncLoop() }
            maybeAutosend()
        } catch {
            historyState = .failed((error as? APIError)?.errorDescription ?? error.localizedDescription)
        }
        // Model list for the picker — best-effort, only where the endpoint has one.
        if supportsModelPicker, availableModels.isEmpty {
            availableModels = (try? await endpoint.models()) ?? []
        }
    }

    func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending, !isBackgroundActive else { return }
        input = ""
        attemptSend(content: text, confirmCancel: false)
    }

    // MARK: Background handoff (assistant only)

    /// Hand the current input off to a durable server-side run instead of
    /// streaming it. The run keeps executing on the backend even if the app is
    /// suspended; `startSyncLoop` polls its progress every 5s.
    func startBackgroundRun() {
        guard supportsBackgroundHandoff else { return }
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending, !isBackgroundActive else { return }
        errorBanner = nil
        isStartingBackgroundRun = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.isStartingBackgroundRun = false }
            do {
                let run = try await self.endpoint.startBackgroundRun(content: text)
                // Clear + show the user's turn only once the handoff is accepted;
                // a later sync reload replaces this row with the server's copy.
                self.input = ""
                self.reducer.appendUserMessage(text)
                self.backgroundRun = run
                self.startSyncLoop()
            } catch {
                self.errorBanner = (error as? APIError)?.errorDescription ?? "Couldn't hand off the run."
            }
        }
    }

    /// Ask the active background run to stop; keeps polling until it settles.
    func stopBackgroundRun() {
        guard let run = backgroundRun, run.isRunning else { return }
        backgroundRun = AssistantRun(id: run.id, status: "cancelling")  // optimistic
        Task { [weak self, endpoint] in
            do { try await endpoint.stopBackgroundRun(runId: run.id) }
            catch { self?.errorBanner = (error as? APIError)?.errorDescription ?? "Couldn't stop the run." }
        }
        startSyncLoop()  // poll until the backend reports a terminal status
    }

    /// Poll `sync` + reload every 5s while a background run is in flight, then
    /// stop. Reloading pulls the freshened Hermes transcript, so incremental
    /// progress (new assistant text, tool cards) appears as the run advances.
    private func startSyncLoop() {
        syncTask?.cancel()
        syncTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                if Task.isCancelled { break }
                guard let self else { break }
                let stillRunning = await self.syncTick()
                if !stillRunning { break }
            }
        }
    }

    /// One reconcile step. Returns whether the run is still in flight. Skips the
    /// transcript reload while a foreground stream is active so it never clobbers
    /// live tokens (the two paths are mutually exclusive in the UI anyway).
    @discardableResult
    private func syncTick() async -> Bool {
        guard !isSending else { return isBackgroundRunning }
        do {
            try await endpoint.syncBackgroundRuns()
            let detail = try await endpoint.loadDetail()
            reducer.loadPersisted(detail.messages)
            if let loadedTitle = detail.title, !loadedTitle.isEmpty { title = loadedTitle }
            backgroundRun = detail.latestRun
        } catch {
            // Transient failure — keep the loop alive; a later tick reconciles.
        }
        return isBackgroundRunning
    }

    /// Toggle Supervise for this chat. Optimistic; rolls back on failure. A no-op
    /// on endpoints without Supervise (the toggle isn't shown there anyway).
    func setSupervised(_ on: Bool) {
        guard supportsSupervise else { return }
        let previous = supervised
        supervised = on
        Task { [weak self] in
            guard let self else { return }
            do {
                supervised = try await endpoint.setSupervised(on)
            } catch {
                supervised = previous
                errorBanner = "Couldn't update Supervise."
            }
        }
    }

    func confirmTakeover() {
        guard let content = pendingBusyContent else { return }
        busyInfo = nil
        pendingBusyContent = nil
        attemptSend(content: content, confirmCancel: true)
    }

    func cancelTakeover() {
        busyInfo = nil
        pendingBusyContent = nil
    }

    func abort() {
        streamTask?.cancel()
        reducer.abort()
        isSending = false
        Task { [endpoint] in try? await endpoint.abort() }
    }

    // MARK: Scene phase

    func handleBackground() {
        streamTask?.cancel()
        syncTask?.cancel()  // iOS suspends timers anyway; loadHistory resumes it
        if isSending {
            reducer.finishByDisconnect()
            isSending = false
        }
    }

    func handleForeground() {
        // The backend keeps a run alive across our disconnect; rehydrate to
        // reconcile whatever happened while backgrounded. `loadHistory` re-seeds
        // `backgroundRun` and restarts the sync loop if a handoff is still running.
        Task { await loadHistory() }
    }

    // MARK: Internals

    private func attemptSend(content: String, confirmCancel: Bool) {
        let rollback = reducer
        reducer.startTurn(prompt: content)
        isSending = true
        errorBanner = nil
        streamTask = Task { [weak self] in
            await self?.runStream(content: content, confirmCancel: confirmCancel, rollback: rollback)
        }
    }

    private func runStream(content: String, confirmCancel: Bool, rollback: TranscriptReducer) async {
        do {
            let stream = try await endpoint.stream(
                content: content, modelKey: selectedModelKey, confirmCancel: confirmCancel)
            for try await line in stream {
                reducer.apply(line)
                if let newTitle = reducer.pendingTitle {
                    if !newTitle.isEmpty { title = newTitle }
                    reducer.pendingTitle = nil
                }
            }
            // Stream ended: finalize if no terminal event arrived (transport drop).
            reducer.finishByDisconnect()
        } catch let error as APIError {
            switch error {
            case .busy(let info):
                reducer = rollback // undo the optimistic turn; offer takeover
                pendingBusyContent = content
                busyInfo = info
            case .unauthorized:
                reducer = rollback
                errorBanner = error.errorDescription
            default:
                reducer.fail(error.errorDescription ?? "Stream error")
            }
        } catch is CancellationError {
            // Aborted/backgrounded — state already handled by the caller.
        } catch {
            reducer.fail(error.localizedDescription)
        }
        isSending = false
    }

    private func maybeAutosend() {
        #if DEBUG
        if input.isEmpty, let text = ProcessInfo.processInfo.environment["NEXUS_DEV_AUTOSEND"], !text.isEmpty {
            input = text
            send()
        }
        #endif
    }
}
