package scan

import (
	"path"
	"strings"
)

var byExt = map[string]string{
	".go": "Go", ".py": "Python", ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript",
	".ts": "TypeScript", ".tsx": "TypeScript", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin",
	".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".cxx": "C++", ".hpp": "C++", ".hh": "C++",
	".cs": "C#", ".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".m": "Objective-C", ".scala": "Scala",
	".sh": "Shell", ".bash": "Shell", ".zsh": "Shell", ".ps1": "PowerShell", ".lua": "Lua", ".dart": "Dart",
	".ex": "Elixir", ".exs": "Elixir", ".erl": "Erlang", ".hs": "Haskell", ".clj": "Clojure", ".zig": "Zig",
	".html": "HTML", ".htm": "HTML", ".css": "CSS", ".scss": "CSS", ".sass": "CSS", ".less": "CSS",
	".vue": "Vue", ".svelte": "Svelte", ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
	".xml": "XML", ".md": "Markdown", ".mdx": "Markdown", ".sql": "SQL", ".proto": "Protobuf",
	".tf": "Terraform", ".hcl": "Terraform", ".gradle": "Gradle", ".r": "R", ".jl": "Julia",
	".txt": "Text", ".cfg": "Config", ".ini": "Config", ".mod": "Go",
}

var byName = map[string]string{
	"Makefile": "Makefile", "Dockerfile": "Docker", "CMakeLists.txt": "CMake", "Gemfile": "Ruby", "Rakefile": "Ruby",
}

// Language returns a display language for a path ("Other" if unknown).
func Language(p string) string {
	base := path.Base(p)
	if l, ok := byName[base]; ok {
		return l
	}
	if strings.HasPrefix(base, "Dockerfile") {
		return "Docker"
	}
	if l, ok := byExt[strings.ToLower(path.Ext(base))]; ok {
		return l
	}
	return "Other"
}
