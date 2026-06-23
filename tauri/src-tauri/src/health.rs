use std::time::Duration;

/// GET a health URL; true iff it answers 2xx within `timeout`.
pub fn probe(url: &str, timeout: Duration) -> bool {
    match reqwest::blocking::Client::builder().timeout(timeout).build() {
        Ok(c) => c.get(url).send().map(|r| r.status().is_success()).unwrap_or(false),
        Err(_) => false,
    }
}

/// Poll `probe_fn` until it returns true or we exhaust `tries`. `aborted`
/// short-circuits (e.g. the child already died).
pub fn wait_for_health<F: FnMut() -> bool>(
    mut probe_fn: F, tries: u32, interval: Duration, aborted: &dyn Fn() -> bool,
) -> bool {
    for _ in 0..tries {
        if probe_fn() { return true; }
        if aborted() { return false; }
        std::thread::sleep(interval);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use std::cell::Cell;

    #[test]
    fn wait_succeeds_when_probe_goes_up_on_third_try() {
        let n = Cell::new(0u32);
        let ok = wait_for_health(|| { n.set(n.get() + 1); n.get() >= 3 },
            10, Duration::from_millis(1), &|| false);
        assert!(ok);
        assert_eq!(n.get(), 3);
    }

    #[test]
    fn wait_gives_up_after_tries() {
        let ok = wait_for_health(|| false, 5, Duration::from_millis(1), &|| false);
        assert!(!ok);
    }

    #[test]
    fn wait_short_circuits_when_aborted() {
        let n = Cell::new(0u32);
        let ok = wait_for_health(|| { n.set(n.get() + 1); false },
            100, Duration::from_millis(1), &|| n.get() >= 2);
        assert!(!ok);
        assert!(n.get() <= 3); // stopped early, not 100 tries
    }
}
