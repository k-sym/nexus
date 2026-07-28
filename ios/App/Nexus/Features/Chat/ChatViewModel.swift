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

    private var pendingBusyContent: String?
    private var streamTask: Task<Void, Never>?

    var supportsModelPicker: Bool { endpoint.supportsModelPicker }
    var supportsSupervise: Bool { endpoint.supportsSupervise }

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
            historyState = .ready
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
        guard !text.isEmpty, !isSending else { return }
        input = ""
        attemptSend(content: text, confirmCancel: false)
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
        if isSending {
            reducer.finishByDisconnect()
            isSending = false
        }
    }

    func handleForeground() {
        // The backend keeps a run alive across our disconnect; rehydrate to
        // reconcile whatever happened while backgrounded.
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
