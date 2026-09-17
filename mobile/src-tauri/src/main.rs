// Keeps the desktop dev build from opening a console window; the mobile
// harnesses enter through `lib::run`'s `mobile_entry_point`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dure_mobile_lib::run()
}
