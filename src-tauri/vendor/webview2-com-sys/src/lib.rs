// Patched by Ziwen-Player-Desktop project:
// The stock crate links the 5 free WebView2 functions against
// `WebView2Loader.dll` (GNU) or `WebView2LoaderStatic.lib` (MSVC). The GNU
// import makes the portable exe depend on a DLL that is not present when the
// exe is copied elsewhere. Here the imports are replaced with runtime
// resolution: the loader DLL is loaded from next to the executable, or
// extracted from bytes embedded in this binary (portable, single-file mode).

#[allow(
    non_snake_case,
    non_upper_case_globals,
    non_camel_case_types,
    dead_code,
    clippy::all
)]
pub mod Microsoft {
    pub mod Web {
        pub mod WebView2 {
            pub mod Win32 {
                mod windows_link {
                    macro_rules! link_webview2 {
                        (
                            $library:literal $abi:literal fn $name:ident(
                                $($arg:ident : $ty:ty),* $(,)?
                            ) -> windows_core::HRESULT
                        ) => {
                            #[allow(non_snake_case)]
                            pub unsafe fn $name($($arg: $ty),*) -> windows_core::HRESULT {
                                use ::std::sync::OnceLock;

                                type FnTy = unsafe extern "system" fn($($ty),*) -> windows_core::HRESULT;
                                static PROC: OnceLock<Option<FnTy>> = OnceLock::new();

                                let proc = PROC.get_or_init(|| {
                                    $crate::runtime::resolve::<FnTy>(concat!(stringify!($name), "\0"))
                                });
                                match *proc {
                                    Some(f) => f($($arg),*),
                                    None => windows_core::HRESULT(0x8000_4005u32 as i32), // E_FAIL
                                }
                            }
                        };
                    }

                    pub(crate) use link_webview2 as link;
                }

                include!("bindings.rs");
            }
        }
    }
}

/// Runtime loading of the WebView2 loader (see crate-level doc comment).
pub mod runtime {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::OnceLock;

    use windows::Win32::Foundation::{FARPROC, HMODULE};
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows_core::{PCSTR, PCWSTR};

    /// HMODULE is neither Send nor Sync; wrap it so it can live in a static.
    struct LoadedModule(HMODULE);
    // Safety: HMODULE is just an opaque handle value; moving/sharing it is safe.
    unsafe impl Send for LoadedModule {}
    unsafe impl Sync for LoadedModule {}

    static LOADER: OnceLock<Option<LoadedModule>> = OnceLock::new();

    /// The module handle of the WebView2 loader, loaded on first use.
    pub fn loader_module() -> Option<HMODULE> {
        LOADER.get_or_init(load_loader).as_ref().map(|m| m.0)
    }

    /// Resolve an exported function from the WebView2 loader by name.
    /// `name` must be a NUL-terminated C string (see `link_webview2!`).
    pub fn resolve<F>(name: &'static str) -> Option<F> {
        let module = loader_module()?;
        let proc: FARPROC = unsafe { GetProcAddress(module, PCSTR(name.as_ptr())) };
        match proc {
            Some(ptr) => Some(unsafe { std::mem::transmute_copy(&ptr) }),
            None => None,
        }
    }

    fn load_loader() -> Option<LoadedModule> {
        // 1) A loader DLL shipped next to the executable.
        if let Some(exe_dir) = exe_dir() {
            let candidate = exe_dir.join("WebView2Loader.dll");
            if candidate.is_file() {
                if let Some(module) = load_library(&candidate) {
                    return Some(LoadedModule(module));
                }
            }
        }

        // 2) Portable mode: extract the embedded loader DLL next to the exe
        //    (or into the system temp dir when the exe dir is not writable).
        const EMBEDDED: &[u8] = include_bytes!("../x64/WebView2Loader.dll");

        let mut targets: Vec<std::path::PathBuf> = Vec::new();
        if let Some(exe_dir) = exe_dir() {
            targets.push(exe_dir.join("WebView2Loader.dll"));
        }
        targets.push(std::env::temp_dir().join(format!(
            "ziwen_webview2loader_{:016x}.dll",
            fnv1a64(EMBEDDED)
        )));

        for path in &targets {
            if ensure_file(path, EMBEDDED).is_ok() {
                if let Some(module) = load_library(path) {
                    return Some(LoadedModule(module));
                }
            }
        }

        // 3) Last resort: let the system resolve the DLL by name.
        let wide: Vec<u16> = "WebView2Loader.dll".encode_utf16().chain(Some(0)).collect();
        unsafe { LoadLibraryW(PCWSTR(wide.as_ptr())).ok() }.map(LoadedModule)
    }

    fn exe_dir() -> Option<std::path::PathBuf> {
        std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
    }

    fn ensure_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        if path.is_file() {
            if let Ok(existing) = std::fs::read(path) {
                if existing == bytes {
                    return Ok(());
                }
            }
        }
        std::fs::write(path, bytes)
    }

    fn load_library(path: &Path) -> Option<HMODULE> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe { LoadLibraryW(PCWSTR(wide.as_ptr())).ok() }
    }

    fn fnv1a64(data: &[u8]) -> u64 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for &b in data {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash
    }
}

pub mod declared_interfaces;

#[cfg(test)]
mod test {
    use windows_core::w;

    use crate::Microsoft::Web::WebView2::Win32::*;

    #[test]
    fn compare_eq() {
        let mut result = 1;
        unsafe { CompareBrowserVersions(w!("1.0.0"), w!("1.0.0"), &mut result) }.unwrap();
        assert_eq!(0, result);
    }

    #[test]
    fn compare_lt() {
        let mut result = 0;
        unsafe { CompareBrowserVersions(w!("1.0.0"), w!("1.0.1"), &mut result) }.unwrap();
        assert_eq!(-1, result);
    }

    #[test]
    fn compare_gt() {
        let mut result = 0;
        unsafe { CompareBrowserVersions(w!("2.0.0"), w!("1.0.1"), &mut result) }.unwrap();
        assert_eq!(1, result);
    }
}
