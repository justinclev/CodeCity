package netscan

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
)

var (
	specTop    = regexp.MustCompile(`(?m)^["']?(openapi|swagger)["']?\s*:`)
	yamlPath   = regexp.MustCompile(`^(\s+)["']?(/[^"':]*)["']?\s*:\s*$`)
	yamlMethod = regexp.MustCompile(`^\s+(get|put|post|delete|patch|head|options)\s*:`)
	serverURL  = regexp.MustCompile(`(?m)^\s*-?\s*url\s*:\s*["']?([^"'\s]+)["']?`)
)

func basePathOf(u string) string {
	if i := strings.Index(u, "://"); i >= 0 {
		rest := u[i+3:]
		if j := strings.IndexByte(rest, '/'); j >= 0 {
			u = rest[j:]
		} else {
			return ""
		}
	}
	u = strings.TrimRight(u, "/")
	if strings.HasPrefix(u, "/") && !strings.Contains(u, "{") {
		return u
	}
	return ""
}

// OpenAPI reads the paths of an OpenAPI / Swagger document. They are weak routes: the file may be
// a copy kept for client generation.
func OpenAPI(path string, src []byte) []Route {
	lname := strings.ToLower(path)
	text := string(src)
	var out []Route
	add := func(base, p, m string) {
		out = append(out, Route{Method: strings.ToUpper(m), Route: join(base, p), Weak: true})
	}
	if strings.HasSuffix(lname, ".json") {
		var doc struct {
			Servers  []struct{ URL string } `json:"servers"`
			BasePath string                 `json:"basePath"`
			Paths    map[string]map[string]json.RawMessage
			Openapi  string
			Swagger  string
		}
		if json.Unmarshal(src, &doc) != nil || (doc.Openapi == "" && doc.Swagger == "") {
			return nil
		}
		base := basePathOf(doc.BasePath)
		if len(doc.Servers) > 0 {
			base = basePathOf(doc.Servers[0].URL)
		}
		keys := make([]string, 0, len(doc.Paths))
		for p := range doc.Paths {
			keys = append(keys, p)
		}
		sort.Strings(keys)
		for _, p := range keys {
			for m := range doc.Paths[p] {
				switch strings.ToLower(m) {
				case "get", "put", "post", "delete", "patch", "head", "options":
					add(base, p, m)
				}
			}
		}
		return out
	}
	if !strings.HasSuffix(lname, ".yaml") && !strings.HasSuffix(lname, ".yml") || !specTop.MatchString(text) {
		return nil
	}
	base := ""
	if m := serverURL.FindStringSubmatch(text); m != nil {
		base = basePathOf(m[1])
	}
	inPaths, cur := false, ""
	pathIndent := -1
	for _, ln := range strings.Split(text, "\n") {
		t := strings.TrimSpace(ln)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		if !strings.HasPrefix(ln, " ") && !strings.HasPrefix(ln, "\t") {
			inPaths = strings.HasPrefix(t, "paths:")
			cur = ""
			continue
		}
		if !inPaths {
			continue
		}
		if m := yamlPath.FindStringSubmatch(ln); m != nil && (pathIndent < 0 || len(m[1]) == pathIndent) {
			pathIndent = len(m[1])
			cur = m[2]
			continue
		}
		if m := yamlMethod.FindStringSubmatch(ln); m != nil && cur != "" {
			add(base, cur, m[1])
			cur = cur // the same path may carry several methods
		}
	}
	return out
}
