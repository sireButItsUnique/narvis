mod manager;

use crate::manager::StateManager;

/// Workspace root type.
pub struct Workspace {
    pub manager: StateManager,
}

impl Workspace {
    pub fn new() -> Self {
        Self { manager: StateManager::new() }
    }
}
