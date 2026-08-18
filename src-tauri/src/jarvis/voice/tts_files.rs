use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) fn temp_audio_path(request_id: &str) -> PathBuf {
    let safe_id: String = request_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .take(64)
        .collect();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!("traflix-jarvis-{safe_id}-{nanos}.mp3"))
}

pub(super) fn normalize_windows_extended_prefix(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(stripped) = value.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

pub(super) fn canonical_temp_file(path: &Path) -> Option<PathBuf> {
    let root = normalize_windows_extended_prefix(std::fs::canonicalize(std::env::temp_dir()).ok()?);
    let file = normalize_windows_extended_prefix(std::fs::canonicalize(path).ok()?);
    if !file.is_file() || !file.starts_with(&root) {
        return None;
    }
    Some(file)
}

pub(crate) fn cleanup_temp_file(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::{canonical_temp_file, cleanup_temp_file, normalize_windows_extended_prefix};
    use std::fs;

    #[test]
    fn generated_temp_path_is_canonicalized_and_bounded_to_temp_root() {
        let path = std::env::temp_dir().join("traflix-jarvis-path-test.mp3");
        let _ = fs::remove_file(&path);
        fs::write(&path, b"mp3").unwrap();
        let canonical = canonical_temp_file(&path).unwrap();
        let expected = normalize_windows_extended_prefix(fs::canonicalize(&path).unwrap());
        assert_eq!(canonical, expected);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn cleanup_is_idempotent_for_success_and_all_failure_paths() {
        for suffix in ["success", "helper", "json", "playback", "cancel"] {
            let path = std::env::temp_dir().join(format!("traflix-jarvis-cleanup-{suffix}.mp3"));
            let _ = fs::remove_file(&path);
            fs::write(&path, b"mp3").unwrap();
            cleanup_temp_file(&path);
            cleanup_temp_file(&path);
            assert!(!path.exists());
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_extended_prefix_is_normalized_before_exact_path_comparison() {
        let normal = std::path::PathBuf::from(r"C:\Temp\jarvis.mp3");
        let extended = std::path::PathBuf::from(r"\\?\C:\Temp\jarvis.mp3");
        assert_eq!(normalize_windows_extended_prefix(extended), normal);
    }
}
