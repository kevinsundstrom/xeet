//! The browser/Node host: a JS object as `Fetch`, `Lookup`, `Cache` and `Clock`.
//!
//! `xeet-resolve` wants four traits; a JS caller has one object with optional
//! functions. This module bridges the two, and it is the only place in the crate
//! that touches `js_sys` — the export itself lives in `lib.rs`'s `ffi` module,
//! which is where wasm-bindgen's generated `unsafe` is allowed.
//!
//! The contract, as `packages/xeet` implements it (docs/RESOLVE.md):
//!
//! ```js
//! const host = {
//!   // Required. The library sends `redirect: "manual"` and follows the chain
//!   // itself, so this must hand back the 3xx — not the page it points at.
//!   async fetch(request) {
//!     // request: { url, method: "GET", headers: {userAgent, accept, …},
//!     //            redirect: "manual", maxBytes, timeoutMs }
//!     return {
//!       status: 301,                       // number
//!       headers: { location: "https://…" },// lower-case keys
//!       body: new ArrayBuffer(0),          // ArrayBuffer | Uint8Array | string
//!       truncated: false,                  // optional
//!       finalUrl: null,                    // optional
//!     };
//!   },
//!   // Optional: without it the address guard can only refuse IP literals.
//!   async lookup(host) { return ["93.184.216.34"]; },
//!   // Optional: a disk or `Cache` store; the library owns the TTL.
//!   async cacheGet(key) { return null; },            // {value, storedAt} | null
//!   async cacheSet(key, value, storedAt) {},
//!   now() { return Date.now(); },
//! };
//! ```

use std::net::IpAddr;

use js_sys::{Function, Object, Promise, Reflect};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

use xeet_resolve::fetch::{
    Cache, CacheEntry, Clock, Fetch, FetchError, Lookup, LookupError, Method, Redirect, Request,
    Response,
};

/// One JS object, adapted to every trait the library takes.
pub struct JsHost {
    pub fetch: Function,
    pub lookup: Option<Function>,
    pub cache_get: Option<Function>,
    pub cache_set: Option<Function>,
    pub now: Option<Function>,
}

impl JsHost {
    /// Reads the object's optional members. `fetch` is the only one required.
    pub fn new(host: &JsValue) -> Result<JsHost, String> {
        let get = |name: &str| -> Option<Function> {
            Reflect::get(host, &JsValue::from_str(name))
                .ok()
                .and_then(|value| value.dyn_into::<Function>().ok())
        };
        let Some(fetch) = get("fetch") else {
            return Err("the resolver host has no fetch function".to_string());
        };
        Ok(JsHost {
            fetch,
            lookup: get("lookup"),
            cache_get: get("cacheGet"),
            cache_set: get("cacheSet"),
            now: get("now"),
        })
    }

    fn call(&self, function: &Function, arguments: &[JsValue]) -> Result<JsValue, String> {
        function
            .apply(
                &JsValue::NULL,
                &js_sys::Array::from_iter(arguments.iter().cloned()),
            )
            .map_err(describe)
    }

    async fn call_async(
        &self,
        function: &Function,
        arguments: &[JsValue],
    ) -> Result<JsValue, String> {
        let value = self.call(function, arguments)?;
        let promise: Promise = value
            .dyn_into()
            .map_err(|_| "the host function did not return a promise".to_string())?;
        JsFuture::from(promise).await.map_err(describe)
    }
}

/// A JS error (or a thrown value) as text.
fn describe(value: JsValue) -> String {
    if let Some(message) = value.as_string() {
        return message;
    }
    Reflect::get(&value, &JsValue::from_str("message"))
        .ok()
        .and_then(|message| message.as_string())
        .unwrap_or_else(|| format!("{value:?}"))
}

fn string_field(value: &JsValue, name: &str) -> Option<String> {
    Reflect::get(value, &JsValue::from_str(name))
        .ok()
        .and_then(|field| field.as_string())
}

fn number_field(value: &JsValue, name: &str) -> Option<f64> {
    Reflect::get(value, &JsValue::from_str(name))
        .ok()
        .and_then(|field| field.as_f64())
}

fn bool_field(value: &JsValue, name: &str) -> Option<bool> {
    Reflect::get(value, &JsValue::from_str(name))
        .ok()
        .and_then(|field| field.as_bool())
}

impl Fetch for JsHost {
    async fn fetch(&self, request: Request) -> Result<Response, FetchError> {
        let object = Object::new();
        let set = |name: &str, value: JsValue| {
            let _ = Reflect::set(&object, &JsValue::from_str(name), &value);
        };
        set("url", JsValue::from_str(&request.url));
        set("method", JsValue::from_str("GET"));
        set("redirect", JsValue::from_str("manual"));
        set("maxBytes", JsValue::from_f64(request.max_bytes as f64));
        set(
            "timeoutMs",
            JsValue::from_f64(request.timeout.as_millis() as f64),
        );
        let headers = Object::new();
        for (name, value) in &request.headers {
            let _ = Reflect::set(
                &headers,
                &JsValue::from_str(name),
                &JsValue::from_str(value),
            );
        }
        set("headers", headers.into());
        debug_assert_eq!(request.method, Method::Get);
        debug_assert_eq!(request.redirect, Redirect::Manual);

        let response = self
            .call_async(&self.fetch, &[object.into()])
            .await
            .map_err(FetchError::Transport)?;
        // A host may signal a refusal by throwing `{blocked: "..."}`.
        if let Some(blocked) = string_field(&response, "blocked") {
            return Err(FetchError::Blocked(blocked));
        }
        let status = number_field(&response, "status")
            .ok_or_else(|| FetchError::Transport("the host's response has no status".to_string()))?
            as u16;
        let mut headers_out: Vec<(String, String)> = Vec::new();
        if let Ok(entry_headers) = Reflect::get(&response, &JsValue::from_str("headers")) {
            let keys = Object::keys(&Object::from(entry_headers.clone()));
            for index in 0..keys.length() {
                let key = keys.get(index);
                if let Some(name) = key.as_string() {
                    if let Some(value) = string_field(&entry_headers, &name) {
                        headers_out.push((name.to_ascii_lowercase(), value));
                    }
                }
            }
        }
        let body = body_bytes(&response)?;
        let truncated =
            bool_field(&response, "truncated").unwrap_or(false) || body.len() > request.max_bytes;
        let body = if body.len() > request.max_bytes {
            body[..request.max_bytes].to_vec()
        } else {
            body
        };
        Ok(Response {
            status,
            headers: headers_out,
            body,
            truncated,
            final_url: string_field(&response, "finalUrl"),
        })
    }
}

/// The `body` member: an ArrayBuffer, a typed array or a string.
fn body_bytes(response: &JsValue) -> Result<Vec<u8>, FetchError> {
    let Ok(body) = Reflect::get(response, &JsValue::from_str("body")) else {
        return Ok(Vec::new());
    };
    if body.is_null() || body.is_undefined() {
        return Ok(Vec::new());
    }
    if let Some(text) = body.as_string() {
        return Ok(text.into_bytes());
    }
    if let Some(buffer) = body.dyn_ref::<js_sys::ArrayBuffer>() {
        return Ok(js_sys::Uint8Array::new(buffer).to_vec());
    }
    if let Some(view) = body.dyn_ref::<js_sys::Uint8Array>() {
        return Ok(view.to_vec());
    }
    Err(FetchError::Transport(
        "the host's response body is not an ArrayBuffer, Uint8Array or string".to_string(),
    ))
}

impl Lookup for JsHost {
    async fn lookup(&self, host: &str) -> Result<Vec<IpAddr>, LookupError> {
        let Some(function) = &self.lookup else {
            return Err(LookupError::NoSuchHost(host.to_string()));
        };
        let value = self
            .call_async(function, &[JsValue::from_str(host)])
            .await
            .map_err(|_| LookupError::NoSuchHost(host.to_string()))?;
        let array = js_sys::Array::from(&value);
        let mut out = Vec::new();
        for entry in array.iter() {
            if let Some(text) = entry.as_string() {
                if let Ok(address) = text.parse::<IpAddr>() {
                    out.push(address);
                }
            }
        }
        if out.is_empty() {
            return Err(LookupError::NoSuchHost(host.to_string()));
        }
        Ok(out)
    }
}

impl Cache for JsHost {
    async fn get(&self, key: &str) -> Option<CacheEntry> {
        let function = self.cache_get.as_ref()?;
        let value = self
            .call_async(function, &[JsValue::from_str(key)])
            .await
            .ok()?;
        if value.is_null() || value.is_undefined() {
            return None;
        }
        Some(CacheEntry {
            value: string_field(&value, "value")?,
            stored_at_ms: number_field(&value, "storedAt")? as u64,
        })
    }

    async fn set(&self, key: &str, entry: CacheEntry) {
        let Some(function) = self.cache_set.as_ref() else {
            return;
        };
        let _ = self
            .call_async(
                function,
                &[
                    JsValue::from_str(key),
                    JsValue::from_str(&entry.value),
                    JsValue::from_f64(entry.stored_at_ms as f64),
                ],
            )
            .await;
    }
}

impl Clock for JsHost {
    fn now_ms(&self) -> u64 {
        match &self.now {
            Some(function) => function
                .call0(&JsValue::NULL)
                .ok()
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0) as u64,
            None => 0,
        }
    }
}
