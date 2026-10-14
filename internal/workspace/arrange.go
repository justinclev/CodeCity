package workspace

import (
	"math"
	"sort"

	"github.com/justinclev/codecity/internal/city"
)

// arrange places the cities on the world map from facts alone (sizes, names, links), so the same
// repositories always give the same map:
//
//   - Connected repositories form a region. Inside it, traffic flows north to south: callers,
//     publishers, writers and dependents sit north of the services, subscribers, readers and
//     libraries they use (longest-path layers), and each layer is ordered to keep roads from
//     crossing (barycenter sweeps). Cities then slide toward their neighbours, so the layout
//     is a staggered river delta instead of a grid.
//   - Regions with no link to each other are islands, packed outward from the biggest region along
//     a spiral, first fit.
//   - Every pair of cities keeps a margin wide enough for highways to run between them.
func arrange(cities []*city.City, names []string, links []city.Link) (offsets [][2]float64, worldW, worldD float64) {
	n := len(cities)
	maxSide := 0.0
	for _, c := range cities {
		maxSide = math.Max(maxSide, math.Max(c.Bounds.W, c.Bounds.D))
	}
	margin := math.Max(24, maxSide*0.45)

	type edge struct{ from, to int }
	seen := map[edge]bool{}
	out := make([][]int, n)
	adj := make([][]int, n)
	for _, l := range links {
		if l.Kind == "people" || l.From == l.To {
			continue
		}
		e := edge{l.From, l.To}
		if seen[e] {
			continue
		}
		seen[e] = true
		out[l.From] = append(out[l.From], l.To)
		adj[l.From] = append(adj[l.From], l.To)
		adj[l.To] = append(adj[l.To], l.From)
	}
	less := func(a, b int) bool { // stable order: bigger first, then by name
		wa, wb := cities[a].Bounds.W*cities[a].Bounds.D, cities[b].Bounds.W*cities[b].Bounds.D
		if wa != wb {
			return wa > wb
		}
		return names[a] < names[b]
	}

	// regions = connected components
	comp := make([]int, n)
	for i := range comp {
		comp[i] = -1
	}
	var regions [][]int
	for _, s := range sortedIdx(n, less) {
		if comp[s] >= 0 {
			continue
		}
		id := len(regions)
		var members []int
		stack := []int{s}
		comp[s] = id
		for len(stack) > 0 {
			c := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			members = append(members, c)
			for _, x := range adj[c] {
				if comp[x] < 0 {
					comp[x] = id
					stack = append(stack, x)
				}
			}
		}
		regions = append(regions, members)
	}

	type placed struct {
		idx  []int
		x, z []float64 // top-left, relative to the region's own origin
		w, d float64
	}
	var pls []placed
	for _, members := range regions {
		pls = append(pls, bestRegion(members, cities, names, out, adj, margin, less))
	}
	// biggest region first (by area), then by its first city's name
	sort.SliceStable(pls, func(a, b int) bool {
		aa, bb := pls[a].w*pls[a].d, pls[b].w*pls[b].d
		if aa != bb {
			return aa > bb
		}
		return names[pls[a].idx[0]] < names[pls[b].idx[0]]
	})

	// pack the regions: first fit on a spiral around the biggest
	type box struct{ x, z, w, d float64 }
	var boxes []box
	hit := func(b box) bool {
		for _, o := range boxes {
			if b.x < o.x+o.w+margin*1.5 && o.x < b.x+b.w+margin*1.5 && b.z < o.z+o.d+margin*1.5 && o.z < b.z+b.d+margin*1.5 {
				return true
			}
		}
		return false
	}
	offsets = make([][2]float64, n)
	minX, minZ := math.Inf(1), math.Inf(1)
	var final []box
	for k, p := range pls {
		b := box{w: p.w, d: p.d}
		if k > 0 {
			step := math.Max(margin, 12)
			found := false
			for r := step; !found; r += step {
				arc := math.Max(step, 1)
				steps := int(math.Max(8, math.Ceil(2*math.Pi*r/arc)))
				for s := 0; s < steps && !found; s++ {
					ang := 2 * math.Pi * float64(s) / float64(steps)
					b.x = math.Cos(ang)*r - p.w/2
					b.z = math.Sin(ang)*r*0.8 - p.d/2 // a little wider than tall
					if !hit(b) {
						found = true
					}
				}
			}
		} else {
			b.x, b.z = -p.w/2, -p.d/2
		}
		boxes = append(boxes, b)
		final = append(final, b)
		minX, minZ = math.Min(minX, b.x), math.Min(minZ, b.z)
	}
	for k, p := range pls {
		for j, i := range p.idx {
			offsets[i] = [2]float64{final[k].x - minX + margin + p.x[j], final[k].z - minZ + margin + p.z[j]}
			worldW = math.Max(worldW, offsets[i][0]+cities[i].Bounds.W+margin)
			worldD = math.Max(worldD, offsets[i][1]+cities[i].Bounds.D+margin)
		}
	}
	return offsets, worldW, worldD
}

func sortedIdx(n int, less func(a, b int) bool) []int {
	s := make([]int, n)
	for i := range s {
		s[i] = i
	}
	sort.SliceStable(s, func(a, b int) bool { return less(s[a], s[b]) })
	return s
}

// layoutRegion lays out one connected group of cities in north→south layers.
func layoutRegion(members []int, cities []*city.City, names []string, out, adj [][]int, margin float64, less func(a, b int) bool, variant int) (r struct {
	idx  []int
	x, z []float64
	w, d float64
}) {
	members = append([]int(nil), members...)
	sort.SliceStable(members, func(a, b int) bool { return less(members[a], members[b]) })
	in := map[int]bool{}
	for _, m := range members {
		in[m] = true
	}
	if len(members) == 1 {
		i := members[0]
		r.idx, r.x, r.z = []int{i}, []float64{0}, []float64{0}
		r.w, r.d = cities[i].Bounds.W, cities[i].Bounds.D
		return r
	}

	// drop edges that close a cycle (DFS back edges, visiting in stable order), then longest-path layers
	state := map[int]int{} // 0 new, 1 on stack, 2 done
	back := map[[2]int]bool{}
	var dfs func(c int)
	dfs = func(c int) {
		state[c] = 1
		nb := append([]int(nil), out[c]...)
		sort.SliceStable(nb, func(a, b int) bool { return less(nb[a], nb[b]) })
		for _, x := range nb {
			switch state[x] {
			case 0:
				dfs(x)
			case 1:
				back[[2]int{c, x}] = true
			}
		}
		state[c] = 2
	}
	// start from cities nobody points at (the entrances), biggest first, then whatever is left
	pointed := map[int]bool{}
	for _, m := range members {
		for _, x := range out[m] {
			pointed[x] = true
		}
	}
	for _, m := range members {
		if !pointed[m] && state[m] == 0 {
			dfs(m)
		}
	}
	for _, m := range members {
		if state[m] == 0 {
			dfs(m)
		}
	}
	layer := map[int]int{}
	var depth func(c int) int
	depth = func(c int) int {
		if v, ok := layer[c]; ok {
			return v
		}
		layer[c] = 0
		best := 0
		for _, p := range members { // predecessors
			for _, x := range out[p] {
				if x == c && !back[[2]int{p, c}] {
					best = max(best, depth(p)+1)
				}
			}
		}
		layer[c] = best
		return best
	}
	for _, m := range members {
		depth(m)
	}
	// entrances (nothing points at them) sit just above the nearest thing they use, not at the very top,
	// so their roads stay short
	for _, m := range members {
		if pointed[m] || len(out[m]) == 0 {
			continue
		}
		nearest := math.MaxInt
		for _, x := range out[m] {
			if !back[[2]int{m, x}] {
				nearest = min(nearest, layer[x])
			}
		}
		if nearest != math.MaxInt {
			layer[m] = nearest - 1
		}
	}
	minL := math.MaxInt
	for _, m := range members {
		minL = min(minL, layer[m])
	}
	maxL := 0
	for _, m := range members {
		layer[m] -= minL
		maxL = max(maxL, layer[m])
	}
	rows := make([][]int, maxL+1)
	for _, m := range members {
		rows[layer[m]] = append(rows[layer[m]], m)
	}

	// order each layer by the mean position of its neighbours in the neighbouring layers
	pos := map[int]float64{}
	for _, row := range rows {
		if variant%2 == 1 {
			for a, b := 0, len(row)-1; a < b; a, b = a+1, b-1 {
				row[a], row[b] = row[b], row[a]
			}
		}
		for k, c := range row {
			pos[c] = float64(k)
		}
	}
	for sweep := 0; sweep < 6; sweep++ {
		order := make([]int, 0, len(rows))
		for l := range rows {
			order = append(order, l)
		}
		if (sweep+variant/2)%2 == 1 {
			for a, b := 0, len(order)-1; a < b; a, b = a+1, b-1 {
				order[a], order[b] = order[b], order[a]
			}
		}
		for _, l := range order {
			bary := map[int]float64{}
			for _, c := range rows[l] {
				sum, cnt := 0.0, 0
				for _, x := range adj[c] {
					if in[x] && layer[x] != l {
						sum += pos[x] / math.Max(1, float64(len(rows[layer[x]])-1))
						cnt++
					}
				}
				if cnt > 0 {
					bary[c] = sum / float64(cnt)
				} else {
					bary[c] = pos[c] / math.Max(1, float64(len(rows[l])-1))
				}
			}
			sort.SliceStable(rows[l], func(a, b int) bool {
				ca, cb := rows[l][a], rows[l][b]
				if bary[ca] != bary[cb] {
					return bary[ca] < bary[cb]
				}
				return less(ca, cb)
			})
			for k, c := range rows[l] {
				pos[c] = float64(k)
			}
		}
	}

	// z: layers stacked with generous room; x: packed per layer, then pulled toward neighbours
	cx := map[int]float64{}
	cz := map[int]float64{}
	z := 0.0
	for _, row := range rows {
		rowD, x := 0.0, 0.0
		for _, c := range row {
			cx[c] = x + cities[c].Bounds.W/2
			x += cities[c].Bounds.W + margin*2.2
			rowD = math.Max(rowD, cities[c].Bounds.D)
		}
		shift := (x - margin*2.2) / 2
		for _, c := range row {
			cx[c] -= shift
			cz[c] = z + rowD/2
		}
		z += rowD + margin*2.2
	}
	for iter := 0; iter < 30; iter++ {
		for l, row := range rows {
			target := map[int]float64{}
			for _, c := range row {
				sum, cnt := 0.0, 0
				for _, x := range adj[c] {
					if in[x] && layer[x] != l {
						sum += cx[x]
						cnt++
					}
				}
				target[c] = cx[c]
				if cnt > 0 {
					target[c] = cx[c]*0.5 + sum/float64(cnt)*0.5
				}
			}
			// keep the order and the margin: left to right sweep, then right to left
			for k, c := range row {
				cx[c] = target[c]
				if k > 0 {
					p := row[k-1]
					cx[c] = math.Max(cx[c], cx[p]+(cities[p].Bounds.W+cities[c].Bounds.W)/2+margin*2.2)
				}
			}
			for k := len(row) - 2; k >= 0; k-- {
				c, nx := row[k], row[k+1]
				cx[c] = math.Min(cx[c], cx[nx]-(cities[nx].Bounds.W+cities[c].Bounds.W)/2-margin*2.2)
			}
		}
	}
	minX, maxX, minZ, maxZ := math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)
	for _, m := range members {
		minX = math.Min(minX, cx[m]-cities[m].Bounds.W/2)
		maxX = math.Max(maxX, cx[m]+cities[m].Bounds.W/2)
		minZ = math.Min(minZ, cz[m]-cities[m].Bounds.D/2)
		maxZ = math.Max(maxZ, cz[m]+cities[m].Bounds.D/2)
	}
	for _, m := range members {
		r.idx = append(r.idx, m)
		r.x = append(r.x, cx[m]-cities[m].Bounds.W/2-minX)
		r.z = append(r.z, cz[m]-cities[m].Bounds.D/2-minZ)
	}
	r.w, r.d = maxX-minX, maxZ-minZ
	return r
}

type regionPlan = struct {
	idx  []int
	x, z []float64
	w, d float64
}

// bestRegion tries a few deterministic variants of a region (flow north→south or west→east, two
// orderings of each layer) and keeps the one whose roads cross least, are shortest and whose
// outline is closest to square.
func bestRegion(members []int, cities []*city.City, names []string, out, adj [][]int, margin float64, less func(a, b int) bool) regionPlan {
	if len(members) == 1 {
		return layoutRegion(members, cities, names, out, adj, margin, less, 0)
	}
	in := map[int]int{}
	for k, m := range members {
		in[m] = k
	}
	var best regionPlan
	bestScore := math.Inf(1)
	for variant := 0; variant < 4; variant++ {
		for _, flip := range []bool{false, true} {
			p := layoutRegion(members, cities, names, out, adj, margin, less, variant)
			if flip { // west → east: swap the axes, then push apart whatever the swap made touch
				p.x, p.z = p.z, p.x
				separate(&p, cities, margin)
			}
			sc := scoreRegion(p, cities, out, in)
			if sc < bestScore-1e-9 {
				best, bestScore = p, sc
			}
		}
	}
	return best
}

// separate restores the margin between cities after the axes were swapped and refits the outline.
func separate(p *regionPlan, cities []*city.City, margin float64) {
	n := len(p.idx)
	for pass := 0; pass < 200; pass++ {
		moved := false
		for a := 0; a < n; a++ {
			for b := a + 1; b < n; b++ {
				ca, cb := cities[p.idx[a]], cities[p.idx[b]]
				ox := (ca.Bounds.W+cb.Bounds.W)/2 + margin - math.Abs((p.x[b]+cb.Bounds.W/2)-(p.x[a]+ca.Bounds.W/2))
				oz := (ca.Bounds.D+cb.Bounds.D)/2 + margin - math.Abs((p.z[b]+cb.Bounds.D/2)-(p.z[a]+ca.Bounds.D/2))
				if ox <= 0 || oz <= 0 {
					continue
				}
				moved = true
				if ox < oz {
					s := 1.0
					if p.x[b]+cb.Bounds.W/2 < p.x[a]+ca.Bounds.W/2 {
						s = -1
					}
					p.x[a] -= s * ox / 2
					p.x[b] += s * ox / 2
				} else {
					s := 1.0
					if p.z[b]+cb.Bounds.D/2 < p.z[a]+ca.Bounds.D/2 {
						s = -1
					}
					p.z[a] -= s * oz / 2
					p.z[b] += s * oz / 2
				}
			}
		}
		if !moved {
			break
		}
	}
	minX, minZ, maxX, maxZ := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for k, i := range p.idx {
		minX, minZ = math.Min(minX, p.x[k]), math.Min(minZ, p.z[k])
		maxX, maxZ = math.Max(maxX, p.x[k]+cities[i].Bounds.W), math.Max(maxZ, p.z[k]+cities[i].Bounds.D)
	}
	for k := range p.idx {
		p.x[k] -= minX
		p.z[k] -= minZ
	}
	p.w, p.d = maxX-minX, maxZ-minZ
}

// scoreRegion: lower is better. Roads are the straight lines between city centres.
func scoreRegion(p regionPlan, cities []*city.City, out [][]int, in map[int]int) float64 {
	type seg struct {
		ax, az, bx, bz float64
		a, b           int
	}
	var segs []seg
	ctr := func(k int) (float64, float64) {
		c := cities[p.idx[k]]
		return p.x[k] + c.Bounds.W/2, p.z[k] + c.Bounds.D/2
	}
	length := 0.0
	for _, i := range p.idx {
		for _, j := range out[i] {
			kb, ok := in[j]
			if !ok {
				continue
			}
			ka := in[i]
			ax, az := ctr(ka)
			bx, bz := ctr(kb)
			segs = append(segs, seg{ax, az, bx, bz, ka, kb})
			length += math.Hypot(bx-ax, bz-az)
		}
	}
	cross := func(s, t seg) bool {
		if s.a == t.a || s.a == t.b || s.b == t.a || s.b == t.b {
			return false
		}
		o := func(px, pz, qx, qz, rx, rz float64) float64 { return (qx-px)*(rz-pz) - (qz-pz)*(rx-px) }
		d1, d2 := o(s.ax, s.az, s.bx, s.bz, t.ax, t.az), o(s.ax, s.az, s.bx, s.bz, t.bx, t.bz)
		d3, d4 := o(t.ax, t.az, t.bx, t.bz, s.ax, s.az), o(t.ax, t.az, t.bx, t.bz, s.bx, s.bz)
		return d1*d2 < 0 && d3*d4 < 0
	}
	crossings, through := 0, 0
	for a := range segs {
		for b := a + 1; b < len(segs); b++ {
			if cross(segs[a], segs[b]) {
				crossings++
			}
		}
		for k, i := range p.idx { // a road running through a city it does not connect
			if k == segs[a].a || k == segs[a].b {
				continue
			}
			c := cities[i]
			if segCrossesRect(segs[a].ax, segs[a].az, segs[a].bx, segs[a].bz, p.x[k], p.z[k], c.Bounds.W, c.Bounds.D) {
				through++
			}
		}
	}
	aspect := math.Abs(math.Log(math.Max(p.w, 1) / math.Max(p.d, 1)))
	scale := math.Max(p.w, p.d)
	return float64(crossings)*scale*3 + float64(through)*scale*2 + length + aspect*scale*0.5
}

func segCrossesRect(ax, az, bx, bz, x, z, w, d float64) bool {
	t0, t1 := 0.0, 1.0
	dx, dz := bx-ax, bz-az
	for _, c := range [][4]float64{{ax, dx, x, x + w}, {az, dz, z, z + d}} {
		if math.Abs(c[1]) < 1e-9 {
			if c[0] < c[2] || c[0] > c[3] {
				return false
			}
			continue
		}
		u, v := (c[2]-c[0])/c[1], (c[3]-c[0])/c[1]
		if u > v {
			u, v = v, u
		}
		t0, t1 = math.Max(t0, u), math.Min(t1, v)
		if t0 > t1 {
			return false
		}
	}
	return true
}
