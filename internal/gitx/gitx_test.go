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
