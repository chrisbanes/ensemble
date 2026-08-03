pub mod acceptance;
pub mod agent;
pub mod api;
pub mod config;
pub mod config_watcher;
pub mod error;
pub mod history;
pub mod history_store;
pub mod interaction;
pub mod observability;
pub mod orchestrator;
pub mod pipeline;
pub mod timeline;
pub mod tracker;
pub mod transcript;
pub mod ui;
pub mod workspace;

#[cfg(test)]
pub(crate) mod test_support;
