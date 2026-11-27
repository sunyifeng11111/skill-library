fn main() {
    #[cfg(feature = "desktop")]
    {
        println!("cargo:rerun-if-changed=icons");
        println!("cargo:rerun-if-changed=icons/icon.icns");
        println!("cargo:rerun-if-changed=icons/icon.png");
        tauri_build::build();
    }
}
