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
		pls = append(pls, layoutRegion(members, cities, names, out, adj, margin, less))
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
func layoutRegion(members []int, cities []*city.City, names []string, out, adj [][]int, margin float64, less func(a, b int) bool) (r struct {
	idx  []int
	x, z []float64
	w, d float64
}) {
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
		for k, c := range row {
			pos[c] = float64(k)
		}
	}
	for sweep := 0; sweep < 6; sweep++ {
		order := make([]int, 0, len(rows))
		for l := range rows {
			order = append(order, l)
		}
		if sweep%2 == 1 {
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
			x += cities[c].Bounds.W + margin
			rowD = math.Max(rowD, cities[c].Bounds.D)
		}
		shift := (x - margin) / 2
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
					cx[c] = math.Max(cx[c], cx[p]+(cities[p].Bounds.W+cities[c].Bounds.W)/2+margin)
				}
			}
			for k := len(row) - 2; k >= 0; k-- {
				c, nx := row[k], row[k+1]
				cx[c] = math.Min(cx[c], cx[nx]-(cities[nx].Bounds.W+cities[c].Bounds.W)/2-margin)
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
