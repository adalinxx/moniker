// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "host-check",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/0xLattice/Lattice.git", exact: "50.0.1"),
    ],
    targets: [
        .executableTarget(
            name: "host-check",
            dependencies: [
                .product(name: "LatticePrimitives", package: "Lattice"),
                .product(name: "LatticeValidation", package: "Lattice"),
            ]
        ),
    ]
)
