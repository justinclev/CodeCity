package analyze

import (
	"reflect"
	"testing"

	"github.com/justinclev/codecity/internal/city"
	"github.com/justinclev/codecity/internal/flow"
)

func TestShapeTower(t *testing.T) {
	src := `package a

import "fmt"

type Server struct {
	name string
	port int
}

func (s *Server) Start() error {
	fmt.Println("a")
	fmt.Println("b")
	fmt.Println("c")
	return nil
}

func (s *Server) Stop() {
	fmt.Println("a")
	fmt.Println("b")
}

func helper() {}
`
	s := shapeOf("a/server.go", "Go", []byte(src))
	if s.Kind != city.ShapeTower || len(s.Tiers) != 2 || s.Names[0] != "Server" || s.Funcs != 3 || s.Types != 1 {
		t.Fatalf("shape = %+v", s)
	}
	if s.Tiers[1] <= s.Tiers[0] {
		t.Errorf("the type should dominate: %v", s.Tiers)
	}
}

func TestShapeKinds(t *testing.T) {
	types := "export interface A {\n  x: number\n  y: string\n}\n\nexport type B = { a: A }\n\nexport enum C {\n  X,\n  Y,\n}\n"
	if s := shapeOf("src/types.ts", "TypeScript", []byte(types)); s.Kind != city.ShapeTypes || s.Funcs != 0 {
		t.Errorf("types: %+v", s)
	}
	slab := ""
	for _, n := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		slab += "def " + n + "():\n    return 1\n\n"
	}
	if s := shapeOf("util.py", "Python", []byte(slab)); s.Kind != city.ShapeSlab || len(s.Tiers) != 1 || s.Funcs != 7 {
		t.Errorf("slab: %+v", s)
	}
	if s := shapeOf("a/x_test.go", "Go", []byte("package a\n\nfunc TestX(t *testing.T) {}\n")); s.Kind != city.ShapeTest {
		t.Errorf("test: %+v", s)
	}
	if s := shapeOf("package.json", "JSON", []byte("{\n  \"name\": \"x\"\n}\n")); s.Kind != city.ShapeData || len(s.Tiers) != 1 {
		t.Errorf("data: %+v", s)
	}
	doc := "# Title\n\nintro\n\n## Install\n\na\nb\nc\nd\n\n## Use\n\ne\nf\ng\nh\ni\nj\nk\nl\n"
	s := shapeOf("README.md", "Markdown", []byte(doc))
	if s.Kind != city.ShapeDoc || !reflect.DeepEqual(s.Names, []string{"Use", "Install"}) || s.Tiers[0]+s.Tiers[1]+s.Tiers[2] != 16 {
		t.Errorf("doc: %+v", s)
	}
	rs := "struct P { x: i32 }\n\nimpl P {\n    fn a(&self) {\n        1;\n    }\n    fn b(&self) {\n        2;\n    }\n}\n\nimpl std::fmt::Display for P {\n    fn fmt(&self) {\n        3;\n    }\n}\n"
	if s := shapeOf("src/p.rs", "Rust", []byte(rs)); s.Kind != city.ShapeTower || s.Names[0] != "P" || len(s.Names) != 1 {
		t.Errorf("rust: %+v", s)
	}
}

func TestRoles(t *testing.T) {
	c := &city.City{Buildings: []city.Building{{Path: "main.go", Lang: "Go", Shape: &city.Shape{}}, {Path: "store.go", Lang: "Go", Shape: &city.Shape{}}}}
	files := []flow.File{
		{Path: "go.mod", Lang: "Go", Content: []byte("module x\n")},
		{Path: "main.go", Lang: "Go", Content: []byte(`package main

import (
	"net/http"
	"os/exec"
)

func main() {
	http.HandleFunc("/x", handle)
	exec.Command("ls").Run()
}

func handle(w http.ResponseWriter, r *http.Request) { save() }
`)},
		{Path: "store.go", Lang: "Go", Content: []byte(`package main

import "os"

func save() { os.WriteFile("x", nil, 0o644) }
`)},
	}
	assignRoles(c, files, nil)
	if got := c.Buildings[0].Shape.Roles; !reflect.DeepEqual(got, []string{city.RoleEntry, city.RoleServe, city.RoleExec}) {
		t.Errorf("main.go roles = %v", got)
	}
	if got := c.Buildings[1].Shape.Roles; !reflect.DeepEqual(got, []string{city.RoleFiles}) {
		t.Errorf("store.go roles = %v", got)
	}
}
