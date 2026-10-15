// Runs the policy module through Lattice's own host: the validation genesis
// applies (determinism scan, exports, signatures), then every recorded context
// from the test suite, comparing the host's verdict with the recorded one.
//
//   host-check <module.wasm> <contexts directory>
//
// Context files are named `<n>-accept.bin` or `<n>-reject.bin`.
import Foundation
import LatticePrimitives
import LatticeValidation

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: host-check <module.wasm> <contexts directory>\n".utf8))
    exit(2)
}
let moduleBytes = try Data(contentsOf: URL(fileURLWithPath: arguments[1]))
let moduleCID = try WasmPolicyModuleHeader(node: WasmPolicyModule(bytes: moduleBytes)).rawCID
let policy = WasmPolicyRef(moduleCID: moduleCID, scope: .transaction)
try WasmPolicyEvaluator.validate(policy: policy, moduleBytes: moduleBytes)
print("module \(moduleCID) (\(moduleBytes.count) bytes) passes genesis validation")

let directory = URL(fileURLWithPath: arguments[2])
let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
    .filter { $0.pathExtension == "bin" }
var mismatches = 0
for file in files {
    let expected = file.lastPathComponent.hasSuffix("-accept.bin")
    // A trap is a rejection, as it is for the block validator.
    let verdict = (try? WasmPolicyEvaluator.evaluate(
        policy: policy, contextData: try Data(contentsOf: file), moduleBytes: moduleBytes)) ?? false
    if verdict != expected {
        mismatches += 1
        print("MISMATCH \(file.lastPathComponent): host says \(verdict)")
    }
}
print("\(files.count - mismatches)/\(files.count) contexts agree")
exit(mismatches == 0 && !files.isEmpty ? 0 : 1)
