use crate::config::draft::{parse_raw_yaml_with_dotenv, ConfigDocumentState};
use crate::config::setup::{
    resolve_tracker_output_path, SetupArtifacts, SetupRequest, SetupTracker,
};
use crate::error::ConfigError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const JOURNAL_VERSION: u8 = 1;
const STATE_DIR: &str = ".ensemble-state";
const PENDING_DIR: &str = "pending-setup";
const MANIFEST_FILE: &str = "manifest.json";
const RAW_CONFIG_FILE: &str = "config.raw";

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Staged,
    Publishing,
    Published,
    Activated,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum OperationKind {
    Template,
    Todo,
    Dotenv,
}

#[derive(Serialize, Deserialize)]
struct Operation {
    kind: OperationKind,
    destination: PathBuf,
    payload: String,
    payload_digest: String,
    before: Option<String>,
    before_digest: Option<String>,
    before_mode: Option<u32>,
    required_mode: u32,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    version: u8,
    raw_digest: String,
    phase: Phase,
    published_operations: usize,
    operations_digest: String,
    operations: Vec<Operation>,
}

/// Handle to the one private setup generation owned by a config directory.
///
/// It intentionally exposes no `Debug` implementation because its payload may
/// contain a resolved tracker secret.
#[derive(Clone)]
pub struct PendingSetupGeneration {
    config_path: PathBuf,
    journal_dir: PathBuf,
    raw_digest: String,
}

impl PendingSetupGeneration {
    pub fn prepare_candidate(&self, raw_yaml: &str) -> Result<ConfigDocumentState, ConfigError> {
        self.require_digest(raw_yaml)?;
        let manifest = self.load_manifest()?;
        let dotenv = self.staged_dotenv(&manifest)?;
        Ok(parse_raw_yaml_with_dotenv(
            self.config_path.clone(),
            raw_yaml.to_string(),
            &dotenv,
        ))
    }

    pub fn publish(&self, raw_yaml: &str) -> Result<(), ConfigError> {
        self.require_current_config(raw_yaml)?;
        let mut manifest = self.load_manifest()?;
        if manifest.raw_digest != self.raw_digest {
            return Err(transaction_error("pending setup generation changed"));
        }
        match manifest.phase {
            Phase::Activated => return Ok(()),
            Phase::Published => return self.verify_published(&manifest),
            Phase::Staged => {
                manifest.phase = Phase::Publishing;
                self.write_manifest(&manifest)?;
            }
            Phase::Publishing => {}
        }

        for index in manifest.published_operations..manifest.operations.len() {
            let operation = &manifest.operations[index];
            validate_operation_parent(&config_dir(&self.config_path)?, operation)?;
            let payload = read_private_payload(&self.journal_dir, &operation.payload)?;
            write_file_atomically(
                &operation.destination,
                &payload,
                operation.required_mode,
                "setup companion",
            )?;
            manifest.published_operations = index + 1;
            self.write_manifest(&manifest)?;
        }
        manifest.phase = Phase::Published;
        self.write_manifest(&manifest)?;
        self.verify_published(&manifest)
    }

    pub fn finish_activation(&self) -> Result<(), ConfigError> {
        let mut manifest = self.load_manifest()?;
        if manifest.phase != Phase::Published && manifest.phase != Phase::Activated {
            return Err(transaction_error(
                "pending setup generation is not fully published",
            ));
        }
        if manifest.phase == Phase::Published {
            manifest.phase = Phase::Activated;
            self.write_manifest(&manifest)?;
        }
        remove_journal_dir(&self.journal_dir)
    }

    fn staged_dotenv(&self, manifest: &Manifest) -> Result<HashMap<String, String>, ConfigError> {
        let mut dotenv = crate::config::ensemble::read_dotenv(
            &self
                .config_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(".env"),
        );
        let Some(operation) = manifest
            .operations
            .iter()
            .find(|operation| operation.kind == OperationKind::Dotenv)
        else {
            return Ok(dotenv);
        };
        let payload = read_private_payload(&self.journal_dir, &operation.payload)?;
        for item in dotenvy::from_read_iter(payload.as_slice()) {
            let (name, value) = item
                .map_err(|_| transaction_error("pending setup environment payload is malformed"))?;
            dotenv.insert(name, value);
        }
        Ok(dotenv)
    }

    fn verify_published(&self, manifest: &Manifest) -> Result<(), ConfigError> {
        for operation in &manifest.operations {
            let expected = read_private_payload(&self.journal_dir, &operation.payload)?;
            let actual = std::fs::read(&operation.destination).map_err(|error| {
                transaction_error(format!(
                    "failed to verify setup companion '{}': {error}",
                    operation.destination.display()
                ))
            })?;
            if actual != expected {
                return Err(transaction_error(format!(
                    "setup companion '{}' does not match the pending generation",
                    operation.destination.display()
                )));
            }
            verify_mode(&operation.destination, operation.required_mode)?;
        }
        Ok(())
    }

    fn require_current_config(&self, raw_yaml: &str) -> Result<(), ConfigError> {
        self.require_digest(raw_yaml)?;
        let actual = std::fs::read(&self.config_path).map_err(|error| {
            transaction_error(format!(
                "failed to re-read config generation '{}': {error}",
                self.config_path.display()
            ))
        })?;
        if digest_bytes(&actual) != self.raw_digest {
            return Err(transaction_error(
                "config generation changed before setup publication",
            ));
        }
        Ok(())
    }

    fn require_digest(&self, raw_yaml: &str) -> Result<(), ConfigError> {
        if digest_bytes(raw_yaml.as_bytes()) != self.raw_digest {
            return Err(transaction_error(
                "setup candidate does not match the pending generation",
            ));
        }
        Ok(())
    }

    fn load_manifest(&self) -> Result<Manifest, ConfigError> {
        load_manifest(&self.journal_dir, &self.config_path)
    }

    fn write_manifest(&self, manifest: &Manifest) -> Result<(), ConfigError> {
        write_manifest(&self.journal_dir, manifest)
    }
}

/// Stage a setup generation before `config.yaml` is persisted.
pub fn stage_setup_generation(
    config_path: &Path,
    request: &SetupRequest,
    artifacts: &SetupArtifacts,
) -> Result<PendingSetupGeneration, ConfigError> {
    let config_dir = config_dir(config_path)?;
    let state_dir = state_dir(&config_dir);
    ensure_private_dir(&state_dir)?;
    cleanup_orphan_staging_dirs(&state_dir)?;
    let pending_dir = pending_dir(&config_dir);
    let raw_digest = digest_bytes(artifacts.raw_yaml.as_bytes());

    if pending_dir.exists() {
        let existing = load_manifest(&pending_dir, config_path)?;
        if existing.raw_digest == raw_digest
            && pending_payload_matches(&pending_dir, &existing, artifacts)?
        {
            return Ok(PendingSetupGeneration {
                config_path: config_path.to_path_buf(),
                journal_dir: pending_dir,
                raw_digest,
            });
        }
        if existing.phase == Phase::Published || existing.phase == Phase::Activated {
            remove_journal_dir(&pending_dir)?;
        } else {
            recover_mismatched_generation(config_path, &pending_dir, &existing)?;
        }
    }

    let staging = tempfile::Builder::new()
        .prefix(".setup-stage-")
        .tempdir_in(&state_dir)
        .map_err(|error| {
            transaction_error(format!("failed to create setup staging area: {error}"))
        })?;
    set_mode(staging.path(), 0o700, "setup staging directory")?;

    let operations = build_operations(config_path, request, artifacts, staging.path())?;
    preflight_destination_directories(&config_dir, &operations)?;
    write_file_atomically(
        &staging.path().join(RAW_CONFIG_FILE),
        artifacts.raw_yaml.as_bytes(),
        0o600,
        "setup raw config payload",
    )?;
    let manifest = Manifest {
        version: JOURNAL_VERSION,
        raw_digest: raw_digest.clone(),
        phase: Phase::Staged,
        published_operations: 0,
        operations_digest: digest_operations(&operations)?,
        operations,
    };
    write_manifest(staging.path(), &manifest)?;
    sync_directory(staging.path())?;
    let staging_path = staging.keep();
    std::fs::rename(&staging_path, &pending_dir)
        .map_err(|error| transaction_error(format!("failed to publish setup journal: {error}")))?;
    sync_directory(&state_dir)?;

    Ok(PendingSetupGeneration {
        config_path: config_path.to_path_buf(),
        journal_dir: pending_dir,
        raw_digest,
    })
}

fn pending_payload_matches(
    journal_dir: &Path,
    manifest: &Manifest,
    artifacts: &SetupArtifacts,
) -> Result<bool, ConfigError> {
    let Some(expected_dotenv) = artifacts.env_file.as_deref() else {
        // Preserve edits intentionally reuse the resolved secret payload from
        // the persisted pending generation.
        return Ok(true);
    };
    let Some(operation) = manifest
        .operations
        .iter()
        .find(|operation| operation.kind == OperationKind::Dotenv)
    else {
        return Ok(false);
    };
    Ok(read_private_payload(journal_dir, &operation.payload)? == expected_dotenv.as_bytes())
}

fn preflight_destination_directories(
    config_dir: &Path,
    operations: &[Operation],
) -> Result<(), ConfigError> {
    for operation in operations {
        validate_operation_parent(config_dir, operation)?;
        let Some(parent) = operation.destination.parent() else {
            continue;
        };
        std::fs::create_dir_all(parent).map_err(|error| {
            transaction_error(format!(
                "failed to prepare setup destination directory '{}': {error}",
                parent.display()
            ))
        })?;
    }
    Ok(())
}

/// Return the pending generation only when it owns these exact raw config bytes.
pub fn matching_setup_generation(
    config_path: &Path,
    raw_yaml: &str,
) -> Result<Option<PendingSetupGeneration>, ConfigError> {
    let config_dir = config_dir(config_path)?;
    let journal_dir = pending_dir(&config_dir);
    if !journal_dir.exists() {
        return Ok(None);
    }
    let manifest = load_manifest(&journal_dir, config_path)?;
    let raw_digest = digest_bytes(raw_yaml.as_bytes());
    if manifest.raw_digest != raw_digest {
        recover_mismatched_generation(config_path, &journal_dir, &manifest)?;
        return Ok(None);
    }
    Ok(Some(PendingSetupGeneration {
        config_path: config_path.to_path_buf(),
        journal_dir,
        raw_digest,
    }))
}

pub fn has_pending_setup_generation(config_path: &Path) -> Result<bool, ConfigError> {
    let config_dir = config_dir(config_path)?;
    Ok(pending_dir(&config_dir).exists())
}

/// Recover setup filesystem state before any host parses config or opens root resources.
pub fn recover_setup_before_load(config_path: &Path) -> Result<(), ConfigError> {
    let config_dir = config_dir(config_path)?;
    let state_dir = state_dir(&config_dir);
    if state_dir.exists() {
        verify_private_directory(&state_dir)?;
        cleanup_orphan_staging_dirs(&state_dir)?;
    }
    let journal_dir = pending_dir(&config_dir);
    if !journal_dir.exists() {
        return Ok(());
    }
    let manifest = load_manifest(&journal_dir, config_path)?;
    let current = std::fs::read(config_path).ok();
    let matches = current
        .as_deref()
        .is_some_and(|raw| digest_bytes(raw) == manifest.raw_digest);
    if matches {
        let raw = String::from_utf8(current.unwrap())
            .map_err(|_| transaction_error("config generation is not valid UTF-8"))?;
        let generation = PendingSetupGeneration {
            config_path: config_path.to_path_buf(),
            journal_dir,
            raw_digest: manifest.raw_digest,
        };
        generation.publish(&raw)?;
        generation.finish_activation()
    } else {
        recover_mismatched_generation(config_path, &journal_dir, &manifest)
    }
}

fn cleanup_orphan_staging_dirs(state_dir: &Path) -> Result<(), ConfigError> {
    let entries = std::fs::read_dir(state_dir)
        .map_err(|error| transaction_error(format!("failed to inspect setup state: {error}")))?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            transaction_error(format!("failed to inspect setup state: {error}"))
        })?;
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(".setup-stage-") {
            continue;
        }
        let path = entry.path();
        verify_private_directory(&path)?;
        std::fs::remove_dir_all(&path).map_err(|error| {
            transaction_error(format!(
                "failed to remove abandoned setup staging area: {error}"
            ))
        })?;
    }
    sync_directory(state_dir)
}

fn recover_mismatched_generation(
    config_path: &Path,
    journal_dir: &Path,
    manifest: &Manifest,
) -> Result<(), ConfigError> {
    match manifest.phase {
        Phase::Staged | Phase::Activated => remove_journal_dir(journal_dir),
        Phase::Publishing | Phase::Published => {
            let root = config_dir(config_path)?;
            let errors = manifest
                .operations
                .iter()
                .rev()
                .filter_map(|operation| restore_operation(&root, journal_dir, operation).err())
                .map(|error| error.to_string())
                .collect::<Vec<_>>();
            if !errors.is_empty() {
                return Err(transaction_error(format!(
                    "setup rollback failed for {} destination(s): {}",
                    errors.len(),
                    errors.join("; ")
                )));
            }
            remove_journal_dir(journal_dir)
        }
    }
    .map_err(|error| {
        transaction_error(format!(
            "failed to recover setup transaction for '{}': {error}",
            config_path.display()
        ))
    })
}

fn build_operations(
    config_path: &Path,
    request: &SetupRequest,
    artifacts: &SetupArtifacts,
    staging_dir: &Path,
) -> Result<Vec<Operation>, ConfigError> {
    let root = config_dir(config_path)?;
    let mut sources = artifacts
        .templates
        .iter()
        .map(|(relative, contents)| {
            let destination = normalize_absolute(&root.join(relative))?;
            if !destination.starts_with(normalize_absolute(&root.join("templates"))?) {
                return Err(transaction_error(
                    "template destination escapes the setup template directory",
                ));
            }
            Ok((
                OperationKind::Template,
                destination,
                contents.as_bytes(),
                0o644,
            ))
        })
        .collect::<Result<Vec<_>, ConfigError>>()?;

    if let (Some(contents), SetupTracker::TodoFile { path }) =
        (artifacts.todo_md.as_deref(), &request.tracker)
    {
        sources.push((
            OperationKind::Todo,
            normalize_absolute(&resolve_tracker_output_path(path, &root)?)?,
            contents.as_bytes(),
            0o644,
        ));
    }
    if let Some(contents) = artifacts.env_file.as_deref() {
        sources.push((
            OperationKind::Dotenv,
            normalize_absolute(&root.join(".env"))?,
            contents.as_bytes(),
            0o600,
        ));
    }

    sources
        .into_iter()
        .enumerate()
        .map(|(index, (kind, destination, contents, default_mode))| {
            let payload = format!("payload-{index}");
            write_file_atomically(
                &staging_dir.join(&payload),
                contents,
                0o600,
                "setup payload",
            )?;
            let (before, before_digest, before_mode, required_mode) =
                match std::fs::read(&destination) {
                    Ok(contents) => {
                        let before = format!("before-{index}");
                        write_file_atomically(
                            &staging_dir.join(&before),
                            &contents,
                            0o600,
                            "setup before-image",
                        )?;
                        let mode = file_mode(&destination)?;
                        (
                            Some(before),
                            Some(digest_bytes(&contents)),
                            Some(mode),
                            if kind == OperationKind::Dotenv {
                                0o600
                            } else {
                                mode
                            },
                        )
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        (None, None, None, default_mode)
                    }
                    Err(error) => {
                        return Err(transaction_error(format!(
                            "failed to capture setup destination '{}': {error}",
                            destination.display()
                        )))
                    }
                };
            Ok(Operation {
                kind,
                destination,
                payload,
                payload_digest: digest_bytes(contents),
                before,
                before_digest,
                before_mode,
                required_mode,
            })
        })
        .collect()
}

fn restore_operation(
    config_dir: &Path,
    journal_dir: &Path,
    operation: &Operation,
) -> Result<(), ConfigError> {
    validate_operation_parent(config_dir, operation)?;
    let current = match std::fs::symlink_metadata(&operation.destination) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            Some((
                std::fs::read(&operation.destination).map_err(|error| {
                    transaction_error(format!(
                        "failed to inspect setup destination '{}': {error}",
                        operation.destination.display()
                    ))
                })?,
                file_mode(&operation.destination)?,
            ))
        }
        Ok(_) => {
            return Err(transaction_error(format!(
                "setup destination '{}' changed after publication; refusing to overwrite it during rollback",
                operation.destination.display()
            )))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(transaction_error(format!(
                "failed to inspect setup destination '{}': {error}",
                operation.destination.display()
            )))
        }
    };
    let published = read_private_payload(journal_dir, &operation.payload)?;
    let matches_published = current.as_ref().is_some_and(|(contents, mode)| {
        contents == &published && mode_matches(*mode, operation.required_mode)
    });

    let before = operation
        .before
        .as_deref()
        .map(|name| read_private_payload(journal_dir, name))
        .transpose()?;
    let matches_before = match (&current, &before) {
        (None, None) => true,
        (Some((current, mode)), Some(before)) => {
            current == before
                && operation
                    .before_mode
                    .is_some_and(|before_mode| mode_matches(*mode, before_mode))
        }
        _ => false,
    };
    if matches_before {
        return Ok(());
    }
    if !matches_published {
        return Err(transaction_error(format!(
            "setup destination '{}' changed after publication; refusing to overwrite it during rollback",
            operation.destination.display()
        )));
    }

    match before {
        Some(contents) => write_file_atomically(
            &operation.destination,
            &contents,
            operation.before_mode.unwrap_or(0o600),
            "setup before-image",
        ),
        None => match std::fs::remove_file(&operation.destination) {
            Ok(()) => {
                sync_parent(&operation.destination)?;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(transaction_error(format!(
                "failed to remove setup destination '{}': {error}",
                operation.destination.display()
            ))),
        },
    }
}

fn load_manifest(journal_dir: &Path, config_path: &Path) -> Result<Manifest, ConfigError> {
    let parent = journal_dir
        .parent()
        .ok_or_else(|| transaction_error("setup journal has no state directory"))?;
    verify_private_directory(parent)?;
    verify_private_directory(journal_dir)?;
    let manifest_path = journal_dir.join(MANIFEST_FILE);
    verify_private_file(&manifest_path)?;
    let raw = std::fs::read(manifest_path)
        .map_err(|error| transaction_error(format!("failed to read setup journal: {error}")))?;
    let manifest: Manifest = serde_json::from_slice(&raw)
        .map_err(|_| transaction_error("setup journal manifest is malformed"))?;
    if manifest.version != JOURNAL_VERSION {
        return Err(transaction_error("setup journal version is unsupported"));
    }
    if manifest.published_operations > manifest.operations.len() {
        return Err(transaction_error("setup journal progress is invalid"));
    }
    if digest_operations(&manifest.operations)? != manifest.operations_digest {
        return Err(transaction_error("setup journal operation set is invalid"));
    }
    let root = config_dir(config_path)?;
    let template_root = normalize_absolute(&root.join("templates"))?;
    let staged_raw = read_private_payload(journal_dir, RAW_CONFIG_FILE)?;
    if digest_bytes(&staged_raw) != manifest.raw_digest {
        return Err(transaction_error(
            "setup journal raw config digest is invalid",
        ));
    }
    let expected_todo = staged_todo_destination(&staged_raw, &root)?;
    let mut destinations = HashSet::new();
    for (index, operation) in manifest.operations.iter().enumerate() {
        if operation.payload != format!("payload-{index}")
            || operation
                .before
                .as_deref()
                .is_some_and(|name| name != format!("before-{index}"))
            || !operation.destination.is_absolute()
            || normalize_absolute(&operation.destination)? != operation.destination
        {
            return Err(transaction_error("setup journal operation is invalid"));
        }
        if !destinations.insert(operation.destination.clone())
            || operation.before.is_some() != operation.before_mode.is_some()
            || operation.before.is_some() != operation.before_digest.is_some()
        {
            return Err(transaction_error("setup journal operation is invalid"));
        }
        let expected_mode = if operation.kind == OperationKind::Dotenv {
            0o600
        } else {
            operation.before_mode.unwrap_or(0o644)
        };
        if operation.required_mode != expected_mode {
            return Err(transaction_error("setup journal file mode is invalid"));
        }
        match operation.kind {
            OperationKind::Template if !operation.destination.starts_with(&template_root) => {
                return Err(transaction_error(
                    "setup journal template destination is invalid",
                ))
            }
            OperationKind::Dotenv if operation.destination != root.join(".env") => {
                return Err(transaction_error(
                    "setup journal environment destination is invalid",
                ))
            }
            OperationKind::Todo if expected_todo.as_ref() != Some(&operation.destination) => {
                return Err(transaction_error(
                    "setup journal TODO destination is invalid",
                ))
            }
            _ => {}
        }
        validate_operation_parent(&root, operation)?;
        let payload = read_private_payload(journal_dir, &operation.payload)?;
        if digest_bytes(&payload) != operation.payload_digest {
            return Err(transaction_error("setup journal payload digest is invalid"));
        }
        if let Some(before) = &operation.before {
            let before_payload = read_private_payload(journal_dir, before)?;
            if operation.before_digest.as_deref() != Some(digest_bytes(&before_payload).as_str()) {
                return Err(transaction_error(
                    "setup journal before-image digest is invalid",
                ));
            }
        }
    }
    Ok(manifest)
}

fn validate_operation_parent(root: &Path, operation: &Operation) -> Result<(), ConfigError> {
    if operation.kind != OperationKind::Template {
        return Ok(());
    }
    let parent = operation
        .destination
        .parent()
        .ok_or_else(|| transaction_error("setup template destination has no parent"))?;
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| transaction_error("setup template destination escapes config directory"))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(transaction_error(
                    "setup template destination contains a symbolic link",
                ))
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(transaction_error(
                    "setup template destination parent is not a directory",
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => {
                return Err(transaction_error(format!(
                    "failed to inspect setup template destination: {error}"
                )))
            }
        }
    }
    Ok(())
}

fn staged_todo_destination(raw_yaml: &[u8], root: &Path) -> Result<Option<PathBuf>, ConfigError> {
    let document: serde_yaml::Value = serde_yaml::from_slice(raw_yaml)
        .map_err(|_| transaction_error("setup journal raw config is malformed"))?;
    let tracker = document.get("tracker");
    if tracker
        .and_then(|value| value.get("kind"))
        .and_then(serde_yaml::Value::as_str)
        != Some("todo_file")
    {
        return Ok(None);
    }
    let path = tracker
        .and_then(|value| value.get("path"))
        .and_then(serde_yaml::Value::as_str)
        .ok_or_else(|| transaction_error("setup journal TODO config path is missing"))?;
    resolve_tracker_output_path(Path::new(path), root)
        .and_then(|path| normalize_absolute(&path))
        .map(Some)
}

fn write_manifest(journal_dir: &Path, manifest: &Manifest) -> Result<(), ConfigError> {
    let bytes = serde_json::to_vec(manifest)
        .map_err(|_| transaction_error("failed to encode setup journal"))?;
    write_file_atomically(
        &journal_dir.join(MANIFEST_FILE),
        &bytes,
        0o600,
        "setup journal",
    )
}

fn read_private_payload(journal_dir: &Path, name: &str) -> Result<Vec<u8>, ConfigError> {
    let path = journal_dir.join(name);
    verify_private_file(&path)?;
    std::fs::read(&path).map_err(|error| {
        transaction_error(format!("failed to read private setup payload: {error}"))
    })
}

fn write_file_atomically(
    path: &Path,
    contents: &[u8],
    mode: u32,
    label: &str,
) -> Result<(), ConfigError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|error| {
        transaction_error(format!("failed to create {label} directory: {error}"))
    })?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| transaction_error(format!("failed to stage {label}: {error}")))?;
    set_mode(temporary.path(), mode, label)?;
    temporary
        .write_all(contents)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| transaction_error(format!("failed to write {label}: {error}")))?;
    temporary.persist(path).map_err(|error| {
        transaction_error(format!("failed to replace {label}: {}", error.error))
    })?;
    verify_mode(path, mode)?;
    sync_parent(path)
}

fn ensure_private_dir(path: &Path) -> Result<(), ConfigError> {
    if path.exists() {
        return verify_private_directory(path);
    }
    std::fs::create_dir_all(path).map_err(|error| {
        transaction_error(format!("failed to create setup state directory: {error}"))
    })?;
    set_mode(path, 0o700, "setup state directory")
}

fn remove_journal_dir(path: &Path) -> Result<(), ConfigError> {
    std::fs::remove_dir_all(path)
        .map_err(|error| transaction_error(format!("failed to remove setup journal: {error}")))?;
    sync_parent(path)
}

fn state_dir(config_dir: &Path) -> PathBuf {
    config_dir.join(STATE_DIR)
}

fn pending_dir(config_dir: &Path) -> PathBuf {
    state_dir(config_dir).join(PENDING_DIR)
}

fn config_dir(config_path: &Path) -> Result<PathBuf, ConfigError> {
    let parent = config_path
        .parent()
        .ok_or(ConfigError::ConfigDirUnavailable)?;
    normalize_absolute(parent)
}

fn normalize_absolute(path: &Path) -> Result<PathBuf, ConfigError> {
    let absolute = std::path::absolute(path)
        .map_err(|error| transaction_error(format!("failed to normalize setup path: {error}")))?;
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str())
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(transaction_error("setup path escapes the filesystem root"));
                }
            }
        }
    }
    Ok(normalized)
}

fn digest_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn digest_operations(operations: &[Operation]) -> Result<String, ConfigError> {
    let encoded = serde_json::to_vec(operations)
        .map_err(|_| transaction_error("failed to encode setup journal operations"))?;
    Ok(digest_bytes(&encoded))
}

fn transaction_error(reason: impl Into<String>) -> ConfigError {
    ConfigError::ConfigWriteFailed {
        reason: reason.into(),
    }
}

#[cfg(unix)]
fn mode_matches(actual: u32, expected: u32) -> bool {
    actual == expected
}

#[cfg(not(unix))]
fn mode_matches(_actual: u32, _expected: u32) -> bool {
    true
}

#[cfg(unix)]
fn file_mode(path: &Path) -> Result<u32, ConfigError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|metadata| metadata.permissions().mode() & 0o777)
        .map_err(|error| transaction_error(format!("failed to inspect setup file mode: {error}")))
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> Result<u32, ConfigError> {
    Ok(0o600)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32, label: &str) -> Result<(), ConfigError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|error| transaction_error(format!("failed to secure {label}: {error}")))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32, _label: &str) -> Result<(), ConfigError> {
    Ok(())
}

#[cfg(unix)]
fn verify_mode(path: &Path, required: u32) -> Result<(), ConfigError> {
    let actual = file_mode(path)?;
    if actual != required {
        return Err(transaction_error(format!(
            "private setup state has unsafe permissions at '{}'",
            path.display()
        )));
    }
    Ok(())
}

fn verify_private_file(path: &Path) -> Result<(), ConfigError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        transaction_error(format!("failed to inspect private setup state: {error}"))
    })?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(transaction_error(
            "private setup state is not a regular file",
        ));
    }
    verify_mode(path, 0o600)
}

fn verify_private_directory(path: &Path) -> Result<(), ConfigError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        transaction_error(format!("failed to inspect private setup state: {error}"))
    })?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(transaction_error("private setup state is not a directory"));
    }
    verify_mode(path, 0o700)
}

#[cfg(not(unix))]
fn verify_mode(_path: &Path, _required: u32) -> Result<(), ConfigError> {
    Ok(())
}

fn sync_parent(path: &Path) -> Result<(), ConfigError> {
    if let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), ConfigError> {
    std::fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| transaction_error(format!("failed to flush setup directory: {error}")))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), ConfigError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::secrets::{SecretDisplay, SecretEdit, SecretValue};
    use crate::config::setup::{SetupAgent, SetupStep};

    fn github_request(token: &str) -> SetupRequest {
        SetupRequest {
            tracker: SetupTracker::GitHub {
                repository: "owner/repo".to_string(),
                project_number: Some(1),
                status_field: Some("Status".to_string()),
                api_key: SecretDisplay::Unset,
                api_key_edit: SecretEdit::SetEnvironment {
                    variable: "GITHUB_TOKEN".to_string(),
                },
                api_token: Some(SecretValue::new(token)),
                active_states: vec!["Ready".to_string()],
                terminal_states: vec!["Done".to_string()],
            },
            repos: vec![],
            agents: vec![SetupAgent {
                role: "builder".to_string(),
                acpx_agent: "codex".to_string(),
                model: None,
                reasoning_level: None,
                permission_mode: None,
                prompt: None,
                prompt_file: Some("templates/build.liquid".to_string()),
            }],
            steps: vec![SetupStep {
                name: "build".to_string(),
                agent_role: "builder".to_string(),
                kind: None,
                depends: Some(vec![]),
                tracker_state: None,
                artifact_snapshot: None,
                artifact_inputs: Vec::new(),
                artifact_access: Default::default(),
                gate: None,
                route: None,
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        }
    }

    fn todo_request(root: &Path) -> SetupRequest {
        SetupRequest {
            tracker: SetupTracker::TodoFile {
                path: root.join("nested/TODO.md"),
            },
            repos: vec![],
            agents: vec![SetupAgent {
                role: "builder".to_string(),
                acpx_agent: "codex".to_string(),
                model: None,
                reasoning_level: None,
                permission_mode: None,
                prompt: None,
                prompt_file: Some("templates/build.liquid".to_string()),
            }],
            steps: vec![SetupStep {
                name: "build".to_string(),
                agent_role: "builder".to_string(),
                kind: None,
                depends: Some(vec![]),
                tracker_state: None,
                artifact_snapshot: None,
                artifact_inputs: Vec::new(),
                artifact_access: Default::default(),
                gate: None,
                route: None,
            }],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        }
    }

    #[test]
    fn pending_setup_generation_is_private_and_prepares_staged_dotenv() {
        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("config.yaml");
        let request = github_request("secret-value");
        let artifacts = crate::config::setup::build_setup_artifacts(&request);
        let generation = stage_setup_generation(&config_path, &request, &artifacts).unwrap();

        #[cfg(unix)]
        {
            assert_eq!(file_mode(&generation.journal_dir).unwrap(), 0o700);
            let manifest = generation.load_manifest().unwrap();
            assert!(manifest.operations.iter().all(|operation| {
                file_mode(&generation.journal_dir.join(&operation.payload)).unwrap() == 0o600
            }));
        }
        let candidate = generation.prepare_candidate(&artifacts.raw_yaml).unwrap();
        let config = candidate.active_config.unwrap();
        assert_eq!(config.tracker.api_key.as_deref(), Some("secret-value"));
        assert!(config
            .agents
            .get("builder")
            .unwrap()
            .prompt_template
            .as_ref()
            .unwrap()
            .ends_with("templates/build.liquid"));
        assert!(
            !format!("{}", generation.load_manifest().unwrap().version).contains("secret-value")
        );
    }

    #[test]
    fn pending_setup_generation_recovers_published_generation_forward() {
        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("config.yaml");
        let request = github_request("secret-value");
        let artifacts = crate::config::setup::build_setup_artifacts(&request);
        let generation = stage_setup_generation(&config_path, &request, &artifacts).unwrap();
        crate::config::draft::persist_config_atomically(&config_path, &artifacts.raw_yaml).unwrap();
        generation.publish(&artifacts.raw_yaml).unwrap();

        recover_setup_before_load(&config_path).unwrap();

        assert!(!generation.journal_dir.exists());
        assert_eq!(
            std::fs::read_to_string(root.path().join(".env")).unwrap(),
            "GITHUB_TOKEN=secret-value\n"
        );
    }

    #[test]
    fn setup_generation_entrypoint_startup_recovers_before_config_parse() {
        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("config.yaml");
        let request = github_request("secret-value");
        let artifacts = crate::config::setup::build_setup_artifacts(&request);
        let generation = stage_setup_generation(&config_path, &request, &artifacts).unwrap();
        crate::config::draft::persist_config_atomically(&config_path, &artifacts.raw_yaml).unwrap();

        let document = crate::config::draft::recover_and_load_config_state(&config_path).unwrap();

        assert_eq!(
            document
                .active_config
                .as_ref()
                .unwrap()
                .tracker
                .api_key
                .as_deref(),
            Some("secret-value")
        );
        assert!(!generation.journal_dir.exists());
    }

    #[test]
    fn pending_setup_generation_rolls_back_mismatched_published_generation() {
        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("config.yaml");
        std::fs::write(root.path().join(".env"), "GITHUB_TOKEN=old\n").unwrap();
        set_mode(&root.path().join(".env"), 0o600, "test dotenv").unwrap();
        let request = github_request("secret-value");
        let artifacts = crate::config::setup::build_setup_artifacts(&request);
        let generation = stage_setup_generation(&config_path, &request, &artifacts).unwrap();
        crate::config::draft::persist_config_atomically(&config_path, &artifacts.raw_yaml).unwrap();
        generation.publish(&artifacts.raw_yaml).unwrap();
        crate::config::draft::persist_config_atomically(&config_path, "tracker: invalid\n")
            .unwrap();

        recover_setup_before_load(&config_path).unwrap();

        assert_eq!(
            std::fs::read_to_string(root.path().join(".env")).unwrap(),
            "GITHUB_TOKEN=old\n"
        );
        assert!(!generation.journal_dir.exists());
    }

    #[test]
    fn pending_setup_generation_does_not_overwrite_externally_rotated_environment() {
        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("config.yaml");
        let dotenv_path = root.path().join(".env");
        std::fs::write(&dotenv_path, "GITHUB_TOKEN=old\n").unwrap();
        set_mode(&dotenv_path, 0o600, "test dotenv").unwrap();
        let request = github_request("candidate");
        let artifacts = crate::config::setup::build_setup_artifacts(&request);
        let generation = stage_setup_generation(&config_path, &request, &artifacts).unwrap();
        crate::config::draft::persist_config_atomically(&config_path, &artifacts.raw_yaml).unwrap();
        generation.publish(&artifacts.raw_yaml).unwrap();
        std::fs::write(&dotenv_path, "GITHUB_TOKEN=rotated\n").unwrap();
        set_mode(&dotenv_path, 0o600, "test dotenv").unwrap();
        crate::config::draft::persist_config_atomically(&config_path, "tracker: invalid\n")
            .unwrap();

        let error = recover_setup_before_load(&config_path).unwrap_err();

        assert!(error.to_string().contains("refusing to overwrite"));
        assert!(!error.to_string().contains("candidate"));
        assert_eq!(
            std::fs::read_to_string(&dotenv_path).unwrap(),
            "GITHUB_TOKEN=rotated\n"
        );
        assert!(generation.journal_dir.exists());
    }

    #[cfg(unix)]
    #[test]
    fn pending_setup_generation_does_not_follow_externally_replaced_environment_symlink() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let config_path = root.path().join("config.yaml");
        let dotenv_path = root.path().join(".env");
        let request = github_request("candidate");
        let artifacts = crate::config::setup::build_setup_artifacts(&request);
        let generation = stage_setup_generation(&config_path, &request, &artifacts).unwrap();
        crate::config::draft::persist_config_atomically(&config_path, &artifacts.raw_yaml).unwrap();
        generation.publish(&artifacts.raw_yaml).unwrap();
        std::fs::remove_file(&dotenv_path).unwrap();
        let outside_dotenv = outside.path().join(".env");
        std::fs::write(&outside_dotenv, artifacts.env_file.as_ref().unwrap()).unwrap();
        set_mode(&outside_dotenv, 0o600, "test dotenv").unwrap();
        symlink(&outside_dotenv, &dotenv_path).unwrap();
        crate::config::draft::persist_config_atomically(&config_path, "tracker: invalid\n")
            .unwrap();

        let error = recover_setup_before_load(&config_path).unwrap_err();

        assert!(error.to_string().contains("refusing to overwrite"));
        assert!(dotenv_path.is_symlink());
        assert_eq!(
            std::fs::read_to_string(&outside_dotenv).unwrap(),
            artifacts.env_file.unwrap()
        );
        assert!(generation.journal_dir.exists());
    }

    #[test]
    fn pending_setup_generation_mismatch_restores_environment_before_reparse() {
        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("config.yaml");
        std::fs::write(root.path().join(".env"), "GITHUB_TOKEN=old\n").unwrap();
        set_mode(&root.path().join(".env"), 0o600, "test dotenv").unwrap();
        let request = github_request("candidate");
        let artifacts = crate::config::setup::build_setup_artifacts(&request);
        let generation = stage_setup_generation(&config_path, &request, &artifacts).unwrap();
        crate::config::draft::persist_config_atomically(&config_path, &artifacts.raw_yaml).unwrap();
        generation.publish(&artifacts.raw_yaml).unwrap();
        let external_raw = format!("{}\n", artifacts.raw_yaml);
        crate::config::draft::persist_config_atomically(&config_path, &external_raw).unwrap();

        assert!(matching_setup_generation(&config_path, &external_raw)
            .unwrap()
            .is_none());
        let reparsed = crate::config::draft::load_config_state(&config_path).unwrap();

        assert_eq!(
            reparsed
                .active_config
                .as_ref()
                .unwrap()
                .tracker
                .api_key
                .as_deref(),
            Some("old")
        );
    }

    #[test]
    fn pending_setup_generation_rejects_digest_mismatch_without_secret_diagnostic() {
        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("config.yaml");
        let request = github_request("do-not-leak");
        let artifacts = crate::config::setup::build_setup_artifacts(&request);
        let generation = stage_setup_generation(&config_path, &request, &artifacts).unwrap();

        let error = generation.prepare_candidate("different").unwrap_err();

        assert!(!error.to_string().contains("do-not-leak"));
    }

    #[test]
    fn pending_setup_preparation_keeps_final_todo_and_template_paths() {
        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("config.yaml");
        let request = todo_request(root.path());
        let artifacts = crate::config::setup::build_setup_artifacts(&request);
        let generation = stage_setup_generation(&config_path, &request, &artifacts).unwrap();

        let candidate = generation.prepare_candidate(&artifacts.raw_yaml).unwrap();
        let config = candidate.active_config.unwrap();

        assert_eq!(
            config.tracker.path.as_deref(),
            Some(root.path().join("nested/TODO.md").as_path())
        );
        assert!(config
            .agents
            .get("builder")
            .unwrap()
            .prompt_template
            .as_ref()
            .unwrap()
            .ends_with("templates/build.liquid"));
        assert!(root.path().join("nested").is_dir());
        assert!(!root.path().join("nested/TODO.md").exists());
    }

    #[test]
    fn pending_setup_generation_recovers_forward_after_each_replacement() {
        for interrupted_after in 0..=2 {
            let root = tempfile::tempdir().unwrap();
            let config_path = root.path().join("config.yaml");
            let request = todo_request(root.path());
            let artifacts = crate::config::setup::build_setup_artifacts(&request);
            let generation = stage_setup_generation(&config_path, &request, &artifacts).unwrap();
            crate::config::draft::persist_config_atomically(&config_path, &artifacts.raw_yaml)
                .unwrap();
            let mut manifest = generation.load_manifest().unwrap();
            manifest.phase = Phase::Publishing;
            for (index, operation) in manifest
                .operations
                .iter()
                .take(interrupted_after)
                .enumerate()
            {
                let payload =
                    read_private_payload(&generation.journal_dir, &operation.payload).unwrap();
                write_file_atomically(
                    &operation.destination,
                    &payload,
                    operation.required_mode,
                    "test companion",
                )
                .unwrap();
                manifest.published_operations = index + 1;
            }
            generation.write_manifest(&manifest).unwrap();

            recover_setup_before_load(&config_path).unwrap();

            assert!(!generation.journal_dir.exists());
            assert!(root.path().join("templates/build.liquid").exists());
            assert!(root.path().join("nested/TODO.md").exists());
        }
    }

    #[test]
    fn pending_setup_generation_rejects_unknown_and_malformed_manifests() {
        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("config.yaml");
        let request = github_request("do-not-leak");
        let artifacts = crate::config::setup::build_setup_artifacts(&request);
        let generation = stage_setup_generation(&config_path, &request, &artifacts).unwrap();
        let mut manifest = generation.load_manifest().unwrap();
        manifest.version = JOURNAL_VERSION + 1;
        generation.write_manifest(&manifest).unwrap();

        let error = recover_setup_before_load(&config_path).unwrap_err();
        assert!(error.to_string().contains("unsupported"));
        assert!(!error.to_string().contains("do-not-leak"));

        write_file_atomically(
            &generation.journal_dir.join(MANIFEST_FILE),
            b"{not-json",
            0o600,
            "test manifest",
        )
        .unwrap();
        let error = recover_setup_before_load(&config_path).unwrap_err();
        assert!(error.to_string().contains("malformed"));
        assert!(!error.to_string().contains("do-not-leak"));
    }

    #[test]
    fn pending_setup_generation_rejects_untrusted_destination_changes() {
        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("config.yaml");
        let request = todo_request(root.path());
        let artifacts = crate::config::setup::build_setup_artifacts(&request);
        let generation = stage_setup_generation(&config_path, &request, &artifacts).unwrap();
        let mut manifest = generation.load_manifest().unwrap();
        manifest.operations[0].destination = config_path.clone();
        generation.write_manifest(&manifest).unwrap();

        let error = generation
            .prepare_candidate(&artifacts.raw_yaml)
            .unwrap_err();

        assert!(error.to_string().contains("operation set"));
        assert!(!config_path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn pending_setup_generation_rejects_symlinked_template_parent() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), root.path().join("templates")).unwrap();
        let config_path = root.path().join("config.yaml");
        let request = todo_request(root.path());
        let artifacts = crate::config::setup::build_setup_artifacts(&request);

        let error = match stage_setup_generation(&config_path, &request, &artifacts) {
            Ok(_) => panic!("symlinked template parent should be rejected"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("symbolic link"));
        assert!(!outside.path().join("build.liquid").exists());
    }

    #[cfg(unix)]
    #[test]
    fn pending_setup_generation_fails_closed_on_unsafe_payload_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("config.yaml");
        let request = github_request("do-not-leak");
        let artifacts = crate::config::setup::build_setup_artifacts(&request);
        let generation = stage_setup_generation(&config_path, &request, &artifacts).unwrap();
        let manifest = generation.load_manifest().unwrap();
        let payload = generation.journal_dir.join(&manifest.operations[0].payload);
        std::fs::set_permissions(&payload, std::fs::Permissions::from_mode(0o644)).unwrap();

        let error = generation
            .prepare_candidate(&artifacts.raw_yaml)
            .unwrap_err();

        assert!(error.to_string().contains("unsafe permissions"));
        assert!(!error.to_string().contains("do-not-leak"));
    }

    #[test]
    fn pending_setup_generation_rejects_payload_mutation_and_operation_omission() {
        let root = tempfile::tempdir().unwrap();
        let config_path = root.path().join("config.yaml");
        let request = github_request("do-not-leak");
        let artifacts = crate::config::setup::build_setup_artifacts(&request);
        let generation = stage_setup_generation(&config_path, &request, &artifacts).unwrap();
        let manifest = generation.load_manifest().unwrap();
        write_file_atomically(
            &generation.journal_dir.join(&manifest.operations[0].payload),
            b"mutated",
            0o600,
            "test payload",
        )
        .unwrap();

        let error = generation
            .prepare_candidate(&artifacts.raw_yaml)
            .unwrap_err();
        assert!(error.to_string().contains("payload digest"));

        let generation = {
            remove_journal_dir(&generation.journal_dir).unwrap();
            stage_setup_generation(&config_path, &request, &artifacts).unwrap()
        };
        let mut manifest = generation.load_manifest().unwrap();
        manifest.operations.pop();
        generation.write_manifest(&manifest).unwrap();

        let error = generation
            .prepare_candidate(&artifacts.raw_yaml)
            .unwrap_err();
        assert!(error.to_string().contains("operation set"));
        assert!(!error.to_string().contains("do-not-leak"));
    }
}
