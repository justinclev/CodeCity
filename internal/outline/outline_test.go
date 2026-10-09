package outline

import (
	"fmt"
	"strings"
	"testing"
)

func names(ps []Piece) string {
	var b []string
	for _, p := range ps {
		ind := ""
		if p.Parent >= 0 {
			ind = "  "
		}
		b = append(b, fmt.Sprintf("%s%s:%s@%d-%d", ind, p.Kind, p.Name, p.Start, p.End))
	}
	return strings.Join(b, "\n")
}

func check(t *testing.T, lang, src, want string) {
	t.Helper()
	got := names(Outline(lang, []byte(src)))
	if got != strings.TrimSpace(want) {
		t.Errorf("%s outline:\n%s\nwant:\n%s", lang, got, strings.TrimSpace(want))
	}
}

func TestGo(t *testing.T) {
	check(t, "Go", `package x

import (
	"fmt"
)

// Server serves.
type Server struct {
	addr string // "}" in a comment
}

type ID int

func (s *Server) Start() error {
	if s.addr == "{" {
		return nil
	}
	return fmt.Errorf("x")
}

func helper[T any](v T) T { return v }
`, `
imports:imports & header@1-7
struct:Server@8-10
type:ID@11-12
method:Server.Start@13-19
func:helper@20-21`)
}

func TestJavaScriptExpressStyle(t *testing.T) {
	check(t, "JavaScript", `'use strict';

var http = require('http');
var res = Object.create(http.ServerResponse.prototype);
module.exports = res;

res.status = function status(code) {
  this.statusCode = code;
  return this;
};

/**
 * Send a response. { braces in comments }
 */
res.send = function send(body) {
  var chunk = body;
  if (typeof chunk === 'string') {
    chunk = '}' + chunk;
  }
  return this;
};

function sendfile(res, file) {
  function onerror(err) { done(err); }
  file.on('error', onerror);
}
`, `
imports:imports & header@1-6
func:res.status@7-10
func:res.send@11-21
func:sendfile@22-26`)
}

func TestTypeScriptClass(t *testing.T) {
	check(t, "TypeScript", `import { a } from './a';

export class Store<T> {
  private items: T[] = [];

  add(item: T): void {
    this.items.push(item);
  }

  async load(url: string): Promise<void> {
    const r = await fetch(url);
    if (r.ok) {
      this.items = await r.json();
    }
  }
}

export const double = (x: number) => x * 2;

export interface Opts {
  a: number;
}
`, `
imports:imports & header@1-2
class:Store@3-16
  method:add@6-8
  method:load@10-15
func:double@17-18
interface:Opts@19-22`)
}

func TestPython(t *testing.T) {
	check(t, "Python", `import os


class Repo:
    """Docs with def inside."""

    def __init__(self, path):
        self.path = path

    async def fetch(self):
        if self.path:
            return os.listdir(
                self.path,
            )


def main():
    Repo(".").fetch()
`, `
imports:imports & header@1-3
class:Repo@4-14
  method:__init__@7-8
  method:fetch@10-14
func:main@15-18`)
}

func TestRust(t *testing.T) {
	check(t, "Rust", `use std::fmt;

pub struct Point<'a> {
    name: &'a str,
}

impl<'a> fmt::Display for Point<'a> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}", self.name)
    }
}

fn main() {
    let c = '{';
}
`, `
imports:imports & header@1-2
struct:Point@3-5
impl:fmt::Display for Point<'a>@6-11
  method:fmt@8-10
func:main@12-15`)
}

func TestJava(t *testing.T) {
	check(t, "Java", `package a;

public class Greeter {
    private final String name;

    public Greeter(String name) {
        this.name = name;
    }

    public String greet() {
        if (name.isEmpty()) {
            return "hi";
        }
        return "hi " + name;
    }
}
`, `
imports:imports & header@1-2
class:Greeter@3-16
  method:Greeter@6-8
  method:greet@10-15`)
}

func TestMetricsAndFallback(t *testing.T) {
	ps := Outline("Go", []byte("package a\n\nfunc f() {\n\tif x {\n\t\ty()\n\t}\n}\n"))
	f := ps[len(ps)-1]
	if f.Name != "f" || f.LOC != 5 || f.Complexity != 1+2+1 {
		t.Errorf("f = %+v", f)
	}
	ps = Outline("Markdown", []byte("# a\n\ntext\n"))
	if len(ps) != 1 || ps[0].Start != 1 || ps[0].End != 3 {
		t.Errorf("fallback = %+v", ps)
	}
	if Outline("Go", nil) != nil {
		t.Error("empty")
	}
}
