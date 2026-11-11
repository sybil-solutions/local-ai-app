// The model that runs on the phone itself: where it comes from, whether this phone can run it, and its file on disk.
import CryptoKit
import Foundation
import Observation

enum OnDeviceModel {
    static let name = "LFM3-1.7B"
    static let file = "LFM3-1.7B-Q4_K_M.gguf"
    /// Liquid AI's own GGUF build, pinned to one commit of the repository so the file can never change under the app.
    static let url = URL(string: "https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF/resolve/cd0c74c575b5c416f3011b5b4c298077f26ca8c2/LFM3-1.7B-Q4_K_M.gguf")!
    static let bytes: Int64 = 1_099_627_808
    static let sha256 = "3793e1e6e2266919d6e015287221b41100175a98eddaba92e111aed3b05c93c4"
    static let page = URL(string: "https://huggingface.co/LiquidAI/LFM3-1.7B")!

    /// The model takes about 2 GB while it runs, beside everything else the phone is doing. iPhones with 8 GB of
    /// memory report a little less than 8 GB, so the line is drawn at 7.
    static var fits: Bool { ProcessInfo.processInfo.physicalMemory >= 7_000_000_000 }
    /// False in the Simulator, where there is no llama.cpp to run it with.
    static var canRun: Bool {
        #if canImport(llama)
        true
        #else
        false
        #endif
    }
    static var folder: URL { URL.applicationSupportDirectory.appending(path: "Models", directoryHint: .isDirectory) }
    static var place: URL { folder.appending(path: file) }
}

/// The model's file: downloading it, checking it, deleting it. A download that is interrupted continues from where
/// it stopped. The file is only ever used after its SHA-256 has matched.
@MainActor @Observable
final class ModelFile: NSObject, URLSessionDownloadDelegate {
    enum State: Equatable { case missing, downloading(Double), checking, ready, failed(String) }
    private(set) var state: State = FileManager.default.fileExists(atPath: OnDeviceModel.place.path) ? .ready : .missing

    @ObservationIgnored private var task: URLSessionDownloadTask?
    @ObservationIgnored private var resume: Data?
    @ObservationIgnored private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)

    func download() {
        guard task == nil else { return }
        state = .downloading(0)
        task = resume.map { session.downloadTask(withResumeData: $0) } ?? session.downloadTask(with: OnDeviceModel.url)
        resume = nil
        task?.resume()
    }

    func cancel() {
        task?.cancel { data in Task { @MainActor in self.resume = data } }
        task = nil
        state = .missing
    }

    func delete() {
        try? FileManager.default.removeItem(at: OnDeviceModel.place)
        resume = nil
        state = .missing
    }

    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        let whole = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : OnDeviceModel.bytes
        Task { @MainActor in if case .downloading = self.state { self.state = .downloading(Double(totalBytesWritten) / Double(whole)) } }
    }

    // The downloaded file is only here until this returns, so it is checked and moved before it does.
    nonisolated func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let answered = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        Task { @MainActor in self.state = .checking }
        let outcome: State
        if !(200 ..< 300).contains(answered) {
            outcome = .failed("Hugging Face answered \(answered)")
        } else if Self.sha256(of: location) != OnDeviceModel.sha256 {
            outcome = .failed("The download did not match its checksum, so it was not kept")
        } else {
            do {
                try FileManager.default.createDirectory(at: OnDeviceModel.folder, withIntermediateDirectories: true)
                try? FileManager.default.removeItem(at: OnDeviceModel.place)
                try FileManager.default.moveItem(at: location, to: OnDeviceModel.place)
                var place = OnDeviceModel.place, values = URLResourceValues()
                values.isExcludedFromBackup = true // it can be downloaded again; it does not belong in a backup
                try? place.setResourceValues(values)
                outcome = .ready
            } catch { outcome = .failed(error.localizedDescription) }
        }
        Task { @MainActor in self.task = nil; self.state = outcome }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error = error as NSError?, error.code != NSURLErrorCancelled else { return }
        let kept = error.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
        Task { @MainActor in
            self.resume = kept
            self.task = nil
            self.state = .failed(error.localizedDescription)
        }
    }

    private nonisolated static func sha256(of file: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? handle.close() }
        var hash = SHA256()
        while let chunk = try? handle.read(upToCount: 4 << 20), !chunk.isEmpty { hash.update(data: chunk) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
