This step receives the immutable triage-draft Artifact only after the configured `Triage approved`
status event is fresh, allowlisted, and durably authorized. The exact approved patch is between
these markers:

BEGIN APPROVED TRIAGE PATCH
{{ dependency_outputs[0].output_json }}
END APPROVED TRIAGE PATCH

Write only that exact JSON value to a workspace file, then invoke
`/absolute/path/to/github-project-drain/tools/apply-triage-patch.sh` with that file and the explicit
repository, Project, status-field, and issue arguments. Replace this placeholder with the installed
helper's absolute path when copying the bundle. Do not reconstruct or modify the patch, and do not
use `gh` for any other mutation.
