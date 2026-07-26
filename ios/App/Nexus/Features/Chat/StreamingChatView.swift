import SwiftUI
import NexusCore

/// The shared streaming chat surface: rehydrated history + a live transcript,
/// a composer with send/stop, a context meter, and the 409 takeover flow.
struct StreamingChatView: View {
    private let title: String
    @State private var vm: ChatViewModel
    @Environment(\.scenePhase) private var scenePhase

    init(api: APIClient, threadId: String, title: String) {
        self.title = title
        _vm = State(initialValue: ChatViewModel(api: api, threadId: threadId))
    }

    var body: some View {
        transcript
            .navigationTitle(title)
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
            if let usage = vm.reducer.contextUsage {
                ContextMeter(usage: usage)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message", text: $vm.input, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...5)
                    .disabled(vm.isSending)

                if vm.isSending {
                    Button { vm.abort() } label: {
                        Image(systemName: "stop.circle.fill").font(.title)
                    }
                    .tint(.red)
                } else {
                    Button { vm.send() } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.title)
                    }
                    .disabled(vm.input.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .padding(.horizontal).padding(.vertical, 8)
        }
        .background(.bar)
    }
}

// MARK: - Message bubble

struct MessageBubble: View {
    let message: RenderedMessage

    var body: some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: 40)
                Text(message.content)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Theme.accent, in: RoundedRectangle(cornerRadius: 16))
                    .foregroundStyle(.white)
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

struct MarkdownText: View {
    let text: String
    var body: some View {
        Text(attributed).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
    private var attributed: AttributedString {
        (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
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
