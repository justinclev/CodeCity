package gitx

import "testing"

func TestStripTrailers(t *testing.T) {
	for in, want := range map[string]string{
		"Why it changed.\n\nCo-Authored-By: A <a@b>\nSigned-off-by: B": "Why it changed.",
		"Co-Authored-By: A <a@b>":                                      "",
		"Fixes the parser: it skipped lines.":                          "Fixes the parser: it skipped lines.",
		"First.\n\nNote: this is prose, not a trailer":                 "First.\n\nNote: this is prose, not a trailer",
		"": "",
	} {
		if got := stripTrailers(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestVersionLess(t *testing.T) {
	for _, c := range [][2]string{{"v1.9.0", "v1.10.0"}, {"v1.2", "v1.2.1"}, {"1.0.0-rc1", "1.0.0-rc2"}, {"a", "b"}} {
		if !versionLess(c[0], c[1]) || versionLess(c[1], c[0]) {
			t.Errorf("%s < %s", c[0], c[1])
		}
	}
}
