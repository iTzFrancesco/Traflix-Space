/// Converts assistant Markdown into deterministic speech text.
///
/// This is intentionally the only normalization boundary in the TTS
/// pipeline. The provider receives the resulting text verbatim and is only
/// responsible for synthesis and playback.
pub fn normalize_for_speech(input: &str, max_chars: usize) -> Option<String> {
    if input.trim().is_empty() || max_chars == 0 {
        return None;
    }

    let visible_lines = input
        .lines()
        .filter(|line| {
            let lowered = line.to_ascii_lowercase();
            !lowered.contains("pending action") && !lowered.contains("diagnostic")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let without_code = strip_code_spans(&visible_lines);
    let without_urls = remove_url_tokens(&extract_markdown_link_text(&without_code));
    let chars = without_urls.chars().collect::<Vec<_>>();
    let mut marked_up = String::with_capacity(without_urls.len());

    for index in 0..chars.len() {
        let character = chars[index];
        if is_apostrophe_between_letters(&chars, index) {
            marked_up.push(character);
        } else if is_speech_delimiter(character) || is_quote_delimiter(character) {
            marked_up.push(' ');
        } else {
            marked_up.push(character);
        }
    }

    let result = collapse_speech_whitespace(&strip_unspeakable_chars(&marked_up));
    if result.is_empty() || !result.chars().any(char::is_alphanumeric) {
        return None;
    }

    truncate_speech_text(&result, max_chars)
}

fn strip_code_spans(input: &str) -> String {
    let chars = input.chars().collect::<Vec<_>>();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;

    while index < chars.len() {
        if chars[index] != '`' {
            output.push(chars[index]);
            index += 1;
            continue;
        }

        let opening_len = backtick_run_length(&chars, index);
        let delimiter_len = opening_len.min(3);
        let mut closing = None;
        let mut search = index + opening_len;
        while search < chars.len() {
            if chars[search] == '`' {
                let run_length = backtick_run_length(&chars, search);
                if run_length >= delimiter_len {
                    closing = Some(search + delimiter_len);
                    break;
                }
                search += run_length;
            } else {
                search += 1;
            }
        }

        output.push(' ');
        index = closing.unwrap_or(chars.len());
    }

    output
}

fn backtick_run_length(chars: &[char], start: usize) -> usize {
    chars[start..]
        .iter()
        .take_while(|character| **character == '`')
        .count()
}

fn extract_markdown_link_text(input: &str) -> String {
    let chars = input.chars().collect::<Vec<_>>();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;

    while index < chars.len() {
        let (bracket_start, is_image) = if chars[index] == '[' {
            (index, false)
        } else if chars[index] == '!' && chars.get(index + 1) == Some(&'[') {
            (index + 1, true)
        } else {
            output.push(chars[index]);
            index += 1;
            continue;
        };

        let Some(close_bracket) = chars[bracket_start + 1..]
            .iter()
            .position(|character| *character == ']')
            .map(|offset| bracket_start + 1 + offset)
        else {
            output.push(chars[index]);
            index += 1;
            continue;
        };

        if chars.get(close_bracket + 1) != Some(&'(') {
            output.push(chars[index]);
            index += 1;
            continue;
        }

        let Some(close_parenthesis) = matching_parenthesis(&chars, close_bracket + 1) else {
            output.push(chars[index]);
            index += 1;
            continue;
        };

        if is_image {
            output.push(' ');
        }
        output.extend(chars[bracket_start + 1..close_bracket].iter());
        output.push(' ');
        index = close_parenthesis + 1;
    }

    output
}

fn matching_parenthesis(chars: &[char], opening: usize) -> Option<usize> {
    let mut depth = 0;
    for (index, character) in chars.iter().enumerate().skip(opening) {
        match character {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn remove_url_tokens(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    for token in input.split_whitespace() {
        let candidate = token.trim_start_matches(['(', '[', '{', '<']);
        let is_url = candidate.starts_with("http://")
            || candidate.starts_with("https://")
            || candidate.starts_with("www.");
        if !is_url {
            if !output.is_empty() {
                output.push(' ');
            }
            output.push_str(token);
            continue;
        }

        let trailing = token
            .chars()
            .rev()
            .take_while(|character| {
                matches!(
                    character,
                    ')' | ']' | '}' | '.' | ',' | ';' | ':' | '!' | '?' | '…'
                )
            })
            .filter(|character| !matches!(character, ')' | ']' | '}'))
            .collect::<Vec<_>>();
        for character in trailing.iter().rev() {
            output.push(*character);
        }
    }
    output
}

fn is_apostrophe_between_letters(chars: &[char], index: usize) -> bool {
    matches!(chars[index], '\'' | '’')
        && index > 0
        && index + 1 < chars.len()
        && chars[index - 1].is_alphabetic()
        && chars[index + 1].is_alphabetic()
}

fn is_speech_delimiter(character: char) -> bool {
    matches!(
        character,
        '*' | '_'
            | '`'
            | '#'
            | '>'
            | '('
            | ')'
            | '['
            | ']'
            | '{'
            | '}'
            | '~'
            | '|'
            | '/'
            | '\\'
            | '@'
            | '$'
            | '%'
            | '&'
            | '+'
            | '='
            | '^'
    )
}

fn is_quote_delimiter(character: char) -> bool {
    matches!(
        character,
        '\'' | '’' | '"' | '“' | '”' | '„' | '«' | '»' | '‹' | '›'
    )
}

fn collapse_speech_whitespace(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    for character in input.chars() {
        if character.is_whitespace() {
            if !output.ends_with(' ') {
                output.push(' ');
            }
        } else if is_prosody_punctuation(character) && output.ends_with(' ') {
            output.pop();
            output.push(character);
        } else {
            output.push(character);
        }
    }
    output.trim().to_string()
}

fn is_prosody_punctuation(character: char) -> bool {
    matches!(character, '.' | ',' | ';' | ':' | '!' | '?' | '…')
}

fn truncate_speech_text(text: &str, max_chars: usize) -> Option<String> {
    if text.chars().count() <= max_chars {
        return Some(text.to_string());
    }

    let prefix = text.chars().take(max_chars).collect::<String>();
    let end = prefix
        .char_indices()
        .rev()
        .find(|(_, character)| is_prosody_punctuation(*character))
        .map(|(index, character)| index + character.len_utf8())
        .unwrap_or(prefix.len());
    let truncated = prefix[..end].trim();
    if truncated.is_empty() {
        None
    } else {
        Some(truncated.to_string())
    }
}

fn strip_unspeakable_chars(text: &str) -> String {
    let sanitized: String = text
        .chars()
        .map(|c| if is_speech_safe_char(c) { c } else { ' ' })
        .collect();
    sanitized.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_speech_safe_char(c: char) -> bool {
    let cp = c as u32;
    if matches!(
        cp,
        0x200C | 0x200D | 0x00AD | 0xFEFF
            | 0xFE00..=0xFE0F
            | 0xE0100..=0xE01EF
            | 0xE000..=0xF8FF
            | 0x2190..=0x2BFF
            | 0x1F000..=0x1FAFF
    ) {
        return false;
    }

    c.is_alphanumeric()
        || c.is_whitespace()
        || matches!(
            c,
            '\'' | '’' | '.' | ',' | ';' | ':' | '!' | '?' | '…' | '-' | '–' | '—' | '−' | '×'
        )
}

#[cfg(test)]
fn assert_speech_text(input: &str, expected: &str) {
    let output = normalize_for_speech(input, 800).unwrap_or_default();
    assert_eq!(output, expected, "input: {input:?}");
}

#[cfg(test)]
mod tests {
    use super::{assert_speech_text, normalize_for_speech};

    #[test]
    fn markdown_code_urls_and_internal_lines_are_removed() {
        let text = "Ciao **Francesco** https://example.com\n```rust\nsecret()\n```\nPending Action: conferma";
        let output = normalize_for_speech(text, 800).unwrap();
        assert_eq!(output, "Ciao Francesco");
    }

    #[test]
    fn markdown_delimiters_are_removed_without_losing_visible_content() {
        assert_speech_text("**codice**.", "codice.");
        assert_speech_text("_corsivo_", "corsivo");
        assert_speech_text("# Titolo", "Titolo");
        assert_speech_text("> Citazione importante.", "Citazione importante.");
        assert_speech_text("Una \"citazione utile\".", "Una citazione utile.");
        assert_speech_text("Parentesi (importante): sì!", "Parentesi importante: sì!");
    }

    #[test]
    fn italian_apostrophes_and_prosody_punctuation_are_preserved() {
        assert_speech_text(
            "L'utente dell'azione, però, è pronto!",
            "L'utente dell'azione, però, è pronto!",
        );
        assert_speech_text(
            "L’utente dell’azione: tutto bene?",
            "L’utente dell’azione: tutto bene?",
        );
    }

    #[test]
    fn markdown_links_keep_visible_text_and_drop_url() {
        assert_speech_text(
            "Leggi [la documentazione](https://example.com/docs).",
            "Leggi la documentazione.",
        );
    }

    #[test]
    fn inline_code_is_omitted_while_surrounding_text_survives() {
        assert_speech_text("Prima `codice_tecnico` dopo.", "Prima dopo.");
        assert_speech_text("Solo `codice_tecnico`", "Solo");
    }

    #[test]
    fn speech_is_bounded_at_sentence_boundary() {
        let output = normalize_for_speech("Prima frase. Seconda frase molto lunga", 20).unwrap();
        assert_eq!(output, "Prima frase.");
    }

    #[test]
    fn emoji_variation_selectors_and_zwj_are_stripped_for_speech() {
        assert_speech_text("Ciao 👋 mondo! 🎉🔥", "Ciao mondo!");
        assert_speech_text("👨\u{200d}👩\u{200d}👧 famiglia", "famiglia");
        assert_speech_text("✔️ Fatto.", "Fatto.");
        assert_speech_text("ciao👋mondo", "ciao mondo");
        assert_speech_text("Perché 2×3? – Sì!…", "Perché 2×3? – Sì!…");
        assert!(normalize_for_speech("🚀🎉🎊", 800).is_none());
    }

    #[test]
    fn empty_speech_is_rejected() {
        assert!(normalize_for_speech("```code```", 800).is_none());
        assert!(normalize_for_speech("https://example.com", 800).is_none());
        assert!(normalize_for_speech("***___###>>>", 800).is_none());
    }
}
