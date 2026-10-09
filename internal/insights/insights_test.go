package insights

import (
	"strings"
	"testing"
	"time"

	"github.com/justinclev/codecity/internal/city"
)

func TestCompute(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	old := now.Add(-400 * 24 * time.Hour).Unix()
	c := &city.City{
		Repo:     city.Repo{Name: "r", Ref: "main", Commit: "abcdef1234"},
		HasChurn: true,
		Commits:  []city.Commit{{Date: now.Format(time.RFC3339)}},
		Authors:  []city.Author{{Name: "ann", Last: now.Unix()}, {Name: "bob", Last: old}},
		Buildings: []city.Building{
			{Path: "src/hot.go", Lang: "Go", H: []city.Point{{0, 100, 120, 900, 300}}, Churn: [][4]int64{{0, 50, 500, now.Unix()}}, Own: &[3]int{0, 40, 3}, Coupling: [][3]int{{1, 10, 80}}},
			{Path: "src/hot_test.go", Lang: "Go", H: []city.Point{{0, 50, 60, 400, 80}}, Churn: [][4]int64{{0, 12, 100, now.Unix()}}, Own: &[3]int{0, 12, 1}, Coupling: [][3]int{{0, 10, 80}}},
			{Path: "legacy/old.go", Lang: "Go", H: []city.Point{{0, 400, 450, 9000, 900}}, Churn: [][4]int64{{0, 2, 400, old}}, Own: &[3]int{1, 2, 1}},
			{Path: "README.md", Lang: "Markdown", H: []city.Point{{0, 30, 40, 900, 0}}, Churn: [][4]int64{{0, 99, 900, now.Unix()}}, Own: &[3]int{0, 99, 1}},
			{Path: "gone.go", Lang: "Go", H: []city.Point{{0, city.Absent, 0, 0, 0}}},
		},
	}
	r := Compute(c, 10)
	if r.Files != 4 || r.Active != 1 {
		t.Errorf("files=%d active=%d", r.Files, r.Active)
	}
	if len(r.Hotspots) != 3 || r.Hotspots[0].Path != "src/hot.go" {
		t.Errorf("hotspots = %+v", r.Hotspots)
	}
	if len(r.Coupling) != 1 || r.Coupling[0].Degree != 80 {
		t.Errorf("coupling = %+v", r.Coupling)
	}
	if len(r.Orphaned) != 1 || r.Orphaned[0].Path != "legacy/old.go" {
		t.Errorf("orphaned = %+v", r.Orphaned)
	}
	if r.Hotspots[0].OwnerShare != 80 {
		t.Errorf("owner share = %d", r.Hotspots[0].OwnerShare)
	}
	md := r.Markdown()
	for _, want := range []string{"## Hotspots", "`src/hot.go`", "## Change coupling", "inactive owners", "| `legacy` |"} {
		if !strings.Contains(md, want) {
			t.Errorf("markdown missing %q", want)
		}
	}
	if strings.Contains(md, "README.md` | 99") {
		t.Error("docs must not rank as hotspots")
	}
}
