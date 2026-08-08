use crate::jarvis::types::{DocumentationEntry, OmittedDocument};
use std::cmp::min;
use std::fs::{self, File, Metadata};
use std::io::{self, Read};
#[cfg(test)]
use std::path::Component;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio_util::sync::CancellationToken;

const EXCLUDED_DIRECTORIES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    "vendor",
    ".cache",
    "temp",
    "tmp",
    "__pycache__",
    ".venv",
    "venv",
    "bower_components",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentationError {
    RootResolution,
    RootNotDirectory,
    #[cfg(test)]
    PathTraversal,
    #[cfg(test)]
    NotMarkdown,
    #[cfg(test)]
    SensitivePath,
    #[cfg(test)]
    ExcludedPath,
    #[cfg(test)]
    OutsideWorkspace,
    Timeout,
    Cancelled,
    Io,
}

#[derive(Debug, Clone)]
pub struct DocumentationLimits {
    pub max_documents: usize,
    pub max_bytes_per_document: usize,
    pub max_total_bytes: usize,
    pub max_depth: usize,
    pub timeout: Duration,
}

impl Default for DocumentationLimits {
    fn default() -> Self {
        Self {
            max_documents: 256,
            max_bytes_per_document: 64 * 1024,
            max_total_bytes: 2 * 1024 * 1024,
            max_depth: 16,
            timeout: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentMetadata {
    pub modified_at: String,
    pub metadata_fingerprint: String,
    pub size: u64,
    pub canonical_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct DiscoveredDocument {
    pub relative_path: String,
    pub absolute_path: PathBuf,
    pub metadata: DocumentMetadata,
}

#[derive(Debug, Clone)]
pub struct DiscoveryResult {
    pub root: PathBuf,
    pub documents: Vec<DiscoveredDocument>,
    pub omitted_documents: Vec<OmittedDocument>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ReadDocument {
    pub entry: DocumentationEntry,
    pub metadata: DocumentMetadata,
}

#[derive(Clone)]
pub struct DocumentationCollector {
    limits: DocumentationLimits,
}

impl DocumentationCollector {
    pub fn new(limits: DocumentationLimits) -> Self {
        Self { limits }
    }

    #[cfg(test)]
    pub fn read_markdown(
        &self,
        root: &Path,
        relative_path: &str,
    ) -> Result<DocumentationEntry, DocumentationError> {
        let canonical_root = canonical_root(root)?;
        let relative = Path::new(relative_path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(DocumentationError::PathTraversal);
        }
        if relative.components().any(|component| {
            matches!(component, Component::Normal(name) if is_excluded_directory(&name.to_string_lossy()))
        }) {
            return Err(DocumentationError::ExcludedPath);
        }

        let candidate = canonical_root.join(relative);
        let discovered = self.discover_candidate(&canonical_root, &candidate, relative_path)?;
        self.read_until(
            &discovered,
            self.limits.max_bytes_per_document,
            Instant::now() + self.limits.timeout,
            None,
        )
        .map(|document| document.entry)
    }

    pub(crate) fn discover_until(
        &self,
        root: &Path,
        deadline: Instant,
        cancellation: Option<&CancellationToken>,
    ) -> Result<DiscoveryResult, DocumentationError> {
        let canonical_root = canonical_root(root)?;
        let mut result = DiscoveryResult {
            root: canonical_root.clone(),
            documents: Vec::new(),
            omitted_documents: Vec::new(),
            warnings: Vec::new(),
        };
        self.visit_directory(
            &canonical_root,
            &canonical_root,
            0,
            deadline,
            cancellation,
            &mut result,
        )?;
        result
            .documents
            .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        result
            .omitted_documents
            .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        result.warnings.sort();
        Ok(result)
    }

    pub(crate) fn read_until(
        &self,
        discovered: &DiscoveredDocument,
        max_bytes: usize,
        deadline: Instant,
        cancellation: Option<&CancellationToken>,
    ) -> Result<ReadDocument, DocumentationError> {
        check_budget(deadline, cancellation)?;
        let bytes_to_read = min(
            discovered.metadata.size as usize,
            min(max_bytes, self.limits.max_bytes_per_document),
        );
        let mut file = File::open(&discovered.absolute_path).map_err(|_| DocumentationError::Io)?;
        let mut bytes = Vec::with_capacity(bytes_to_read);
        file.by_ref()
            .take(bytes_to_read as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| DocumentationError::Io)?;
        check_budget(deadline, cancellation)?;

        let truncated = discovered.metadata.size > bytes.len() as u64;
        let content = String::from_utf8_lossy(&bytes).into_owned();
        let entry = DocumentationEntry {
            relative_path: discovered.relative_path.clone(),
            modified_at: discovered.metadata.modified_at.clone(),
            content_hash: content_hash(&bytes, truncated),
            content,
            truncated,
            untrusted: true,
        };
        Ok(ReadDocument {
            entry,
            metadata: discovered.metadata.clone(),
        })
    }

    fn visit_directory(
        &self,
        root: &Path,
        directory: &Path,
        depth: usize,
        deadline: Instant,
        cancellation: Option<&CancellationToken>,
        result: &mut DiscoveryResult,
    ) -> Result<(), DocumentationError> {
        check_budget(deadline, cancellation)?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(directory).map_err(|_| DocumentationError::Io)? {
            match entry {
                Ok(entry) => entries.push(entry),
                Err(_) => result
                    .warnings
                    .push("one or more directory entries could not be inspected".to_string()),
            }
        }
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            check_budget(deadline, cancellation)?;
            let path = entry.path();
            let relative = relative_display(root, &path);
            let file_name = entry.file_name().to_string_lossy().to_string();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    result.omitted_documents.push(OmittedDocument {
                        relative_path: relative,
                        reason: "metadata unavailable".to_string(),
                    });
                    continue;
                }
            };

            if metadata.file_type().is_symlink() {
                match fs::canonicalize(&path) {
                    Ok(target)
                        if target.starts_with(root)
                            && target.is_file()
                            && is_markdown(&file_name)
                            && !is_sensitive_file(&file_name) =>
                    {
                        if result.documents.len() >= self.limits.max_documents {
                            result.omitted_documents.push(OmittedDocument {
                                relative_path: relative,
                                reason: "maximum document count reached".to_string(),
                            });
                            continue;
                        }
                        match fs::metadata(&target).and_then(|target_metadata| {
                            self.document_metadata(&path, &target, &target_metadata)
                        }) {
                            Ok(document_metadata) => result.documents.push(DiscoveredDocument {
                                relative_path: relative,
                                absolute_path: path,
                                metadata: document_metadata,
                            }),
                            Err(_) => result.omitted_documents.push(OmittedDocument {
                                relative_path: relative,
                                reason: "metadata unavailable".to_string(),
                            }),
                        }
                    }
                    Ok(_) => result.omitted_documents.push(OmittedDocument {
                        relative_path: relative,
                        reason: "symlink escapes workspace or is not a Markdown file".to_string(),
                    }),
                    Err(_) => result.omitted_documents.push(OmittedDocument {
                        relative_path: relative,
                        reason: "symlink target unavailable".to_string(),
                    }),
                }
                continue;
            }

            if metadata.is_dir() {
                if is_excluded_directory(&file_name) {
                    result.omitted_documents.push(OmittedDocument {
                        relative_path: relative,
                        reason: "directory excluded".to_string(),
                    });
                    continue;
                }
                if depth >= self.limits.max_depth {
                    result.omitted_documents.push(OmittedDocument {
                        relative_path: relative,
                        reason: "maximum depth reached".to_string(),
                    });
                    continue;
                }
                self.visit_directory(root, &path, depth + 1, deadline, cancellation, result)?;
                continue;
            }

            if is_sensitive_file(&file_name) {
                result.omitted_documents.push(OmittedDocument {
                    relative_path: relative,
                    reason: "credential-like file excluded".to_string(),
                });
                continue;
            }
            if !is_markdown(&file_name) {
                // Source, manifest, configuration and binary files are outside
                // the automatic context by policy. Skip them without creating
                // an unbounded diagnostic list for large repositories.
                continue;
            }
            if result.documents.len() >= self.limits.max_documents {
                result.omitted_documents.push(OmittedDocument {
                    relative_path: relative,
                    reason: "maximum document count reached".to_string(),
                });
                continue;
            }

            let canonical = match fs::canonicalize(&path) {
                Ok(canonical) if canonical.starts_with(root) => canonical,
                Ok(_) => {
                    result.omitted_documents.push(OmittedDocument {
                        relative_path: relative,
                        reason: "path escapes workspace".to_string(),
                    });
                    continue;
                }
                Err(_) => {
                    result.omitted_documents.push(OmittedDocument {
                        relative_path: relative,
                        reason: "path unavailable".to_string(),
                    });
                    continue;
                }
            };
            match self.document_metadata(&path, &canonical, &metadata) {
                Ok(document_metadata) => result.documents.push(DiscoveredDocument {
                    relative_path: relative,
                    absolute_path: path,
                    metadata: document_metadata,
                }),
                Err(_) => result.omitted_documents.push(OmittedDocument {
                    relative_path: relative,
                    reason: "metadata unavailable".to_string(),
                }),
            }
        }
        Ok(())
    }

    #[cfg(test)]
    fn discover_candidate(
        &self,
        root: &Path,
        candidate: &Path,
        relative_path: &str,
    ) -> Result<DiscoveredDocument, DocumentationError> {
        let file_name = candidate
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(DocumentationError::PathTraversal)?;
        if is_sensitive_file(file_name) {
            return Err(DocumentationError::SensitivePath);
        }
        if !is_markdown(file_name) {
            return Err(DocumentationError::NotMarkdown);
        }
        let metadata = fs::symlink_metadata(candidate).map_err(|_| DocumentationError::Io)?;
        let canonical =
            fs::canonicalize(candidate).map_err(|_| DocumentationError::OutsideWorkspace)?;
        if !canonical.starts_with(root) || !canonical.is_file() {
            return Err(DocumentationError::OutsideWorkspace);
        }
        let document_metadata = self
            .document_metadata(candidate, &canonical, &metadata)
            .map_err(|_| DocumentationError::Io)?;
        Ok(DiscoveredDocument {
            relative_path: relative_path.replace('\\', "/"),
            absolute_path: candidate.to_path_buf(),
            metadata: document_metadata,
        })
    }

    fn document_metadata(
        &self,
        _path: &Path,
        canonical: &Path,
        metadata: &Metadata,
    ) -> io::Result<DocumentMetadata> {
        let modified_at = format_system_time(metadata.modified()?);
        let metadata_fingerprint = format!(
            "{}:{}:{}",
            metadata.len(),
            modified_at,
            canonical.to_string_lossy()
        );
        Ok(DocumentMetadata {
            modified_at,
            metadata_fingerprint,
            size: metadata.len(),
            canonical_path: canonical.to_path_buf(),
        })
    }
}

pub fn is_excluded_directory(name: &str) -> bool {
    EXCLUDED_DIRECTORIES
        .iter()
        .any(|excluded| excluded.eq_ignore_ascii_case(name))
}

pub fn is_sensitive_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".env"
        || lower.starts_with(".env.")
        || lower.contains("credential")
        || lower.contains("secret")
        || lower.contains("password")
        || lower.contains("token")
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower == "id_rsa"
}

pub fn is_markdown(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".md")
}

fn canonical_root(root: &Path) -> Result<PathBuf, DocumentationError> {
    let canonical = fs::canonicalize(root).map_err(|_| DocumentationError::RootResolution)?;
    if !canonical.is_dir() {
        return Err(DocumentationError::RootNotDirectory);
    }
    Ok(canonical)
}

fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn check_budget(
    deadline: Instant,
    cancellation: Option<&CancellationToken>,
) -> Result<(), DocumentationError> {
    if cancellation
        .map(|token| token.is_cancelled())
        .unwrap_or(false)
    {
        return Err(DocumentationError::Cancelled);
    }
    if Instant::now() >= deadline {
        return Err(DocumentationError::Timeout);
    }
    Ok(())
}

fn format_system_time(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}.{:09}Z", duration.as_secs(), duration.subsec_nanos())
}

pub(crate) fn content_hash(bytes: &[u8], truncated: bool) -> String {
    let mut hash: u64 = 14_695_981_039_346_656_037;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(1_099_511_628_211);
    }
    if truncated {
        hash ^= 0x5452_554e_4341_5445;
    }
    format!("fnv1a-{hash:016x}")
}
