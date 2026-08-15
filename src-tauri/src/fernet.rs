//! Fernet (spec 0x80) decryption — port of the Android app's `fernetDecrypt`
//! (AES-128-CBC + HMAC-SHA256), using only decryption.

use aes::Aes128;
use base64::engine::general_purpose::URL_SAFE;
use base64::Engine;
use cbc::cipher::{BlockDecryptMut, KeyIvInit};
use cbc::Decryptor;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;
type Aes128Cbc = Decryptor<Aes128>;

fn base64url_decode(value: &str) -> Result<Vec<u8>, String> {
    let trimmed = value.trim();
    let padding = (4 - trimmed.len() % 4) % 4;
    let mut padded = trimmed.to_string();
    padded.push_str(&"=".repeat(padding));
    URL_SAFE
        .decode(padded.as_bytes())
        .map_err(|e| format!("base64 decode failed: {e}"))
}

/// Decrypt a Fernet token using a base64url key.
pub fn fernet_decrypt(token: &str, key: &str) -> Result<String, String> {
    let token_bytes = base64url_decode(token)?;
    let key_bytes = base64url_decode(key)?;

    if token_bytes.len() < 57 || key_bytes.len() != 32 || token_bytes[0] != 0x80 {
        return Err("Invalid Fernet token".to_string());
    }

    let signing_key = &key_bytes[0..16];
    let encryption_key = &key_bytes[16..32];

    let signature_start = token_bytes.len() - 32;
    let expected = {
        let mut mac = HmacSha256::new_from_slice(signing_key).map_err(|e| e.to_string())?;
        mac.update(&token_bytes[..signature_start]);
        mac.finalize().into_bytes()
    };
    let actual = &token_bytes[signature_start..];

    if expected.as_slice() != actual {
        return Err("Invalid Fernet signature".to_string());
    }

    let iv = &token_bytes[9..25];
    let cipher_text = &token_bytes[25..signature_start];

    let decryptor = Aes128Cbc::new_from_slices(encryption_key, iv).map_err(|e| e.to_string())?;
    let mut buf = cipher_text.to_vec();
    let plaintext = decryptor
        .decrypt_padded_mut::<cbc::cipher::block_padding::Pkcs7>(&mut buf)
        .map_err(|e| format!("decrypt failed: {e}"))?;

    String::from_utf8(plaintext.to_vec()).map_err(|e| e.to_string())
}
