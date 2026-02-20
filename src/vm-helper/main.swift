import Foundation
import Virtualization
import Compression

// MARK: - Constants

let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
let vmBaseDir = "\(homeDir)/.agent-swarm/vms"

// MARK: - VM Config (JSON per VM)

struct VMConfig: Codable {
    var cpus: Int
    var memoryMB: Int
    var macAddress: String
}

func readConfig(vmDir: String) throws -> VMConfig {
    let data = try Data(contentsOf: URL(fileURLWithPath: "\(vmDir)/config.json"))
    return try JSONDecoder().decode(VMConfig.self, from: data)
}

// MARK: - DHCP Lease IP Resolution

func normalizeMac(_ mac: String) -> String {
    // Normalize MAC by lowering and stripping leading zeros from each octet
    // so "46:51:4C:A9:60:02" and "46:51:4c:a9:60:2" both become "46:51:4c:a9:60:2"
    return mac.lowercased().split(separator: ":").map { octet in
        String(octet.drop(while: { $0 == "0" })) == "" ? "0" : String(octet.drop(while: { $0 == "0" }))
    }.joined(separator: ":")
}

func resolveIP(macAddress: String) -> String? {
    // Use ARP table to resolve MAC → IP (works with Virtualization.framework NAT)
    let target = normalizeMac(macAddress)
    let pipe = Pipe()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/arp")
    process.arguments = ["-an"]
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do { try process.run() } catch { return nil }
    process.waitUntilExit()

    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    guard let output = String(data: data, encoding: .utf8) else { return nil }

    for line in output.components(separatedBy: "\n") {
        // Extract MAC from ARP line and normalize for comparison
        let parts = line.components(separatedBy: " ")
        if parts.count >= 4, parts[2] == "at" {
            let arpMac = normalizeMac(parts[3])
            if arpMac == target {
                if let start = line.range(of: "("), let end = line.range(of: ")") {
                    return String(line[start.upperBound..<end.lowerBound])
                }
            }
        }
    }
    return nil
}

// MARK: - VM Configuration Builder

func buildVMConfiguration(vmDir: String, config: VMConfig) throws -> VZVirtualMachineConfiguration {
    let vmConfig = VZVirtualMachineConfiguration()

    vmConfig.cpuCount = config.cpus
    vmConfig.memorySize = UInt64(config.memoryMB) * 1024 * 1024

    // EFI Boot Loader
    let efiVarsPath = "\(vmDir)/efi_vars.bin"
    let efiVarsURL = URL(fileURLWithPath: efiVarsPath)
    let bootLoader = VZEFIBootLoader()
    if FileManager.default.fileExists(atPath: efiVarsPath) {
        bootLoader.variableStore = VZEFIVariableStore(url: efiVarsURL)
    } else {
        bootLoader.variableStore = try VZEFIVariableStore(creatingVariableStoreAt: efiVarsURL)
    }
    vmConfig.bootLoader = bootLoader

    // Storage devices
    var storage: [VZStorageDeviceConfiguration] = []

    let diskPath = "\(vmDir)/disk.img"
    let diskAttachment = try VZDiskImageStorageDeviceAttachment(
        url: URL(fileURLWithPath: diskPath), readOnly: false
    )
    storage.append(VZVirtioBlockDeviceConfiguration(attachment: diskAttachment))

    // Cloud-init ISO (if exists)
    let ciPath = "\(vmDir)/cidata.iso"
    if FileManager.default.fileExists(atPath: ciPath) {
        let ciAttachment = try VZDiskImageStorageDeviceAttachment(
            url: URL(fileURLWithPath: ciPath), readOnly: true
        )
        storage.append(VZVirtioBlockDeviceConfiguration(attachment: ciAttachment))
    }
    vmConfig.storageDevices = storage

    // Network (NAT - built into macOS)
    let net = VZVirtioNetworkDeviceConfiguration()
    net.attachment = VZNATNetworkDeviceAttachment()
    if let mac = VZMACAddress(string: config.macAddress) {
        net.macAddress = mac
    }
    vmConfig.networkDevices = [net]

    // Entropy (for /dev/random in guest - needed for SSH key generation)
    vmConfig.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]

    // Memory balloon
    vmConfig.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]

    // Serial console -> log file
    let logPath = "\(vmDir)/console.log"
    FileManager.default.createFile(atPath: logPath, contents: nil)
    let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
    let logHandle = try FileHandle(forWritingTo: URL(fileURLWithPath: logPath))
    let nullRead = FileHandle(forReadingAtPath: "/dev/null")!
    serial.attachment = VZFileHandleSerialPortAttachment(
        fileHandleForReading: nullRead,
        fileHandleForWriting: logHandle
    )
    vmConfig.serialPorts = [serial]

    try vmConfig.validate()
    return vmConfig
}

// MARK: - VM Delegate

class VMDelegate: NSObject, VZVirtualMachineDelegate {
    func virtualMachine(_ vm: VZVirtualMachine, didStopWithError error: Error) {
        fputs("VM stopped with error: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
    func guestDidStop(_ vm: VZVirtualMachine) {
        fputs("Guest shut down\n", stderr)
        exit(0)
    }
}

// MARK: - Commands

func cmdRun(name: String) throws {
    let vmDir = "\(vmBaseDir)/\(name)"
    guard FileManager.default.fileExists(atPath: vmDir) else {
        fputs("VM not found: \(name)\n", stderr)
        exit(1)
    }

    let config = try readConfig(vmDir: vmDir)
    let vmConfig = try buildVMConfiguration(vmDir: vmDir, config: config)

    let vm = VZVirtualMachine(configuration: vmConfig)
    let delegate = VMDelegate()
    vm.delegate = delegate

    // Write PID file
    let pid = ProcessInfo.processInfo.processIdentifier
    try "\(pid)".write(toFile: "\(vmDir)/pid", atomically: true, encoding: .utf8)

    // Ignore SIGHUP so VM survives terminal close
    signal(SIGHUP, SIG_IGN)

    // Handle SIGTERM for graceful shutdown
    let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    sigtermSource.setEventHandler {
        if vm.canRequestStop {
            do { try vm.requestStop() } catch { vm.stop { _ in exit(0) } }
        } else {
            vm.stop { _ in exit(0) }
        }
    }
    sigtermSource.resume()
    signal(SIGTERM, SIG_IGN)

    // Handle SIGINT similarly
    let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    sigintSource.setEventHandler {
        if vm.canRequestStop {
            do { try vm.requestStop() } catch { vm.stop { _ in exit(0) } }
        } else {
            vm.stop { _ in exit(0) }
        }
    }
    sigintSource.resume()
    signal(SIGINT, SIG_IGN)

    // Start VM
    vm.start { result in
        switch result {
        case .success:
            fputs("VM \(name) started (PID \(pid))\n", stderr)
        case .failure(let error):
            fputs("Failed to start VM: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }

    // Keep the delegate alive
    _ = delegate
    RunLoop.main.run()
}

func cmdStop(name: String) {
    let pidPath = "\(vmBaseDir)/\(name)/pid"
    guard let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8),
          let pid = Int32(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)) else {
        fputs("No PID file for \(name)\n", stderr)
        exit(1)
    }

    guard kill(pid, 0) == 0 else {
        fputs("VM process \(pid) not running\n", stderr)
        try? FileManager.default.removeItem(atPath: pidPath)
        return
    }

    kill(pid, SIGTERM)

    // Wait up to 10s for graceful shutdown
    for _ in 0..<20 {
        if kill(pid, 0) != 0 {
            try? FileManager.default.removeItem(atPath: pidPath)
            fputs("VM \(name) stopped\n", stderr)
            return
        }
        Thread.sleep(forTimeInterval: 0.5)
    }

    kill(pid, SIGKILL)
    try? FileManager.default.removeItem(atPath: pidPath)
    fputs("VM \(name) force-stopped\n", stderr)
}

func cmdIP(name: String) {
    let vmDir = "\(vmBaseDir)/\(name)"
    guard let config = try? readConfig(vmDir: vmDir) else {
        fputs("VM not found: \(name)\n", stderr)
        exit(1)
    }

    if let ip = resolveIP(macAddress: config.macAddress) {
        print(ip)
    } else {
        exit(1)
    }
}

func cmdList() {
    let fm = FileManager.default
    guard let entries = try? fm.contentsOfDirectory(atPath: vmBaseDir) else {
        print("[]")
        return
    }

    var results: [[String: Any]] = []
    for name in entries.sorted() {
        let vmDir = "\(vmBaseDir)/\(name)"
        let configPath = "\(vmDir)/config.json"
        guard fm.fileExists(atPath: configPath),
              let config = try? readConfig(vmDir: vmDir) else { continue }

        var isRunning = false
        if let pidStr = try? String(contentsOfFile: "\(vmDir)/pid", encoding: .utf8),
           let pid = Int32(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)) {
            isRunning = kill(pid, 0) == 0
        }

        let ip: Any = isRunning ? (resolveIP(macAddress: config.macAddress) as Any? ?? NSNull()) : NSNull()

        results.append([
            "name": name,
            "status": isRunning ? "running" : "stopped",
            "ip": ip,
            "macAddress": config.macAddress,
            "cpus": config.cpus,
            "memoryMB": config.memoryMB,
        ])
    }

    if let data = try? JSONSerialization.data(withJSONObject: results, options: .prettyPrinted),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    }
}

// MARK: - Qcow2 to Raw Converter

func cmdConvertQcow2(input: String, output: String) throws {
    let fh = try FileHandle(forReadingFrom: URL(fileURLWithPath: input))
    defer { fh.closeFile() }

    let headerData = fh.readData(ofLength: 104)
    guard headerData.count >= 72 else {
        fputs("File too small to be qcow2\n", stderr); exit(1)
    }

    let magic: UInt32 = headerData.withUnsafeBytes { $0.load(fromByteOffset: 0, as: UInt32.self).bigEndian }
    guard magic == 0x514649fb else {
        fputs("Not a qcow2 file (bad magic)\n", stderr); exit(1)
    }

    let version: UInt32 = headerData.withUnsafeBytes { $0.load(fromByteOffset: 4, as: UInt32.self).bigEndian }
    guard version == 2 || version == 3 else {
        fputs("Unsupported qcow2 version: \(version)\n", stderr); exit(1)
    }

    let clusterBits: UInt32 = headerData.withUnsafeBytes { $0.load(fromByteOffset: 20, as: UInt32.self).bigEndian }
    let virtualSize: UInt64 = headerData.withUnsafeBytes { $0.load(fromByteOffset: 24, as: UInt64.self).bigEndian }
    let l1Size: UInt32 = headerData.withUnsafeBytes { $0.load(fromByteOffset: 36, as: UInt32.self).bigEndian }
    let l1TableOffset: UInt64 = headerData.withUnsafeBytes { $0.load(fromByteOffset: 40, as: UInt64.self).bigEndian }

    let clusterSize = UInt64(1) << UInt64(clusterBits)
    let l2Entries = Int(clusterSize / 8)

    fputs("qcow2 v\(version): \(virtualSize / 1024 / 1024)MB virtual, cluster=\(clusterSize / 1024)KB, L1=\(l1Size) entries\n", stderr)

    // Create sparse output file
    FileManager.default.createFile(atPath: output, contents: nil)
    let outFh = try FileHandle(forWritingTo: URL(fileURLWithPath: output))
    defer { outFh.closeFile() }
    outFh.truncateFile(atOffset: virtualSize)

    // Read L1 table
    fh.seek(toFileOffset: l1TableOffset)
    let l1Data = fh.readData(ofLength: Int(l1Size) * 8)

    var clustersWritten = 0

    for l1Idx in 0..<Int(l1Size) {
        let l2Offset: UInt64 = l1Data.withUnsafeBytes {
            $0.load(fromByteOffset: l1Idx * 8, as: UInt64.self).bigEndian
        } & 0x00fffffffffffe00

        if l2Offset == 0 { continue }

        fh.seek(toFileOffset: l2Offset)
        let l2Data = fh.readData(ofLength: l2Entries * 8)

        for l2Idx in 0..<l2Entries {
            let rawEntry: UInt64 = l2Data.withUnsafeBytes {
                $0.load(fromByteOffset: l2Idx * 8, as: UInt64.self).bigEndian
            }

            let isCompressed = (rawEntry >> 62) & 1 == 1
            let outputOffset = (UInt64(l1Idx) * UInt64(l2Entries) + UInt64(l2Idx)) * clusterSize
            guard outputOffset < virtualSize else { continue }

            if isCompressed {
                // qcow2 compressed cluster (matches QEMU's parsing):
                // csize_shift = 62 - (cluster_bits - 8)
                // coffset = entry & ((1 << csize_shift) - 1)
                // nb_csectors = ((entry >> csize_shift) & csize_mask) + 1
                let nbCSectorBits = UInt64(clusterBits) - 8
                let csizeShift = 62 - nbCSectorBits
                let csizeMask = (UInt64(1) << nbCSectorBits) - 1
                let offsetMask = (UInt64(1) << csizeShift) - 1

                let compOffset = rawEntry & offsetMask
                let compSectors = ((rawEntry >> csizeShift) & csizeMask) + 1
                let compSize = compSectors * 512

                if compOffset == 0 { continue }
                fh.seek(toFileOffset: compOffset)
                let compData = fh.readData(ofLength: Int(compSize))

                // qcow2 uses raw deflate — Apple's COMPRESSION_ZLIB handles this directly
                let decompressed = compData.withUnsafeBytes { (src: UnsafeRawBufferPointer) -> Data? in
                    guard let srcBase = src.bindMemory(to: UInt8.self).baseAddress else { return nil }
                    let dstSize = Int(clusterSize)
                    let dst = UnsafeMutablePointer<UInt8>.allocate(capacity: dstSize)
                    defer { dst.deallocate() }
                    let result = compression_decode_buffer(
                        dst, dstSize,
                        srcBase, compData.count,
                        nil, COMPRESSION_ZLIB
                    )
                    guard result > 0 else { return nil }
                    return Data(bytes: dst, count: result)
                }

                if let data = decompressed {
                    outFh.seek(toFileOffset: outputOffset)
                    outFh.write(data)
                    clustersWritten += 1
                }
            } else {
                let clusterOffset = rawEntry & 0x00fffffffffffe00
                if clusterOffset == 0 { continue }

                fh.seek(toFileOffset: clusterOffset)
                let data = fh.readData(ofLength: Int(clusterSize))

                outFh.seek(toFileOffset: outputOffset)
                outFh.write(data)
                clustersWritten += 1
            }
        }

        let pct = Int(Double(l1Idx + 1) / Double(l1Size) * 100)
        fputs("\r  Converting: \(pct)%", stderr)
    }

    fputs("\n  Done: \(clustersWritten) clusters written to raw image\n", stderr)
}

// MARK: - Main

let args = CommandLine.arguments

guard args.count >= 2 else {
    fputs("""
    vm-helper - macOS native VM manager (Virtualization.framework)

    Commands:
      run <name>                    Start VM (foreground, writes PID file)
      stop <name>                   Stop VM (sends SIGTERM to run process)
      ip <name>                     Print VM IP (from DHCP leases)
      list                          List VMs as JSON
      convert-qcow2 <in> <out>     Convert qcow2 disk image to raw

    """, stderr)
    exit(1)
}

let command = args[1]

do {
    switch command {
    case "run":
        guard args.count >= 3 else { fputs("Usage: vm-helper run <name>\n", stderr); exit(1) }
        try cmdRun(name: args[2])
    case "stop":
        guard args.count >= 3 else { fputs("Usage: vm-helper stop <name>\n", stderr); exit(1) }
        cmdStop(name: args[2])
    case "ip":
        guard args.count >= 3 else { fputs("Usage: vm-helper ip <name>\n", stderr); exit(1) }
        cmdIP(name: args[2])
    case "list":
        cmdList()
    case "convert-qcow2":
        guard args.count >= 4 else { fputs("Usage: vm-helper convert-qcow2 <input> <output>\n", stderr); exit(1) }
        try cmdConvertQcow2(input: args[2], output: args[3])
    default:
        fputs("Unknown command: \(command)\n", stderr)
        exit(1)
    }
} catch {
    fputs("Error: \(error.localizedDescription)\n", stderr)
    exit(1)
}
