package workspace

import (
	"math"
	"testing"

	"github.com/justinclev/codecity/internal/city"
)

func box(w, d float64) *city.City { return &city.City{Bounds: city.Bounds{W: w, D: d}} }

func TestArrange(t *testing.T) {
	names := []string{"web", "gateway", "orders", "users", "db", "lib", "solo1", "solo2"}
	sizes := [][2]float64{{80, 60}, {50, 50}, {120, 90}, {70, 70}, {60, 60}, {40, 40}, {30, 30}, {35, 25}}
	var cs []*city.City
	for _, s := range sizes {
		cs = append(cs, box(s[0], s[1]))
	}
	links := []city.Link{
		{From: 0, To: 1, Kind: "api"}, {From: 1, To: 2, Kind: "api"}, {From: 1, To: 3, Kind: "api"},
		{From: 2, To: 4, Kind: "data"}, {From: 3, To: 4, Kind: "data"}, {From: 2, To: 5, Kind: "dependency"},
		{From: 5, To: 2, Kind: "dependency"}, // a cycle must not break the layout
	}
	off, w, d := arrange(cs, names, links)

	// no overlaps, room for roads between cities, all inside the world
	for i := range cs {
		if off[i][0] < 0 || off[i][1] < 0 || off[i][0]+cs[i].Bounds.W > w || off[i][1]+cs[i].Bounds.D > d {
			t.Errorf("city %s outside the world", names[i])
		}
		for j := i + 1; j < len(cs); j++ {
			gx := math.Max(off[j][0]-(off[i][0]+cs[i].Bounds.W), off[i][0]-(off[j][0]+cs[j].Bounds.W))
			gz := math.Max(off[j][1]-(off[i][1]+cs[i].Bounds.D), off[i][1]-(off[j][1]+cs[j].Bounds.D))
			if math.Max(gx, gz) < 24 {
				t.Errorf("%s and %s are too close (%.1f)", names[i], names[j], math.Max(gx, gz))
			}
		}
	}
	// flow runs north → south: web above gateway above orders above db
	for _, p := range [][2]int{{0, 1}, {1, 2}, {1, 3}, {2, 4}} {
		if off[p[0]][1] >= off[p[1]][1] {
			t.Errorf("%s should lie north of %s", names[p[0]], names[p[1]])
		}
	}

	// deterministic, and independent of the order the repositories were given in
	perm := []int{5, 2, 7, 0, 3, 6, 1, 4}
	inv := make([]int, len(perm))
	pn := make([]string, len(perm))
	pc := make([]*city.City, len(perm))
	for k, o := range perm {
		inv[o] = k
		pn[k], pc[k] = names[o], cs[o]
	}
	var pl []city.Link
	for _, l := range links {
		l.From, l.To = inv[l.From], inv[l.To]
		pl = append(pl, l)
	}
	off2, _, _ := arrange(pc, pn, pl)
	for k, o := range perm {
		if math.Abs(off2[k][0]-off[o][0]) > 1e-6 || math.Abs(off2[k][1]-off[o][1]) > 1e-6 {
			t.Fatalf("%s moved when the input order changed: %v vs %v", names[o], off2[k], off[o])
		}
	}
}
