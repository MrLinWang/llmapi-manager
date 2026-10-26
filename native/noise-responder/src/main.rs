use snow::{Builder, params::NoiseParams};
use std::io::{self, BufRead};

fn main() {
    let params: NoiseParams = "Noise_XX_25519_ChaChaPoly_SHA256".parse().unwrap();
    let prologue = b"easytier-peerconn-noise";
    let static_key = [9u8; 32];
    let mut hs = Builder::new(params).prologue(prologue).unwrap()
        .local_private_key(&static_key).unwrap().build_responder().unwrap();

    let stdin = io::stdin();
    let mut buf = vec![0u8; 65536];
    let mut scratch = vec![0u8; 65536];

    for line in stdin.lock().lines() {
        let line = line.unwrap();
        let line = line.trim();
        if line == "QUIT" { break; }
        if let Some(hexdata) = line.strip_prefix("READ ") {
            let data = hex::decode(hexdata).unwrap();
            match hs.read_message(&data, &mut scratch) {
                Ok(_) => println!("OK"),
                Err(e) => println!("ERR {}", e),
            }
        } else if line.starts_with("WRITE") {
            match hs.write_message(&[], &mut buf) {
                Ok(n) => println!("MSG {}", hex::encode(&buf[..n])),
                Err(e) => println!("ERR {}", e),
            }
        } else if line == "DONE" {
            println!("DONE {}", hs.is_handshake_finished());
        }
    }
}
