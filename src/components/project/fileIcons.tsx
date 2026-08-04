import {
  File,
  FileCode2,
  FileJson,
  FileText,
  type LucideIcon,
} from "lucide-react";

const CODE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "jsx",
  "php",
  "py",
  "rs",
  "sh",
  "sql",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yml",
  "yaml",
  "zsh",
]);

const DATA_EXTENSIONS = new Set(["json", "jsonc", "toml", "ini", "env"]);
const TEXT_EXTENSIONS = new Set(["md", "mdx", "txt", "log", "csv", "rtf"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);

export function fileExtension(name: string): string {
  const basename = name.replace(/\\/g, "/").split("/").pop() ?? name;
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? basename.slice(dot + 1).toLowerCase() : "";
}

export function getFileIcon(name: string): LucideIcon {
  const extension = fileExtension(name);
  if (CODE_EXTENSIONS.has(extension)) return FileCode2;
  if (DATA_EXTENSIONS.has(extension)) return FileJson;
  if (TEXT_EXTENSIONS.has(extension)) return FileText;
  return File;
}

export function isPreviewableImage(name: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(name));
}
