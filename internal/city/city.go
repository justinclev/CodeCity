// Package city defines the city.json schema consumed by the viewer.
package city

const Version = 3

type City struct {
	Version   int        `json:"version"`
	Repo      Repo       `json:"repo"`
	Stats     Stats      `json:"stats"`             // for the newest commit
	Commits   []Commit   `json:"commits"`           // oldest first; at least one
	HasChurn  bool       `json:"churn"`             // Building.Churn and Building.Own are populated
	Authors   []Author   `json:"authors,omitempty"` // owners of at least one file, most commits first
	Bounds    Bounds     `json:"bounds"`
	Districts []District `json:"districts"`
	Buildings []Building `json:"buildings"`
}

type Repo struct {
	Name       string `json:"name"`
	Source     string `json:"source"`
	Remote     string `json:"remote,omitempty"`
	Path       string `json:"path,omitempty"` // absolute work tree of a local repo (for editor links)
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
}
