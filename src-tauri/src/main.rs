#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_updater_desktop;
mod desktop;
mod online_desktop;
mod settings_desktop;
mod updates_desktop;

fn main() {
    desktop::run();
}
