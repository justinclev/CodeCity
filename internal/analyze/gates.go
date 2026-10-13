package analyze

import (
	"context"
	"math"

	"github.com/justinclev/codecity/internal/flow"
	"github.com/justinclev/codecity/internal/gitx"
	"github.com/justinclev/codecity/internal/scan"
)

// preFlow is the flow graph of the newest commit, built before the layout so that the city can be laid out
// around its entrances and exits (and reused afterwards for roles and highway facts).
type preFlow struct {
	g    *flow.Graph
	bias map[string]float64
}

// readFlow builds the flow graph of the files present at the newest commit.
func readFlow(ctx context.Context, br *gitx.BlobReader, files []*fileHist, tipOid map[string]string) (*preFlow, error) {
	var in []flow.File
	bytes := 0
	for _, f := range files {
		oid, ok := tipOid[f.path]
		if !ok || !roleWanted(f.path, f.lang) || len(in) >= maxRoleFiles {
			continue
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		content, err := br.Read(oid, scan.DefaultMaxBytes)
		if err != nil {
			return nil, err
		}
		if bytes+len(content) > maxRoleBytes {
			continue
		}
		in = append(in, flow.File{Path: f.path, Lang: f.lang, Content: content})
		bytes += len(content)
	}
	if len(in) == 0 {
		return &preFlow{}, nil
	}
	g := flow.Build(in, flow.Options{})
	return &preFlow{g: g, bias: gateBias(g)}, nil
}

// gateBias says where in the city a file belongs: -1 = it only takes things in (routes, commands, events,
// program entry), +1 = it only reaches out (database, network, files, processes, other services); 0 = both
// equally. Files with neither are absent from the map.
func gateBias(g *flow.Graph) map[string]float64 {
	ins, outs := map[string]int{}, map[string]int{}
	nodes := make(map[int]*flow.Node, len(g.Nodes))
	for _, n := range g.Nodes {
		nodes[n.ID] = n
		if n.Entry == "main" && n.Path != "" && !n.Test {
			ins[n.Path]++
		}
	}
	for _, e := range g.Edges {
		from, to := nodes[e.From], nodes[e.To]
		if from == nil || to == nil {
			continue
		}
		switch {
		case e.Kind == flow.EHandles && to.Path != "" && !to.Test &&
			(from.Kind == flow.KEndpoint || from.Kind == flow.KCommand || from.Kind == flow.KFlag || from.Kind == flow.KEvent):
			ins[to.Path]++
		case e.Kind == flow.EFeeds && from.Kind == flow.KIO && to.Path != "" && !to.Test &&
			(from.Sub == "env" || from.Sub == "args" || from.Sub == "stdin"):
			ins[to.Path]++
		case e.Kind == flow.ERequest && from.Path != "" && !from.Test:
			outs[from.Path]++
		case e.Kind == flow.EIO && to.Kind == flow.KIO && from.Path != "" && !from.Test &&
			to.Sub != "log" && to.Sub != "stdio" && to.Sub != "env" && to.Sub != "args" && to.Sub != "stdin":
			outs[from.Path]++
		}
	}
	bias := map[string]float64{}
	for p, n := range ins {
		bias[p] = -float64(n) / float64(n+outs[p])
	}
	for p, n := range outs {
		if _, ok := bias[p]; !ok {
			bias[p] = 1
		} else {
			bias[p] = math.Round((float64(n)-float64(ins[p]))/float64(n+ins[p])*1000) / 1000
		}
	}
	return bias
}
