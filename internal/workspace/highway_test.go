package workspace

import (
	"fmt"
	"testing"
	"time"

	"github.com/justinclev/codecity/internal/city"
)

// A world at the facts caps (12 repositories, 4000 routes and 4000 calls each) must link quickly.
func TestApiLinksAtScale(t *testing.T) {
	const repos, n = 12, 4000
	cs := make([]*city.City, repos)
	names := make([]string, repos)
	for r := range cs {
		names[r] = fmt.Sprintf("svc%d", r)
		f := &city.Facts{}
		for i := 0; i < n; i++ {
			f.Serves = append(f.Serves, city.Served{Building: i, Method: "GET", Route: fmt.Sprintf("/api/s%d/r%d/{id}", r, i)})
			target := (r + 1) % repos
			f.Calls = append(f.Calls, city.Call{Building: i, Method: "GET", URL: fmt.Sprintf("http://localhost/api/s%d/r%d/42", target, i)})
		}
		cs[r] = &city.City{Facts: f}
	}
	start := time.Now()
	links := apiLinks(cs, names)
	if d := time.Since(start); d > 10*time.Second {
		t.Fatalf("apiLinks took %v", d)
	}
	if len(links) != repos {
		t.Fatalf("want one link per repository, got %d", len(links))
	}
	for _, l := range links {
		if l.To != (l.From+1)%repos || len(l.Via) != maxFileLinks {
			t.Fatalf("link %d→%d has %d pairs", l.From, l.To, len(l.Via))
		}
	}
}
