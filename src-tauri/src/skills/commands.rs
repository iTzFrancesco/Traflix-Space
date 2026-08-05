use serde::Serialize;
use std::path::PathBuf;

/// Info su una skill restituita al frontend
#[derive(Debug, Clone, Serialize)]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
}

/// Costruisce il path `{home}\.agents\skills`
fn skills_dir() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let mut path = PathBuf::from(home);
    path.push(".agents");
    path.push("skills");
    Some(path)
}

/// Legge e parsifica una SKILL.md, estraendo nome e descrizione.
fn parse_skill_file(path: &PathBuf) -> Option<(String, String)> {
    let content = std::fs::read_to_string(path).ok()?;
    let content = content.trim();

    // Prova a estrarre frontmatter YAML (tra --- \n ... \n ---)
    if let Some((name, desc)) = parse_frontmatter(content) {
        return Some((name, desc));
    }

    // Fallback: prima riga H1 (# Nome) e prima riga di testo dopo
    let name = content
        .lines()
        .find(|l| l.starts_with("# "))
        .map(|l| l.trim_start_matches("# ").trim().to_string())
        .or_else(|| {
            // Ultimo fallback: nome dal nome cartella
            path.parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .map(|n| n.to_string())
        })?;

    let desc = content
        .lines()
        .skip_while(|l| l.starts_with("#") || l.starts_with("---") || l.trim().is_empty())
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
        .unwrap_or_default();

    Some((name, desc))
}

/// Parsing manuale del frontmatter YAML (solo name e description)
fn parse_frontmatter(content: &str) -> Option<(String, String)> {
    let content = content.trim();
    if !content.starts_with("---") {
        return None;
    }

    let end = content[3..].find("\n---")?;
    let yaml_block = &content[3..3 + end];

    let mut name: Option<String> = None;
    let mut desc: Option<String> = None;

    let lines: Vec<&str> = yaml_block.lines().collect();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index].trim();
        if let Some(val) = line.strip_prefix("name:") {
            name = Some(val.trim().trim_matches(['"', '\'']).to_string());
        } else if let Some(val) = line.strip_prefix("description:") {
            let value = val.trim();
            if value.starts_with('|') || value.starts_with('>') {
                // YAML block descriptions are common in local skills. Keep
                // them compact because the frontend only needs a short card
                // preview, not the complete SKILL.md body.
                let mut parts = Vec::new();
                index += 1;
                while index < lines.len() {
                    let continuation = lines[index].trim();
                    if !continuation.is_empty() {
                        parts.push(continuation);
                    }
                    index += 1;
                }
                desc = Some(parts.join(" "));
                break;
            }
            desc = Some(value.trim_matches(['"', '\'']).to_string());
        }
        index += 1;
    }

    name.map(|n| (n, desc.unwrap_or_default()))
}

/// Scansiona la cartella skills e restituisce la lista di SkillInfo.
pub fn scan_skills() -> Vec<SkillInfo> {
    let dir = match skills_dir() {
        Some(d) => d,
        None => return vec![],
    };

    if !dir.exists() {
        return vec![];
    }

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };

    let mut skills: Vec<SkillInfo> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        // Cerca SKILL.md (case-insensitive: proviamo SKILL.md e skill.md)
        let skill_file = path.join("SKILL.md");
        let skill_file_lower = path.join("skill.md");

        let md_path = if skill_file.exists() {
            skill_file
        } else if skill_file_lower.exists() {
            skill_file_lower
        } else {
            continue;
        };

        // ID = nome cartella
        let id = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.to_string())
            .unwrap_or_default();

        let (name, description) = parse_skill_file(&md_path).unwrap_or_else(|| {
            let fallback_name = id.clone();
            (fallback_name, String::new())
        });

        skills.push(SkillInfo {
            id,
            name,
            description,
            path: md_path.to_string_lossy().to_string(),
        });
    }

    // Ordine alfabetico per nome
    skills.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.to_lowercase().cmp(&b.id.to_lowercase()))
    });

    skills
}

#[tauri::command]
pub fn list_skills() -> Result<Vec<SkillInfo>, String> {
    Ok(scan_skills())
}
