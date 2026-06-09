use std::io::Write;
use std::path::Path;

use tempfile::NamedTempFile;

/// Write a mock `acpx` shell script to `dir/mock_acpx.sh` and return its path
/// as a string.
///
/// The script is written through a `NamedTempFile` in the same directory and
/// then atomically renamed onto the final path. On Linux (especially overlayfs
/// used by CI runners) a freshly written file can briefly appear
/// open-for-write to the kernel's exec check, causing `Command::spawn` to fail
/// with `ETXTBSY` ("Text file busy"). Persisting from a temp file gives the
/// final path a settled inode that is not associated with any open writer,
/// which avoids the race deterministically.
///
/// `script_content` has its shebang normalised to `#!/bin/bash` so the script
/// does not depend on `/usr/bin/env` being on `PATH` for the spawned process.
pub(crate) fn write_mock_acpx_script(dir: &Path, script_content: &str) -> String {
    let script_path = dir.join("mock_acpx.sh");
    let script_content = script_content.replacen("#!/usr/bin/env bash", "#!/bin/bash", 1);

    let mut temp = NamedTempFile::new_in(dir).unwrap();
    temp.write_all(script_content.as_bytes()).unwrap();
    temp.as_file_mut().sync_all().unwrap();
    let persisted = temp.persist(&script_path).unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    drop(persisted);
    script_path.display().to_string()
}
