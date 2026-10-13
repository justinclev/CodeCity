// Package city defines the city.json schema consumed by the viewer.
package city

import "github.com/justinclev/codecity/internal/deps"

const Version = 8

type City struct {
	// Facts is what the repo provides and uses, for linking repositories; not sent to the viewer.
	Facts *Facts `json:"-"`

	Version  int      `json:"version"`
	Repo     Repo     `json:"repo"`
	Stats    Stats    `json:"stats"`             // for the newest commit
	Commits  []Commit `json:"commits"`           // oldest first; at least one
	HasChurn bool     `json:"churn"`             // Building.Churn and Building.Own are populated
	Authors  []Author `json:"authors,omitempty"` // owners of at least one file, most commits first
	// Multi-repository worlds: each repo is a top-level district (child of the
	// world root, district 0) and Links connect repos by evidence.
	Repos     []RepoInfo `json:"repos,omitempty"`
	Links     []Link     `json:"links,omitempty"`
	Bounds    Bounds     `json:"bounds"`
	Districts []District `json:"districts"`
	Buildings []Building `json:"buildings"`
}

type Repo struct {
	Name       string `json:"name"`
	Source     string `json:"source"`
	Remote     string `json:"remote,omitempty"`
	Path       string `json:"path,omitempty"` // absolute work tree of a local repo (for editor links)
	Base       string `json:"base,omitempty"` // git-relative project dir when this city is one project of a monorepo ("" = whole repo)
	Ref        string `json:"ref"`
	Commit     string `json:"commit"`
	AnalyzedAt string `json:"analyzedAt"`
}

// Commit is a sampled point on the first-parent history.
type Commit struct {
	Hash    string `json:"hash"`
	Date    string `json:"date"`
	Author  string `json:"author"`
	Subject string `json:"subject"`
	Repo    int    `json:"repo,omitempty"` // multi-repo: which repository this commit belongs to
}

// RepoInfo describes one repository of a multi-repo world.
type RepoInfo struct {
	Name     string `json:"name"`
	Source   string `json:"source"`
	Remote   string `json:"remote,omitempty"`
	Path     string `json:"path,omitempty"`
	Base     string `json:"base,omitempty"` // git-relative project dir for a monorepo project
	Ref      string `json:"ref"`
	Commit   string `json:"commit"`
	District int    `json:"district"` // its root district
	HasChurn bool   `json:"churn"`
}

// Link connects two repositories. Kind "dependency" points From the dependent
// repo To the repo it depends on; "people" is undirected (shared contributors).
type Link struct {
	From     int      `json:"from"`
	To       int      `json:"to"`
	Kind     string   `json:"kind"`
	Evidence []string `json:"evidence,omitempty"` // human-readable reasons
	// Files: [importing building, imported district] pairs (dependency links).
	Files [][2]int `json:"files,omitempty"`
	// Via: building pairs behind an "api" or "message" link — [from, to] are buildings of
	// the From and To repository (merged indices); Label is "POST /orders" or the topic.
	Via []Via `json:"via,omitempty"`
	// Broker: for "message" links the brokers involved (kafka, nats, ...).
	Brokers []string `json:"brokers,omitempty"`
	// People: shared contributors (people links), most active first.
	People      []string `json:"people,omitempty"`
	PeopleCount int      `json:"peopleCount,omitempty"`
}

// Via is one concrete connection of a link: an HTTP call to a served route, or a
// message published to a topic and consumed by the other repository.
type Via struct {
	From  int    `json:"a"`
	To    int    `json:"b"`
	Label string `json:"l"`
}

// Point is one change in a file's size history: [commit index, loc, lines, bytes, complexity].
// loc == Absent means the file does not exist from that commit on (until the next point).
type Point [5]int

// Absent marks a file that does not exist at a commit.
const Absent = -1

// Author is a contributor (git mailmap name).
type Author struct {
	Name    string `json:"name"`
	Commits int    `json:"commits"` // non-merge commits up to the newest sample
	Files   int    `json:"files"`   // files they own (most commits to the file)
	Last    int64  `json:"last"`    // unix time of their newest commit
}

type LangStat struct {
	Files int `json:"files"`
	LOC   int `json:"loc"`
}

type Stats struct {
	Files     int                 `json:"files"`
	Dirs      int                 `json:"dirs"`
	LOC       int                 `json:"loc"`
	Lines     int                 `json:"lines"`
	Bytes     int64               `json:"bytes"`
	Languages map[string]LangStat `json:"languages"`
	Skipped   map[string]int      `json:"skipped"`
}

type Bounds struct {
	W float64 `json:"w"`
	D float64 `json:"d"`
}

// District is a directory (single-child chains are collapsed into one: "a/b/c").
// Parent is an index into Districts, -1 for the root.
type District struct {
	Path   string  `json:"path"`
	Name   string  `json:"name"`
	Depth  int     `json:"depth"`
	Parent int     `json:"parent"`
	X      float64 `json:"x"`
	Z      float64 `json:"z"`
	W      float64 `json:"w"`
	D      float64 `json:"d"`
}

// Building is a file. District indexes Districts. The footprint is fixed for the
// whole history (sized by the file's peak LOC) so the layout never shifts between
// commits; H records how its size changed over time. A file is absent before its
// first point.
type Building struct {
	Path     string  `json:"path"`
	Name     string  `json:"name"`
	District int     `json:"district"`
	Lang     string  `json:"lang"`
	X        float64 `json:"x"`
	Z        float64 `json:"z"`
	W        float64 `json:"w"`
	D        float64 `json:"d"`
	H        []Point `json:"h"`
	Repo     int     `json:"repo,omitempty"` // multi-repo: index into Repos
	// Churn is sparse: [commit index i, commits, lines changed, newest commit unix time]
	// for changes landing in (sample i-1, sample i]; everything up to the first sample
	// is attributed to index 0.
	Churn [][4]int64 `json:"ch,omitempty"`
	// Own is [author index, owner's commits to this file, distinct authors] over all
	// history up to the newest sample; nil when the file has no recorded changes.
	Own *[3]int `json:"own,omitempty"`
	// Coupling lists files that change in the same commits:
	// [building index, shared commits, degree %] where degree = shared / mean(revisions).
	Coupling [][3]int `json:"cpl,omitempty"`
	// Imp / ImpD: files (building indices) and package directories (district
	// indices) of the same repository that this file imports, at the newest commit.
	Imp  []int `json:"imp,omitempty"`
	ImpD []int `json:"impd,omitempty"`
	// Shape is the building's architecture, derived from its code at the newest
	// commit (nil when the file is absent then). It never changes between commits.
	Shape *Shape `json:"shape,omitempty"`
}

// Shape kinds (archetypes).
const (
	ShapeTower = "tower" // one class / type with its methods dominates: a tower on a podium
	ShapeSlab  = "slab"  // many small functions, none dominant
	ShapeTypes = "types" // declarations only (types, interfaces): a glass box
	ShapeData  = "data"  // data / config files: utility block
	ShapeDoc   = "doc"   // documentation: library
	ShapeTest  = "test"  // tests: lattice annex
)

// Roles (rooftops), from the flow analysis at the newest commit.
const (
	RoleEntry = "entry" // program entry point (main)
	RoleServe = "serve" // handles HTTP routes
	RoleDB    = "db"    // talks to a database
	RoleExec  = "exec"  // runs processes
	RoleFiles = "files" // reads / writes files
	RoleCall  = "call"  // calls HTTP services
)

// Shape describes how a file is built.
type Shape struct {
	// Tiers: LOC of the stacked tiers, bottom first. Tier 0 is the podium (imports,
	// small declarations); each further tier is one dominant declaration group
	// (≥15% of the file, largest first), named in Names.
	Tiers []int    `json:"t"`
	Names []string `json:"n,omitempty"`
	Kind  string   `json:"k,omitempty"`
	Funcs int      `json:"f,omitempty"` // functions and methods
	Types int      `json:"y,omitempty"` // classes, structs, interfaces, enums, type aliases
	Roles []string `json:"r,omitempty"`
}

// Facts are extracted at the newest commit for cross-repository linking.
type Facts struct {
	Remote     string // normalized "host/owner/repo", "" if unknown
	Identities []deps.Identity
	Deps       []deps.Dep
	Imports    map[int][]string // building index → import specs (see deps.Imports)
	Authors    map[string]int   // every contributor (case-merged) → non-merge commits
	Serves     []Served         // network endpoints this repository serves (HTTP routes, gRPC services, GraphQL fields)
	Aliases    []string         // network names its configuration gives services (docker-compose, Kubernetes)
	DB         []DBUse          // database tables its code reads and writes
	Calls      []Call           // HTTP requests it makes to a known target
	Messages   []Msg            // topics it publishes to / consumes from
}

// Served is an HTTP route and the building that handles it.
type Served struct {
	Building int
	Method   string
	Route    string
	Weak     bool // from a file that may only be a copy (OpenAPI spec, GraphQL schema)
}

// DBUse is a database table a building reads or writes.
type DBUse struct {
	Building int
	Table    string
	Write    bool
}

// Call is an outgoing HTTP request with a known target.
type Call struct {
	Building int
	Method   string
	URL      string
}

// Msg is a publish or subscribe site.
type Msg struct {
	Building int
	Dir      string // "pub" | "sub"
	Broker   string
	Topic    string
}
