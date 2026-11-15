fn main() {
    // On Windows the app manifest (Common Controls v6, DPI awareness) is embedded
    // through the linker for *every* target, so unit/integration test binaries
    // load too (otherwise they fail with STATUS_ENTRYPOINT_NOT_FOUND).
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let mut attrs = tauri_build::Attributes::new();
    if windows {
        attrs =
            attrs.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::env::current_dir()
            .unwrap()
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(attrs).expect("failed to run tauri-build");
}
