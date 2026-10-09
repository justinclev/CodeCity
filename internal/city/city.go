// Package city defines the city.json schema consumed by the viewer.
package city

const Version = 1

type City struct {
	Version   int        `json:"version"`
	Repo      Repo       `json:"repo"`
	Stats     Stats      `json:"stats"`
	Bounds    Bounds     `json:"bounds"`
	Districts []District `json:"districts"`
	Buildings []Building `json:"buildings"`
}

type Repo struct {
	Name       string `json:"name"`
	Source     string `json:"source"`
	Remote     string `json:"remote,omitempty"`
	Ref        string `json:"ref"`
	Commit     string `json:"commit"`
	AnalyzedAt string `json:"analyzedAt"`
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

// Building is a file. District indexes Districts.
type Building struct {
	Path     string  `json:"path"`
	Name     string  `json:"name"`
	District int     `json:"district"`
	Lang     string  `json:"lang"`
	X        float64 `json:"x"`
	Z        float64 `json:"z"`
	W        float64 `json:"w"`
	D        float64 `json:"d"`
	LOC      int     `json:"loc"`
	Lines    int     `json:"lines"`
	Bytes    int64   `json:"bytes"`
}
