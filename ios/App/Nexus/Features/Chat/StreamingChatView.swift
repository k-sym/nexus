import SwiftUI
import PhotosUI
import NexusCore

/// The shared streaming chat surface: rehydrated history + a live transcript,
/// a composer with send/stop, a context meter, and the 409 takeover flow.
struct StreamingChatView: View {
    @State private var vm: ChatViewModel
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showAttachMenu = false
    @State private var showPhotosPicker = false
    @State private var showFileImporter = false
    @Environment(\.scenePhase) private var scenePhase

    /// Backend-agnostic entry point.
    init(endpoint: ChatEndpoint, title: String) {
        _vm = State(initialValue: ChatViewModel(endpoint: endpoint, title: title))
    }

    /// Convenience for project-thread chat.
    init(api: APIClient, threadId: String, title: String) {
        self.init(endpoint: ThreadChatEndpoint(api: api, threadId: threadId), title: title)
    }

    var body: some View {
        transcript
            .navigationTitle(vm.title)
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) { composer }
            .task {
                if case .loading = vm.historyState { await vm.loadHistory() }
            }
            .onChange(of: scenePhase) { oldPhase, newPhase in
                if newPhase == .background {
                    vm.handleBackground()
                } else if newPhase == .active, oldPhase == .background {
                    vm.handleForeground()
                }
            }
            .alert("Thread busy", isPresented: busyBinding, presenting: vm.busyInfo) { _ in
                Button("Cancel running turn & send", role: .destructive) { vm.confirmTakeover() }
                Button("Keep waiting", role: .cancel) { vm.cancelTakeover() }
            } message: { info in
                Text("\(info.activeTitle ?? "Another turn") is already running on this \(info.kind == .modelBusy ? "model" : "thread").")
            }
    }

    private var busyBinding: Binding<Bool> {
        Binding(get: { vm.busyInfo != nil }, set: { if !$0 { vm.cancelTakeover() } })
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    switch vm.historyState {
                    case .loading:
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    case .failed(let message):
                        ErrorStateView(message: message) { Task { await vm.loadHistory() } }
                    case .ready:
                        ForEach(vm.reducer.messages) { MessageBubble(message: $0) }
                        if let streaming = vm.reducer.streaming {
                            MessageBubble(message: streaming)
                        }
                        if let error = vm.reducer.errorText {
                            Label(error, systemImage: "exclamationmark.triangle.fill")
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding()
            }
            .onChange(of: vm.scrollTrigger) {
                withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: vm.historyState) {
                if case .ready = vm.historyState { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }

    // MARK: Composer

    private var composer: some View {
        @Bindable var vm = vm
        return VStack(spacing: 0) {
            if let banner = vm.errorBanner {
                Label(banner, systemImage: "wifi.exclamationmark")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal).padding(.top, 6)
            }
            // One control row: the model picker takes the free space, Supervise
            // is a compact button-toggle. Each control appears only if the
            // endpoint supports it — the assistant supports neither, so the whole
            // row collapses and the composer is just the input + send/stop.
            if vm.supportsModelPicker || vm.supportsSupervise {
                HStack(spacing: 8) {
                    if vm.supportsModelPicker { modelPicker }
                    if vm.supportsSupervise { superviseToggle }
                }
                .padding(.horizontal).padding(.top, 6)
            }
            if let usage = vm.reducer.contextUsage {
                ContextMeter(usage: usage)
            }
            if vm.isBackgroundActive {
                BackgroundRunStrip(stopping: vm.backgroundRun?.status == "cancelling")
            }
            if !vm.pendingAttachments.isEmpty {
                AttachmentTray(drafts: vm.pendingAttachments, onRemove: vm.removeAttachment)
                    .disabled(vm.isSending || vm.isBackgroundActive)
            }
            HStack(alignment: .bottom, spacing: 8) {
                // Attach photos (vision) or files (assistant only). Hidden while a
                // turn is in flight or once the 5-attachment cap is reached.
                if vm.canAddAttachment, !vm.isSending, !vm.isBackgroundActive {
                    Button { showAttachMenu = true } label: {
                        Image(systemName: "paperclip").font(.title2)
                    }
                    .tint(.secondary)
                    .accessibilityLabel("Add attachment")
                }

                TextField("Message", text: $vm.input, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(2...6)
                    .disabled(vm.isSending || vm.isBackgroundActive)

                // Hand off to a durable background run (assistant only): the turn
                // keeps running on the backend even if the app is suspended.
                if vm.supportsBackgroundHandoff, !vm.isSending, !vm.isBackgroundActive {
                    Button { vm.startBackgroundRun() } label: {
                        Image(systemName: "icloud.and.arrow.up").font(.title2)
                    }
                    .tint(.secondary)
                    .disabled(!vm.canSubmit)
                    .accessibilityLabel("Hand off to background run")
                }

                if vm.isSending {
                    Button { vm.abort() } label: {
                        Image(systemName: "stop.circle.fill").font(.title)
                    }
                    .tint(.red)
                } else if vm.isBackgroundActive {
                    Button { vm.stopBackgroundRun() } label: {
                        Image(systemName: "stop.circle.fill").font(.title)
                    }
                    .tint(.red)
                    .disabled(vm.isStartingBackgroundRun)  // no run id to stop yet
                    .accessibilityLabel("Stop background run")
                } else {
                    Button { vm.send() } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.title)
                    }
                    .disabled(!vm.canSubmit)
                }
            }
            .padding(.horizontal).padding(.vertical, 8)
        }
        .background(.bar)
        .confirmationDialog("Add attachment", isPresented: $showAttachMenu, titleVisibility: .visible) {
            Button("Photo Library") { showPhotosPicker = true }
            Button("Files") { showFileImporter = true }
            Button("Cancel", role: .cancel) {}
        }
        .photosPicker(
            isPresented: $showPhotosPicker,
            selection: $photoItems,
            maxSelectionCount: max(1, ChatViewModel.attachmentLimit - vm.pendingAttachments.count),
            matching: .images)
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: AttachmentEncoder.allowedFileTypes,
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result { loadPickedFiles(urls) }
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await loadPickedPhotos(items) }
        }
    }

    /// Encode each picked file (security-scoped) and stage it, up to the cap.
    private func loadPickedFiles(_ urls: [URL]) {
        for url in urls {
            guard vm.canAddAttachment else { break }
            if let draft = AttachmentEncoder.fileDraft(from: url) {
                vm.addAttachment(draft)
            }
        }
    }

    /// Decode each picked photo to a `UIImage`, JPEG-encode it, and stage it.
    /// Runs off the picker order; caps at the remaining slots. Clears the
    /// selection when done so re-picking the same photo fires `onChange` again.
    private func loadPickedPhotos(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard vm.canAddAttachment else { break }
            if let data = try? await item.loadTransferable(type: Data.self),
               let image = UIImage(data: data),
               let draft = AttachmentEncoder.imageDraft(from: image, index: vm.pendingAttachments.count) {
                vm.addAttachment(draft)
            }
        }
        photoItems = []
    }

    /// Compact model chip: flexes to fill the row, truncating a long model name,
    /// and opens a menu of the curated models.
    private var modelPicker: some View {
        @Bindable var vm = vm
        return Menu {
            Picker("Model", selection: $vm.selectedModelKey) {
                Text("Default").tag(String?.none)
                ForEach(vm.availableModels) { model in
                    Text(model.configured == false ? "\(model.name) (no auth)" : model.name)
                        .tag(String?.some(model.modelKey))
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "cpu")
                Text(vm.selectedModelLabel).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.caption2)
                Spacer(minLength: 0)
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
            )
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .disabled(vm.isSending)
    }

    /// Supervise as a labeled button-toggle: tinted/filled when on, so a lone
    /// icon never has to carry the meaning on its own.
    private var superviseToggle: some View {
        @Bindable var vm = vm
        return Toggle(isOn: Binding(get: { vm.supervised }, set: { vm.setSupervised($0) })) {
            Label("Supervise", systemImage: "hand.raised.fill")
                .font(.subheadline)
                .labelStyle(.titleAndIcon)
        }
        .toggleStyle(.button)
        .tint(Theme.accent)
        .fixedSize()
    }
}

// MARK: - Message bubble

struct MessageBubble: View {
    let message: RenderedMessage

    var body: some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: 40)
                VStack(alignment: .trailing, spacing: 6) {
                    // Attachments shown on the sent turn — image thumbnails or file
                    // cards (live only; a persisted reload carries none, so they
                    // clear on rehydrate).
                    ForEach(message.attachments) { attachment in
                        if attachment.isImage, let image = attachment.uiImage {
                            Image(uiImage: image)
                                .resizable().scaledToFill()
                                .frame(maxWidth: 220, maxHeight: 220)
                                .clipShape(RoundedRectangle(cornerRadius: 14))
                        } else {
                            FileAttachmentCard(name: attachment.name ?? "File", mimeType: attachment.mimeType)
                        }
                    }
                    if !message.content.isEmpty {
                        Text(message.content)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(Theme.accent, in: RoundedRectangle(cornerRadius: 16))
                            .foregroundStyle(.white)
                    }
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if !message.thinking.isEmpty {
                    ThinkingView(text: message.thinking)
                }
                ForEach(message.toolCalls) { ToolCallCard(tool: $0) }
                if !message.content.isEmpty {
                    MarkdownText(text: message.content)
                } else if message.isStreaming, message.thinking.isEmpty, message.toolCalls.isEmpty {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Working…").foregroundStyle(.secondary).font(.callout)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct ThinkingView: View {
    let text: String
    @State private var expanded = false
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(text).font(.callout).italic()
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Label("Thinking", systemImage: "brain").font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct ToolCallCard: View {
    let tool: ToolCallView
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 8) {
                    statusIcon
                    Text(tool.name).font(.subheadline.weight(.medium))
                    if let summary = argSummary {
                        Text(summary).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if !tool.result.isEmpty {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(.plain)

            if expanded, !tool.result.isEmpty {
                Text(tool.result)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(10)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder private var statusIcon: some View {
        switch tool.status {
        case .running: ProgressView().controlSize(.mini)
        case .completed: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .error: Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
        case .interrupted: Image(systemName: "minus.circle.fill").foregroundStyle(.secondary)
        }
    }

    private var argSummary: String? {
        guard case .object(let object) = tool.args else { return nil }
        for key in ["file_path", "path", "command", "pattern", "query", "url", "prompt"] {
            if let value = object[key]?.string { return value }
        }
        return object.values.compactMap { $0.string }.first
    }
}

/// Decode a base64 image attachment for display.
extension RenderedAttachment {
    var uiImage: UIImage? { Data(base64Encoded: base64).flatMap(UIImage.init(data:)) }
}

/// Horizontal strip of staged attachment thumbnails in the composer, each with a
/// remove affordance.
struct AttachmentTray: View {
    let drafts: [AttachmentDraft]
    let onRemove: (UUID) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(drafts) { draft in
                    Group {
                        if let image = draft.image {
                            Image(uiImage: image)
                                .resizable().scaledToFill()
                                .frame(width: 56, height: 56)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        } else {
                            FileAttachmentCard(
                                name: draft.attachment.name ?? "File", mimeType: draft.attachment.mimeType)
                                .frame(maxWidth: 180)
                        }
                    }
                    .overlay(alignment: .topTrailing) {
                        Button { onRemove(draft.id) } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.body)
                                .foregroundStyle(.white, .black.opacity(0.55))
                        }
                        .padding(2)
                        .accessibilityLabel("Remove attachment")
                    }
                }
            }
            .padding(.horizontal).padding(.top, 8)
        }
    }
}

/// Thin caption shown while a handed-off run executes server-side. There's no
/// live token stream for a background run, so this reassures the user work is
/// underway between 5s sync reloads.
struct BackgroundRunStrip: View {
    let stopping: Bool
    var body: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.mini)
            Text(stopping ? "Stopping…" : "Working in the background…")
            Spacer()
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .padding(.horizontal).padding(.top, 4)
    }
}

struct ContextMeter: View {
    let usage: ContextUsage
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "gauge.with.dots.needle.33percent")
            if let tokens = usage.tokens {
                Text("\(format(tokens)) / \(format(usage.contextWindow)) tokens")
            }
            if let percent = usage.percent {
                let pct = percent <= 1 ? percent * 100 : percent
                Text("· \(Int(pct))%")
            }
            Spacer()
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .padding(.horizontal).padding(.top, 4)
    }

    private func format(_ n: Int) -> String {
        n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)"
    }
}
