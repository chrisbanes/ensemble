use serde::{Deserialize, Serialize};

/// Strategy for handling branch pushes at the end of a successful pipeline.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PushStrategy {
    /// Prompt user interactively (CLI mode only, blocks until response).
    Ask,
    /// Automatically push branch to origin.
    AutoPush,
    /// Leave local, user handles manually.
    #[default]
    Manual,
    /// Only create PR (implicit push).
    PrOnly,
}

impl PushStrategy {
    /// Returns true if this strategy requires interactive user input.
    pub fn is_interactive(&self) -> bool {
        matches!(self, PushStrategy::Ask)
    }

    /// Returns true if this strategy will push to remote.
    pub fn will_push(&self) -> bool {
        matches!(self, PushStrategy::AutoPush | PushStrategy::PrOnly)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_push_strategy_is_interactive() {
        assert!(PushStrategy::Ask.is_interactive());
        assert!(!PushStrategy::AutoPush.is_interactive());
        assert!(!PushStrategy::Manual.is_interactive());
        assert!(!PushStrategy::PrOnly.is_interactive());
    }

    #[test]
    fn test_push_strategy_will_push() {
        assert!(!PushStrategy::Ask.will_push());
        assert!(PushStrategy::AutoPush.will_push());
        assert!(!PushStrategy::Manual.will_push());
        assert!(PushStrategy::PrOnly.will_push());
    }

    #[test]
    fn test_push_strategy_default() {
        assert_eq!(PushStrategy::default(), PushStrategy::Manual);
    }

    #[test]
    fn test_push_strategy_deserialization() {
        let yaml = r#""ask""#;
        let strategy: PushStrategy = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(strategy, PushStrategy::Ask);

        let yaml = r#""auto_push""#;
        let strategy: PushStrategy = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(strategy, PushStrategy::AutoPush);
    }
}
