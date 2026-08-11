fn main() {
    tauri_build::build();

    // Rust test binaries do not receive Tauri's application manifest. Without
    // the common-controls v6 activation context, rfd can resolve
    // TaskDialogIndirect against the legacy comctl32 export table and the
    // Windows test process fails before the harness starts.
    if std::env::var_os("CARGO_CFG_WINDOWS").is_some() {
        let manifest = std::path::PathBuf::from(
            std::env::var_os("OUT_DIR").expect("OUT_DIR is set for Cargo build scripts"),
        )
        .join("common-controls.manifest");
        std::fs::write(
            &manifest,
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
</assembly>
"#,
        )
        .expect("write Windows common-controls manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
