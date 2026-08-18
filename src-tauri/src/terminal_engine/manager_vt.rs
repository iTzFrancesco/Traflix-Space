use super::*;

pub(crate) fn convert_vt_cell(vt_cell: &vt100::Cell) -> Cell {
    Cell {
        ch: vt_cell.contents().chars().next().unwrap_or(' '),
        fg: convert_vt_color(&vt_cell.fgcolor()),
        bg: convert_vt_color(&vt_cell.bgcolor()),
        bold: vt_cell.bold(),
        italic: vt_cell.italic(),
        underline: vt_cell.underline(),
        inverse: vt_cell.inverse(),
    }
}

fn convert_vt_color(color: &vt100::Color) -> Color {
    match color {
        vt100::Color::Default => Color::new(204, 204, 204),
        vt100::Color::Idx(idx) => idx_to_rgb(*idx),
        vt100::Color::Rgb(r, g, b) => Color::new(*r, *g, *b),
    }
}

fn idx_to_rgb(idx: u8) -> Color {
    if idx < 16 {
        Color::new(
            ANSI_COLORS[idx as usize][0],
            ANSI_COLORS[idx as usize][1],
            ANSI_COLORS[idx as usize][2],
        )
    } else if idx < 232 {
        let n = (idx - 16) as u16;
        let r = ((n / 36) * 255 / 5) as u8;
        let g = (((n % 36) / 6) * 255 / 5) as u8;
        let b = ((n % 6) * 255 / 5) as u8;
        Color::new(r, g, b)
    } else {
        let gray = (idx - 232) * 255 / 23;
        Color::new(gray, gray, gray)
    }
}

const ANSI_COLORS: [[u8; 3]; 16] = [
    [0, 0, 0],       // Black
    [205, 49, 49],   // Red
    [13, 188, 121],  // Green
    [229, 229, 16],  // Yellow
    [36, 114, 200],  // Blue
    [188, 63, 188],  // Magenta
    [17, 168, 205],  // Cyan
    [229, 229, 229], // White
    [102, 102, 102], // BrightBlack
    [241, 76, 76],   // BrightRed
    [35, 209, 139],  // BrightGreen
    [245, 245, 67],  // BrightYellow
    [59, 142, 234],  // BrightBlue
    [214, 112, 214], // BrightMagenta
    [41, 184, 219],  // BrightCyan
    [229, 229, 229], // BrightWhite
];
