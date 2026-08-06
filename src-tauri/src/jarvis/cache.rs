use crate::jarvis::documentation::{DocumentationCollector, DocumentationLimits, DocumentMetadata};
use crate::jarvis::types::{CacheStatus, DocumentationContext, DocumentationEntry, OmittedDocument};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone)]
pub struct CachedDocument {
    pub metadata: DocumentMetadata,
    pub entry: DocumentationEntry,
}

#[derive(Debug, Clone)]
struct WorkspaceCacheEntry {
    root: PathBuf,
    documents: BTreeMap<String, CachedDocument>,
    revision: String,
    last_updated: String,
}

#[derive(Debug, Default)]
pub struct ContextCache {
    workspaces: std::collections::HashMap<String, WorkspaceCacheEntry>,
}

#[derive(Debug, Clone)]
pub struct CacheBuildOutput {
    pub context: DocumentationContext,
    pub documents_read: usize,
    pub reused_documents: usize,
    pub removed_documents: usize,
}

impl ContextCache {
    pub fn invalidate(&mut self, workspace_id: &str) {
        self.workspaces.remove(workspace_id);
    }

    pub fn build(
        &mut self,
        workspace_id: &str,
        workspace_root: &Path,
        generated_at: &str,
        limits: &DocumentationLimits,
        cancellation: Option<&CancellationToken>,
    ) -> Result<CacheBuildOutput, crate::jarvis::documentation::DocumentationError> {
        let collector = DocumentationCollector::new(limits.clone());
        let deadline = Instant::now() + limits.timeout;
        let discovery = collector.discover_until(workspace_root, deadline, cancellation)?;
        let root = discovery.root.clone();
        let previous = self.workspaces.get(workspace_id).cloned();
        let root_changed = previous
            .as_ref()
            .is_some_and(|entry| entry.root != root);
        let previous_documents = if root_changed {
            BTreeMap::new()
        } else {
            previous
                .as_ref()
                .map(|entry| entry.documents.clone())
                .unwrap_or_default()
        };

        let mut documents = BTreeMap::new();
        let mut omitted_documents = discovery.omitted_documents;
        let mut warnings = discovery.warnings;
        let mut total_bytes = 0usize;
        let mut documents_read = 0usize;
        let mut reused_documents = 0usize;

        for discovered in discovery.documents {
            if total_bytes >= limits.max_total_bytes {
                omitted_documents.push(OmittedDocument {
                    relative_path: discovered.relative_path,
                    reason: "maximum package byte limit reached".to_string(),
                });
                continue;
            }

            let reusable = previous_documents
                .get(&discovered.relative_path)
                .filter(|cached| cached.metadata == discovered.metadata)
                .cloned();
            let cached = if let Some(cached) = reusable {
                let content_bytes = cached.entry.content.as_bytes().len();
                if total_bytes.saturating_add(content_bytes) <= limits.max_total_bytes {
                    reused_documents += 1;
                    cached
                } else {
                    omitted_documents.push(OmittedDocument {
                        relative_path: discovered.relative_path,
                        reason: "maximum package byte limit reached".to_string(),
                    });
                    continue;
                }
            } else {
                let remaining = limits.max_total_bytes.saturating_sub(total_bytes);
                match collector.read_until(&discovered, remaining, deadline, cancellation) {
                    Ok(read) => {
                        documents_read += 1;
                        CachedDocument {
                            metadata: read.metadata,
                            entry: read.entry,
                        }
                    }
                    Err(error) => {
                        omitted_documents.push(OmittedDocument {
                            relative_path: discovered.relative_path,
                            reason: reason_for_error(&error),
                        });
                        warnings.push("one or more Markdown documents could not be read".to_string());
                        continue;
                    }
                }
            };

            total_bytes = total_bytes.saturating_add(cached.entry.content.as_bytes().len());
            documents.insert(cached.entry.relative_path.clone(), cached);
        }

        let removed_documents = previous_documents
            .keys()
            .filter(|path| !documents.contains_key(*path))
            .count();
        let changed = root_changed
            || previous.is_none()
            || removed_documents > 0
            || documents_read > 0
            || documents.len() != previous_documents.len();
        let cache_status = if root_changed {
            CacheStatus::Invalidated
        } else if previous.is_none() {
            CacheStatus::Miss
        } else if changed {
            CacheStatus::Incremental
        } else {
            CacheStatus::Hit
        };

        let revision = revision_for(&root, &documents);
        let mut document_entries = documents.values().map(|cached| cached.entry.clone()).collect::<Vec<_>>();
        document_entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        omitted_documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        omitted_documents.dedup_by(|left, right| left.relative_path == right.relative_path && left.reason == right.reason);
        warnings.sort();
        warnings.dedup();

        let context = DocumentationContext {
            workspace_id: workspace_id.to_string(),
            workspace_root: root.to_string_lossy().to_string(),
            generated_at: generated_at.to_string(),
            revision: revision.clone(),
            cache_status,
            documents: document_entries,
            omitted_documents,
            warnings,
        };

        self.workspaces.insert(
            workspace_id.to_string(),
            WorkspaceCacheEntry {
                root,
                documents,
                revision,
                last_updated: generated_at.to_string(),
            },
        );

        Ok(CacheBuildOutput {
            context,
            documents_read,
            reused_documents,
            removed_documents,
        })
    }

    pub fn revision(&self, workspace_id: &str) -> Option<String> {
        self.workspaces
            .get(workspace_id)
            .map(|entry| format!("{}@{}", entry.revision, entry.last_updated))
    }
}

fn revision_for(root: &Path, documents: &BTreeMap<String, CachedDocument>) -> String {
    let mut hash = 14_695_981_039_346_656_037u64;
    for byte in root.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(1_099_511_628_211);
    }
    for (path, document) in documents {
        for byte in path
            .as_bytes()
            .iter()
            .chain(document.metadata.metadata_fingerprint.as_bytes())
            .chain(document.entry.content_hash.as_bytes())
        {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(1_099_511_628_211);
        }
    }
    format!("rev-{hash:016x}")
}

fn reason_for_error(error: &crate::jarvis::documentation::DocumentationError) -> String {
    match error {
        crate::jarvis::documentation::DocumentationError::Cancelled => "collection cancelled",
        crate::jarvis::documentation::DocumentationError::Timeout => "collection timeout",
        crate::jarvis::documentation::DocumentationError::Io => "read error",
        _ => "document rejected by path policy",
    }
    .to_string()
}
