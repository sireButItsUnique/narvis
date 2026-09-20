/// OS abstraction trait.
pub trait OsAdapter {
    fn open(&self, path: &str) -> bool;
}

pub struct Adapter;

impl OsAdapter for Adapter {
    fn open(&self, _path: &str) -> bool {
        true
    }
}
