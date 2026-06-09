use std::io::Write;
use std::path::Path;

/// Write a mock `acpx` shell script to `dir/mock_acpx.sh` and return its path
/// as a string.
///
/// `script_content` has its shebang normalised to `#!/bin/bash` so the script
/// does not depend on `/usr/bin/env` being on `PATH` for the spawned process.
pub(crate) fn write_mock_acpx_script(dir: &Path, script_content: &str) -> String {
    let script_path = dir.join("mock_acpx.sh");
    let script_content = script_content.replacen("#!/usr/bin/env bash", "#!/bin/bash", 1);

    {
        let mut file = std::fs::File::create(&script_path).unwrap();
        file.write_all(script_content.as_bytes()).unwrap();
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    script_path.display().to_string()
}
