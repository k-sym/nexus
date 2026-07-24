import SwiftUI
import NexusCore

/// Drives one thread's chat: rehydrates history, streams turns into a
/// `TranscriptReducer`, and handles the 409 busy → `X-Confirm-Cancel` retry and
/// background/foreground reconciliation. Thread-scoped; the Assistant surface
/// will reuse this shape via a `ChatEndpoint` abstraction in a follow-up.
@MainActor
@Observable
final class ChatViewModel {
    enum HistoryState: Equatable {
        case loading, ready
        case failed(String)
    }

    private let api: APIClient
    let threadId: String

    private(set) var reducer = TranscriptReducer()
    private(set) var historyState: HistoryState = .loading
    private(set) var isSending = false

    var input: String = ""
    /// Non-nil drives the "cancel the running turn?" confirmation.
    var busyInfo: BusyInfo?
    var errorBanner: String?

    private var pendingBusyContent: String?
    private var streamTask: Task<Void, Never>?

    init(api: APIClient, threadId: String) {
        self.api = api
        self.threadId = threadId
    }

    /// A cheap value that changes whenever the transcript grows, for auto-scroll.
    var scrollTrigger: String {
        "\(reducer.messages.count)-\(reducer.streaming?.content.count ?? 0)-\(reducer.streaming?.thinking.count ?? 0)-\(reducer.streaming?.toolCalls.count ?? 0)-\(reducer.streaming?.toolCalls.last?.result.count ?? 0)"
    }

    func loadHistory() async {
        do {
            let detail = try await api.threadDetail(threadId: threadId)
            reducer.loadPersisted(detail.messages)
            historyState = .ready
            maybeAutosend()
        } catch {
            historyState = .failed((error as? APIError)?.errorDescription ?? error.localizedDescription)
        }
    }

    func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        input = ""
        attemptSend(content: text, confirmCancel: false)
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
        Task { try? await api.abortThread(threadId: threadId) }
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
            let stream = try await api.streamThreadMessage(
                threadId: threadId, content: content, confirmCancel: confirmCancel)
            for try await line in stream {
                reducer.apply(line)
                if reducer.pendingTitle != nil { reducer.pendingTitle = nil }
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
