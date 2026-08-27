#!/bin/sh
# Applies one approved, reference-configured triage patch. This is intentionally
# not an Ensemble runtime API or a generic GraphQL wrapper.
set -eu

usage() {
  echo "usage: $0 --repo OWNER/REPO --project-number NUMBER --status-field NAME --issue NUMBER --patch FILE" >&2
  exit 64
}

repo=
project_number=
status_field=
issue_number=
patch=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) repo=${2-}; shift 2 ;;
    --project-number) project_number=${2-}; shift 2 ;;
    --status-field) status_field=${2-}; shift 2 ;;
    --issue) issue_number=${2-}; shift 2 ;;
    --patch) patch=${2-}; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$repo" ] && [ -n "$project_number" ] && [ -n "$status_field" ] && [ -n "$issue_number" ] && [ -n "$patch" ] || usage
[ -r "$patch" ] || { echo "patch is not readable: $patch" >&2; exit 65; }
command -v gh >/dev/null 2>&1 || { echo "gh is required" >&2; exit 69; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 69; }

# The checked-in reference intentionally has a finite policy. Copy and edit this
# file with the configuration; do not turn it into an arbitrary mutation proxy.
allowed_statuses='["Ready to implement"]'
allowed_labels='["needs-triage","ready-for-agent","ready-for-human"]'
approval_status='Triage approved'

jq -e '
  type == "object" and
  (keys | sort) == ["comment", "expected_snapshot", "operations", "version"] and
  .version == 1 and
  (.comment | type == "string" and length > 0) and
  (.expected_snapshot | type == "object" and
    (keys | sort) == ["issue_number", "labels", "project_id", "status"] and
    (.issue_number | type == "number" and floor == . and . > 0) and
    (.project_id | type == "string" and length > 0) and
    (.status | type == "string" and length > 0) and
    (.labels | type == "array" and all(.[]; type == "string" and length > 0) and (length == (unique | length)))) and
  (.operations | type == "array" and length > 0 and
    all(.[]; type == "object" and (keys | sort) == ["type", "value"] and
      (.type == "set_status" or .type == "add_label" or .type == "remove_label") and
      (.value | type == "string" and length > 0)) and
    ([.[] | [.type, .value] | @json] | length == (unique | length)))
' "$patch" >/dev/null || { echo "patch does not satisfy triage-patch schema version 1" >&2; exit 65; }

expected_issue=$(jq -r '.expected_snapshot.issue_number' "$patch")
[ "$expected_issue" = "$issue_number" ] || { echo "patch issue does not match --issue" >&2; exit 65; }
while IFS= read -r operation; do
  type=$(printf '%s' "$operation" | jq -r '.type')
  value=$(printf '%s' "$operation" | jq -r '.value')
  case "$type" in
    set_status) printf '%s' "$allowed_statuses" | jq -e --arg value "$value" 'index($value) != null' >/dev/null || { echo "status is outside reference allowlist" >&2; exit 65; } ;;
    add_label|remove_label) printf '%s' "$allowed_labels" | jq -e --arg value "$value" 'index($value) != null' >/dev/null || { echo "label is outside reference allowlist" >&2; exit 65; } ;;
  esac
done <<EOF
$(jq -c '.operations[]' "$patch")
EOF

owner=${repo%%/*}
name=${repo#*/}
[ -n "$owner" ] && [ -n "$name" ] && [ "$owner" != "$name" ] || { echo "--repo must be OWNER/REPO" >&2; exit 64; }

# This authoritative reread supplies every identity used below. The patch binds
# to it before any mutation is attempted, so stale drafts fail closed.
snapshot_query='query ReferenceTriageSnapshot($owner: String!, $name: String!, $project: Int!, $issue: Int!) {
  repository(owner: $owner, name: $name) {
    projectV2(number: $project) {
      id
      fields(first: 100) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }
    }
    labels(first: 100) { nodes { id name } }
    issue(number: $issue) {
      id number labels(first: 100) { nodes { id name } }
      projectItems(first: 100) {
        nodes {
          id project { id }
          fieldValues(first: 100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { id name } } } } }
        }
      }
    }
  }
}'
snapshot=$(gh api graphql -f query="$snapshot_query" -F owner="$owner" -F name="$name" -F project="$project_number" -F issue="$issue_number")

project_id=$(printf '%s' "$snapshot" | jq -er '.data.repository.projectV2.id')
status_field_id=$(printf '%s' "$snapshot" | jq -er --arg name "$status_field" '[.data.repository.projectV2.fields.nodes[] | select(.name == $name) | .id] | if length == 1 then .[0] else error("status field must resolve exactly once") end')
item_id=$(printf '%s' "$snapshot" | jq -er --arg project "$project_id" '[.data.repository.issue.projectItems.nodes[] | select(.project.id == $project) | .id] | if length == 1 then .[0] else error("project item must resolve exactly once") end')
issue_id=$(printf '%s' "$snapshot" | jq -er '.data.repository.issue.id')
actual_issue=$(printf '%s' "$snapshot" | jq -er '.data.repository.issue.number')
actual_status=$(printf '%s' "$snapshot" | jq -er --arg item "$item_id" --arg field "$status_field_id" '[.data.repository.issue.projectItems.nodes[] | select(.id == $item) | .fieldValues.nodes[] | select(.field.id == $field) | .name] | if length == 1 then .[0] else error("current status must resolve exactly once") end')
actual_labels=$(printf '%s' "$snapshot" | jq -ce '[.data.repository.issue.labels.nodes[].name] | sort')
expected_project=$(jq -r '.expected_snapshot.project_id' "$patch")
expected_status=$(jq -r '.expected_snapshot.status' "$patch")
expected_labels=$(jq -c '.expected_snapshot.labels | sort' "$patch")

[ "$actual_issue" = "$issue_number" ] && [ "$project_id" = "$expected_project" ] && [ "$expected_status" = "$approval_status" ] && [ "$actual_status" = "$expected_status" ] && [ "$actual_labels" = "$expected_labels" ] || {
  echo "patch expected_snapshot does not match the authoritative GitHub reread (issue=$actual_issue project=$project_id status=$actual_status labels=$actual_labels)" >&2
  exit 65
}

# Resolve every target before the first write. `operation_plan` has only finite,
# pre-approved operation kinds and server-derived IDs, in patch source order.
operation_plan=
while IFS= read -r operation; do
  type=$(printf '%s' "$operation" | jq -r '.type')
  value=$(printf '%s' "$operation" | jq -r '.value')
  case "$type" in
    set_status)
      option_id=$(printf '%s' "$snapshot" | jq -er --arg field "$status_field_id" --arg value "$value" '[.data.repository.projectV2.fields.nodes[] | select(.id == $field) | .options[] | select(.name == $value) | .id] | if length == 1 then .[0] else error("status option must resolve exactly once") end')
      operation_plan="${operation_plan}${type}|${option_id}\n"
      ;;
    add_label)
      label_id=$(printf '%s' "$snapshot" | jq -er --arg value "$value" '[.data.repository.labels.nodes[] | select(.name == $value) | .id] | if length == 1 then .[0] else error("label must resolve exactly once") end')
      operation_plan="${operation_plan}${type}|${label_id}\n"
      ;;
    remove_label)
      label_id=$(printf '%s' "$snapshot" | jq -er --arg value "$value" '[.data.repository.labels.nodes[] | select(.name == $value) | .id] | if length == 1 then .[0] else error("label must resolve exactly once") end')
      operation_plan="${operation_plan}${type}|${label_id}\n"
      ;;
  esac
done <<EOF
$(jq -c '.operations[]' "$patch")
EOF

printf '%b' "$operation_plan" | while IFS='|' read -r type target_id; do
  case "$type" in
    set_status)
      gh api graphql -f query='mutation ReferenceTriageSetStatus($project: ID!, $item: ID!, $field: ID!, $option: String!) { updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field, value: {singleSelectOptionId: $option}}) { projectV2Item { id } } }' -F project="$project_id" -F item="$item_id" -F field="$status_field_id" -F option="$target_id" >/dev/null
      ;;
    add_label)
      gh api graphql -f query='mutation ReferenceTriageAddLabels($issue: ID!, $labels: [ID!]!) { addLabelsToLabelable(input: {labelableId: $issue, labelIds: $labels}) { clientMutationId } }' -F issue="$issue_id" -F labels[]="$target_id" >/dev/null
      ;;
    remove_label)
      gh api graphql -f query='mutation ReferenceTriageRemoveLabels($issue: ID!, $labels: [ID!]!) { removeLabelsFromLabelable(input: {labelableId: $issue, labelIds: $labels}) { clientMutationId } }' -F issue="$issue_id" -F labels[]="$target_id" >/dev/null
      ;;
  esac
done
