package deps

import (
	"sort"
	"strings"
	"testing"
)

func depNames(ds []Dep) string {
	var s []string
	for _, d := range ds {
		s = append(s, d.Kind+":"+d.Name)
	}
	sort.Strings(s)
	return strings.Join(s, " ")
}

func TestGoMod(t *testing.T) {
	ids, ds := Manifest("go.mod", []byte(`module github.com/acme/app

go 1.22

require github.com/acme/lib v1.2.3 // indirect
require (
	golang.org/x/sync v0.1.0
	github.com/other/thing v0.0.1
)
replace github.com/acme/lib => ../lib
replace example.com/a => github.com/fork/a v1.0.0
`))
	if len(ids) != 1 || ids[0].Name != "github.com/acme/app" || ids[0].Dir != "" {
		t.Errorf("ids = %+v", ids)
	}
	if got := depNames(ds); got != "go:github.com/acme/lib go:github.com/fork/a go:github.com/other/thing go:golang.org/x/sync" {
		t.Errorf("deps = %s", got)
	}
}

func TestPackageJSON(t *testing.T) {
	ids, ds := Manifest("packages/web/package.json", []byte(`{
  "name": "@acme/Web",
  "dependencies": {"express": "^4", "@acme/core": "workspace:*", "tool": "github:Acme/Tool#v2"},
  "devDependencies": {"vite": "8"}
}`))
	if len(ids) != 1 || ids[0].Name != "@acme/web" || ids[0].Dir != "packages/web" {
		t.Errorf("ids = %+v", ids)
	}
	if got := depNames(ds); got != "git:github.com/acme/tool npm:@acme/core npm:express npm:tool npm:vite" {
		t.Errorf("deps = %s", got)
	}
}

func TestCargo(t *testing.T) {
	ids, ds := Manifest("Cargo.toml", []byte(`[package]
name = "my-app"

[dependencies]
serde = { version = "1", features = ["derive"] }
my-lib = { git = "https://github.com/acme/my-lib.git" }

[dependencies.tokio]
version = "1"

[target.'cfg(unix)'.dependencies]
nix = "0.27"
`))
	if len(ids) != 1 || ids[0].Name != "my_app" {
		t.Errorf("ids = %+v", ids)
	}
	if got := depNames(ds); got != "cargo:my_lib cargo:nix cargo:serde cargo:tokio git:github.com/acme/my-lib" {
		t.Errorf("deps = %s", got)
	}
}

func TestPython(t *testing.T) {
	ids, ds := Manifest("pyproject.toml", []byte(`[project]
name = "Acme-Tools"
dependencies = [
  "requests>=2.0",
  "acme_core[extra] ; python_version > '3.8'",
]
`))
	if len(ids) != 1 || ids[0].Name != "acme_tools" {
		t.Errorf("ids = %+v", ids)
	}
	if got := depNames(ds); got != "python:acme_core python:requests" {
		t.Errorf("deps = %s", got)
	}
	_, ds = Manifest("requirements-dev.txt", []byte("# c\nflask==3.0\n-e git+https://github.com/acme/core.git#egg=acme-core\n-r base.txt\n"))
	if got := depNames(ds); got != "git:github.com/acme/core python:acme_core python:flask" {
		t.Errorf("requirements = %s", got)
	}
	ids, ds = Manifest("setup.py", []byte("setup(\n  name='acme-x',\n  install_requires=['numpy>=1', \"acme-core\"],\n)"))
	if len(ids) != 1 || ids[0].Name != "acme_x" || depNames(ds) != "python:acme_core python:numpy" {
		t.Errorf("setup.py = %+v %s", ids, depNames(ds))
	}
	mods := PythonModules([]string{"acme/__init__.py", "src/widgets/__init__.py", "tests/__init__.py", "acme/sub/__init__.py"})
	if len(mods) != 2 || mods[0].Name != "acme" || mods[1].Name != "widgets" || mods[1].Dir != "src/widgets" {
		t.Errorf("modules = %+v", mods)
	}
}

func TestGitmodulesAndURLs(t *testing.T) {
	_, ds := Manifest(".gitmodules", []byte("[submodule \"x\"]\n\tpath = x\n\turl = git@github.com:Acme/X.git\n"))
	if got := depNames(ds); got != "git:github.com/acme/x" {
		t.Errorf("submodule = %s", got)
	}
	for in, want := range map[string]string{
		"https://github.com/acme/lib":           "github.com/acme/lib",
		"https://user@github.com/acme/lib.git/": "github.com/acme/lib",
		"ssh://git@gitlab.com:22/acme/lib.git":  "gitlab.com/acme/lib",
		"git+https://github.com/acme/lib#v1":    "github.com/acme/lib",
		"gitlab:acme/lib":                       "gitlab.com/acme/lib",
		"github.com/acme/lib/sub/pkg":           "github.com/acme/lib",
		"acme/lib":                              "",
		"^1.2.3":                                "",
	} {
		if got := NormalizeURL(in); got != want {
			t.Errorf("NormalizeURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestImports(t *testing.T) {
	check := func(lang, src, want string) {
		t.Helper()
		got := Imports(lang, []byte(src))
		sort.Strings(got)
		if strings.Join(got, " ") != want {
			t.Errorf("%s imports = %v, want %s", lang, got, want)
		}
	}
	check("Go", "package a\nimport (\n\t\"fmt\"\n\tlib \"github.com/acme/lib/pkg/x\"\n)\nimport \"golang.org/x/sync\"\n",
		"go:github.com/acme/lib/pkg/x go:golang.org/x/sync")
	check("TypeScript", "import x from 'express';\nimport { a } from \"@acme/core/utils\";\nimport './local';\nimport 'reflect-metadata';\nconst y = require('lodash/get');\nconst z = await import('node:fs');\nexport * from 'zod';\n",
		"npm:@acme/core npm:express npm:lodash npm:reflect-metadata npm:zod")
	check("Python", "import os, acme.sub as s\nfrom requests import get\nfrom . import local\nfrom .x import y\n",
		"python:acme python:os python:requests")
	check("Rust", "use serde::Serialize;\nuse std::fmt;\nuse crate::a;\npub use my_lib::thing;\nextern crate log;\n",
		"cargo:log cargo:my_lib cargo:serde")
}
