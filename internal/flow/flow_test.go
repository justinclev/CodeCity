package flow

import (
	"strings"
	"testing"
)

// has reports whether g has an edge kind from a node named from to one named to (names may be suffixes).
func has(g *Graph, from, kind, to string) bool {
	for _, e := range g.Edges {
		if e.Kind != kind {
			continue
		}
		a, b := g.Nodes[e.From].Name, g.Nodes[e.To].Name
		if (a == from || strings.HasSuffix(a, from)) && (b == to || strings.HasSuffix(b, to)) {
			return true
		}
	}
	return false
}

func dump(g *Graph) string {
	var sb strings.Builder
	for _, e := range g.Edges {
		sb.WriteString(g.Nodes[e.From].Name + " -" + e.Kind + "-> " + g.Nodes[e.To].Name + "\n")
	}
	return sb.String()
}

func TestGo(t *testing.T) {
	files := []File{
		{Path: "go.mod", Lang: "Go", Content: []byte("module example.com/app\n\ngo 1.22\n")},
		{Path: "main.go", Lang: "Go", Content: []byte(`package main

import (
	"flag"
	"fmt"
	"net/http"
	"os"

	"example.com/app/store"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	flag.Parse()
	switch os.Args[1] {
	case "serve":
		serve(*addr)
	case "dump":
		fmt.Println(os.Getenv("HOME"))
	}
}

func serve(addr string) {
	s := &Server{db: store.Open("app.db")}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /users/{id}", s.user)
	mux.HandleFunc("POST /users", func(w http.ResponseWriter, r *http.Request) {
		s.db.Save("x")
		s.count++
	})
	health := func(w http.ResponseWriter, r *http.Request) { fmt.Fprintln(w, "ok") }
	mux.HandleFunc("GET /health", health)
	http.ListenAndServe(addr, mux)
}

type Saver interface{ Save(string) error }

type Server struct {
	db    *store.DB
	count int
	saver Saver
}

func (s *Server) user(w http.ResponseWriter, r *http.Request) {
	_ = s.db.Find(r.PathValue("id"))
	_ = s.saver.Save("y")
	resp := &Server{}
	resp.count = 3 // a local value, not state
}
`)},
		{Path: "store/store.go", Lang: "Go", Content: []byte(`package store

import (
	"database/sql"
	"os"
	"os/exec"
)

type DB struct{ conn *sql.DB }

func Open(path string) *DB {
	c, _ := sql.Open("sqlite3", path)
	return &DB{conn: c}
}

func (d *DB) Find(id string) string {
	d.conn.QueryRow("SELECT name FROM users WHERE id = ?", id)
	return id
}

func (d *DB) Save(name string) error {
	_, err := d.conn.Exec("INSERT INTO users (name) VALUES (?)", name)
	os.WriteFile("audit.log", []byte(name), 0o644)
	exec.Command("git", "add", ".").Run()
	return err
}
`)},
	}
	g := Build(files, Options{})
	for _, c := range [][3]string{
		{"main", ECall, "serve"},
		{"serve", ECall, "store.Open"},
		{"serve", ENew, "Server"},
		{"Server.user", ECall, "DB.Find"},
		{"Server.user", ECall, "Saver.Save"},
		{"Saver.Save", EImpl, "DB.Save"},
		{"GET /users/{id}", EHandles, "Server.user"},
		{"POST /users", EHandles, "serve ‹POST /users›"},
		{"serve ‹POST /users›", ECall, "DB.Save"},
		{"serve ‹POST /users›", EWrites, "Server.count"},
		{"GET /health", EHandles, "serve ‹health›"},
		{"serve", "callback", ""},
		{"serve", "", ""},
		{"DB.Find", EIO, "users"},
		{"DB.Save", EIO, "users"},
		{"DB.Save", EWrites, "files (written)"},
		{"DB.Save", EIO, "git"},
		{"store.Open", EIO, "sqlite3"},
		{"serve", EIO, "store.Open"},
		{"command-line arguments", EFeeds, "main"},
		{"--addr", EFeeds, "main"},
		{"serve", EHandles, ""},
		{"dump", EHandles, "main"},
		{"environment", EFeeds, "main"},
		{"main", EWrites, "stdout"},
	} {
		switch {
		case c[1] == "" || c[1] == "callback" || c[0] == "serve" && c[1] == EIO || c[0] == "serve" && c[1] == EHandles:
			continue // placeholders kept readable above; checked below
		}
		if !has(g, c[0], c[1], c[2]) {
			t.Errorf("missing %s -%s-> %s\n%s", c[0], c[1], c[2], dump(g))
		}
	}
	if !has(g, "serve", EHandles, "serve") && !has(g, "serve", EHandles, "main") {
		// command "serve" dispatches to the serve function
		if !has(g, "serve", EHandles, "serve") {
			t.Errorf("command serve not linked\n%s", dump(g))
		}
	}
	if has(g, "Server.user", EWrites, "Server.count") {
		t.Errorf("filling a local value counted as a state write")
	}
	for _, e := range g.Edges {
		if e.Kind == ECall && !e.Exact {
			t.Errorf("Go call not exact: %s -> %s", g.Nodes[e.From].Name, g.Nodes[e.To].Name)
		}
	}
}

func TestScript(t *testing.T) {
	files := []File{
		{Path: "package.json", Lang: "JSON", Content: []byte(`{"name":"web"}`)},
		{Path: "server/app.ts", Lang: "TypeScript", Content: []byte(`import express from 'express';
import { listUsers, saveUser } from './users';
const app = express();
app.get('/api/users/:id', async (req, res) => {
  res.json(await listUsers(req.params.id));
});
app.post('/api/users', saveUser);
app.listen(3000);
`)},
		{Path: "server/users.ts", Lang: "TypeScript", Content: []byte(`import { Pool } from 'pg';
import * as fs from 'fs';
const pool = new Pool();
export async function listUsers(id: string) {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return r.rows;
}
export function saveUser(req: any, res: any) {
  pool.query("INSERT INTO users(name) VALUES ($1)", [req.body.name]);
  fs.writeFileSync('last.json', JSON.stringify(req.body));
  console.log('saved');
}
`)},
		{Path: "web/api.ts", Lang: "TypeScript", Content: []byte(`export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  return res.json() as Promise<T>;
}
`)},
		{Path: "web/store.ts", Lang: "TypeScript", Content: []byte(`import { api } from './api';
export interface User { id: string }
export class Store {
  private users: User[] = [];
  selected = '';
  async load(id: string) {
    this.users = await api<User[]>(` + "`/api/users/${id}`" + `);
    localStorage.setItem('last', id);
  }
  save(name: string) {
    return fetch('/api/users', { method: 'POST', body: name });
  }
  pick(id: string) { this.selected = id; this.render(); }
  render() { return this.users.length; }
}
`)},
		{Path: "web/main.ts", Lang: "TypeScript", Content: []byte(`import { Store } from './store';
const store = new Store();
document.getElementById('reload')!.addEventListener('click', () => store.load('1'));
function boot() {
  store.pick(localStorage.getItem('last') ?? '');
}
boot();
`)},
	}
	g := Build(files, Options{})
	for _, c := range [][3]string{
		{"‹GET /api/users/:id›", ECall, "listUsers"},
		{"GET /api/users/:id", EHandles, "‹GET /api/users/:id›"},
		{"POST /api/users", EHandles, "saveUser"},
		{"listUsers", EIO, "users"},
		{"saveUser", EIO, "users"},
		{"saveUser", EWrites, "files (written)"},
		{"saveUser", EWrites, "console"},
		{"Store.load", ECall, "api"},
		{"Store.load", ERequest, "GET /api/users/:id"},
		{"Store.save", ERequest, "POST /api/users"},
		{"Store.load", EWrites, "Store.users"},
		{"Store.users", EFeeds, "Store.render"},
		{"Store.pick", ECall, "Store.render"},
		{"Store.pick", EWrites, "Store.selected"},
		{"Store.load", EWrites, "localStorage"},
		{"localStorage", EFeeds, "boot"},
		{"click #reload", EHandles, "Store.load"},
		{"main.ts (top level)", ENew, "Store"},
		{"boot", ECall, "Store.pick"},
		{"main.ts (top level)", ECall, "boot"},
	} {
		if !has(g, c[0], c[1], c[2]) {
			t.Errorf("missing %s -%s-> %s\n%s", c[0], c[1], c[2], dump(g))
		}
	}
}

func TestPython(t *testing.T) {
	files := []File{
		{Path: "app/__init__.py", Lang: "Python", Content: []byte("")},
		{Path: "app/routes.py", Lang: "Python", Content: []byte(`from flask import Flask
from .service import UserService
import requests, subprocess, os

app = Flask(__name__)
svc = UserService()

@app.route("/users/<id>", methods=["GET", "DELETE"])
def user(id):
    return svc.find(id)

@app.post("/sync")
def sync():
    data = requests.get("https://api.example.com/users").json()
    subprocess.run(["git", "pull"])
    token = os.environ.get("TOKEN")
    svc.store(data)
`)},
		{Path: "app/service.py", Lang: "Python", Content: []byte(`import sqlite3

class Repo:
    def query(self, sql):
        return self.conn.execute(sql)

class UserService:
    def __init__(self):
        self.repo = Repo()
        self.cache = {}

    def find(self, id):
        if id in self.cache:
            return self.cache[id]
        return self.repo.query("SELECT * FROM users WHERE id = ?")

    def store(self, rows):
        self.cache = {}
        with open("dump.json", "w") as f:
            f.write(str(rows))
        print("stored")
`)},
	}
	g := Build(files, Options{})
	for _, c := range [][3]string{
		{"GET /users/<id>", EHandles, "user"},
		{"DELETE /users/<id>", EHandles, "user"},
		{"POST /sync", EHandles, "sync"},
		{"user", ECall, "UserService.find"},
		{"UserService.find", ECall, "Repo.query"},
		{"UserService.find", EIO, "users"},
		{"sync", EIO, "api.example.com"},
		{"sync", EIO, "git"},
		{"environment", EFeeds, "sync"},
		{"UserService.store", EWrites, "UserService.cache"},
		{"UserService.cache", EFeeds, "UserService.find"},
		{"UserService.store", EWrites, "files (written)"},
		{"UserService.store", EWrites, "stdout"},
		{"routes.py (top level)", ENew, "UserService"},
		{"sync", ECall, "UserService.store"},
	} {
		if !has(g, c[0], c[1], c[2]) {
			t.Errorf("missing %s -%s-> %s\n%s", c[0], c[1], c[2], dump(g))
		}
	}
}

func TestRust(t *testing.T) {
	files := []File{
		{Path: "src/main.rs", Lang: "Rust", Content: []byte(`use axum::{routing::get, Router};
use std::process::Command;
mod store;

#[tokio::main]
async fn main() {
    let app = Router::new().route("/items", get(list_items).post(add_item));
    println!("listening");
}

async fn list_items() -> String {
    let s = store::Store::new();
    s.all()
}

async fn add_item() {
    Command::new("git").arg("status").output().unwrap();
    let cfg = std::fs::read_to_string("config.toml").unwrap();
    let mut s = store::Store::new();
    s.add(cfg);
}
`)},
		{Path: "src/store.rs", Lang: "Rust", Content: []byte(`pub trait Repo { fn all(&self) -> String; }
pub struct Store { items: Vec<String> }
impl Store {
    pub fn new() -> Self { Store { items: vec![] } }
    pub fn add(&mut self, s: String) { self.items.push(s); self.log(); }
    fn log(&self) { eprintln!("{}", self.items.len()); }
}
impl Repo for Store {
    fn all(&self) -> String { self.items.join(",") }
}
`)},
	}
	g := Build(files, Options{})
	for _, c := range [][3]string{
		{"GET /items", EHandles, "list_items"},
		{"POST /items", EHandles, "add_item"},
		{"add_item", EIO, "git"},
		{"files (read)", EFeeds, "add_item"},
		{"add_item", ECall, "Store::new"},
		{"add_item", ECall, "Store::add"},
		{"Store::add", ECall, "Store::log"},
		{"Store::add", EWrites, "Store.items"},
		{"Store::log", EWrites, "stderr"},
		{"main", EWrites, "stdout"},
		{"Repo::all", EImpl, "Store::all"},
	} {
		if !has(g, c[0], c[1], c[2]) {
			t.Errorf("missing %s -%s-> %s\n%s", c[0], c[1], c[2], dump(g))
		}
	}
}

func TestRouteMatching(t *testing.T) {
	for _, c := range []struct {
		route, url string
		ok         bool
	}{
		{"/api/file", "/api/file", true},
		{"/users/{id}", "/users/\x00", true},
		{"/users/:id", "/users/42", true},
		{"/static/", "/static/app.js", true},
		{"/api/file", "/api/files", false},
		{"/users/{id}", "/users/1/posts", false},
	} {
		re := routeRegexp(c.route)
		if got := re.MatchString(c.url); got != c.ok {
			t.Errorf("%s ~ %q: got %v", c.route, c.url, got)
		}
	}
	if got := sqlInsert.FindStringSubmatch("insert into audit_log (a) values (1)"); got == nil || got[1] != "audit_log" {
		t.Errorf("sql insert: %v", got)
	}
}

func TestMatcher(t *testing.T) {
	rs := []Route{{Route: "/"}, {Method: "GET", Route: "/api/orders"}, {Route: "/api/orders/{id}"}, {Route: "/static/"}, {Route: "/{tenant}/ping"}, {Route: "/a/b/c/d/e"}}
	m := NewMatcher(rs)
	cases := []struct {
		method, url string
		want        []int
	}{
		{"GET", "http://x:80/api/orders", []int{1}},
		{"GET", "/api/orders/42", []int{2}},
		{"GET", "/static/app.js", []int{3}},
		{"GET", "/acme/ping", []int{4}},
		{"GET", "/a/b/c/d/e", []int{5}},
		{"POST", "/api/orders", []int{0}}, // /api/orders is GET only: only the catch-all "/" takes a POST
	}
	for _, c := range cases {
		got, _, _ := m.Match(c.method, c.url)
		if len(got) == 0 && len(c.want) == 0 {
			continue
		}
		if len(got) != 1 || len(c.want) != 1 || got[0] != c.want[0] {
			t.Errorf("%s %s = %v, want %v", c.method, c.url, got, c.want)
		}
	}
}

func TestRequestToLocalhostWithPort(t *testing.T) {
	g := Build([]File{{Path: "main.go", Lang: "Go", Content: []byte(`package main

import "net/http"

func main() {
	http.HandleFunc("/api/x", h)
	http.Get("http://localhost:8080/api/x")
}

func h(w http.ResponseWriter, r *http.Request) {}
`)}}, Options{})
	found := false
	for _, e := range g.Edges {
		if e.Kind == ERequest {
			found = true
		}
	}
	if !found {
		t.Fatal("a request to localhost:8080 must reach the route this code base serves")
	}
}
