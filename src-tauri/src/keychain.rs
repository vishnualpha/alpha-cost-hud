//! Secure storage for API keys via the OS keychain. Non-secret config (URLs,
//! workspaceId) lives in the JS store; only secrets go here.
//!
//! Generic per-account storage backs both the gateway key and each direct
//! provider key (e.g. "provider:anthropic"). Account names are validated to a
//! safe charset so they can't escape the service namespace.

use keyring::Entry;

const SERVICE: &str = "ai.thealpha.costhud";
const GATEWAY_ACCOUNT: &str = "gateway-api-key";

fn valid_account(account: &str) -> bool {
    !account.is_empty()
        && account.len() <= 128
        && account
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
}

fn entry(account: &str) -> Result<Entry, String> {
    if !valid_account(account) {
        return Err("invalid account name".into());
    }
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

fn set(account: &str, key: &str) -> Result<(), String> {
    entry(account)?.set_password(key).map_err(|e| e.to_string())
}

fn get(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn clear(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---- Gateway key (back-compat single-key commands) ----
#[tauri::command]
pub fn save_api_key(key: String) -> Result<(), String> {
    set(GATEWAY_ACCOUNT, &key)
}

#[tauri::command]
pub fn get_api_key() -> Result<Option<String>, String> {
    get(GATEWAY_ACCOUNT)
}

#[tauri::command]
pub fn clear_api_key() -> Result<(), String> {
    clear(GATEWAY_ACCOUNT)
}

// ---- Generic named-account key storage (direct providers) ----
#[tauri::command]
pub fn save_provider_key(account: String, key: String) -> Result<(), String> {
    set(&account, &key)
}

#[tauri::command]
pub fn get_provider_key(account: String) -> Result<Option<String>, String> {
    get(&account)
}

#[tauri::command]
pub fn clear_provider_key(account: String) -> Result<(), String> {
    clear(&account)
}
