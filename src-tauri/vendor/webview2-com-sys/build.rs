// Patched by Ziwen-Player-Desktop project: the loader is resolved at runtime
// (see src/lib.rs), so no import libs are linked anymore. We only copy the x64
// loader DLL into OUT_DIR so tauri-build can place it next to the built exe
// as a dev convenience; the exe itself is self-contained either way.

use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("x86_64") {
        let out_dir = PathBuf::from(env::var("OUT_DIR")?);
        let x64_dir = out_dir.join("x64");
        fs::create_dir_all(&x64_dir)?;
        let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
        fs::copy(
            manifest_dir.join("x64").join("WebView2Loader.dll"),
            x64_dir.join("WebView2Loader.dll"),
        )?;
    }
    println!("cargo:rustc-link-lib=advapi32");
    Ok(())
}
