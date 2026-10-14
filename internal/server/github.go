package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

// GitHubRepo is one repository in a GitHub repo listing.
type GitHubRepo struct {
	FullName string `json:"fullName"` // owner/repo
	Private  bool   `json:"private"`
	URL      string `json:"url"`      // https clone URL
	Pushed   string `json:"pushed"`   // ISO date of the last push
	Language string `json:"language"` // primary language (may be empty)
	Archived bool   `json:"archived"`
}

// ghRepo is the subset of the GitHub API's repository object we read.
type ghRepo struct {
	FullName string `json:"full_name"`
	Private  bool   `json:"private"`
	CloneURL string `json:"clone_url"`
	PushedAt string `json:"pushed_at"`
	Language string `json:"language"`
	Archived bool   `json:"archived"`
}

// GitHubRepos lists the repositories visible to a token (or a user's public
// repos when only a username is given). It is a thin, read-only proxy to the
// GitHub REST API so the token is sent to GitHub over HTTPS from the loopback
// server rather than embedded in the page's cross-origin requests.
func GitHubRepos(ctx context.Context, token, user string) ([]GitHubRepo, error) {
	token = strings.TrimSpace(token)
	user = strings.TrimSpace(user)
	if token == "" && user == "" {
		return nil, errBad("a GitHub token or username is required")
	}
	client := &http.Client{Timeout: 20 * time.Second}
	var out []GitHubRepo
	for page := 1; page <= 5; page++ { // up to 500 repos, newest push first
		var url string
		if token != "" {
			url = fmt.Sprintf("https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=%d", page)
		} else {
			url = fmt.Sprintf("https://api.github.com/users/%s/repos?per_page=100&sort=pushed&page=%d", user, page)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		req.Header.Set("User-Agent", "codecity")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, errBad("could not reach GitHub: " + err.Error())
		}
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			resp.Body.Close()
			return nil, errBad("GitHub rejected the credentials (check the token and its scopes)")
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, errBad(fmt.Sprintf("GitHub returned %s", resp.Status))
		}
		var repos []ghRepo
		if err := json.NewDecoder(resp.Body).Decode(&repos); err != nil {
			resp.Body.Close()
			return nil, err
		}
		resp.Body.Close()
		for _, r := range repos {
			out = append(out, GitHubRepo{FullName: r.FullName, Private: r.Private, URL: r.CloneURL,
				Pushed: r.PushedAt, Language: r.Language, Archived: r.Archived})
		}
		if len(repos) < 100 {
			break
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Pushed > out[j].Pushed }) // newest activity first
	return out, nil
}
