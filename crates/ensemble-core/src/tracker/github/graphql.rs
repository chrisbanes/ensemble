use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::super::TrackerError;

pub(super) trait Operation {
    const NAME: &'static str;
    const QUERY: &'static str;
    type Response: DeserializeOwned;
}

#[derive(Debug, Deserialize)]
struct GraphqlResponse<T> {
    data: Option<T>,
    #[serde(default)]
    errors: Vec<GraphqlError>,
}

#[derive(Debug, Deserialize)]
struct GraphqlError {
    message: String,
}

pub(super) fn decode_response<O: Operation>(
    bytes: &[u8],
    token: &str,
) -> Result<O::Response, TrackerError> {
    let response: GraphqlResponse<O::Response> =
        serde_json::from_slice(bytes).map_err(|error| TrackerError::UnexpectedPayload {
            reason: redact_token(
                &format!("{} response could not be decoded: {error}", O::NAME),
                token,
            ),
        })?;

    if !response.errors.is_empty() {
        let errors = response
            .errors
            .into_iter()
            .map(|error| error.message)
            .collect::<Vec<_>>()
            .join("; ");
        return Err(TrackerError::GraphqlErrors {
            errors: redact_token(&format!("{}: {errors}", O::NAME), token),
        });
    }

    response
        .data
        .ok_or_else(|| TrackerError::UnexpectedPayload {
            reason: format!("{} response missing data", O::NAME),
        })
}

pub(super) fn redact_token(value: &str, token: &str) -> String {
    if token.is_empty() {
        value.to_string()
    } else {
        value.replace(token, "[REDACTED]")
    }
}

pub(super) fn unexpected_payload<O: Operation>(reason: impl std::fmt::Display) -> TrackerError {
    TrackerError::UnexpectedPayload {
        reason: format!("{} response: {reason}", O::NAME),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PageInfo {
    pub(super) has_next_page: bool,
    pub(super) end_cursor: Option<String>,
}

impl PageInfo {
    pub(super) fn next_cursor(&self) -> Result<Option<String>, TrackerError> {
        if self.has_next_page {
            self.end_cursor
                .clone()
                .map(Some)
                .ok_or(TrackerError::MissingEndCursor)
        } else {
            Ok(None)
        }
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct Connection<T> {
    #[serde(rename = "pageInfo")]
    pub(super) page_info: PageInfo,
    pub(super) nodes: Vec<Option<T>>,
}

#[derive(Debug, Deserialize)]
pub(super) struct Edge<T> {
    pub(super) cursor: String,
    pub(super) node: Option<T>,
}

#[derive(Debug, Deserialize)]
pub(super) struct Nodes<T> {
    pub(super) nodes: Vec<Option<T>>,
}

#[derive(Debug, Deserialize)]
pub(super) struct Label {
    pub(super) name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IssueNode {
    pub(super) id: Option<String>,
    pub(super) number: Option<u64>,
    pub(super) title: Option<String>,
    pub(super) body: Option<String>,
    pub(super) created_at: Option<String>,
    pub(super) updated_at: Option<String>,
    pub(super) url: Option<String>,
    pub(super) state: Option<String>,
    pub(super) labels: Option<Nodes<Label>>,
    pub(super) assignees: Option<AssigneeConnection>,
    pub(super) project_items: Option<Nodes<ProjectItem>>,
}

#[derive(Debug, Deserialize)]
pub(super) struct User {
    pub(super) id: Option<String>,
    pub(super) login: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AssigneeConnection {
    #[serde(default)]
    pub(super) total_count: Option<u64>,
    pub(super) nodes: Vec<Option<User>>,
}

pub(super) struct Viewer;

impl Operation for Viewer {
    const NAME: &'static str = "Viewer";
    const QUERY: &'static str = VIEWER_QUERY;
    type Response = ViewerData;
}

pub(super) const VIEWER_QUERY: &str = r#"
query {
  viewer { id login }
}
"#;

#[derive(Debug, Deserialize)]
pub(super) struct ViewerData {
    pub(super) viewer: Option<User>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectItem {
    pub(super) id: Option<String>,
    pub(super) project: Option<ProjectRef>,
    pub(super) field_values: Option<Nodes<FieldValue>>,
    pub(super) content: Option<IssueNode>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ProjectRef {
    pub(super) id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FieldValue {
    pub(super) name: Option<String>,
    pub(super) option_id: Option<String>,
    pub(super) field: Option<FieldRef>,
}

#[derive(Debug, Deserialize)]
pub(super) struct FieldRef {
    pub(super) id: Option<String>,
    #[allow(dead_code)]
    pub(super) name: Option<String>,
}

pub(super) struct ProjectDiscovery;

impl Operation for ProjectDiscovery {
    const NAME: &'static str = "ProjectDiscovery";
    const QUERY: &'static str = PROJECT_DISCOVERY_QUERY;
    type Response = ProjectDiscoveryData;
}

pub(super) const PROJECT_DISCOVERY_QUERY: &str = r#"
query($owner: String!, $repo: String!, $projectNumber: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    projectV2(number: $projectNumber) {
      id
      fields(first: 20, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
}
"#;

#[derive(Debug, Deserialize)]
pub(super) struct ProjectDiscoveryData {
    pub(super) repository: Option<ProjectDiscoveryRepository>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ProjectDiscoveryRepository {
    #[serde(rename = "projectV2")]
    pub(super) project: Option<Project>,
}

#[derive(Debug, Deserialize)]
pub(super) struct Project {
    pub(super) id: String,
    pub(super) fields: Connection<ProjectField>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ProjectField {
    pub(super) id: Option<String>,
    pub(super) name: Option<String>,
    pub(super) options: Option<Vec<ProjectFieldOption>>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ProjectFieldOption {
    pub(super) id: Option<String>,
    pub(super) name: Option<String>,
}

pub(super) struct ProjectItems;

impl Operation for ProjectItems {
    const NAME: &'static str = "ProjectItems";
    const QUERY: &'static str = PROJECT_ITEMS_QUERY;
    type Response = ProjectItemsData;
}

pub(super) const PROJECT_ITEMS_QUERY: &str = r#"
query($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 50, after: $cursor, orderBy: {field: POSITION, direction: ASC}) {
        pageInfo { hasNextPage endCursor }
        edges {
          cursor
          node {
            fieldValues(first: 100) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name optionId
                  field { ... on ProjectV2SingleSelectField { id name } }
                }
              }
            }
            content {
              ... on Issue {
                id number title body createdAt updatedAt url
                labels(first: 20) { nodes { name } }
                assignees(first: 100) { totalCount nodes { id login } }
              }
            }
          }
        }
      }
    }
  }
}
"#;

#[derive(Debug, Deserialize)]
pub(super) struct ProjectItemsData {
    pub(super) node: Option<ProjectItemsNode>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ProjectItemsNode {
    pub(super) items: ProjectItemConnection,
}

#[derive(Debug, Deserialize)]
pub(super) struct ProjectItemConnection {
    #[serde(rename = "pageInfo")]
    pub(super) page_info: PageInfo,
    pub(super) edges: Vec<Option<Edge<ProjectItem>>>,
}

pub(super) struct RepositoryIssues;

impl Operation for RepositoryIssues {
    const NAME: &'static str = "RepositoryIssues";
    const QUERY: &'static str = REPOSITORY_ISSUES_QUERY;
    type Response = RepositoryIssuesData;
}

pub(super) const REPOSITORY_ISSUES_QUERY: &str = r#"
query($owner: String!, $repo: String!, $cursor: String, $labels: [String!]) {
  repository(owner: $owner, name: $repo) {
    issues(first: 50, after: $cursor, states: [OPEN, CLOSED], labels: $labels, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number title body createdAt updatedAt url state
        labels(first: 20) { nodes { name } }
        assignees(first: 100) { totalCount nodes { id login } }
      }
    }
  }
}
"#;

#[derive(Debug, Deserialize)]
pub(super) struct RepositoryIssuesData {
    pub(super) repository: Option<RepositoryIssuesRepository>,
}

#[derive(Debug, Deserialize)]
pub(super) struct RepositoryIssuesRepository {
    pub(super) issues: Connection<IssueNode>,
}

pub(super) struct IssueStates;

impl Operation for IssueStates {
    const NAME: &'static str = "IssueStates";
    const QUERY: &'static str = ISSUE_STATES_QUERY;
    type Response = IssueStatesData;
}

pub(super) const ISSUE_STATES_QUERY: &str = r#"
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Issue {
      id number title state url
      labels(first: 20) { nodes { name } }
      assignees(first: 100) { totalCount nodes { id login } }
    }
  }
}
"#;

#[derive(Debug, Deserialize)]
pub(super) struct IssueStatesData {
    pub(super) nodes: Vec<Option<IssueNode>>,
}

pub(super) struct IssueAssignees;

impl Operation for IssueAssignees {
    const NAME: &'static str = "IssueAssignees";
    const QUERY: &'static str = ISSUE_ASSIGNEES_QUERY;
    type Response = IssueAssigneesData;
}

pub(super) const ISSUE_ASSIGNEES_QUERY: &str = r#"
query($issueId: ID!) {
  node(id: $issueId) {
    ... on Issue { id assignees(first: 100) { totalCount nodes { id login } } }
  }
}
"#;

#[derive(Debug, Deserialize)]
pub(super) struct IssueAssigneesData {
    pub(super) node: Option<IssueNode>,
}

pub(super) struct AddAssignees;

impl Operation for AddAssignees {
    const NAME: &'static str = "AddAssignees";
    const QUERY: &'static str = ADD_ASSIGNEES_MUTATION;
    type Response = AddAssigneesData;
}

pub(super) const ADD_ASSIGNEES_MUTATION: &str = r#"
mutation($issueId: ID!, $assigneeId: ID!) {
  addAssigneesToAssignable(input: {assignableId: $issueId, assigneeIds: [$assigneeId]}) {
    assignable { ... on Issue { id } }
  }
}
"#;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AddAssigneesData {
    #[serde(rename = "addAssigneesToAssignable")]
    _result: Option<AssignableMutationPayload>,
}

#[derive(Debug, Deserialize)]
pub(super) struct AssignableMutationPayload {
    _assignable: Option<IdNode>,
}

pub(super) struct IssueComments;

impl Operation for IssueComments {
    const NAME: &'static str = "IssueComments";
    const QUERY: &'static str = ISSUE_COMMENTS_QUERY;
    type Response = IssueCommentsData;
}

pub(super) const ISSUE_COMMENTS_QUERY: &str = r#"
query($issueId: ID!, $cursor: String) {
  node(id: $issueId) {
    ... on Issue {
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id body createdAt updatedAt author { login } }
      }
    }
  }
}
"#;

#[derive(Debug, Deserialize)]
pub(super) struct IssueCommentsData {
    pub(super) node: Option<IssueCommentsNode>,
}

#[derive(Debug, Deserialize)]
pub(super) struct IssueCommentsNode {
    pub(super) comments: Connection<CommentNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CommentNode {
    pub(super) id: String,
    pub(super) body: String,
    pub(super) created_at: Option<String>,
    pub(super) updated_at: Option<String>,
    pub(super) author: Option<CommentAuthor>,
}

#[derive(Debug, Deserialize)]
pub(super) struct CommentAuthor {
    pub(super) login: Option<String>,
}

pub(super) struct AddComment;

impl Operation for AddComment {
    const NAME: &'static str = "AddComment";
    const QUERY: &'static str = ADD_COMMENT_MUTATION;
    type Response = AddCommentData;
}

pub(super) const ADD_COMMENT_MUTATION: &str = r#"
mutation($subjectId: ID!, $body: String!) {
  addComment(input: {subjectId: $subjectId, body: $body}) {
    commentEdge { node { id url } }
  }
}
"#;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AddCommentData {
    pub(super) add_comment: Option<AddCommentPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AddCommentPayload {
    pub(super) comment_edge: Option<CommentEdge>,
}

#[derive(Debug, Deserialize)]
pub(super) struct CommentEdge {
    pub(super) node: Option<CommentMetadata>,
}

#[derive(Debug, Deserialize)]
pub(super) struct CommentMetadata {
    pub(super) id: String,
    pub(super) url: Option<String>,
}

pub(super) struct UpdateProjectItemField;

impl Operation for UpdateProjectItemField {
    const NAME: &'static str = "UpdateProjectItemField";
    const QUERY: &'static str = UPDATE_PROJECT_ITEM_FIELD_MUTATION;
    type Response = UpdateProjectItemFieldData;
}

pub(super) const UPDATE_PROJECT_ITEM_FIELD_MUTATION: &str = r#"
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) { projectV2Item { id } }
}
"#;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpdateProjectItemFieldData {
    #[serde(rename = "updateProjectV2ItemFieldValue")]
    _result: Option<ProjectItemMutationPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectItemMutationPayload {
    #[serde(rename = "projectV2Item")]
    _project_item: Option<IdNode>,
}

pub(super) struct RepositoryLabel;

impl Operation for RepositoryLabel {
    const NAME: &'static str = "RepositoryLabel";
    const QUERY: &'static str = REPOSITORY_LABEL_QUERY;
    type Response = RepositoryLabelData;
}

pub(super) const REPOSITORY_LABEL_QUERY: &str = r#"
query($owner: String!, $repo: String!, $name: String!) {
  repository(owner: $owner, name: $repo) { label(name: $name) { id name } }
}
"#;

#[derive(Debug, Deserialize)]
pub(super) struct RepositoryLabelData {
    pub(super) repository: Option<RepositoryLabelRepository>,
}

#[derive(Debug, Deserialize)]
pub(super) struct RepositoryLabelRepository {
    pub(super) label: Option<RepositoryLabelNode>,
}

#[derive(Debug, Deserialize)]
pub(super) struct RepositoryLabelNode {
    pub(super) id: String,
    #[serde(rename = "name")]
    _name: String,
}

pub(super) struct AddLabels;

impl Operation for AddLabels {
    const NAME: &'static str = "AddLabels";
    const QUERY: &'static str = ADD_LABELS_MUTATION;
    type Response = AddLabelsData;
}

pub(super) const ADD_LABELS_MUTATION: &str = r#"
mutation($labelableId: ID!, $labelIds: [ID!]!) {
  addLabelsToLabelable(input: {labelableId: $labelableId, labelIds: $labelIds}) {
    labelable { ... on Issue { id } }
  }
}
"#;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AddLabelsData {
    #[serde(rename = "addLabelsToLabelable")]
    _result: Option<LabelMutationPayload>,
}

pub(super) struct RemoveLabels;

impl Operation for RemoveLabels {
    const NAME: &'static str = "RemoveLabels";
    const QUERY: &'static str = REMOVE_LABELS_MUTATION;
    type Response = RemoveLabelsData;
}

pub(super) const REMOVE_LABELS_MUTATION: &str = r#"
mutation($labelableId: ID!, $labelIds: [ID!]!) {
  removeLabelsFromLabelable(input: {labelableId: $labelableId, labelIds: $labelIds}) {
    labelable { ... on Issue { id } }
  }
}
"#;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoveLabelsData {
    #[serde(rename = "removeLabelsFromLabelable")]
    _result: Option<LabelMutationPayload>,
}

#[derive(Debug, Deserialize)]
pub(super) struct LabelMutationPayload {
    #[serde(rename = "labelable")]
    _labelable: Option<IdNode>,
}

#[derive(Debug, Deserialize)]
pub(super) struct IdNode {
    #[serde(rename = "id")]
    _id: Option<String>,
}

pub(super) struct FindProjectItem;

impl Operation for FindProjectItem {
    const NAME: &'static str = "FindProjectItem";
    const QUERY: &'static str = FIND_PROJECT_ITEM_QUERY;
    type Response = FindProjectItemData;
}

pub(super) const FIND_PROJECT_ITEM_QUERY: &str = r#"
query($nodeId: ID!) {
  node(id: $nodeId) {
    ... on Issue {
      projectItems(first: 100) { nodes { id project { id } } }
    }
  }
}
"#;

#[derive(Debug, Deserialize)]
pub(super) struct FindProjectItemData {
    pub(super) node: Option<IssueNode>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_envelope_reports_operation_for_malformed_data() {
        let error = decode_response::<ProjectDiscovery>(
            br#"{"data":{"repository":{"projectV2":{"id":42}}}}"#,
            "secret-token",
        )
        .unwrap_err();

        assert!(error.to_string().contains("ProjectDiscovery"));
    }

    #[test]
    fn typed_envelope_preserves_graphql_errors_without_token() {
        let error = decode_response::<ProjectDiscovery>(
            br#"{"data":null,"errors":[{"message":"bad secret-token"}]}"#,
            "secret-token",
        )
        .unwrap_err();

        assert!(matches!(error, TrackerError::GraphqlErrors { .. }));
        assert!(error.to_string().contains("bad [REDACTED]"));
        assert!(!error.to_string().contains("secret-token"));
    }

    #[test]
    fn every_read_operation_decodes_its_selected_payload() {
        for result in [
            decode_response::<ProjectDiscovery>(br#"{"data":{"repository":{"projectV2":{"id":"P_1","fields":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}"#, "").map(|_| ()),
            decode_response::<ProjectItems>(br#"{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false,"endCursor":null},"edges":[]}}}}"#, "").map(|_| ()),
            decode_response::<RepositoryIssues>(br#"{"data":{"repository":{"issues":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}"#, "").map(|_| ()),
            decode_response::<IssueStates>(br#"{"data":{"nodes":[]}}"#, "").map(|_| ()),
            decode_response::<Viewer>(br#"{"data":{"viewer":{"id":"U_1","login":"octocat"}}}"#, "").map(|_| ()),
            decode_response::<IssueAssignees>(br#"{"data":{"node":{"id":"I_1","assignees":{"totalCount":0,"nodes":[]}}}}"#, "").map(|_| ()),
            decode_response::<IssueComments>(br#"{"data":{"node":{"comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}"#, "").map(|_| ()),
            decode_response::<RepositoryLabel>(br#"{"data":{"repository":{"label":{"id":"L_1","name":"Todo"}}}}"#, "").map(|_| ()),
            decode_response::<FindProjectItem>(br#"{"data":{"node":{"projectItems":{"nodes":[]}}}}"#, "").map(|_| ()),
        ] {
            result.unwrap();
        }
    }

    #[test]
    fn mutation_operations_decode_selected_payloads() {
        for result in [
            decode_response::<AddComment>(br#"{"data":{"addComment":{"commentEdge":{"node":{"id":"C_1","url":"https://example.test/comment/1"}}}}}"#, "").map(|_| ()),
            decode_response::<UpdateProjectItemField>(br#"{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"PVTI_1"}}}}"#, "").map(|_| ()),
            decode_response::<AddLabels>(br#"{"data":{"addLabelsToLabelable":{"labelable":{"id":"I_1"}}}}"#, "").map(|_| ()),
            decode_response::<RemoveLabels>(br#"{"data":{"removeLabelsFromLabelable":{"labelable":{"id":"I_1"}}}}"#, "").map(|_| ()),
            decode_response::<AddAssignees>(br#"{"data":{"addAssigneesToAssignable":{"assignable":{"id":"I_1"}}}}"#, "").map(|_| ()),
        ] {
            result.unwrap();
        }
    }

    #[test]
    fn fire_and_forget_mutations_accept_missing_payloads() {
        for result in [
            decode_response::<AddComment>(br#"{"data":{}}"#, "").map(|_| ()),
            decode_response::<UpdateProjectItemField>(br#"{"data":{}}"#, "").map(|_| ()),
            decode_response::<AddLabels>(br#"{"data":{}}"#, "").map(|_| ()),
            decode_response::<RemoveLabels>(br#"{"data":{}}"#, "").map(|_| ()),
            decode_response::<AddAssignees>(br#"{"data":{}}"#, "").map(|_| ()),
        ] {
            result.unwrap();
        }
    }
}
