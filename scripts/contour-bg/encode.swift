import Foundation
import AVFoundation
import CoreGraphics
import CoreVideo
import ImageIO
import Darwin

func die(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("✗ " + message + "\n").utf8))
    exit(1)
}

func arg(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func run() throws {
    guard let inputDir = arg("--input"), let outputPath = arg("--output") else {
        die("用法：swift encode.swift --input <PNG目录> --output <out.mp4> [--width 1600] [--height 900] [--fps 24] [--bitrate 1600000]")
    }
    let width = Int(arg("--width") ?? "1600") ?? 1600
    let height = Int(arg("--height") ?? "900") ?? 900
    let fps = Int(arg("--fps") ?? "24") ?? 24
    let bitrate = Int(arg("--bitrate") ?? "1600000") ?? 1_600_000

    let files = try FileManager.default.contentsOfDirectory(atPath: inputDir)
        .filter { $0.hasSuffix(".png") }
        .sorted()
    guard !files.isEmpty else { die("PNG 目录是空的：\(inputDir)") }

    let output = URL(fileURLWithPath: outputPath)
    try FileManager.default.createDirectory(
        at: output.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    if FileManager.default.fileExists(atPath: outputPath) {
        try FileManager.default.removeItem(at: output)
    }

    let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
    writer.shouldOptimizeForNetworkUse = true

    let compression: [String: Any] = [
        AVVideoAverageBitRateKey: bitrate,
        AVVideoExpectedSourceFrameRateKey: fps,
        AVVideoMaxKeyFrameIntervalKey: fps * 2,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoAllowFrameReorderingKey: false,
    ]
    let settings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: compression,
    ]

    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
        assetWriterInput: input,
        sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
        ]
    )

    guard writer.canAdd(input) else { die("AVAssetWriter 不接受视频轨") }
    writer.add(input)
    guard writer.startWriting() else {
        die("startWriting 失败：\(writer.error?.localizedDescription ?? "unknown")")
    }
    writer.startSession(atSourceTime: .zero)

    func appendFrame(_ name: String, _ index: Int) throws {
        let url = URL(fileURLWithPath: inputDir).appendingPathComponent(name)
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw NSError(domain: "contour", code: 1, userInfo: [NSLocalizedDescriptionKey: "读不了 PNG：\(name)"])
        }
        while !input.isReadyForMoreMediaData {
            usleep(2_000)
        }
        guard let pool = adaptor.pixelBufferPool else {
            throw NSError(domain: "contour", code: 2, userInfo: [NSLocalizedDescriptionKey: "没有 pixelBufferPool"])
        }
        var pixelBuffer: CVPixelBuffer?
        let created = CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBuffer)
        guard created == kCVReturnSuccess, let buffer = pixelBuffer else {
            throw NSError(domain: "contour", code: 3, userInfo: [NSLocalizedDescriptionKey: "pixelBuffer 创建失败：\(created)"])
        }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(buffer),
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                | CGBitmapInfo.byteOrder32Little.rawValue
        ) else {
            throw NSError(domain: "contour", code: 4, userInfo: [NSLocalizedDescriptionKey: "CGContext 创建失败"])
        }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let time = CMTime(value: CMTimeValue(index), timescale: CMTimeScale(fps))
        if !adaptor.append(buffer, withPresentationTime: time) {
            throw NSError(domain: "contour", code: 5, userInfo: [NSLocalizedDescriptionKey: "append 失败：\(writer.error?.localizedDescription ?? "unknown")"])
        }
    }

    for (index, file) in files.enumerated() {
        try autoreleasepool {
            try appendFrame(file, index)
        }
        if index == 0 || (index + 1) % 60 == 0 || index + 1 == files.count {
            print("  encoded \(index + 1)/\(files.count)")
        }
    }

    input.markAsFinished()
    writer.endSession(atSourceTime: CMTime(value: CMTimeValue(files.count), timescale: CMTimeScale(fps)))
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    guard writer.status == .completed else {
        die("finishWriting 失败：\(writer.error?.localizedDescription ?? "unknown")")
    }

    let size = (try? FileManager.default.attributesOfItem(atPath: outputPath)[.size] as? NSNumber)?.intValue ?? 0
    let asset = AVURLAsset(url: output)
    let duration = CMTimeGetSeconds(asset.duration)
    let track = asset.tracks(withMediaType: .video).first
    let natural = track?.naturalSize ?? .zero
    let actualFps = track?.nominalFrameRate ?? 0
    print("OK \(outputPath)")
    print("  size=\(size) B · duration=\(String(format: "%.3f", duration))s · \(Int(natural.width))x\(Int(natural.height)) · fps=\(String(format: "%.1f", actualFps)) · frames=\(files.count)")
}

do {
    try run()
} catch {
    die(error.localizedDescription)
}
