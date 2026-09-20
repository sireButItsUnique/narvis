use std::collections::HashMap;

/// Manages window state.
pub struct StateManager {
    windows: HashMap<i32, String>,
}

impl StateManager {
    pub fn new() -> Self {
        Self { windows: HashMap::new() }
    }

    pub fn get(&self, id: i32) -> Option<&String> {
        self.helper();
        self.windows.get(&id)
    }

    fn helper(&self) {
        println!("help");
    }
}

#[cfg(target_os = "windows")]
pub fn win_only() {}

fn caller() {
    let s = StateManager::new();
    s.get(1);
    unresolved_fn();
}
