package layout

import (
	"fmt"
	"math"
	"testing"
)

func leaf(n string, w float64) *Node { return &Node{Name: n, Weight: w} }

func walk(n *Node, f func(*Node)) {
	f(n)
	for _, c := range n.Children {
		walk(c, f)
	}
}

func aspect(r Rect) float64 { return math.Max(r.W/r.H, r.H/r.W) }

func TestPaperExample(t *testing.T) {
	root := &Node{Name: "r"}
	for i, w := range []float64{6, 6, 4, 3, 2, 2, 1} {
		root.Children = append(root.Children, leaf(fmt.Sprint("n", i), w))
	}
	Layout(root, 6, 4, Options{})
	var area float64
	for _, c := range root.Children {
		area += c.Rect.W * c.Rect.H
		if a := aspect(c.Rect); a > 3 {
			t.Errorf("%s aspect %.2f", c.Name, a)
		}
		if want := c.Weight; math.Abs(c.Rect.W*c.Rect.H-want) > 1e-9 {
			t.Errorf("%s area %.3f want %.0f", c.Name, c.Rect.W*c.Rect.H, want)
		}
	}
	if math.Abs(area-24) > 1e-9 {
		t.Errorf("total %v", area)
	}
}

func build() *Node {
	return &Node{Name: "root", Children: []*Node{
		{Name: "a", Children: []*Node{leaf("a1", 50), leaf("a2", 20), leaf("a3", 5), {Name: "deep", Children: []*Node{leaf("d1", 9), leaf("d2", 9)}}}},
		{Name: "b", Children: []*Node{leaf("b1", 100), leaf("b2", 1)}},
		leaf("c", 30), leaf("d", 30), leaf("e", 2),
	}}
}

func TestContainmentNoOverlap(t *testing.T) {
	root := build()
	Layout(root, 100, 80, DefaultOptions)
	const eps = 1e-6
	var leaves []*Node
	walk(root, func(n *Node) {
		for _, c := range n.Children {
			in := n.Inner
			if c.Rect.X < in.X-eps || c.Rect.Y < in.Y-eps || c.Rect.X+c.Rect.W > in.X+in.W+eps || c.Rect.Y+c.Rect.H > in.Y+in.H+eps {
				t.Errorf("%s not inside %s", c.Name, n.Name)
			}
		}
		if !n.IsDir() {
			leaves = append(leaves, n)
		}
	})
	for i := range leaves {
		for j := i + 1; j < len(leaves); j++ {
			a, b := leaves[i].Inner, leaves[j].Inner
			if a.X < b.X+b.W-eps && b.X < a.X+a.W-eps && a.Y < b.Y+b.H-eps && b.Y < a.Y+a.H-eps {
				t.Errorf("overlap %s %s", leaves[i].Name, leaves[j].Name)
			}
		}
	}
}

func TestSiblingAreaProportional(t *testing.T) {
	root := build()
	Layout(root, 100, 80, DefaultOptions)
	in := root.Inner
	total := root.Total()
	for _, c := range root.Children {
		got := c.Rect.W * c.Rect.H / (in.W * in.H)
		if want := c.Total() / total; math.Abs(got-want) > 1e-9 {
			t.Errorf("%s share %.4f want %.4f", c.Name, got, want)
		}
	}
}

func TestDeterministic(t *testing.T) {
	a, b := build(), build()
	// reverse child order of b; ties must still resolve identically
	for i, j := 0, len(b.Children)-1; i < j; i, j = i+1, j-1 {
		b.Children[i], b.Children[j] = b.Children[j], b.Children[i]
	}
	Layout(a, 100, 80, DefaultOptions)
	Layout(b, 100, 80, DefaultOptions)
	pos := func(n *Node) map[string]Rect {
		m := map[string]Rect{}
		walk(n, func(x *Node) { m[x.Name] = x.Rect })
		return m
	}
	pa, pb := pos(a), pos(b)
	for k, v := range pa {
		if pb[k] != v {
			t.Errorf("%s differs: %v vs %v", k, v, pb[k])
		}
	}
}

func TestZeroWeightIgnored(t *testing.T) {
	root := &Node{Name: "r", Children: []*Node{leaf("z", 0), leaf("a", 1)}}
	Layout(root, 10, 10, DefaultOptions)
	if root.Children[1].Rect.W*root.Children[1].Rect.H < 99 {
		t.Error("a should fill")
	}
}
