use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use ensemble_core::config::ensemble::{
    load_config, validate_config, ArtifactAccess, AuthorizationHandoffMode, StepKind,
};

fn example_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/examples/github-project-drain")
}

#[test]
fn github_project_drain_reference_is_a_complete_public_configuration_bundle() {
    let root = example_root();
    let config = load_config(&root.join("config.yaml")).expect("reference config loads");

    assert!(config.uses_workflow_selection());
    validate_config(&config).expect("reference config uses supported public contracts");
    assert_eq!(
        config
            .pipelines
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "delivery",
            "epic-closure",
            "human-attention",
            "planning",
            "triage"
        ]
    );

    let planning = &config.pipelines["planning"];
    let plan = planning
        .steps
        .iter()
        .find(|step| step.name == "draft-plan")
        .expect("planning drafts an Artifact");
    assert!(plan.artifact_snapshot.is_some());
    let plan_route = planning
        .steps
        .iter()
        .find(|step| step.name == "route-plan-outcome")
        .expect("planning routes the draft result");
    assert_eq!(plan_route.kind, StepKind::Route);
    assert_eq!(
        plan_route
            .route
            .as_ref()
            .unwrap()
            .cases
            .keys()
            .collect::<Vec<_>>(),
        ["operator_required", "revision"]
    );
    assert_eq!(
        plan_route.route.as_ref().unwrap().terminals["revision"].state,
        "Ready to implement"
    );
    assert_eq!(
        plan_route.route.as_ref().unwrap().terminals["operator_required"].state,
        "Needs human"
    );
    let acknowledgement = planning
        .steps
        .iter()
        .find(|step| step.name == "acknowledge-plan-revision")
        .expect("planning waits for acknowledgement");
    assert_eq!(acknowledgement.artifact_inputs, ["draft-plan"]);
    assert_eq!(acknowledgement.artifact_access, ArtifactAccess::Immutable);
    assert_eq!(
        acknowledgement
            .authorization
            .as_ref()
            .expect("acknowledgement is status-event authorized")
            .handoff,
        AuthorizationHandoffMode::WaitForEvent
    );

    let delivery = &config.pipelines["delivery"];
    let gate = delivery
        .steps
        .iter()
        .find(|step| step.name == "delivery-gate")
        .expect("delivery has a deterministic gate");
    assert_eq!(gate.kind, StepKind::Gate);
    for name in ["review", "verify"] {
        let assessment = delivery
            .steps
            .iter()
            .find(|step| step.name == name)
            .expect("delivery assessment exists");
        assert_eq!(assessment.artifact_inputs, ["implement"]);
        assert_eq!(assessment.artifact_access, ArtifactAccess::Immutable);
    }

    let triage = &config.pipelines["triage"];
    let triage_applier = triage
        .steps
        .iter()
        .find(|step| step.name == "apply-triage-patch")
        .expect("triage has an applier");
    assert!(triage_applier.approval.is_none());
    assert_eq!(triage_applier.artifact_inputs, ["draft-triage-patch"]);
    assert_eq!(triage_applier.artifact_access, ArtifactAccess::Immutable);
    let triage_authorization = triage_applier
        .authorization
        .as_ref()
        .expect("triage applier is authorized before dispatch");
    assert_eq!(
        triage_authorization.handoff,
        AuthorizationHandoffMode::WaitForEvent
    );
    assert!(triage_authorization.after_artifact);
    assert_eq!(triage_authorization.event.value, "Triage approved");
    assert_eq!(triage_authorization.event.actors, ["example-maintainer"]);
    assert_eq!(triage.on_success, "Ready to implement");
    assert!(config.scheduler.lanes["triage"].idle_only);
    assert!(config.scheduler.lanes["human-attention"].idle_only);
    for state in ["Triage approved", "Awaiting review", "Awaiting merge"] {
        assert!(config.tracker.active_states.contains(&state.to_string()));
    }
    let epic = &config.pipelines["epic-closure"];
    let epic_route = epic
        .steps
        .iter()
        .find(|step| step.name == "route-epic-outcome")
        .expect("epic closure has an outcome route");
    assert_eq!(
        epic_route.route.as_ref().unwrap().terminals["close"].state,
        "Done"
    );
    assert_eq!(
        epic_route.route.as_ref().unwrap().terminals["attention"].state,
        "Needs human"
    );
    assert_eq!(config.pipelines["human-attention"].on_success, "Human hold");
    let delivery_selection = config
        .workflow_selection
        .iter()
        .find(|rule| rule.name == "delivery")
        .expect("delivery selection exists");
    assert_eq!(
        delivery_selection.labels_none.as_deref(),
        Some(["epic".to_string()].as_slice())
    );
    assert!(root.join("tools/apply-triage-patch.sh").is_file());
    let helper =
        fs::read_to_string(root.join("tools/apply-triage-patch.sh")).expect("triage helper exists");
    assert!(helper.contains("-F labels[]"));
    assert!(helper.contains("ReferenceTriageRepositoryLabels"));
    let triage_apply_prompt = fs::read_to_string(root.join("prompts/triage-apply.md"))
        .expect("triage applier prompt exists");
    assert!(triage_apply_prompt.contains("{{ dependency_outputs[0].output_json }}"));
    let triage_schema: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(root.join("schemas/triage-patch.schema.json"))
            .expect("triage schema exists"),
    )
    .expect("triage schema is JSON");
    let triage_validator =
        jsonschema::validator_for(&triage_schema).expect("triage schema compiles");
    assert!(triage_validator
        .validate(
            &serde_json::from_str(&patch_document(
                "Triage approved",
                "set_status",
                "Ready to implement",
            ))
            .unwrap(),
        )
        .is_ok());
    assert!(triage_validator
        .validate(
            &serde_json::from_str(&patch_document("Triage approved", "set_status", "Backlog",))
                .unwrap(),
        )
        .is_err());

    let guide = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/github-project-drain.md"),
    )
    .expect("canonical guide exists");
    for asset in [
        "examples/github-project-drain/config.yaml",
        "examples/github-project-drain/tools/apply-triage-patch.sh",
        "PVTSSF_example_status",
        "wait_for_event",
        "automatic_transition",
    ] {
        assert!(guide.contains(asset), "guide links or explains {asset}");
    }
    for guide_name in ["configuration.md", "pipelines.md"] {
        assert!(fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs")
                .join(guide_name),
        )
        .expect("guide exists")
        .contains("github-project-drain.md"));
    }
}

#[cfg(unix)]
#[test]
fn triage_helper_rejects_invalid_stale_and_out_of_policy_patches_before_mutation() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().expect("temporary fixture");
    let patch_path = root.path().join("patch.json");
    let log_path = root.path().join("gh.log");
    let bin_dir = root.path().join("bin");
    fs::create_dir(&bin_dir).expect("mock bin directory");
    let gh_path = bin_dir.join("gh");
    fs::write(
        &gh_path,
        r#"#!/bin/sh
printf '%s\n' "$*" >> "$GH_LOG"
case "$*" in
  *ReferenceTriageSnapshot*) cat "$GH_SNAPSHOT" ;;
  *) exit 0 ;;
esac
"#,
    )
    .expect("mock gh");
    fs::set_permissions(&gh_path, fs::Permissions::from_mode(0o755)).expect("executable gh");

    let snapshot_path = root.path().join("snapshot.json");
    fs::write(&snapshot_path, fixture_snapshot()).expect("snapshot response");
    let script = example_root().join("tools/apply-triage-patch.sh");

    let run = |patch: &str| {
        fs::write(&patch_path, patch).expect("patch fixture");
        let mut command = Command::new(&script);
        command
            .args([
                "--repo",
                "example/ensemble",
                "--project-number",
                "6",
                "--status-field",
                "Status",
                "--issue",
                "42",
                "--patch",
                patch_path.to_str().expect("utf-8 patch path"),
            ])
            .env("GH_LOG", &log_path)
            .env("GH_SNAPSHOT", &snapshot_path)
            .env(
                "PATH",
                format!("{}:{}", bin_dir.display(), std::env::var("PATH").unwrap()),
            );
        command.status().expect("helper starts")
    };

    assert!(!run("{not json").success());
    assert!(fs::read_to_string(&log_path).unwrap_or_default().is_empty());

    fs::write(&log_path, "").unwrap();
    assert!(!run(&patch_document(
        "Different status",
        "set_status",
        "Ready to implement"
    ))
    .success());
    let stale_log = fs::read_to_string(&log_path).expect("stale read was logged");
    assert!(stale_log.contains("ReferenceTriageSnapshot"));
    assert!(!stale_log.contains("ReferenceTriageSetStatus"));

    fs::write(&log_path, "").unwrap();
    assert!(!run(&patch_document("Triage approved", "set_status", "Done")).success());
    assert!(fs::read_to_string(&log_path).unwrap_or_default().is_empty());

    fs::write(&log_path, "").unwrap();
    assert!(!run(&patch_document("Triage approved", "set_status", "Backlog")).success());
    assert!(fs::read_to_string(&log_path).unwrap_or_default().is_empty());

    fs::write(&log_path, "").unwrap();
    fs::write(
        &snapshot_path,
        fixture_snapshot().replace(
            "        { \"id\": \"LABEL_agent\", \"name\": \"ready-for-agent\" },\n",
            "",
        ),
    )
    .unwrap();
    assert!(!run(r#"{
  "version": 1,
  "comment": "Later target is unavailable.",
  "expected_snapshot": {
    "issue_number": 42,
    "project_id": "PVT_reference",
    "status": "Triage approved",
    "labels": ["needs-triage"]
  },
  "operations": [
    { "type": "set_status", "value": "Ready to implement" },
    { "type": "add_label", "value": "ready-for-agent" }
  ]
}"#,)
    .success());
    let unavailable_log = fs::read_to_string(&log_path).unwrap();
    assert!(unavailable_log.contains("ReferenceTriageSnapshot"));
    assert!(!unavailable_log.contains("ReferenceTriageSetStatus"));

    let assert_ambiguous_target_is_write_free = |snapshot: serde_json::Value, patch: String| {
        fs::write(
            &snapshot_path,
            serde_json::to_vec_pretty(&snapshot).unwrap(),
        )
        .unwrap();
        fs::write(&log_path, "").unwrap();
        assert!(!run(&patch).success());
        let log = fs::read_to_string(&log_path).unwrap();
        assert!(log.contains("ReferenceTriageSnapshot"));
        for mutation in [
            "ReferenceTriageSetStatus",
            "ReferenceTriageAddLabels",
            "ReferenceTriageRemoveLabels",
        ] {
            assert!(
                !log.contains(mutation),
                "ambiguous target wrote via {mutation}"
            );
        }
    };

    let status_patch = patch_document("Triage approved", "set_status", "Ready to implement");
    let label_patch = patch_document("Triage approved", "add_label", "ready-for-agent");

    let mut duplicate_field: serde_json::Value = serde_json::from_str(fixture_snapshot()).unwrap();
    let field = duplicate_field["data"]["repository"]["projectV2"]["fields"]["nodes"][0].clone();
    duplicate_field["data"]["repository"]["projectV2"]["fields"]["nodes"]
        .as_array_mut()
        .unwrap()
        .push(field);
    assert_ambiguous_target_is_write_free(duplicate_field, status_patch.clone());

    let mut duplicate_item: serde_json::Value = serde_json::from_str(fixture_snapshot()).unwrap();
    let item = duplicate_item["data"]["repository"]["issue"]["projectItems"]["nodes"][0].clone();
    duplicate_item["data"]["repository"]["issue"]["projectItems"]["nodes"]
        .as_array_mut()
        .unwrap()
        .push(item);
    assert_ambiguous_target_is_write_free(duplicate_item, status_patch.clone());

    let mut duplicate_option: serde_json::Value = serde_json::from_str(fixture_snapshot()).unwrap();
    let option = duplicate_option["data"]["repository"]["projectV2"]["fields"]["nodes"][0]
        ["options"][2]
        .clone();
    duplicate_option["data"]["repository"]["projectV2"]["fields"]["nodes"][0]["options"]
        .as_array_mut()
        .unwrap()
        .push(option);
    assert_ambiguous_target_is_write_free(duplicate_option, status_patch);

    let mut duplicate_label: serde_json::Value = serde_json::from_str(fixture_snapshot()).unwrap();
    let label = duplicate_label["data"]["repository"]["labels"]["nodes"][1].clone();
    duplicate_label["data"]["repository"]["labels"]["nodes"]
        .as_array_mut()
        .unwrap()
        .push(label);
    assert_ambiguous_target_is_write_free(duplicate_label, label_patch);
}

#[cfg(unix)]
#[test]
fn triage_helper_applies_only_the_configured_status_and_label_operations() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().expect("temporary fixture");
    let patch_path = root.path().join("patch.json");
    let log_path = root.path().join("gh.log");
    let snapshot_path = root.path().join("snapshot.json");
    let bin_dir = root.path().join("bin");
    fs::create_dir(&bin_dir).expect("mock bin directory");
    let gh_path = bin_dir.join("gh");
    fs::write(
        &gh_path,
        r#"#!/bin/sh
printf '%s\n' "$*" >> "$GH_LOG"
case "$*" in
  *ReferenceTriageSnapshot*) cat "$GH_SNAPSHOT" ;;
  *) exit 0 ;;
esac
"#,
    )
    .expect("mock gh");
    fs::set_permissions(&gh_path, fs::Permissions::from_mode(0o755)).expect("executable gh");
    fs::write(&snapshot_path, fixture_snapshot()).expect("snapshot response");
    fs::write(
        &patch_path,
        r#"{
  "version": 1,
  "comment": "Approved triage patch.",
  "expected_snapshot": {
    "issue_number": 42,
    "project_id": "PVT_reference",
    "status": "Triage approved",
    "labels": ["needs-triage"]
  },
  "operations": [
    { "type": "set_status", "value": "Ready to implement" },
    { "type": "remove_label", "value": "needs-triage" },
    { "type": "add_label", "value": "ready-for-agent" }
  ]
}"#,
    )
    .expect("approved patch");

    let status = Command::new(example_root().join("tools/apply-triage-patch.sh"))
        .args([
            "--repo",
            "example/ensemble",
            "--project-number",
            "6",
            "--status-field",
            "Status",
            "--issue",
            "42",
            "--patch",
            patch_path.to_str().expect("utf-8 patch path"),
        ])
        .env("GH_LOG", &log_path)
        .env("GH_SNAPSHOT", &snapshot_path)
        .env(
            "PATH",
            format!("{}:{}", bin_dir.display(), std::env::var("PATH").unwrap()),
        )
        .status()
        .expect("helper starts");
    assert!(status.success());
    let log = fs::read_to_string(log_path).expect("gh calls are logged");
    for operation in [
        "ReferenceTriageSnapshot",
        "ReferenceTriageSetStatus",
        "ReferenceTriageRemoveLabels",
        "ReferenceTriageAddLabels",
    ] {
        assert!(log.contains(operation), "helper invokes {operation}: {log}");
    }
}

#[cfg(unix)]
#[test]
fn triage_helper_resolves_an_allowlisted_label_beyond_the_first_repository_page() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().expect("temporary fixture");
    let patch_path = root.path().join("patch.json");
    let log_path = root.path().join("gh.log");
    let snapshot_path = root.path().join("snapshot.json");
    let labels_page_path = root.path().join("labels-page.json");
    let bin_dir = root.path().join("bin");
    fs::create_dir(&bin_dir).expect("mock bin directory");
    let gh_path = bin_dir.join("gh");
    fs::write(
        &gh_path,
        r#"#!/bin/sh
printf '%s\n' "$*" >> "$GH_LOG"
case "$*" in
  *ReferenceTriageSnapshot*) cat "$GH_SNAPSHOT" ;;
  *ReferenceTriageRepositoryLabels*) cat "$GH_LABELS_PAGE" ;;
  *) exit 0 ;;
esac
"#,
    )
    .expect("mock gh");
    fs::set_permissions(&gh_path, fs::Permissions::from_mode(0o755)).expect("executable gh");

    let mut snapshot: serde_json::Value = serde_json::from_str(fixture_snapshot()).unwrap();
    let first_page = (0..100)
        .map(|index| serde_json::json!({ "id": format!("LABEL_{index}"), "name": format!("label-{index}") }))
        .collect::<Vec<_>>();
    snapshot["data"]["repository"]["labels"]["nodes"] = serde_json::Value::Array(first_page);
    snapshot["data"]["repository"]["labels"]["pageInfo"] = serde_json::json!({
        "hasNextPage": true,
        "endCursor": "LABEL_CURSOR_1"
    });
    fs::write(&snapshot_path, serde_json::to_vec(&snapshot).unwrap()).expect("snapshot");
    fs::write(
        &labels_page_path,
        serde_json::json!({
            "data": {
                "repository": {
                    "labels": {
                        "nodes": [{ "id": "LABEL_agent", "name": "ready-for-agent" }],
                        "pageInfo": { "hasNextPage": false, "endCursor": null }
                    }
                }
            }
        })
        .to_string(),
    )
    .expect("second labels page");
    fs::write(
        &patch_path,
        patch_document("Triage approved", "add_label", "ready-for-agent"),
    )
    .expect("approved patch");

    let status = Command::new(example_root().join("tools/apply-triage-patch.sh"))
        .args([
            "--repo",
            "example/ensemble",
            "--project-number",
            "6",
            "--status-field",
            "Status",
            "--issue",
            "42",
            "--patch",
            patch_path.to_str().expect("utf-8 patch path"),
        ])
        .env("GH_LOG", &log_path)
        .env("GH_SNAPSHOT", &snapshot_path)
        .env("GH_LABELS_PAGE", &labels_page_path)
        .env(
            "PATH",
            format!("{}:{}", bin_dir.display(), std::env::var("PATH").unwrap()),
        )
        .status()
        .expect("helper starts");

    assert!(status.success());
    let log = fs::read_to_string(log_path).expect("gh calls are logged");
    assert!(log.contains("ReferenceTriageRepositoryLabels"));
    assert!(log.contains("LABEL_CURSOR_1"));
    assert!(log.contains("ReferenceTriageAddLabels"));
}

fn patch_document(status: &str, operation: &str, value: &str) -> String {
    format!(
        r#"{{
  "version": 1,
  "comment": "Triage patch.",
  "expected_snapshot": {{
    "issue_number": 42,
    "project_id": "PVT_reference",
        "status": "{status}",
    "labels": ["needs-triage"]
  }},
  "operations": [{{ "type": "{operation}", "value": "{value}" }}]
}}"#
    )
}

fn fixture_snapshot() -> &'static str {
    r#"{
  "data": {
    "repository": {
      "projectV2": {
        "id": "PVT_reference",
        "fields": { "nodes": [{
          "id": "PVTSSF_reference_status",
          "name": "Status",
          "options": [
            { "id": "OPT_backlog", "name": "Backlog" },
            { "id": "OPT_triage_approved", "name": "Triage approved" },
            { "id": "OPT_ready", "name": "Ready to implement" }
          ]
        }] }
      },
      "labels": { "nodes": [
        { "id": "LABEL_triage", "name": "needs-triage" },
        { "id": "LABEL_agent", "name": "ready-for-agent" },
        { "id": "LABEL_human", "name": "ready-for-human" }
      ], "pageInfo": { "hasNextPage": false, "endCursor": null } },
      "issue": {
        "id": "ISSUE_42",
        "number": 42,
        "labels": { "nodes": [{ "id": "LABEL_triage", "name": "needs-triage" }] },
        "projectItems": { "nodes": [{
          "id": "ITEM_42",
          "project": { "id": "PVT_reference" },
          "fieldValues": { "nodes": [{
            "name": "Triage approved",
            "field": { "id": "PVTSSF_reference_status", "name": "Status" }
          }] }
        }] }
      }
    }
  }
}"#
}
