package netscan

import (
	"regexp"
	"strings"
)

// Request URLs that start from an environment variable: the variable is resolved to the URL
// configured for the repository (.env files, docker-compose, Kubernetes manifests, Dockerfiles);
// when it is not configured, the variable's name gives the target a host hint (ORDERS_SERVICE_URL → "orders").

const envRef = `(?:process\.env\.(\w+)|process\.env\[\s*["'](\w+)["']\s*\]|import\.meta\.env\.(\w+)|os\.Getenv\(\s*"(\w+)"\s*\)|os\.environ(?:\.get)?[\[(]\s*["'](\w+)["'][^\])]*[\])]|os\.getenv\(\s*["'](\w+)["'][^)]*\)|System\.getenv\(\s*"(\w+)"\s*\)|Environment\.GetEnvironmentVariable\(\s*"(\w+)"\s*\))`

var (
	envPath   = `(/[\w/\-.{}:$%]*)`
	envConcat = regexp.MustCompile(envRef + `\s*(?:\)\s*)?(?:\}\s*)?\s*(?:\+\s*)?["'` + "`" + `]?` + envPath)
	envSprint = regexp.MustCompile(`Sprintf\(\s*"%s` + envPath + `"\s*,\s*` + envRef)
	// KEY=value (dotenv, Dockerfile ENV, compose list items)
	envLine = regexp.MustCompile(`(?m)^\s*(?:-\s*)?(?:ENV\s+|export\s+)?([A-Z][A-Z0-9_]*)\s*[=:]\s*["']?([^"'\n#]*?)["']?\s*(?:#.*)?$`)
	envK8s  = regexp.MustCompile(`(?m)^\s*-?\s*name:\s*["']?([A-Z][A-Z0-9_]*)["']?\s*\n\s*value:\s*["']?([^"'\n]*?)["']?\s*$`)
)

func varIn(m []string, from int) string {
	for _, g := range m[from:] {
		if g != "" {
			return g
		}
	}
	return ""
}

// hostHint turns ORDERS_SERVICE_URL into "orders".
func hostHint(v string) string {
	w := strings.ToLower(v)
	for _, suf := range []string{"_base_url", "_service_url", "_service_host", "_api_url", "_endpoint", "_address", "_addr", "_host", "_url", "_uri", "_api", "_base", "_service", "_svc", "_server"} {
		w = strings.TrimSuffix(w, suf)
	}
	for _, pre := range []string{"vite_", "next_public_", "react_app_", "api_"} {
		w = strings.TrimPrefix(w, pre)
	}
	w = strings.ReplaceAll(w, "_", "-")
	if len(w) < 3 || w == "api" || w == "base" || w == "backend" || w == "server" || w == "service" {
		return ""
	}
	return w
}

func baseFor(name string, env map[string]string) string {
	if v, ok := env[name]; ok && isURL(v) {
		return strings.TrimRight(v, "/")
	}
	if h := hostHint(name); h != "" {
		return "http://" + h
	}
	return ""
}

func envCalls(text string, env map[string]string) []Call {
	var out []Call
	for _, m := range envConcat.FindAllStringSubmatch(text, -1) {
		if base := baseFor(varIn(m, 1), env); base != "" && len(m) > 0 {
			out = append(out, Call{URL: base + m[len(m)-1]})
		}
	}
	for _, m := range envSprint.FindAllStringSubmatch(text, -1) {
		if base := baseFor(varIn(m, 2), env); base != "" {
			out = append(out, Call{URL: base + m[1]})
		}
	}
	return out
}

// Env collects the URL-valued variables a configuration file defines.
func Env(path string, src []byte) map[string]string {
	name := path[strings.LastIndexByte(path, '/')+1:]
	lname := strings.ToLower(name)
	yaml := strings.HasSuffix(lname, ".yaml") || strings.HasSuffix(lname, ".yml")
	switch {
	case lname == ".env" || strings.HasPrefix(lname, ".env.") || strings.HasSuffix(lname, ".env") || lname == "dockerfile" || strings.HasPrefix(lname, "dockerfile.") || yaml || lname == "values.yaml":
	default:
		return nil
	}
	text := string(src)
	out := map[string]string{}
	if yaml && !strings.Contains(text, "environment") && !strings.Contains(text, "env:") && !strings.Contains(text, "kind:") {
		return nil
	}
	for _, m := range envLine.FindAllStringSubmatch(text, -1) {
		if v := strings.TrimSpace(m[2]); isURL(v) {
			out[m[1]] = v
		}
	}
	for _, m := range envK8s.FindAllStringSubmatch(text, -1) {
		if isURL(m[2]) {
			out[m[1]] = m[2]
		}
	}
	return out
}

var (
	composeSvc = regexp.MustCompile(`(?m)^  ([a-zA-Z0-9][\w.-]*):\s*$`)
	k8sKind    = regexp.MustCompile(`(?m)^kind:\s*Service\s*$`)
	k8sName    = regexp.MustCompile(`(?m)^  name:\s*["']?([\w.-]+)["']?\s*$`)
)

// Aliases lists the network names a configuration file gives services: docker-compose service
// names and the names of Kubernetes Service objects. A request to http://<alias>/... then names the
// repository that defines the alias.
func Aliases(path string, src []byte) []string {
	name := strings.ToLower(path[strings.LastIndexByte(path, '/')+1:])
	text := string(src)
	var out []string
	switch {
	case strings.HasPrefix(name, "docker-compose") || strings.HasPrefix(name, "compose."):
		if i := strings.Index(text, "\nservices:"); i >= 0 || strings.HasPrefix(text, "services:") {
			rest := text[max(i, 0):]
			rest = rest[strings.Index(rest, "services:")+9:]
			if j := regexp.MustCompile(`(?m)^\S`).FindStringIndex(rest[1:]); j != nil {
				rest = rest[:j[0]+1]
			}
			for _, m := range composeSvc.FindAllStringSubmatch(rest, -1) {
				out = append(out, m[1])
			}
		}
	case strings.HasSuffix(name, ".yaml") || strings.HasSuffix(name, ".yml"):
		for _, doc := range strings.Split(text, "\n---") {
			if k8sKind.MatchString(doc) {
				if m := k8sName.FindStringSubmatch(doc); m != nil {
					out = append(out, m[1])
				}
			}
		}
	}
	return out
}
