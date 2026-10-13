// Package layout implements a squarified treemap (Bruls, Huizing, van Wijk).
package layout

import (
	"math"
	"sort"
)

// Rect is an axis-aligned rectangle (X,Z plane in the city).
type Rect struct{ X, Y, W, H float64 }

// Node is a tree node. Leaves carry Weight; directories derive it from children.
type Node struct {
	Name     string
	Weight   float64 // leaves only
	Bias     float64 // leaves: -1 = belongs at the north edge … +1 = south edge (only when Signal)
	Signal   bool    // Bias carries information
	Children []*Node

	Rect  Rect // the cell allotted to this node (before padding/gap)
	Inner Rect // area available to children (dirs) or the footprint (leaves)
	Depth int
}

// IsDir reports whether n has children.
func (n *Node) IsDir() bool { return len(n.Children) > 0 }

// bias is the weight-averaged bias of the nodes that carry a signal.
func (n *Node) bias() (float64, bool) {
	if !n.IsDir() {
		return n.Bias, n.Signal
	}
	var sum, w float64
	for _, c := range n.Children {
		if b, ok := c.bias(); ok {
			t := c.Total()
			sum += b * t
			w += t
		}
	}
	if w == 0 {
		return 0, false
	}
	return sum / w, true
}

// Total returns the summed weight of the subtree.
func (n *Node) Total() float64 {
	if !n.IsDir() {
		return n.Weight
	}
	var s float64
	for _, c := range n.Children {
		s += c.Total()
	}
	return s
}

// Options tune spacing.
type Options struct {
	PadRatio float64 // directory padding as a fraction of min(w,h)
	MaxPad   float64
	GapRatio float64 // building inset as a fraction of min(w,h)
	MaxGap   float64
}

// DefaultOptions are sensible city spacings.
// Streets are wide enough to walk: buildings are inset by up to 10% of their cell (1.4 units),
// districts by 5% (3 units), so walk mode has walkways and avenues.
var DefaultOptions = Options{PadRatio: 0.05, MaxPad: 3, GapRatio: 0.1, MaxGap: 1.4}

// Layout places root in a w×h rectangle at the origin.
func Layout(root *Node, w, h float64, o Options) {
	place(root, Rect{0, 0, w, h}, 0, o)
}

func place(n *Node, r Rect, depth int, o Options) {
	n.Rect, n.Depth = r, depth
	m := math.Min(r.W, r.H)
	if !n.IsDir() {
		g := math.Min(o.MaxGap, o.GapRatio*m)
		n.Inner = inset(r, g)
		return
	}
	p := math.Min(o.MaxPad, o.PadRatio*m)
	if depth == 0 {
		p = 0
	}
	n.Inner = inset(r, p)
	for _, c := range squarify(n.Children, n.Inner) {
		place(c.node, c.rect, depth+1, o)
	}
}

func inset(r Rect, d float64) Rect {
	if d*2 >= r.W || d*2 >= r.H {
		d = math.Min(r.W, r.H) / 4
	}
	return Rect{r.X + d, r.Y + d, r.W - 2*d, r.H - 2*d}
}

type placed struct {
	node *Node
	rect Rect
}

func squarify(children []*Node, r Rect) []placed {
	items := make([]*Node, 0, len(children))
	totals := map[*Node]float64{}
	var sum float64
	for _, c := range children {
		t := c.Total()
		if t <= 0 {
			continue
		}
		totals[c] = t
		sum += t
		items = append(items, c)
	}
	if len(items) == 0 {
		return nil
	}
	// when some of the siblings are entrances or exits, order them north → south by bias (rows are laid
	// from the top), then by size and name; otherwise the classic largest-first squarified order
	ordered := false
	bias := map[*Node]float64{}
	for _, c := range items {
		b, ok := c.bias()
		bias[c] = b
		ordered = ordered || ok
	}
	sort.SliceStable(items, func(i, j int) bool {
		if ordered && bias[items[i]] != bias[items[j]] {
			return bias[items[i]] < bias[items[j]]
		}
		a, b := totals[items[i]], totals[items[j]]
		if a != b {
			return a > b
		}
		return items[i].Name < items[j].Name
	})
	scale := r.W * r.H / sum
	var out []placed
	rest := items
	for len(rest) > 0 {
		short := math.Min(r.W, r.H)
		if ordered {
			short = r.W // rows run along the top, so the order reads north → south
		}
		k := 1
		best := worst(rest[:1], totals, scale, short)
		for k < len(rest) {
			w := worst(rest[:k+1], totals, scale, short)
			if w > best {
				break
			}
			best = w
			k++
		}
		row := rest[:k]
		var area float64
		for _, c := range row {
			area += totals[c] * scale
		}
		if !ordered && r.W >= r.H { // lay the row as a column on the left
			cw := area / r.H
			y := r.Y
			for _, c := range row {
				ch := totals[c] * scale / cw
				out = append(out, placed{c, Rect{r.X, y, cw, ch}})
				y += ch
			}
			r = Rect{r.X + cw, r.Y, r.W - cw, r.H}
		} else { // row along the top
			rh := area / r.W
			x := r.X
			for _, c := range row {
				cw := totals[c] * scale / rh
				out = append(out, placed{c, Rect{x, r.Y, cw, rh}})
				x += cw
			}
			r = Rect{r.X, r.Y + rh, r.W, r.H - rh}
		}
		rest = rest[k:]
	}
	return out
}

// worst returns the worst aspect ratio if row were laid along a side of length short.
func worst(row []*Node, totals map[*Node]float64, scale, short float64) float64 {
	var sum, mn, mx float64
	mn = math.Inf(1)
	for _, c := range row {
		a := totals[c] * scale
		sum += a
		mn = math.Min(mn, a)
		mx = math.Max(mx, a)
	}
	s2 := short * short
	return math.Max(s2*mx/(sum*sum), sum*sum/(s2*mn))
}
